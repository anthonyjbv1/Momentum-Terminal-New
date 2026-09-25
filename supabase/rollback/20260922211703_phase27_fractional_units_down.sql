-- ROLLBACK for Phase 27 — units go back to being whole shares.
--
-- NOT under supabase/migrations/, so nothing applies it by accident. It is
-- here so that "reversible" is a file somebody can read and run, not a claim.
--
-- WHAT IT CANNOT UNDO. A thousandth of a share has no whole-share
-- counterpart: if anyone has traded a fraction, reversing the scale would
-- either destroy the fraction or misstate the holding, and there is no third
-- answer. So the first thing this file does is refuse to run in that case,
-- loudly, having changed nothing. Run it while every quantity is still a
-- whole number of shares, or not at all.
--
-- Everything else is exactly Phase 27 backwards: the quantities divide by
-- 1000, the basis column and the two transition columns go, the constraints
-- come back in their product form, and each function is restored to the text
-- of the migration that last defined it before Phase 27 —
-- 20260911200110_trading_flow.sql and 20260912153309_portfolio.sql — copied
-- from those files rather than retyped, so a rollback cannot quietly install
-- a third version of anything.
--
-- The same lock, for the same reason as the migration: the Engine reads these
-- tables every 30 seconds and must never see rescaled rows through a function
-- that has not been rescaled with them.

set local lock_timeout = '5s';
lock table public.positions, public.position_closes, public.trade_orders, public.platform_settings in access exclusive mode;

-- ---------------------------------------------------------------------------
-- 0. Refuse if Phase 29 is applied, or if any fraction of a share exists
-- ---------------------------------------------------------------------------

-- PHASE 29 SUPERSEDES THIS FILE. The market price migration renamed
-- positions.entry_score, replaced the flat CHECK constraints this file
-- restores with the cost-curve identities, and gave place_order() an eighth
-- argument. Running this on a Phase 29 schema would reinstall the flat
-- functions over curve-priced rows, so it refuses, having changed nothing.
-- Reverse Phase 29 first with its own down file,
-- 20260925012938_phase29_market_price_down.sql (Phase 29b); that leaves the
-- Phase 28 schema this file was written for, and it applies again (tested in
-- lib/trading/phase29-down.db.test.ts).
do $phase29$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'people' and column_name = 'premium_cents') then
    raise exception 'Phase 27 rollback refused: Phase 29 (the market price) is applied and supersedes this file.'
      using errcode = '22023';
  end if;
end
$phase29$;

do $guard$
begin
  if exists (select 1 from public.positions       where units % 1000 <> 0 or open_units % 1000 <> 0)
  or exists (select 1 from public.position_closes where units % 1000 <> 0)
  or exists (select 1 from public.trade_orders    where units % 1000 <> 0 or opened_units % 1000 <> 0 or closed_units % 1000 <> 0)
  then
    raise exception 'Phase 27 rollback refused: fractional quantities exist. Reversing the scale here would destroy or misstate them.'
      using errcode = '22023';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The constraints that go through the Phase 27 rule
-- ---------------------------------------------------------------------------

alter table public.positions       drop constraint if exists positions_amount_is_cost;
alter table public.positions       drop constraint if exists positions_open_cost_range;
alter table public.positions       drop constraint if exists positions_open_cost_state;
alter table public.trade_orders    drop constraint if exists trade_orders_gross_is_notional;
alter table public.trade_orders    drop constraint if exists trade_orders_requested_spend_positive;
alter table public.trade_orders    drop constraint if exists trade_orders_quantity_scale_check;
alter table public.position_closes drop constraint if exists position_closes_cost_nonneg;
alter table public.position_closes drop constraint if exists position_closes_pnl_is_basis;
alter table public.platform_settings drop constraint if exists platform_settings_min_order_positive;

-- ---------------------------------------------------------------------------
-- 2. Back to whole shares
-- ---------------------------------------------------------------------------

update public.positions       set units = units / 1000, open_units = open_units / 1000;
update public.position_closes set units = units / 1000;
update public.trade_orders    set units = units / 1000, opened_units = opened_units / 1000, closed_units = closed_units / 1000;
update public.platform_settings set max_units_per_person = max_units_per_person / 1000, updated_at = now() where id;

alter table public.positions    drop column if exists open_cost_cents;
alter table public.trade_orders drop column if exists requested_spend_cents;
alter table public.trade_orders drop column if exists quantity_scale;
alter table public.platform_settings drop column if exists min_order_cents;

-- ---------------------------------------------------------------------------
-- 3. The constraints, in their pre-Phase-27 product form
-- ---------------------------------------------------------------------------

alter table public.positions
  add constraint positions_amount_is_cost check (amount_cents = units * entry_price_cents);

alter table public.trade_orders
  add constraint trade_orders_gross_is_notional check (gross_cents = units * fill_price_cents);

alter table public.position_closes
  add constraint position_closes_cost_is_product check (cost_cents = units * entry_price_cents),
  add constraint position_closes_pnl_is_fifo check (
    pnl_cents = case when direction = 'HIGH' then (exit_price_cents - entry_price_cents) * units
                                             else (entry_price_cents - exit_price_cents) * units end
  );

-- ---------------------------------------------------------------------------
-- 4. The functions, as they were
-- ---------------------------------------------------------------------------
-- The seven-argument place_order and the two-column-wider history pair have to
-- go by name: neither can be replaced by a definition with a different
-- signature or row type.

drop function if exists public.place_order(uuid, text, bigint, bigint, text, bigint, text);
drop function if exists public.my_trade_history(timestamptz, uuid, integer);
drop function if exists public.trade_history_for(uuid, timestamptz, uuid, integer);

-- Verbatim from 20260911200110_trading_flow.sql: net_position_cents,
-- position_summary_for, place_order.
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

-- Verbatim from 20260912153309_portfolio.sql: portfolio_value_cents,
-- portfolio_summary_for, trade_history_for, my_trade_history.
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

-- ---------------------------------------------------------------------------
-- 5. The Phase 27 vocabulary itself
-- ---------------------------------------------------------------------------
-- Last, because until this point the constraints and function bodies above
-- still referred to them.

drop function if exists public.shares_label(bigint);
drop function if exists public.shares_text(bigint);
drop function if exists public.units_cost_cents(bigint, bigint);
drop function if exists public.units_proceeds_cents(bigint, bigint);
drop function if exists public.units_per_share();
