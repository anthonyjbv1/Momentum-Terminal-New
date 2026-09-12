-- =============================================================================
-- Momentum Terminal — Phase 6f: the portfolio
--
-- The user sees what they hold, how it is performing, and what they have
-- traded. Every figure on that page is computed HERE, in integer cents, and
-- read as a value; the interface renders and never calculates.
--
-- MARKING. An open position is valued at the quote it would close at right
-- now: a HIGH position at the Sell quote, a LOW one at the Buy quote (the
-- 6e rule, unchanged). That is what the user would actually receive, so it
-- sits below the raw score by the spread, and the interface says so.
--
-- ARITHMETIC (the 6e rounding rule carried forward). Points become cents
-- exactly once, in points_to_cents(); everything after that is integer:
--
--   value       = open_units × mark_cents
--   cost        = Σ open_units × entry_price_cents          (per lot, exact)
--   unrealized  = value − cost                               (HIGH)
--               = cost − value                               (LOW)
--   realized    = Σ position_closes.pnl_cents                (read, never recomputed)
--   cash        = users.wallet_balance_cents
--   total value = cash + Σ value
--
-- "unrealized = (Sell quote − weighted-average entry) × units" is the same
-- number, evaluated with the EXACT average (cost ÷ units before any
-- rounding). The weighted-average entry the interface shows is
-- round(cost ÷ units), half up, for reading only; no P&L ever carries the
-- rounding of a displayed figure. Identity, under the long-only gate:
--
--   total value = paper credit + realized + unrealized
--
-- VALUE HISTORY. The portfolio's value over time cannot be rebuilt from
-- score_history alone: the Sell quote is score − spread, and the spread of
-- past ticks is not recorded. So the value is RECORDED at the moments it
-- changes, as the server computes it then, into portfolio_history:
--
--   * at every Engine tick, for every user holding a position, at that
--     tick's freshly written quotes (apply_engine_tick → snapshot_portfolios);
--   * after every order, at the order's own instant (a trigger on
--     trade_orders → record_portfolio_snapshot).
--
-- Between ticks nothing moves, so the recorded points ARE the history:
-- nothing is interpolated and nothing is synthesised. With the Engine
-- dormant the only points are order-time marks; before the first order
-- there are none, and the chart says so.
--
-- PART 0 (carried from 6e): the close cooldown rises to 60 s and the
-- starting balance to $10,000; existing beta accounts are topped up through
-- the ledger with credit_paper_balance() (a service-role action), never by a
-- migration rewriting balances.
-- =============================================================================

-- Part 0: the close cooldown -------------------------------------------------------
-- 5 s only blocked the within-tick round trip, which already loses the spread.
-- The real exploit is reflexive: buy, let your own flow feed Trading Activity,
-- the tick fires partly on that flow, sell into the move you helped create.
-- 60 s spans two 30-second ticks. TUNABLE — the final value is a POLICY
-- DECISION PENDING — with a floor: the platform's regulatory positioning
-- describes this cooldown as preventing round-trip score influence, so it
-- must remain at least one full tick (30 s). CLOSE_COOLDOWN_MIN_SECONDS in
-- lib/trading/model.ts is the code-side floor and a test pins the default
-- above it.
alter table public.platform_settings
  alter column close_cooldown_seconds set default 60;

update public.platform_settings
   set close_cooldown_seconds = 60, updated_at = now()
 where id and close_cooldown_seconds < 60;

comment on column public.platform_settings.close_cooldown_seconds is
  'RISK LEVER 4 — round-trip guard: a lot may not be closed until this many seconds after it opened. 60 s (two ticks) since 6f. TUNABLE, policy decision pending; must remain at least one full tick (30 s): the platform''s regulatory positioning describes it as preventing round-trip score influence.';

-- Part 0: the starting balance -----------------------------------------------------
-- $10,000 of paper. At one dollar per point a share at score 50 costs $50;
-- $1,000 bought roughly nineteen shares in total, too coarse for a beta whose
-- purpose is finding out whether a portfolio feels like anything.
create or replace function public.starting_balance_cents()
returns bigint
language sql
immutable
set search_path = ''
as $$
  select 1000000::bigint;  -- $10,000.00 of paper credit
$$;

comment on function public.starting_balance_cents() is
  'The paper balance every new user starts with, in integer cents ($10,000 since 6f). Also what reset_paper_balance() returns a user to.';

-- credit_paper_balance ---------------------------------------------------------------
-- The service-role way to grant paper credit to an existing account: a
-- DEPOSIT in the ledger and the matching balance change, one transaction.
-- Used to top up beta accounts when the starting balance rose; never callable
-- by a user.
create or replace function public.credit_paper_balance(p_user_id uuid, p_amount_cents bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before bigint;
  v_after  bigint;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'credit_paper_balance: p_amount_cents must be a positive integer number of cents' using errcode = '22023';
  end if;

  select u.wallet_balance_cents into v_before from public.users u where u.id = p_user_id for update;
  if not found then
    raise exception 'No wallet for user %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.transactions (user_id, type, amount_cents) values (p_user_id, 'DEPOSIT', p_amount_cents);

  update public.users
     set wallet_balance_cents = wallet_balance_cents + p_amount_cents,
         buying_power_cents   = buying_power_cents + p_amount_cents
   where id = p_user_id
   returning wallet_balance_cents into v_after;

  return jsonb_build_object('user_id', p_user_id, 'credited_cents', p_amount_cents, 'balance_before_cents', v_before, 'balance_after_cents', v_after);
end;
$$;

comment on function public.credit_paper_balance(uuid, bigint) is
  'Service-role only: grants paper credit to a user through the ledger (a DEPOSIT row and the balance change together). How beta accounts were topped up when the starting balance rose in 6f.';

revoke execute on function public.credit_paper_balance(uuid, bigint) from public, anon, authenticated;
grant  execute on function public.credit_paper_balance(uuid, bigint) to service_role;

-- Value snapshots ----------------------------------------------------------------------
-- portfolio_history has existed since Phase 1 and nothing wrote it. It now
-- records where each snapshot came from: the tick, or the order.
alter table public.portfolio_history
  add column tick_number bigint references public.engine_ticks (tick_number) on delete set null,
  add column order_id    uuid   references public.trade_orders (id)          on delete set null;

drop index if exists public.portfolio_history_user_recorded_idx;
create index portfolio_history_user_recorded_id_idx on public.portfolio_history (user_id, recorded_at, id);
create index portfolio_history_order_id_idx         on public.portfolio_history (order_id);

comment on table  public.portfolio_history is
  'Recorded total portfolio value per user, integer cents: cash plus every open position marked at its closing quote. One row per Engine tick for each user holding a position (at that tick''s quotes) and one after each order. Never interpolated.';
comment on column public.portfolio_history.total_value_cents is 'wallet_balance_cents + Σ open_units × mark_cents at recorded_at. Integer cents.';
comment on column public.portfolio_history.tick_number       is 'The Engine tick this snapshot was taken at, for tick snapshots.';
comment on column public.portfolio_history.order_id          is 'The order this snapshot followed, for order snapshots.';

-- The one definition of "total portfolio value".
create or replace function public.portfolio_value_cents(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (u.wallet_balance_cents
          + coalesce((select sum(l.open_units * case when l.direction = 'HIGH' then public.points_to_cents(p.sell_price)
                                                                              else public.points_to_cents(p.buy_price) end)
                        from public.positions l
                        join public.people p on p.id = l.person_id
                       where l.user_id = u.id
                         and l.is_open), 0))::bigint
    from public.users u
   where u.id = p_user_id;
$$;

comment on function public.portfolio_value_cents(uuid) is
  'Total portfolio value in integer cents: cash plus every open lot marked at the quote it would close at (HIGH at Sell, LOW at Buy). Null for an unknown user.';

revoke execute on function public.portfolio_value_cents(uuid) from public, anon, authenticated;
grant  execute on function public.portfolio_value_cents(uuid) to service_role;

create or replace function public.record_portfolio_snapshot(
  p_user_id     uuid,
  p_at          timestamptz default now(),
  p_order_id    uuid        default null,
  p_tick_number bigint      default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_value bigint;
begin
  v_value := public.portfolio_value_cents(p_user_id);
  if v_value is null then
    return null;
  end if;
  insert into public.portfolio_history (user_id, total_value_cents, recorded_at, order_id, tick_number)
  values (p_user_id, v_value, coalesce(p_at, now()), p_order_id, p_tick_number);
  return v_value;
end;
$$;

comment on function public.record_portfolio_snapshot(uuid, timestamptz, uuid, bigint) is
  'Appends one portfolio_history row for a user at the value the server computes now. Called after every order (trigger) and by snapshot_portfolios() at every tick.';

revoke execute on function public.record_portfolio_snapshot(uuid, timestamptz, uuid, bigint) from public, anon, authenticated;
grant  execute on function public.record_portfolio_snapshot(uuid, timestamptz, uuid, bigint) to service_role;

create or replace function public.snapshot_portfolios(p_at timestamptz, p_tick_number bigint default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  -- Only users holding a position: their value moves with the quotes. A
  -- user holding nothing has a flat cash value, recorded at their last order.
  insert into public.portfolio_history (user_id, total_value_cents, recorded_at, tick_number)
  select u.id, public.portfolio_value_cents(u.id), coalesce(p_at, now()), p_tick_number
    from public.users u
   where exists (select 1 from public.positions l where l.user_id = u.id and l.is_open);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.snapshot_portfolios(timestamptz, bigint) is
  'Records a portfolio_history row for every user holding a position, at the quotes as they stand. apply_engine_tick() calls it after writing the tick''s scores and spreads.';

revoke execute on function public.snapshot_portfolios(timestamptz, bigint) from public, anon, authenticated;
grant  execute on function public.snapshot_portfolios(timestamptz, bigint) to service_role;

-- After an order: place_order() finalises the trade_orders row (opened /
-- closed units, realized P&L, balance after) as its last write, once the
-- lots, the ledger and the balance have all moved. That update is the moment
-- to record the value.
create or replace function public.trade_orders_snapshot_portfolio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_portfolio_snapshot(new.user_id, new.created_at, new.id, null);
  return null;
end;
$$;

drop trigger if exists trade_orders_snapshot_portfolio on public.trade_orders;
create trigger trade_orders_snapshot_portfolio
  after update of balance_after_cents on public.trade_orders
  for each row
  when (old.balance_after_cents is null and new.balance_after_cents is not null)
  execute function public.trade_orders_snapshot_portfolio();

-- The Engine tick, with the snapshot step. Body as in 20260907143920 plus
-- the one call after the quotes are written.
create or replace function public.apply_engine_tick(p_tick jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tick_number       bigint;
  v_expected          bigint := nullif(p_tick ->> 'expected_tick_number', '')::bigint;
  v_started_at        timestamptz := (p_tick ->> 'started_at')::timestamptz;
  v_finished_at       timestamptz := (p_tick ->> 'finished_at')::timestamptz;
  v_people_updated    integer := 0;
  v_history_rows      integer := 0;
  v_events            integer := 0;
  v_signals_processed integer := 0;
  v_snapshots         integer := 0;
begin
  if v_started_at is null or v_finished_at is null then
    raise exception 'apply_engine_tick: started_at and finished_at are required' using errcode = '22023';
  end if;

  -- One tick at a time.
  perform pg_advisory_xact_lock(hashtext('momentum_engine_tick'));

  v_tick_number := coalesce((select max(tick_number) from public.engine_ticks), 0) + 1;
  if v_expected is not null and v_expected <> v_tick_number then
    raise exception 'apply_engine_tick: stale tick (computed for tick %, next tick is %)', v_expected, v_tick_number
      using errcode = '40001';
  end if;

  insert into public.engine_ticks (tick_number, started_at, finished_at, mood, summary)
  values (v_tick_number, v_started_at, v_finished_at, coalesce((p_tick ->> 'mood')::numeric, 0), p_tick -> 'summary');

  update public.people p
     set current_score = x.score,
         spread        = x.spread,
         last_tick_at  = v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb)) as x(id uuid, score numeric, spread numeric)
   where p.id = x.id;
  get diagnostics v_people_updated = row_count;

  insert into public.score_history (person_id, score, tick_number, recorded_at)
  select x.id, x.score, v_tick_number, v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb)) as x(id uuid, score numeric);
  get diagnostics v_history_rows = row_count;

  insert into public.score_events (tick_number, person_id, force, impact, details, created_at)
  select v_tick_number, e.person_id, e.force, e.impact, e.details, v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'events', '[]'::jsonb)) as e(person_id uuid, force text, impact numeric, details jsonb)
   where e.impact <> 0;
  get diagnostics v_events = row_count;

  update public.signals s
     set processed            = true,
         processed_at         = v_finished_at,
         impact_score         = x.impact_score,
         sentiment_label      = x.sentiment_label,
         sentiment_confidence = x.sentiment_confidence
    from jsonb_to_recordset(coalesce(p_tick -> 'signals', '[]'::jsonb)) as x(id uuid, impact_score numeric, sentiment_label text, sentiment_confidence numeric)
   where s.id = x.id
     and s.processed = false;
  get diagnostics v_signals_processed = row_count;

  -- Portfolio value snapshots at this tick's quotes (Phase 6f): one row per
  -- user holding a position, marked at the Sell / Buy quotes just written.
  v_snapshots := public.snapshot_portfolios(v_finished_at, v_tick_number);

  update public.engine_ticks
     set people_updated = v_people_updated, signals_processed = v_signals_processed
   where tick_number = v_tick_number;

  return jsonb_build_object(
    'tick_number', v_tick_number,
    'people_updated', v_people_updated,
    'history_rows', v_history_rows,
    'score_events', v_events,
    'signals_processed', v_signals_processed,
    'portfolio_snapshots', v_snapshots
  );
end;
$$;

comment on function public.apply_engine_tick(jsonb) is
  'Atomically persists one Engine tick (people scores + spread, score_history, score_events, processed signals, engine_ticks) and records every position-holding user''s portfolio value at the new quotes. Service role only.';

-- The portfolio summary -----------------------------------------------------------------
-- Everything the page shows above the history, one read: cash, every open
-- position marked at its closing quote, unrealized and realized P&L, the
-- paper credit granted so far and the return against it. Integer cents
-- throughout; the two percentages are display figures.
create or replace function public.portfolio_summary_for(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now             timestamptz := now();
  v_cash            bigint;
  v_positions       jsonb;
  v_position_count  integer := 0;
  v_positions_value bigint := 0;
  v_open_cost       bigint := 0;
  v_unrealized      bigint := 0;
  v_realized        bigint := 0;
  v_credit          bigint := 0;
  v_orders          bigint := 0;
  v_closes          bigint := 0;
  v_people_traded   bigint := 0;
  v_first_order     timestamptz;
  v_last_order      timestamptz;
  v_history_points  bigint := 0;
  v_total           bigint;
begin
  select u.wallet_balance_cents into v_cash from public.users u where u.id = p_user_id;
  if v_cash is null then
    return null;
  end if;

  with lots as (
    select l.person_id,
           l.direction,
           sum(l.open_units)::bigint                        as open_units,
           sum(l.open_units * l.entry_price_cents)::bigint  as cost_cents,
           count(*)::integer                                as lots,
           min(l.opened_at)                                 as oldest_opened_at,
           max(l.opened_at)                                 as newest_opened_at
      from public.positions l
     where l.user_id = p_user_id
       and l.is_open
     group by l.person_id, l.direction
  ),
  marked as (
    select lo.*,
           p.slug, p.display_name, p.category, p.avatar_url, p.is_active, p.current_score, p.spread,
           public.points_to_cents(p.buy_price)  as buy_cents,
           public.points_to_cents(p.sell_price) as sell_cents,
           case when lo.direction = 'HIGH' then public.points_to_cents(p.sell_price)
                                          else public.points_to_cents(p.buy_price) end as mark_cents,
           (select coalesce(sum(c.pnl_cents), 0)::bigint
              from public.position_closes c
             where c.user_id = p_user_id and c.person_id = lo.person_id) as realized_cents
      from lots lo
      join public.people p on p.id = lo.person_id
  ),
  valued as (
    select m.*,
           (m.open_units * m.mark_cents)::bigint as value_cents,
           (case when m.direction = 'HIGH' then m.open_units * m.mark_cents - m.cost_cents
                                          else m.cost_cents - m.open_units * m.mark_cents end)::bigint as unrealized_cents
      from marked m
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id',            v.person_id,
           'slug',                 v.slug,
           'display_name',         v.display_name,
           'category',             v.category,
           'avatar_url',           v.avatar_url,
           'is_active',            v.is_active,
           'direction',            v.direction,
           'open_units',           v.open_units,
           'cost_cents',           v.cost_cents,
           'avg_entry_cents',      round(v.cost_cents::numeric / v.open_units)::bigint,
           'lots',                 v.lots,
           'oldest_opened_at',     v.oldest_opened_at,
           'newest_opened_at',     v.newest_opened_at,
           'score',                v.current_score,
           'spread',               v.spread,
           'buy_cents',            v.buy_cents,
           'sell_cents',           v.sell_cents,
           'mark_side',            case when v.direction = 'HIGH' then 'SELL' else 'BUY' end,
           'mark_price_cents',     v.mark_cents,
           'value_cents',          v.value_cents,
           'unrealized_pnl_cents', v.unrealized_cents,
           'unrealized_pct',       case when v.cost_cents > 0 then round(v.unrealized_cents::numeric * 100 / v.cost_cents, 2) end,
           'realized_pnl_cents',   v.realized_cents
         ) order by v.value_cents desc, v.display_name, v.person_id), '[]'::jsonb),
         count(*)::integer,
         coalesce(sum(v.value_cents), 0)::bigint,
         coalesce(sum(v.cost_cents), 0)::bigint,
         coalesce(sum(v.unrealized_cents), 0)::bigint
    into v_positions, v_position_count, v_positions_value, v_open_cost, v_unrealized
    from valued v;

  select coalesce(sum(c.pnl_cents), 0)::bigint, count(*)::bigint
    into v_realized, v_closes
    from public.position_closes c
   where c.user_id = p_user_id;

  -- Paper credit granted so far: deposits less withdrawals (the reset path).
  select coalesce(sum(case when t.type = 'DEPOSIT' then t.amount_cents when t.type = 'WITHDRAWAL' then -t.amount_cents else 0 end), 0)::bigint
    into v_credit
    from public.transactions t
   where t.user_id = p_user_id;

  select count(*)::bigint, count(distinct o.person_id)::bigint, min(o.created_at), max(o.created_at)
    into v_orders, v_people_traded, v_first_order, v_last_order
    from public.trade_orders o
   where o.user_id = p_user_id;

  select count(*)::bigint into v_history_points from public.portfolio_history h where h.user_id = p_user_id;

  v_total := v_cash + v_positions_value;

  return jsonb_build_object(
    'user_id',               p_user_id,
    'as_of',                 v_now,
    'cash_cents',            v_cash,
    'positions_value_cents', v_positions_value,
    'total_value_cents',     v_total,
    'open_cost_cents',       v_open_cost,
    'unrealized_pnl_cents',  v_unrealized,
    'realized_pnl_cents',    v_realized,
    'paper_credit_cents',    v_credit,
    'total_return_cents',    v_total - v_credit,
    'total_return_pct',      case when v_credit > 0 then round((v_total - v_credit)::numeric * 100 / v_credit, 2) end,
    'position_count',        v_position_count,
    'orders',                v_orders,
    'closes',                v_closes,
    'people_traded',         v_people_traded,
    'first_order_at',        v_first_order,
    'last_order_at',         v_last_order,
    'history_points',        v_history_points,
    'positions',             v_positions
  );
end;
$$;

comment on function public.portfolio_summary_for(uuid) is
  'Service-role view of one user''s portfolio: cash, every open position marked at its closing quote (value, weighted-average entry for display, unrealized and per-person realized P&L), the totals, lifetime realized P&L, paper credit and return. Integer cents; percentages are display figures. Null for an unknown user.';

revoke execute on function public.portfolio_summary_for(uuid) from public, anon, authenticated;
grant  execute on function public.portfolio_summary_for(uuid) to service_role;

create or replace function public.my_portfolio()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then null else public.portfolio_summary_for(auth.uid()) end;
$$;

comment on function public.my_portfolio() is 'The signed-in user''s portfolio summary (see portfolio_summary_for).';

revoke execute on function public.my_portfolio() from public, anon;
grant  execute on function public.my_portfolio() to authenticated;

-- Value history ----------------------------------------------------------------------------
-- portfolio_history since a point in time, downsampled by time exactly as
-- person_score_series() downsamples score_history: the window is cut into
-- p_points slices and each slice with a snapshot returns its last value
-- (and its first, so the change over the window is exact). Empty slices
-- return nothing; a user with no snapshots returns no rows.
create or replace function public.portfolio_value_series_for(
  p_user_id uuid,
  p_since   timestamptz default null,
  p_points  integer     default 120
)
returns table (
  bucket_at   timestamptz,
  value_cents bigint,
  open_cents  bigint,
  samples     integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select least(greatest(coalesce(p_points, 120), 2), 1000) as points
  ),
  span as (
    select coalesce(p_since, (select min(h.recorded_at)
                                from public.portfolio_history h
                               where h.user_id = p_user_id)) as from_at,
           now() as to_at
  ),
  ranked as (
    select h.total_value_cents,
           h.recorded_at,
           h.id,
           width_bucket(
             extract(epoch from h.recorded_at),
             extract(epoch from s.from_at),
             extract(epoch from s.to_at) + 0.001,
             (select points from params)
           ) as bucket
      from public.portfolio_history h
      cross join span s
     where h.user_id = p_user_id
       and s.from_at is not null
       and h.recorded_at >= s.from_at
       and h.recorded_at <= s.to_at
  )
  select max(r.recorded_at)                                                     as bucket_at,
         (array_agg(r.total_value_cents order by r.recorded_at desc, r.id desc))[1] as value_cents,
         (array_agg(r.total_value_cents order by r.recorded_at asc, r.id asc))[1]   as open_cents,
         count(*)::int                                                            as samples
    from ranked r
   group by r.bucket
   order by bucket_at;
$$;

comment on function public.portfolio_value_series_for(uuid, timestamptz, integer) is
  'Portfolio chart read side: one user''s recorded value since p_since (null = all), downsampled by time into at most p_points slices; each slice reports the time and value of its last snapshot, the value of its first (open) and how many it holds. Empty slices are omitted.';

revoke execute on function public.portfolio_value_series_for(uuid, timestamptz, integer) from public, anon, authenticated;
grant  execute on function public.portfolio_value_series_for(uuid, timestamptz, integer) to service_role;

create or replace function public.my_portfolio_value_series(p_since timestamptz default null, p_points integer default 120)
returns table (
  bucket_at   timestamptz,
  value_cents bigint,
  open_cents  bigint,
  samples     integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.portfolio_value_series_for(auth.uid(), p_since, p_points);
$$;

comment on function public.my_portfolio_value_series(timestamptz, integer) is 'The signed-in user''s value series (see portfolio_value_series_for). Empty when signed out.';

revoke execute on function public.my_portfolio_value_series(timestamptz, integer) from public, anon;
grant  execute on function public.my_portfolio_value_series(timestamptz, integer) to authenticated;

-- Trade history ---------------------------------------------------------------------------
-- Every order, newest first, with the person and the money as recorded:
-- the executed price is trade_orders.fill_price_cents (the snapshot), the
-- proceeds are the sum of the order's position_closes, the realized P&L the
-- order's own. Keyset pagination on (created_at, id): the tiebreaker is the
-- id, so orders placed at one instant neither skip nor repeat across a page.
create or replace function public.trade_history_for(
  p_user_id   uuid,
  p_before    timestamptz default null,
  p_before_id uuid        default null,
  p_limit     integer     default 20
)
returns table (
  id                  uuid,
  created_at          timestamptz,
  side                text,
  units               bigint,
  fill_price_cents    bigint,
  gross_cents         bigint,
  opened_units        bigint,
  closed_units        bigint,
  cost_cents          bigint,
  proceeds_cents      bigint,
  realized_pnl_cents  bigint,
  balance_after_cents bigint,
  surface             text,
  person_id           uuid,
  person_slug         text,
  person_name         text,
  person_category     text,
  person_avatar       text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.created_at,
         o.side,
         o.units,
         o.fill_price_cents,
         o.gross_cents,
         o.opened_units,
         o.closed_units,
         (o.opened_units * o.fill_price_cents)::bigint as cost_cents,
         coalesce((select sum(c.proceeds_cents) from public.position_closes c where c.order_id = o.id), 0)::bigint as proceeds_cents,
         o.realized_pnl_cents,
         o.balance_after_cents,
         o.surface,
         p.id,
         p.slug,
         p.display_name,
         p.category,
         p.avatar_url
    from public.trade_orders o
    join public.people p on p.id = o.person_id
   where o.user_id = p_user_id
     and (p_before is null or p_before_id is null or (o.created_at, o.id) < (p_before, p_before_id))
   order by o.created_at desc, o.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

comment on function public.trade_history_for(uuid, timestamptz, uuid, integer) is
  'One user''s orders newest first, each with its person and the money as recorded (fill price snapshot, cost of what it opened, proceeds and realized P&L of what it closed). Keyset pagination on (created_at desc, id desc): pass the last row''s created_at and id as p_before / p_before_id.';

revoke execute on function public.trade_history_for(uuid, timestamptz, uuid, integer) from public, anon, authenticated;
grant  execute on function public.trade_history_for(uuid, timestamptz, uuid, integer) to service_role;

create or replace function public.my_trade_history(p_before timestamptz default null, p_before_id uuid default null, p_limit integer default 20)
returns table (
  id                  uuid,
  created_at          timestamptz,
  side                text,
  units               bigint,
  fill_price_cents    bigint,
  gross_cents         bigint,
  opened_units        bigint,
  closed_units        bigint,
  cost_cents          bigint,
  proceeds_cents      bigint,
  realized_pnl_cents  bigint,
  balance_after_cents bigint,
  surface             text,
  person_id           uuid,
  person_slug         text,
  person_name         text,
  person_category     text,
  person_avatar       text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.trade_history_for(auth.uid(), p_before, p_before_id, p_limit);
$$;

comment on function public.my_trade_history(timestamptz, uuid, integer) is 'The signed-in user''s trade history (see trade_history_for). Empty when signed out.';

revoke execute on function public.my_trade_history(timestamptz, uuid, integer) from public, anon;
grant  execute on function public.my_trade_history(timestamptz, uuid, integer) to authenticated;
