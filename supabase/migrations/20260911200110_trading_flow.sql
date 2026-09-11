-- =============================================================================
-- Momentum Terminal — Phase 6e: the trading flow
--
-- A user opens a position on a person (Buy), holds it while the Engine
-- ticks, and closes it (Sell). Paper money only: no payment rail, no
-- withdrawal path. Everything financial lives here, in the database, on the
-- Phase 2 write path: the client never supplies a price, a balance or a P&L.
--
-- MONEY. Every monetary amount is an integer number of cents in a bigint
-- column; every arithmetic step is integer. Scores are numeric points and
-- never mix with money: a quote in points becomes a price in cents exactly
-- once, when the server reads it, by rounding to the nearest cent (numeric
-- round: half away from zero). Scores and spreads are persisted at two
-- decimals, so in practice that rounding is exact. From there on:
--
--   cost      = units × price_cents
--   P&L       = (exit_cents − entry_cents) × units        (HIGH)
--             = (entry_cents − exit_cents) × units        (LOW)
--   proceeds  = capital returned + P&L, never below zero  (paper: a LOW
--               loss is capped at its collateral)
--
-- No further rounding happens anywhere, so no cent is ever created or lost.
-- The weighted-average entry price the interface shows is round(cost /
-- units) and is a display figure only; realized P&L is FIFO by lot.
--
-- UNITS. The schema and the RPCs say `units`; the interface says "shares".
-- The asymmetry is deliberate: it is the seam that lets the user-facing word
-- change without a migration.
--
-- QUOTE AND EXECUTION. The entry price is the person's current Buy quote
-- (score + spread) read by place_order() at the moment it runs, with the
-- person row locked so no tick can move it under the order, and snapshotted
-- onto the lot. The exit price is the current Sell quote (score − spread),
-- the same way. The client may send the price it displayed; if the server's
-- quote differs by more than platform_settings.price_tolerance_cents the
-- order is rejected with the new quote, never filled at a stale one.
--
-- ATOMICITY. place_order() is one transaction: the wallet row is locked
-- FOR UPDATE first (so a user's orders are serialised and can never
-- double-spend), then the person row; every check runs before any write;
-- ledger row, lot, closes, tape and balance change land together or not at
-- all. users_wallet_balance_nonneg is the last line: a balance can never go
-- negative whatever the caller does.
--
-- CLOSING. FIFO: the oldest open lot closes first; partial closes reduce a
-- lot's open_units and a lot is closed when they reach zero. Each close
-- writes a position_closes row with its realized P&L.
--
-- THE GATE. platform_settings.shorting_enabled (6c+) stays the switch. A Buy
-- closes LOW exposure first, then opens HIGH; a Sell closes HIGH exposure
-- first, then opens LOW — and that last step is refused while the gate is
-- down. The full two-sided path is here; the flag only decides.
--
-- RISK LEVERS (installed, not calibrated). Four tunables on
-- platform_settings, each enforced here and each returning a specific
-- rejection. They ship permissive enough not to bind during beta;
-- calibration waits for real flow.
-- =============================================================================

-- The paper balance ---------------------------------------------------------------
-- The one place the starting balance is defined. handle_new_user() grants it.
create or replace function public.starting_balance_cents()
returns bigint
language sql
immutable
set search_path = ''
as $$
  select 100000::bigint;  -- $1,000.00 of paper credit
$$;

comment on function public.starting_balance_cents() is
  'The paper balance every new user starts with, in integer cents. Also what reset_paper_balance() returns a user to.';

revoke execute on function public.starting_balance_cents() from public, anon;
grant  execute on function public.starting_balance_cents() to authenticated, service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  starting_balance_cents constant bigint := public.starting_balance_cents();
  base_username text;
  candidate     text;
  attempts      integer := 0;
begin
  base_username := lower(coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'user'
  ));
  base_username := regexp_replace(base_username, '[^a-z0-9_]', '_', 'g');
  base_username := left(base_username, 30);
  if length(base_username) < 3 then
    base_username := rpad(base_username, 3, '0');
  end if;
  candidate := base_username;

  loop
    begin
      insert into public.users (
        id, email, username, display_name, avatar_url,
        wallet_balance_cents, buying_power_cents
      )
      values (
        new.id,
        new.email,
        candidate,
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), candidate),
        nullif(trim(new.raw_user_meta_data ->> 'avatar_url'), ''),
        starting_balance_cents,
        starting_balance_cents
      );
      exit;
    exception
      when unique_violation then
        attempts := attempts + 1;
        if attempts >= 5 then
          raise;
        end if;
        candidate := left(base_username, 25) || '_' || lpad(floor(random() * 10000)::integer::text, 4, '0');
    end;
  end loop;

  insert into public.transactions (user_id, type, amount_cents)
  values (new.id, 'DEPOSIT', starting_balance_cents);

  return new;
end;
$$;

-- Tunables ---------------------------------------------------------------------------
-- The tolerance band and the four risk levers, one row, service-role writes only.
alter table public.platform_settings
  add column price_tolerance_cents   bigint  not null default 10,
  add column max_units_per_person    bigint  not null default 100000,
  add column max_open_interest_share numeric not null default 1.0,
  add column max_daily_close_cents   bigint  not null default 100000000,
  add column close_cooldown_seconds  integer not null default 5;

alter table public.platform_settings
  add constraint platform_settings_tolerance_nonneg     check (price_tolerance_cents >= 0),
  add constraint platform_settings_max_units_positive   check (max_units_per_person > 0),
  add constraint platform_settings_oi_share_range       check (max_open_interest_share > 0 and max_open_interest_share <= 1),
  add constraint platform_settings_daily_close_positive check (max_daily_close_cents > 0),
  add constraint platform_settings_cooldown_nonneg      check (close_cooldown_seconds >= 0);

comment on column public.platform_settings.price_tolerance_cents is
  'PRICE_TOLERANCE_CENTS. An order whose displayed price differs from the server quote by more than this many cents per unit is rejected with the new quote. Default 10 (0.10 points).';
comment on column public.platform_settings.max_units_per_person is
  'RISK LEVER 1 — most open units one user may hold on one person. Ships permissive (100,000); calibration waits for real flow.';
comment on column public.platform_settings.max_open_interest_share is
  'RISK LEVER 2 — largest share (0–1) of all open units on one person that a single user may hold. Ships at 1.0 (inert); calibration waits for real flow.';
comment on column public.platform_settings.max_daily_close_cents is
  'RISK LEVER 3 — most close (redemption) value one user may realise in a trailing 24 hours, in cents. Ships at $1,000,000 (inert against a $1,000 balance); calibration waits for real flow.';
comment on column public.platform_settings.close_cooldown_seconds is
  'RISK LEVER 4 — round-trip guard: a lot may not be closed until this many seconds after it opened. Ships at 5; calibration waits for real flow.';

-- Positions are lots ---------------------------------------------------------------
-- Per-lot granularity: units, the entry price snapshot in cents, how many
-- units are still open. amount_cents stays the lot's cost (units × entry
-- price) so the 6c+ exposure functions keep reading it. The pre-6e `shares`
-- (numeric) and `cost_basis_cents` columns go: money and quantity are
-- integers here, and the table is empty.
alter table public.positions
  drop constraint positions_shares_positive,
  drop constraint positions_cost_basis_nonneg,
  drop column shares,
  drop column cost_basis_cents;

alter table public.positions
  add column units             bigint not null,
  add column open_units        bigint not null,
  add column entry_price_cents bigint not null,
  add column order_id          uuid;

alter table public.positions
  add constraint positions_units_positive       check (units > 0),
  add constraint positions_open_units_range     check (open_units >= 0 and open_units <= units),
  add constraint positions_entry_price_positive check (entry_price_cents > 0),
  add constraint positions_amount_is_cost       check (amount_cents = units * entry_price_cents),
  add constraint positions_open_units_state     check ((open_units > 0) = is_open);

create index positions_user_person_fifo_idx on public.positions (user_id, person_id, direction, opened_at, id) where is_open;
create index positions_person_open_idx      on public.positions (person_id, direction) where is_open;

comment on table  public.positions is 'A user''s lots: one row per fill that opened units. Money is integer cents, quantity is integer units (the interface says "shares"). FIFO closes reduce open_units.';
comment on column public.positions.units             is 'Units the lot opened with. Never changes.';
comment on column public.positions.open_units        is 'Units still open. 0 once fully closed (then is_open is false).';
comment on column public.positions.entry_price_cents is 'The Buy (HIGH) or Sell (LOW) quote at the moment the server filled the lot, in cents per unit. Snapshot; never recomputed.';
comment on column public.positions.entry_score       is 'The same entry quote in score points, for display.';
comment on column public.positions.amount_cents      is 'The lot''s cost: units × entry_price_cents.';

-- The gate trigger also watches open_units now.
drop trigger if exists positions_enforce_direction on public.positions;
create trigger positions_enforce_direction
  after insert or update of direction, amount_cents, open_units, is_open, user_id, person_id
  on public.positions
  for each row
  execute function public.positions_enforce_direction();

-- Orders and closes -----------------------------------------------------------------
create table public.trade_orders (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.users (id)  on delete cascade,
  person_id           uuid        not null references public.people (id) on delete restrict,
  side                text        not null,
  units               bigint      not null,
  quoted_price_cents  bigint,
  fill_price_cents    bigint      not null,
  gross_cents         bigint      not null,
  opened_units        bigint      not null default 0,
  closed_units        bigint      not null default 0,
  realized_pnl_cents  bigint      not null default 0,
  balance_after_cents bigint,
  surface             text,
  created_at          timestamptz not null default now(),

  constraint trade_orders_side_check          check (side in ('BUY', 'SELL')),
  constraint trade_orders_units_positive      check (units > 0),
  constraint trade_orders_quoted_positive     check (quoted_price_cents is null or quoted_price_cents > 0),
  constraint trade_orders_fill_positive       check (fill_price_cents > 0),
  constraint trade_orders_gross_is_notional   check (gross_cents = units * fill_price_cents),
  constraint trade_orders_units_split         check (opened_units >= 0 and closed_units >= 0 and opened_units + closed_units <= units),
  constraint trade_orders_balance_nonneg      check (balance_after_cents is null or balance_after_cents >= 0)
);

create index trade_orders_user_created_idx   on public.trade_orders (user_id, created_at desc, id desc);
create index trade_orders_person_created_idx on public.trade_orders (person_id, created_at desc, id desc);

comment on table  public.trade_orders is 'Every accepted order: what was asked, what the server filled it at, how it split into units opened and units closed. Integer cents and units.';
comment on column public.trade_orders.quoted_price_cents is 'The price the client displayed when the user confirmed, for the tolerance check. Never the fill price.';
comment on column public.trade_orders.fill_price_cents   is 'The server-read quote the order filled at, in cents per unit.';

create table public.position_closes (
  id                uuid        primary key default gen_random_uuid(),
  order_id          uuid        not null references public.trade_orders (id) on delete cascade,
  position_id       uuid        not null references public.positions (id)    on delete cascade,
  user_id           uuid        not null references public.users (id)        on delete cascade,
  person_id         uuid        not null references public.people (id)       on delete restrict,
  direction         text        not null,
  units             bigint      not null,
  entry_price_cents bigint      not null,
  exit_price_cents  bigint      not null,
  cost_cents        bigint      not null,
  proceeds_cents    bigint      not null,
  pnl_cents         bigint      not null,
  closed_at         timestamptz not null default now(),

  constraint position_closes_direction_check  check (direction in ('HIGH', 'LOW')),
  constraint position_closes_units_positive   check (units > 0),
  constraint position_closes_prices_positive  check (entry_price_cents > 0 and exit_price_cents > 0),
  constraint position_closes_cost_is_product  check (cost_cents = units * entry_price_cents),
  constraint position_closes_proceeds_nonneg  check (proceeds_cents >= 0),
  constraint position_closes_pnl_is_fifo      check (
    pnl_cents = case when direction = 'HIGH' then (exit_price_cents - entry_price_cents) * units
                                              else (entry_price_cents - exit_price_cents) * units end
  )
);

create index position_closes_user_closed_idx   on public.position_closes (user_id, closed_at desc, id desc);
create index position_closes_person_closed_idx on public.position_closes (person_id, closed_at desc, id desc);
create index position_closes_position_id_idx   on public.position_closes (position_id);
create index position_closes_order_id_idx      on public.position_closes (order_id);

comment on table public.position_closes is 'Realized P&L, one row per lot touched by a close: FIFO, integer cents, the arithmetic enforced by check.';

alter table public.positions
  add constraint positions_order_id_fkey foreign key (order_id) references public.trade_orders (id) on delete set null;
create index positions_order_id_idx on public.positions (order_id);

alter table public.transactions
  add column order_id uuid references public.trade_orders (id) on delete set null;
create index transactions_order_id_idx on public.transactions (order_id);

-- RLS: clients read their own rows; every write is here.
alter table public.trade_orders    enable row level security;
alter table public.position_closes enable row level security;

create policy trade_orders_select_own
  on public.trade_orders for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy position_closes_select_own
  on public.position_closes for select
  to authenticated
  using ((select auth.uid()) = user_id);

grant select on public.trade_orders, public.position_closes to authenticated;
grant all    on public.trade_orders, public.position_closes to service_role;
revoke insert, update, delete on public.trade_orders, public.position_closes from anon, authenticated;

-- Exposure, in units and in cents ----------------------------------------------------
create or replace function public.net_position_cents(p_user_id uuid, p_person_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(case when p.direction = 'HIGH' then p.open_units * p.entry_price_cents
                                                     else -(p.open_units * p.entry_price_cents) end), 0)::bigint
    from public.positions p
   where p.user_id = p_user_id
     and p.person_id = p_person_id
     and p.is_open;
$$;

comment on function public.net_position_cents(uuid, uuid) is
  'A user''s net exposure on a person in integer cents at entry prices: open HIGH cost minus open LOW cost. Negative means net short.';

create or replace function public.net_position_units(p_user_id uuid, p_person_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(case when p.direction = 'HIGH' then p.open_units else -p.open_units end), 0)::bigint
    from public.positions p
   where p.user_id = p_user_id
     and p.person_id = p_person_id
     and p.is_open;
$$;

comment on function public.net_position_units(uuid, uuid) is
  'A user''s net position on a person in units: open HIGH units minus open LOW units.';

revoke execute on function public.net_position_units(uuid, uuid) from public, anon;
grant  execute on function public.net_position_units(uuid, uuid) to authenticated, service_role;

-- Quotes ----------------------------------------------------------------------------------
-- The one conversion from points to money: round to the nearest cent.
create or replace function public.points_to_cents(p_points numeric)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select round(p_points * 100)::bigint;
$$;

comment on function public.points_to_cents(numeric) is
  'One score point is one dollar: a quote in points becomes integer cents per unit, rounded half away from zero. The only rounding step in the trading arithmetic.';

grant execute on function public.points_to_cents(numeric) to authenticated, service_role;

create or replace function public.cents_to_dollars_text(p_cents bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_cents < 0 then '-' else '' end || to_char(abs(p_cents) / 100.0, 'FM9,999,999,999,990.00');
$$;

grant execute on function public.cents_to_dollars_text(bigint) to authenticated, service_role;

create or replace function public.trade_quote(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'person_id',  p.id,
           'score',      p.current_score,
           'spread',     p.spread,
           'buy_cents',  public.points_to_cents(p.buy_price),
           'sell_cents', public.points_to_cents(p.sell_price),
           'tolerance_cents', (select s.price_tolerance_cents from public.platform_settings s where s.id),
           'as_of',      now()
         )
    from public.people p
   where p.id = p_person_id
     and p.is_active;
$$;

comment on function public.trade_quote(uuid) is
  'The current Buy and Sell quotes for a person in integer cents per unit, as the server reads them. Null for an unknown or inactive person.';

revoke execute on function public.trade_quote(uuid) from public, anon;
grant  execute on function public.trade_quote(uuid) to authenticated, service_role;

-- Position summary --------------------------------------------------------------------
-- What the interface shows for a user's position on a person: open units,
-- cost, the weighted-average entry price (display only), the mark at the
-- quote the position would close at, unrealized and realized P&L. Definer
-- rights; the authenticated wrapper below binds it to the caller.
create or replace function public.position_summary_for(p_user_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_direction   text;
  v_units       bigint := 0;
  v_cost        bigint := 0;
  v_lots        integer := 0;
  v_oldest      timestamptz;
  v_newest      timestamptz;
  v_mark        bigint;
  v_value       bigint;
  v_unrealized  bigint;
  v_realized    bigint;
  v_buy_cents   bigint;
  v_sell_cents  bigint;
begin
  select public.points_to_cents(p.buy_price), public.points_to_cents(p.sell_price)
    into v_buy_cents, v_sell_cents
    from public.people p
   where p.id = p_person_id;

  select l.direction, sum(l.open_units), sum(l.open_units * l.entry_price_cents), count(*), min(l.opened_at), max(l.opened_at)
    into v_direction, v_units, v_cost, v_lots, v_oldest, v_newest
    from public.positions l
   where l.user_id = p_user_id
     and l.person_id = p_person_id
     and l.is_open
   group by l.direction
   order by sum(l.open_units) desc
   limit 1;

  select coalesce(sum(c.pnl_cents), 0)
    into v_realized
    from public.position_closes c
   where c.user_id = p_user_id
     and c.person_id = p_person_id;

  if v_direction is null then
    return jsonb_build_object(
      'person_id', p_person_id, 'direction', null, 'open_units', 0, 'cost_cents', 0, 'avg_entry_cents', null,
      'lots', 0, 'oldest_opened_at', null, 'newest_opened_at', null,
      'mark_price_cents', v_sell_cents, 'value_cents', 0, 'unrealized_pnl_cents', 0, 'realized_pnl_cents', v_realized
    );
  end if;

  -- A HIGH position closes at the Sell quote, a LOW one at the Buy quote.
  v_mark := case when v_direction = 'HIGH' then v_sell_cents else v_buy_cents end;
  v_value := v_units * v_mark;
  v_unrealized := case when v_direction = 'HIGH' then v_value - v_cost else v_cost - v_value end;

  return jsonb_build_object(
    'person_id', p_person_id,
    'direction', v_direction,
    'open_units', v_units,
    'cost_cents', v_cost,
    'avg_entry_cents', round(v_cost::numeric / v_units)::bigint,
    'lots', v_lots,
    'oldest_opened_at', v_oldest,
    'newest_opened_at', v_newest,
    'mark_price_cents', v_mark,
    'value_cents', v_value,
    'unrealized_pnl_cents', v_unrealized,
    'realized_pnl_cents', v_realized
  );
end;
$$;

comment on function public.position_summary_for(uuid, uuid) is
  'Service-role view of one user''s position on one person: open units, cost, weighted-average entry (display only), mark at the closing quote, unrealized and realized P&L. Integer cents.';

revoke execute on function public.position_summary_for(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.position_summary_for(uuid, uuid) to service_role;

create or replace function public.my_position(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then null else public.position_summary_for(auth.uid(), p_person_id) end;
$$;

comment on function public.my_position(uuid) is 'The signed-in user''s position summary on a person (see position_summary_for).';

revoke execute on function public.my_position(uuid) from public, anon;
grant  execute on function public.my_position(uuid) to authenticated;

-- Rejections ------------------------------------------------------------------------
-- Every refusal is a value, not an exception: the checks all run before any
-- write, so there is nothing to roll back, and the caller gets a code, a
-- human sentence and the current quote to re-confirm against.
create or replace function public.trade_rejection(p_code text, p_message text, p_quote jsonb, p_extra jsonb default '{}'::jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message', p_message, 'quote', p_quote) || coalesce(p_extra, '{}'::jsonb);
$$;

revoke execute on function public.trade_rejection(text, text, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function public.trade_rejection(text, text, jsonb, jsonb) to service_role;

-- place_order -------------------------------------------------------------------------
create or replace function public.place_order(
  p_person_id          uuid,
  p_side               text,
  p_units              bigint,
  p_quoted_price_cents bigint default null,
  p_surface            text   default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id          uuid := auth.uid();
  v_now              timestamptz := now();
  v_settings         public.platform_settings%rowtype;
  v_wallet           bigint;
  v_person           record;
  v_buy_cents        bigint;
  v_sell_cents       bigint;
  v_price_cents      bigint;
  v_quote            jsonb;
  v_close_direction  text;
  v_open_direction   text;
  v_closable_units   bigint;
  v_close_units      bigint;
  v_open_units       bigint;
  v_same_side_units  bigint;
  v_total_side_units bigint;
  v_daily_closed     bigint;
  v_cooldown_wait    numeric;
  v_cost             bigint := 0;
  v_order_id         uuid;
  v_lot              record;
  v_remaining        bigint;
  v_take             bigint;
  v_pnl              bigint;
  v_lot_proceeds     bigint;
  v_total_proceeds   bigint := 0;
  v_total_pnl        bigint := 0;
  v_closed_units     bigint := 0;
  v_position_id      uuid;
  v_balance_after    bigint;
  v_fills            jsonb := '[]'::jsonb;
begin
  -- The actor is always the signed-in user, never a parameter.
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'p_side must be BUY or SELL' using errcode = '22023';
  end if;
  if p_units is null or p_units <= 0 then
    raise exception 'p_units must be a positive integer number of units' using errcode = '22023';
  end if;
  if p_quoted_price_cents is not null and p_quoted_price_cents <= 0 then
    raise exception 'p_quoted_price_cents must be a positive integer number of cents' using errcode = '22023';
  end if;

  select * into v_settings from public.platform_settings s where s.id;

  -- Serialise this user's orders: the wallet row is the lock. Two orders
  -- from the same user run one after the other and each sees the balance
  -- the previous one left.
  select u.wallet_balance_cents into v_wallet
    from public.users u
   where u.id = v_user_id
     for update;
  if not found then
    raise exception 'No wallet for user %', v_user_id using errcode = 'P0002';
  end if;

  -- Lock the person so the quote cannot move under this order, then read it.
  select p.id, p.display_name, p.is_active, p.current_score, p.spread, p.buy_price, p.sell_price
    into v_person
    from public.people p
   where p.id = p_person_id
     for update;
  if not found or not v_person.is_active then
    return public.trade_rejection('unknown_person', 'That person is not on the board.', null);
  end if;

  v_buy_cents   := public.points_to_cents(v_person.buy_price);
  v_sell_cents  := public.points_to_cents(v_person.sell_price);
  v_price_cents := case when p_side = 'BUY' then v_buy_cents else v_sell_cents end;
  v_quote := jsonb_build_object(
    'person_id', v_person.id, 'score', v_person.current_score, 'spread', v_person.spread,
    'buy_cents', v_buy_cents, 'sell_cents', v_sell_cents,
    'tolerance_cents', v_settings.price_tolerance_cents, 'as_of', v_now
  );
  if v_price_cents <= 0 then
    return public.trade_rejection('no_quote', format('%s has no tradeable quote right now.', v_person.display_name), v_quote);
  end if;

  -- The tolerance band: never fill at a price the user has not seen.
  if p_quoted_price_cents is not null and abs(v_price_cents - p_quoted_price_cents) > v_settings.price_tolerance_cents then
    return public.trade_rejection(
      'price_moved',
      format('The price moved. %s now fills at $%s per share, not $%s.',
             case when p_side = 'BUY' then 'Buy' else 'Sell' end,
             public.cents_to_dollars_text(v_price_cents),
             public.cents_to_dollars_text(p_quoted_price_cents)),
      v_quote,
      jsonb_build_object('fill_price_cents', v_price_cents, 'quoted_price_cents', p_quoted_price_cents)
    );
  end if;

  -- Netting, in units: an order first closes the opposite side, then opens its own.
  v_close_direction := case when p_side = 'BUY' then 'LOW' else 'HIGH' end;
  v_open_direction  := case when p_side = 'BUY' then 'HIGH' else 'LOW' end;

  select coalesce(sum(l.open_units), 0) into v_closable_units
    from public.positions l
   where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction;

  v_close_units := least(p_units, v_closable_units);
  v_open_units  := p_units - v_close_units;

  -- THE GATE: a Sell may only open LOW when shorting is on.
  if p_side = 'SELL' and v_open_units > 0 and not coalesce(v_settings.shorting_enabled, false) then
    return public.trade_rejection(
      'exceeds_position',
      case when v_closable_units = 0
           then format('You hold no shares of %s. There is nothing to close.', v_person.display_name)
           else format('You hold %s %s of %s. A Sell can close at most that many.',
                       v_closable_units, case when v_closable_units = 1 then 'share' else 'shares' end, v_person.display_name) end,
      v_quote,
      jsonb_build_object('max_units', v_closable_units)
    );
  end if;

  -- RISK LEVER 4 — round-trip guard on the lots this close would touch (FIFO).
  if v_close_units > 0 and v_settings.close_cooldown_seconds > 0 then
    select max(extract(epoch from (t.opened_at + make_interval(secs => v_settings.close_cooldown_seconds) - v_now)))
      into v_cooldown_wait
      from (
        select l.opened_at,
               coalesce(sum(l.open_units) over (order by l.opened_at, l.id rows between unbounded preceding and 1 preceding), 0) as units_before
          from public.positions l
         where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction
      ) t
     where t.units_before < v_close_units
       and t.opened_at > v_now - make_interval(secs => v_settings.close_cooldown_seconds);
    if v_cooldown_wait is not null and v_cooldown_wait > 0 then
      return public.trade_rejection(
        'cooldown',
        format('You opened this position moments ago. Wait %s more %s before closing it.',
               ceil(v_cooldown_wait)::integer, case when ceil(v_cooldown_wait) = 1 then 'second' else 'seconds' end),
        v_quote,
        jsonb_build_object('wait_seconds', ceil(v_cooldown_wait)::integer)
      );
    end if;
  end if;

  -- RISK LEVER 3 — daily close value.
  if v_close_units > 0 then
    select coalesce(sum(c.proceeds_cents), 0) into v_daily_closed
      from public.position_closes c
     where c.user_id = v_user_id and c.closed_at > v_now - interval '24 hours';
    if v_daily_closed + v_close_units * v_price_cents > v_settings.max_daily_close_cents then
      return public.trade_rejection(
        'daily_limit',
        format('Daily close limit reached: $%s of $%s closed in the last 24 hours.',
               public.cents_to_dollars_text(v_daily_closed), public.cents_to_dollars_text(v_settings.max_daily_close_cents)),
        v_quote,
        jsonb_build_object('closed_today_cents', v_daily_closed, 'limit_cents', v_settings.max_daily_close_cents)
      );
    end if;
  end if;

  if v_open_units > 0 then
    select coalesce(sum(l.open_units), 0) into v_same_side_units
      from public.positions l
     where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_open_direction;

    -- RISK LEVER 1 — units per user per person.
    if v_same_side_units + v_open_units > v_settings.max_units_per_person then
      return public.trade_rejection(
        'max_units',
        format('That would take you past the limit of %s shares of one person.', v_settings.max_units_per_person),
        v_quote,
        jsonb_build_object('limit_units', v_settings.max_units_per_person, 'held_units', v_same_side_units)
      );
    end if;

    -- RISK LEVER 2 — share of open interest on the person.
    select coalesce(sum(l.open_units), 0) into v_total_side_units
      from public.positions l
     where l.person_id = p_person_id and l.is_open and l.direction = v_open_direction;
    if (v_same_side_units + v_open_units)::numeric / (v_total_side_units + v_open_units)::numeric > v_settings.max_open_interest_share then
      return public.trade_rejection(
        'open_interest',
        format('That would give you more than %s%% of all open shares of %s.',
               round(v_settings.max_open_interest_share * 100), v_person.display_name),
        v_quote,
        jsonb_build_object('limit_share', v_settings.max_open_interest_share)
      );
    end if;

    -- THE BALANCE. Cost is units × price, integer; the wallet must cover it
    -- before any proceeds from the closing half are counted.
    v_cost := v_open_units * v_price_cents;
    if v_cost > v_wallet then
      return public.trade_rejection(
        'insufficient_balance',
        format('%s %s cost $%s. Your paper balance is $%s, enough for %s.',
               v_open_units, case when v_open_units = 1 then 'share costs' else 'shares' end,
               public.cents_to_dollars_text(v_cost), public.cents_to_dollars_text(v_wallet),
               case when v_wallet / v_price_cents = 1 then '1 share' else format('%s shares', v_wallet / v_price_cents) end),
        v_quote,
        jsonb_build_object('cost_cents', v_cost, 'balance_cents', v_wallet, 'max_units', v_wallet / v_price_cents)
      );
    end if;
  end if;

  -- Every check has passed. From here everything is one transaction. --------
  insert into public.trade_orders (user_id, person_id, side, units, quoted_price_cents, fill_price_cents, gross_cents, surface, created_at)
  values (v_user_id, p_person_id, p_side, p_units, p_quoted_price_cents, v_price_cents, p_units * v_price_cents, left(p_surface, 40), v_now)
  returning id into v_order_id;

  -- Closes, FIFO: the oldest lot first, partially where the order runs out.
  v_remaining := v_close_units;
  for v_lot in
    select l.id, l.open_units, l.entry_price_cents, l.direction
      from public.positions l
     where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction
     order by l.opened_at, l.id
       for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_lot.open_units, v_remaining);
    v_pnl  := case when v_lot.direction = 'HIGH' then (v_price_cents - v_lot.entry_price_cents) * v_take
                                                 else (v_lot.entry_price_cents - v_price_cents) * v_take end;
    v_lot_proceeds := greatest(v_lot.entry_price_cents * v_take + v_pnl, 0);

    insert into public.position_closes (order_id, position_id, user_id, person_id, direction, units, entry_price_cents, exit_price_cents, cost_cents, proceeds_cents, pnl_cents, closed_at)
    values (v_order_id, v_lot.id, v_user_id, p_person_id, v_lot.direction, v_take, v_lot.entry_price_cents, v_price_cents, v_lot.entry_price_cents * v_take, v_lot_proceeds, v_pnl, v_now);

    update public.positions
       set open_units = open_units - v_take,
           is_open    = (open_units - v_take) > 0,
           closed_at  = case when open_units - v_take = 0 then v_now else closed_at end
     where id = v_lot.id;

    v_fills := v_fills || jsonb_build_object('position_id', v_lot.id, 'units', v_take, 'entry_price_cents', v_lot.entry_price_cents, 'pnl_cents', v_pnl, 'proceeds_cents', v_lot_proceeds);
    v_total_proceeds := v_total_proceeds + v_lot_proceeds;
    v_total_pnl      := v_total_pnl + v_pnl;
    v_closed_units   := v_closed_units + v_take;
    v_remaining      := v_remaining - v_take;
  end loop;

  if v_remaining <> 0 then
    -- Cannot happen under the wallet lock; if it ever does, nothing above survives.
    raise exception 'place_order: open lots changed while the order was running' using errcode = '40001';
  end if;

  -- Open, at the snapshotted price.
  if v_open_units > 0 then
    insert into public.positions (user_id, person_id, direction, amount_cents, entry_score, units, open_units, entry_price_cents, order_id, opened_at)
    values (v_user_id, p_person_id, v_open_direction, v_cost, v_price_cents::numeric / 100, v_open_units, v_open_units, v_price_cents, v_order_id, v_now)
    returning id into v_position_id;

    insert into public.transactions (user_id, type, amount_cents, person_id, order_id, created_at)
    values (v_user_id, 'ALLOCATION', v_cost, p_person_id, v_order_id, v_now);
  end if;

  if v_total_proceeds > 0 then
    insert into public.transactions (user_id, type, amount_cents, person_id, order_id, created_at)
    values (v_user_id, 'REDEMPTION', v_total_proceeds, p_person_id, v_order_id, v_now);
  end if;

  -- The balance: debit the cost, credit the proceeds. users_wallet_balance_nonneg is the backstop.
  update public.users
     set wallet_balance_cents = wallet_balance_cents - v_cost + v_total_proceeds,
         buying_power_cents   = wallet_balance_cents - v_cost + v_total_proceeds
   where id = v_user_id
   returning wallet_balance_cents into v_balance_after;

  -- The tape the Trading Activity force reads: notional, in cents.
  insert into public.trade_events (person_id, user_id, side, amount_cents, created_at)
  values (p_person_id, v_user_id, p_side, p_units * v_price_cents, v_now);

  update public.trade_orders
     set opened_units = v_open_units, closed_units = v_closed_units, realized_pnl_cents = v_total_pnl, balance_after_cents = v_balance_after
   where id = v_order_id;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'id', v_order_id, 'person_id', p_person_id, 'side', p_side, 'units', p_units,
      'fill_price_cents', v_price_cents, 'gross_cents', p_units * v_price_cents,
      'opened_units', v_open_units, 'opened_direction', case when v_open_units > 0 then v_open_direction end,
      'position_id', v_position_id, 'cost_cents', v_cost,
      'closed_units', v_closed_units, 'proceeds_cents', v_total_proceeds, 'realized_pnl_cents', v_total_pnl,
      'fills', v_fills, 'created_at', v_now
    ),
    'balance_cents', v_balance_after,
    'position', public.position_summary_for(v_user_id, p_person_id),
    'quote', v_quote
  );
end;
$$;

comment on function public.place_order(uuid, text, bigint, bigint, text) is
  'THE order RPC. Buy or Sell p_units of a person for the signed-in user at the server-read quote: tolerance check against p_quoted_price_cents, netting (close the opposite side FIFO, open the rest), the shorting gate, the four risk levers, the balance, then one atomic write of order, closes, lot, ledger, tape and balance. Returns {ok:true,...} or {ok:false, code, message, quote}.';

revoke execute on function public.place_order(uuid, text, bigint, bigint, text) from public, anon;
grant  execute on function public.place_order(uuid, text, bigint, bigint, text) to authenticated;

-- reset_paper_balance -------------------------------------------------------------------
-- Admin only. A user can never reset themselves: a self-serve reset teaches
-- that losses do not matter and destroys the behavioural signal. Refuses
-- while positions are open, so a reset never strands a lot.
create or replace function public.reset_paper_balance(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target  bigint := public.starting_balance_cents();
  v_current bigint;
  v_open    bigint;
begin
  select u.wallet_balance_cents into v_current from public.users u where u.id = p_user_id for update;
  if not found then
    raise exception 'No wallet for user %', p_user_id using errcode = 'P0002';
  end if;
  select count(*) into v_open from public.positions l where l.user_id = p_user_id and l.is_open;
  if v_open > 0 then
    raise exception 'reset_paper_balance: user % has % open lot(s); close them first', p_user_id, v_open using errcode = 'P0001';
  end if;

  if v_target > v_current then
    insert into public.transactions (user_id, type, amount_cents) values (p_user_id, 'DEPOSIT', v_target - v_current);
  elsif v_target < v_current then
    insert into public.transactions (user_id, type, amount_cents) values (p_user_id, 'WITHDRAWAL', v_current - v_target);
  end if;

  update public.users set wallet_balance_cents = v_target, buying_power_cents = v_target where id = p_user_id;

  return jsonb_build_object('user_id', p_user_id, 'balance_before_cents', v_current, 'balance_after_cents', v_target);
end;
$$;

comment on function public.reset_paper_balance(uuid) is
  'Service-role only: returns a user''s paper balance to starting_balance_cents() through the ledger. Refuses while any lot is open. Users cannot call this.';

revoke execute on function public.reset_paper_balance(uuid) from public, anon, authenticated;
grant  execute on function public.reset_paper_balance(uuid) to service_role;
