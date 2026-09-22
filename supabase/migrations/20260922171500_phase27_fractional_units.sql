-- Phase 27 — FRACTIONAL SHARES: units become THOUSANDTHS of a share.
--
-- Money has always been integer cents here and stays integer cents. Quantity
-- has always been integer units and stays integer units; what changes is what
-- one unit means. Until now 1 unit = 1 share. From here 1 unit = 1/1000 of a
-- share, so 0.001 share is the smallest tradeable quantity and nothing in the
-- schema has to hold a fraction. No column becomes floating point, and the
-- no-floats test is extended to say so.
--
-- WHY A SCALED INTEGER RATHER THAN A DECIMAL. A numeric(18,3) would also hold
-- thousandths, but then every sum, every CHECK and every comparison in the
-- ledger would be numeric arithmetic, and the one property this schema has
-- always leaned on — that quantities are exact and associative — would depend
-- on a scale declaration staying right in twenty places. Integers cannot
-- drift. The conversion to money is the only place a fraction appears, and it
-- is resolved to a whole cent immediately, by a rule stated once.
--
-- THE ROUNDING RULE — THE PLATFORM NEVER CREATES MONEY.
--
--   a BUY's cost      rounds UP   to the cent   units_cost_cents()
--   a SELL's proceeds round DOWN  to the cent   units_proceeds_cents()
--
-- At most one cent per trade, always in the platform's favour, never the
-- user's. Both directions live in ONE function each, and every other place
-- that turns a quantity into money calls them — place_order(), the read
-- functions, and the CHECK constraints that police the stored rows. Changing
-- the policy is changing these two function bodies and nothing else, which is
-- deliberate: the rule is going to counsel and may come back different.
--
-- WHAT IS NOT CHANGING. The quote is still a flat, server-snapshotted price
-- in cents per share, read inside the order under the same locks, checked
-- against the same tolerance band. The LMSR in lib/engine/spread.ts sets the
-- per-person SPREAD and is untouched; there is no per-order cost curve, so
-- cost stays linear in quantity and a whole-share order prices exactly as it
-- did yesterday.
--
-- THE LOT BASIS. A sell may now consume part of a lot, so a lot carries
-- open_cost_cents: the cents of its original cost not yet realised. A partial
-- close takes floor(take ÷ open_units × open_cost_cents) and the final close
-- takes the exact remainder, so the closes of a lot sum to its amount_cents
-- to the cent, for ever, and realized P&L is proceeds − basis by definition
-- rather than by a formula that can round apart.
--
-- REVERSIBILITY: supabase/rollback/20260922171500_phase27_fractional_units_down.sql
-- restores whole-share units and the pre-Phase-27 functions. It is outside
-- supabase/migrations/ so it is never applied automatically.

-- ---------------------------------------------------------------------------
-- 0. Take the locks up front
-- ---------------------------------------------------------------------------
-- The Engine ticks every 30 seconds and its tick READS these tables: the open
-- capital behind the LMSR spread and the Conviction force comes from
-- positions.amount_cents, and apply_engine_tick() calls snapshot_portfolios(),
-- which calls portfolio_value_cents(), which reads positions.open_units.
--
-- Nothing here changes amount_cents, so the spread and Conviction are blind to
-- this migration. portfolio_value_cents IS rescaled, and its rewrite and the
-- data it reads must never be visible apart — a tick that saw rescaled rows
-- through the old function would write a portfolio value a thousand times too
-- large into portfolio_history and there is no undo for a recorded snapshot.
--
-- DDL is transactional in Postgres, so the whole file commits or none of it
-- does. Taking every lock in the first statement makes that guarantee explicit
-- rather than emergent: from here the Engine's reader waits, once, for the
-- whole migration rather than queueing behind each ALTER in turn. Measured at
-- 16 ms over production's row counts, so what it waits is one tick's slack.
--
-- lock_timeout means a migration that cannot get the locks gives up instead of
-- queueing ahead of every reader behind it, and all three parts of that were
-- checked against this project before the file was applied:
--
--   * the server's own lock_timeout is 0 — infinite — so the line below is
--     doing real work rather than restating a default;
--   * SET LOCAL is still in force for the next statement, which is only true
--     inside a transaction block, so the whole file runs as one transaction;
--   * a deliberate failure part-way through a migration left neither the table
--     it had already created nor a row in the migration ledger.
--
-- So a lock this cannot take within five seconds aborts at statement two, with
-- the data and the schema exactly as they were and the migration unrecorded.
set local lock_timeout = '5s';
lock table public.positions, public.position_closes, public.trade_orders, public.platform_settings in access exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. The scale, and the two rounding directions
-- ---------------------------------------------------------------------------

create or replace function public.units_per_share()
  returns bigint
  language sql
  immutable
  set search_path = ''
as $$ select 1000::bigint $$;

comment on function public.units_per_share() is
  'Phase 27: units are thousandths of a share. The one place the scale is written in SQL; lib/trading/model.ts mirrors it as UNITS_PER_SHARE.';

create or replace function public.units_cost_cents(p_units bigint, p_price_cents bigint)
  returns bigint
  language sql
  immutable
  set search_path = ''
as $$
  -- WHAT A BUYER PAYS. Rounded UP to the cent: a fraction of a cent the
  -- platform cannot bill is a fraction the platform absorbs if it rounds the
  -- other way, and over enough orders that is money created out of rounding.
  select ceil(coalesce(p_units, 0)::numeric * coalesce(p_price_cents, 0)::numeric / 1000)::bigint;
$$;

create or replace function public.units_proceeds_cents(p_units bigint, p_price_cents bigint)
  returns bigint
  language sql
  immutable
  set search_path = ''
as $$
  -- WHAT A SELLER RECEIVES. Rounded DOWN to the cent, for the same reason in
  -- the other direction.
  select floor(coalesce(p_units, 0)::numeric * coalesce(p_price_cents, 0)::numeric / 1000)::bigint;
$$;

comment on function public.units_cost_cents(bigint, bigint) is
  'Phase 27 rounding rule: a buy''s cost, units x price per share / 1000, rounded UP to the cent. The platform never creates money.';
comment on function public.units_proceeds_cents(bigint, bigint) is
  'Phase 27 rounding rule: a sell''s proceeds, units x price per share / 1000, rounded DOWN to the cent. The platform never creates money.';

grant execute on function public.units_per_share()                  to authenticated, service_role;
grant execute on function public.units_cost_cents(bigint, bigint)     to authenticated, service_role;
grant execute on function public.units_proceeds_cents(bigint, bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Drop the constraints that assume 1 unit = 1 share
-- ---------------------------------------------------------------------------
-- Each of these says "money = units x price" with no scale and no rounding.
-- They have to come off before the data is scaled, and they come back below
-- in a form that goes through the rule.

alter table public.positions       drop constraint if exists positions_amount_is_cost;
alter table public.trade_orders    drop constraint if exists trade_orders_gross_is_notional;
alter table public.position_closes drop constraint if exists position_closes_cost_is_product;
alter table public.position_closes drop constraint if exists position_closes_pnl_is_fifo;

-- ---------------------------------------------------------------------------
-- 3. Scale every stored quantity
-- ---------------------------------------------------------------------------
-- Every unit quantity in the ledger, multiplied by exactly 1000. No money
-- column is touched here: a position worth $101.00 is worth $101.00 before
-- and after, and the reconciliation in the phase report proves it per user.

update public.positions       set units = units * 1000, open_units = open_units * 1000;
update public.position_closes set units = units * 1000;
update public.trade_orders    set units = units * 1000, opened_units = opened_units * 1000, closed_units = closed_units * 1000;

-- RISK LEVER 1 scales with the unit so its MEANING is unchanged: a ceiling of
-- 100,000 shares stays a ceiling of 100,000 shares. Leaving the number alone
-- would have silently tightened it by a factor of a thousand.
update public.platform_settings set max_units_per_person = max_units_per_person * 1000, updated_at = now() where id;

-- ---------------------------------------------------------------------------
-- 4. The lot basis
-- ---------------------------------------------------------------------------

alter table public.positions add column if not exists open_cost_cents bigint;

-- BACKFILL: what a lot originally cost, less the basis its closes have
-- already realised. For every lot that has never been closed this is simply
-- amount_cents; for a partially closed one it is the remainder. The invariant
-- the phase report reconciles: open_cost_cents + the lot's prior closes
-- always equals amount_cents.
update public.positions l
   set open_cost_cents = l.amount_cents
                       - coalesce((select sum(c.cost_cents) from public.position_closes c where c.position_id = l.id), 0);

alter table public.positions alter column open_cost_cents set not null;

alter table public.positions
  add constraint positions_open_cost_range check (open_cost_cents >= 0 and open_cost_cents <= amount_cents),
  add constraint positions_open_cost_state check ((open_cost_cents > 0) = (open_units > 0));

comment on column public.positions.open_cost_cents is
  'Phase 27: the cents of this lot''s cost not yet realised. A partial close takes floor(take / open_units x open_cost_cents); the final close takes the exact remainder, so a lot''s closes sum to amount_cents to the cent.';
comment on column public.positions.units      is 'Units the lot opened with, in THOUSANDTHS of a share (Phase 27). Never changes.';
comment on column public.positions.open_units is 'Units still open, in thousandths of a share. 0 once fully closed (then is_open is false).';

-- ---------------------------------------------------------------------------
-- 5. The constraints, back, through the rule
-- ---------------------------------------------------------------------------

alter table public.positions
  add constraint positions_amount_is_cost check (amount_cents = public.units_cost_cents(units, entry_price_cents));

alter table public.trade_orders
  add constraint trade_orders_gross_is_notional check (
    gross_cents = case when side = 'BUY' then public.units_cost_cents(units, fill_price_cents)
                                         else public.units_proceeds_cents(units, fill_price_cents) end
  );

alter table public.position_closes
  -- cost_cents is now an ALLOCATION of the lot's basis, not a product of the
  -- entry price, so the only thing that can be asserted about it is its range.
  add constraint position_closes_cost_nonneg check (cost_cents >= 0),
  -- P&L is what came back less what it cost. Definitional, both directions,
  -- and exact because both sides are already whole cents.
  add constraint position_closes_pnl_is_basis check (pnl_cents = proceeds_cents - cost_cents);

-- ---------------------------------------------------------------------------
-- 6. The minimum order
-- ---------------------------------------------------------------------------
-- A floor in money, not in quantity: at a $56 quote 0.001 of a share is 6
-- cents, which is not an order, it is a rounding artefact with a confirmation
-- screen. Lives beside the risk levers because it is one, and because policy
-- will want to move it without a deploy.

alter table public.platform_settings add column if not exists min_order_cents bigint not null default 100;
alter table public.platform_settings
  add constraint platform_settings_min_order_positive check (min_order_cents > 0);

comment on column public.platform_settings.min_order_cents is
  'Phase 27 RISK LEVER 5: the smallest order the platform accepts, in cents, in either Shares or Dollars mode. Ships at $1.00.';

-- ---------------------------------------------------------------------------
-- 7. The read path, under the rule
-- ---------------------------------------------------------------------------
--
-- EVERY PAYLOAD DECLARES ITS OWN SCALE. Each of the four payloads that carries
-- a quantity — position_summary_for(), portfolio_summary_for(),
-- trade_history_for() and the order object place_order() returns — now also
-- carries units_per_share, and the client divides by what it is told rather
-- than by what it assumes. A client that reads a payload without the field
-- treats the scale as 1, which is exactly what every payload written before
-- this migration means. That is what lets the interface ship BEFORE the data
-- moves: the same build reads both shapes correctly, so there is no instant at
-- which a holding of three shares can be printed as three thousand.

-- A lot's open exposure is now its un-realised basis: exact, and already
-- whole cents, so the net position needs no rounding at all.
create or replace function public.net_position_cents(p_user_id uuid, p_person_id uuid)
  returns bigint
  language sql
  stable
  set search_path = ''
as $$
  select coalesce(sum(case when p.direction = 'HIGH' then p.open_cost_cents else -p.open_cost_cents end), 0)::bigint
    from public.positions p
   where p.user_id = p_user_id
     and p.person_id = p_person_id
     and p.is_open;
$$;

create or replace function public.portfolio_value_cents(p_user_id uuid)
  returns bigint
  language sql
  stable
  security definer
  set search_path = ''
as $$
  -- Positions are marked at what closing them would RETURN, so the mark goes
  -- through the sell side of the rule.
  select (u.wallet_balance_cents
          + coalesce((select sum(public.units_proceeds_cents(l.open_units,
                                   case when l.direction = 'HIGH' then public.points_to_cents(p.sell_price)
                                                                  else public.points_to_cents(p.buy_price) end))
                        from public.positions l
                        join public.people p on p.id = l.person_id
                       where l.user_id = u.id
                         and l.is_open), 0))::bigint
    from public.users u
   where u.id = p_user_id;
$$;

create or replace function public.position_summary_for(p_user_id uuid, p_person_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
as $function$
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

  -- The basis is summed from open_cost_cents: the cents actually paid and not
  -- yet realised, not a re-multiplication of the entry price.
  select l.direction, sum(l.open_units), sum(l.open_cost_cents), count(*), min(l.opened_at), max(l.opened_at)
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
      'mark_price_cents', v_sell_cents, 'value_cents', 0, 'unrealized_pnl_cents', 0, 'realized_pnl_cents', v_realized,
      'units_per_share', public.units_per_share()
    );
  end if;

  -- A HIGH position closes at the Sell quote, a LOW one at the Buy quote.
  v_mark := case when v_direction = 'HIGH' then v_sell_cents else v_buy_cents end;
  v_value := public.units_proceeds_cents(v_units, v_mark);
  v_unrealized := case when v_direction = 'HIGH' then v_value - v_cost else v_cost - v_value end;

  return jsonb_build_object(
    'person_id', p_person_id,
    'direction', v_direction,
    'open_units', v_units,
    'cost_cents', v_cost,
    -- Per SHARE, not per unit: the figure the interface prints beside "avg".
    'avg_entry_cents', round(v_cost::numeric * public.units_per_share() / v_units)::bigint,
    'lots', v_lots,
    'oldest_opened_at', v_oldest,
    'newest_opened_at', v_newest,
    'mark_price_cents', v_mark,
    'value_cents', v_value,
    'unrealized_pnl_cents', v_unrealized,
    'realized_pnl_cents', v_realized,
    -- The scale open_units is expressed in. See the note at the head of 7.
    'units_per_share', public.units_per_share()
  );
end;
$function$;

-- A row set cannot gain a column through `create or replace`, so the history
-- pair is dropped and rebuilt to carry units_per_share alongside the three
-- quantities in each row. my_trade_history() goes with it: it returns
-- trade_history_for()'s row type and would otherwise be left describing a
-- shape that no longer exists.
drop function if exists public.my_trade_history(timestamptz, uuid, integer);
drop function if exists public.trade_history_for(uuid, timestamptz, uuid, integer);

create function public.trade_history_for(
  p_user_id   uuid,
  p_before    timestamptz default null,
  p_before_id uuid        default null,
  p_limit     integer     default 20
)
  returns table (
    id uuid, created_at timestamptz, side text, units bigint, fill_price_cents bigint, gross_cents bigint,
    opened_units bigint, closed_units bigint, cost_cents bigint, proceeds_cents bigint, realized_pnl_cents bigint,
    balance_after_cents bigint, surface text, person_id uuid, person_slug text, person_name text,
    person_category text, person_avatar text, units_per_share bigint
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
         public.units_cost_cents(o.opened_units, o.fill_price_cents) as cost_cents,
         coalesce((select sum(c.proceeds_cents) from public.position_closes c where c.order_id = o.id), 0)::bigint as proceeds_cents,
         o.realized_pnl_cents,
         o.balance_after_cents,
         o.surface,
         p.id,
         p.slug,
         p.display_name,
         p.category,
         p.avatar_url,
         public.units_per_share()
    from public.trade_orders o
    join public.people p on p.id = o.person_id
   where o.user_id = p_user_id
     and (p_before is null or p_before_id is null or (o.created_at, o.id) < (p_before, p_before_id))
   order by o.created_at desc, o.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

create function public.my_trade_history(
  p_before    timestamptz default null,
  p_before_id uuid        default null,
  p_limit     integer     default 20
)
  returns table (
    id uuid, created_at timestamptz, side text, units bigint, fill_price_cents bigint, gross_cents bigint,
    opened_units bigint, closed_units bigint, cost_cents bigint, proceeds_cents bigint, realized_pnl_cents bigint,
    balance_after_cents bigint, surface text, person_id uuid, person_slug text, person_name text,
    person_category text, person_avatar text, units_per_share bigint
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select * from public.trade_history_for(auth.uid(), p_before, p_before_id, p_limit);
$$;

-- Dropping a function drops its grants with it; these restore exactly what
-- the pair carried before (the caller-scoped wrapper is the only one the
-- browser may execute).
revoke all on function public.trade_history_for(uuid, timestamptz, uuid, integer) from public;
revoke all on function public.my_trade_history(timestamptz, uuid, integer) from public;
grant execute on function public.trade_history_for(uuid, timestamptz, uuid, integer) to service_role;
grant execute on function public.my_trade_history(timestamptz, uuid, integer)        to authenticated, service_role;

create or replace function public.portfolio_summary_for(p_user_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
as $function$
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
           sum(l.open_units)::bigint      as open_units,
           sum(l.open_cost_cents)::bigint as cost_cents,
           count(*)::integer              as lots,
           min(l.opened_at)               as oldest_opened_at,
           max(l.opened_at)               as newest_opened_at
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
           public.units_proceeds_cents(m.open_units, m.mark_cents) as value_cents,
           (case when m.direction = 'HIGH' then public.units_proceeds_cents(m.open_units, m.mark_cents) - m.cost_cents
                                          else m.cost_cents - public.units_proceeds_cents(m.open_units, m.mark_cents) end)::bigint as unrealized_cents
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
           'avg_entry_cents',      round(v.cost_cents::numeric * public.units_per_share() / v.open_units)::bigint,
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
    -- The scale every open_units below is expressed in. See the note at 7.
    'units_per_share',       public.units_per_share(),
    'positions',             v_positions
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Saying a quantity out loud
-- ---------------------------------------------------------------------------
-- The rejection messages have to name quantities, and they have to name them
-- the way the interface does or the same order reads two ways. Up to three
-- decimals, trailing zeros trimmed, "share" singular only at exactly one.
-- lib/trading/model.ts holds the mirror of this and a test pins the two
-- together.

create or replace function public.shares_text(p_units bigint)
  returns text
  language sql
  immutable
  set search_path = ''
as $$
  select case
           when coalesce(p_units, 0) % 1000 = 0 then (coalesce(p_units, 0) / 1000)::text
           else trim(trailing '0' from to_char(coalesce(p_units, 0)::numeric / 1000, 'FM999999999990.000'))
         end;
$$;

create or replace function public.shares_label(p_units bigint)
  returns text
  language sql
  immutable
  set search_path = ''
as $$
  select public.shares_text(p_units) || case when coalesce(p_units, 0) = 1000 then ' share' else ' shares' end;
$$;

grant execute on function public.shares_text(bigint)  to authenticated, service_role;
grant execute on function public.shares_label(bigint) to authenticated, service_role;

-- What a Dollars-mode order asked to spend, kept on the row so the ledger can
-- say why the charge is a few cents under a round number.
alter table public.trade_orders add column if not exists requested_spend_cents bigint;
alter table public.trade_orders
  add constraint trade_orders_requested_spend_positive check (requested_spend_cents is null or requested_spend_cents > 0);

comment on column public.trade_orders.requested_spend_cents is
  'Phase 27: the amount a Dollars-mode order asked to spend, in cents. Null for a Shares-mode order. The charge is always <= this.';

-- WHICH SCALE THE CALLER SPOKE. Recorded on every order so Phase 27a can see,
-- from data rather than from belief, that no client is still sending whole
-- shares before the compatibility path is removed.
alter table public.trade_orders add column if not exists quantity_scale text not null default 'share';
alter table public.trade_orders
  add constraint trade_orders_quantity_scale_check check (quantity_scale in ('share', 'milli'));

comment on column public.trade_orders.quantity_scale is
  'Phase 27 transition: the unit scale the CALLER declared. "share" is a pre-Phase-27 client (or one that sent no scale at all); "milli" is a client speaking thousandths. Phase 27a removes the compatibility path once no "share" rows are arriving.';

-- ---------------------------------------------------------------------------
-- 9. place_order, with fractions and a dollar mode
-- ---------------------------------------------------------------------------

drop function if exists public.place_order(uuid, text, bigint, bigint, text);

create function public.place_order(
  p_person_id          uuid,
  p_side               text,
  p_units              bigint  default null,
  p_quoted_price_cents bigint  default null,
  p_surface            text    default null,
  p_max_spend_cents    bigint  default null,
  p_quantity_scale     text    default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $function$
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
  v_units            bigint;
  v_notional         bigint;
  v_close_direction  text;
  v_open_direction   text;
  v_closable_units   bigint;
  v_close_units      bigint;
  v_open_units       bigint;
  v_same_side_units  bigint;
  v_total_side_units bigint;
  v_daily_closed     bigint;
  v_close_value      bigint;
  v_cooldown_wait    numeric;
  v_cost             bigint := 0;
  v_order_id         uuid;
  v_lot              record;
  v_remaining        bigint;
  v_take             bigint;
  v_take_cost        bigint;
  v_pnl              bigint;
  v_lot_proceeds     bigint;
  v_total_proceeds   bigint := 0;
  v_total_pnl        bigint := 0;
  v_closed_units     bigint := 0;
  v_position_id      uuid;
  v_balance_after    bigint;
  v_affordable       bigint;
  v_scale            text;
  v_fills            jsonb := '[]'::jsonb;
begin
  -- The actor is always the signed-in user, never a parameter.
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'p_side must be BUY or SELL' using errcode = '22023';
  end if;
  -- EXACTLY ONE MODE. Shares mode names a quantity; Dollars mode names an
  -- amount and lets the server resolve the quantity against its own quote.
  if (p_units is null) = (p_max_spend_cents is null) then
    raise exception 'exactly one of p_units or p_max_spend_cents must be given' using errcode = '22023';
  end if;
  if p_units is not null and p_units <= 0 then
    raise exception 'p_units must be a positive integer number of units' using errcode = '22023';
  end if;

  -- WHICH SCALE IS p_units IN? (Phase 27 transition.)
  --
  -- The caller SAYS, and is never guessed at. A pre-Phase-27 client sends no
  -- scale at all and means whole shares, which is why the absent case is
  -- 'share' rather than an error: it is what every deployed client meant
  -- yesterday, and it lets this migration land under a live client without
  -- refusing a single order. Inferring the scale from the magnitude of the
  -- number was considered and rejected — "5" is a plausible order in both
  -- scales, so any such rule is wrong for somebody, silently, in money.
  --
  -- Phase 27a deletes this branch once trade_orders.quantity_scale shows no
  -- 'share' rows arriving.
  v_scale := lower(coalesce(nullif(trim(p_quantity_scale), ''), 'share'));
  if v_scale not in ('share', 'milli') then
    raise exception 'p_quantity_scale must be share or milli' using errcode = '22023';
  end if;
  if p_max_spend_cents is not null and p_max_spend_cents <= 0 then
    raise exception 'p_max_spend_cents must be a positive integer number of cents' using errcode = '22023';
  end if;
  if p_quoted_price_cents is not null and p_quoted_price_cents <= 0 then
    raise exception 'p_quoted_price_cents must be a positive integer number of cents' using errcode = '22023';
  end if;

  select * into v_settings from public.platform_settings s where s.id;

  -- Serialise this user's orders: the wallet row is the lock.
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

  -- The tolerance band: never fill at a price the user has not seen. It is
  -- checked BEFORE a Dollars-mode quantity is resolved, so the quantity is
  -- always resolved against a price the user has already accepted.
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

  -- DOLLARS MODE. The largest quantity whose rounded-UP cost still fits
  -- inside the amount asked for. Because ceil(x) <= S is exactly x <= S for
  -- an integer S, that quantity is floor(S x 1000 / price) and the charge is
  -- then at most S, never more, with no search and no float.
  if p_max_spend_cents is not null then
    if p_max_spend_cents < v_settings.min_order_cents then
      return public.trade_rejection(
        'below_minimum',
        format('The smallest order is $%s. Enter at least that much.', public.cents_to_dollars_text(v_settings.min_order_cents)),
        v_quote,
        jsonb_build_object('min_order_cents', v_settings.min_order_cents, 'requested_cents', p_max_spend_cents)
      );
    end if;
    v_units := floor(p_max_spend_cents::numeric * public.units_per_share() / v_price_cents)::bigint;
    if v_units <= 0 then
      return public.trade_rejection(
        'below_minimum',
        format('$%s does not buy a tradeable quantity of %s at $%s per share.',
               public.cents_to_dollars_text(p_max_spend_cents), v_person.display_name, public.cents_to_dollars_text(v_price_cents)),
        v_quote,
        jsonb_build_object('min_order_cents', v_settings.min_order_cents, 'requested_cents', p_max_spend_cents)
      );
    end if;
  else
    -- A whole-share caller's 5 becomes 5000 units; a thousandths caller's
    -- 5000 is already 5000. Dollars mode is scale-free: cents are cents.
    v_units := case when v_scale = 'milli' then p_units else p_units * public.units_per_share() end;
  end if;

  -- SHARES MODE takes the floor on what the order is worth, since that is
  -- the only thing about it the user chose in money. (In Dollars mode the
  -- amount entered was already checked above; the charge lands within one
  -- unit's worth of it.)
  v_notional := case when p_side = 'BUY' then public.units_cost_cents(v_units, v_price_cents)
                                         else public.units_proceeds_cents(v_units, v_price_cents) end;
  if p_max_spend_cents is null and v_notional < v_settings.min_order_cents then
    return public.trade_rejection(
      'below_minimum',
      format('%s of %s is $%s. The smallest order is $%s.',
             public.shares_label(v_units), v_person.display_name,
             public.cents_to_dollars_text(v_notional), public.cents_to_dollars_text(v_settings.min_order_cents)),
      v_quote,
      jsonb_build_object('min_order_cents', v_settings.min_order_cents, 'order_cents', v_notional, 'units', v_units)
    );
  end if;

  -- Netting, in units: an order first closes the opposite side, then opens its own.
  v_close_direction := case when p_side = 'BUY' then 'LOW' else 'HIGH' end;
  v_open_direction  := case when p_side = 'BUY' then 'HIGH' else 'LOW' end;

  select coalesce(sum(l.open_units), 0) into v_closable_units
    from public.positions l
   where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction;

  v_close_units := least(v_units, v_closable_units);
  v_open_units  := v_units - v_close_units;

  -- THE GATE: a Sell may only open LOW when shorting is on.
  if p_side = 'SELL' and v_open_units > 0 and not coalesce(v_settings.shorting_enabled, false) then
    return public.trade_rejection(
      'exceeds_position',
      case when v_closable_units = 0
           then format('You hold no shares of %s. There is nothing to close.', v_person.display_name)
           else format('You hold %s of %s. A Sell can close at most that many.',
                       public.shares_label(v_closable_units), v_person.display_name) end,
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

  -- RISK LEVER 3 — daily close value, at what the close would actually return.
  if v_close_units > 0 then
    select coalesce(sum(c.proceeds_cents), 0) into v_daily_closed
      from public.position_closes c
     where c.user_id = v_user_id and c.closed_at > v_now - interval '24 hours';
    v_close_value := public.units_proceeds_cents(v_close_units, v_price_cents);
    if v_daily_closed + v_close_value > v_settings.max_daily_close_cents then
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

    -- RISK LEVER 1 — units per user per person. Both sides are units; only
    -- the sentence converts to shares.
    if v_same_side_units + v_open_units > v_settings.max_units_per_person then
      return public.trade_rejection(
        'max_units',
        format('That would take you past the limit of %s of one person.', public.shares_label(v_settings.max_units_per_person)),
        v_quote,
        jsonb_build_object('limit_units', v_settings.max_units_per_person, 'held_units', v_same_side_units)
      );
    end if;

    -- RISK LEVER 2 — share of open interest on the person. A ratio of units;
    -- the scale cancels.
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

    -- THE BALANCE, through the buy side of the rounding rule. The wallet must
    -- cover it before any proceeds from the closing half are counted.
    v_cost := public.units_cost_cents(v_open_units, v_price_cents);
    if v_cost > v_wallet then
      v_affordable := floor(v_wallet::numeric * public.units_per_share() / v_price_cents)::bigint;
      return public.trade_rejection(
        'insufficient_balance',
        format('%s of %s costs $%s. Your paper balance is $%s, enough for %s.',
               public.shares_label(v_open_units), v_person.display_name,
               public.cents_to_dollars_text(v_cost), public.cents_to_dollars_text(v_wallet),
               public.shares_label(v_affordable)),
        v_quote,
        jsonb_build_object('cost_cents', v_cost, 'balance_cents', v_wallet, 'max_units', v_affordable)
      );
    end if;
  end if;

  -- Every check has passed. From here everything is one transaction. --------
  insert into public.trade_orders (user_id, person_id, side, units, quoted_price_cents, fill_price_cents, gross_cents, requested_spend_cents, quantity_scale, surface, created_at)
  values (v_user_id, p_person_id, p_side, v_units, p_quoted_price_cents, v_price_cents, v_notional, p_max_spend_cents, v_scale, left(p_surface, 40), v_now)
  returning id into v_order_id;

  -- Closes, FIFO: the oldest lot first, partially where the order runs out.
  -- THE BASIS SPLIT. A partial take gets its proportional share of what is
  -- left of the lot's cost, floored; a take that empties the lot gets the
  -- exact remainder. So a lot's closes sum to its amount_cents to the cent
  -- however many times it is cut, and no basis is created or lost.
  v_remaining := v_close_units;
  for v_lot in
    select l.id, l.open_units, l.open_cost_cents, l.entry_price_cents, l.direction
      from public.positions l
     where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction
     order by l.opened_at, l.id
       for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_lot.open_units, v_remaining);
    v_take_cost := case when v_take = v_lot.open_units then v_lot.open_cost_cents
                        else floor(v_take::numeric * v_lot.open_cost_cents / v_lot.open_units)::bigint end;
    -- A HIGH lot returns what the units fetch at the exit price, rounded
    -- down. A LOW lot (shorting, currently gated off) returns twice its basis
    -- less what the units now cost to buy back, with that leg rounded UP for
    -- the same conservative reason.
    v_lot_proceeds := case when v_lot.direction = 'HIGH'
                           then public.units_proceeds_cents(v_take, v_price_cents)
                           else greatest(2 * v_take_cost - public.units_cost_cents(v_take, v_price_cents), 0) end;
    v_pnl := v_lot_proceeds - v_take_cost;

    insert into public.position_closes (order_id, position_id, user_id, person_id, direction, units, entry_price_cents, exit_price_cents, cost_cents, proceeds_cents, pnl_cents, closed_at)
    values (v_order_id, v_lot.id, v_user_id, p_person_id, v_lot.direction, v_take, v_lot.entry_price_cents, v_price_cents, v_take_cost, v_lot_proceeds, v_pnl, v_now);

    update public.positions
       set open_units      = open_units - v_take,
           open_cost_cents = open_cost_cents - v_take_cost,
           is_open         = (open_units - v_take) > 0,
           closed_at       = case when open_units - v_take = 0 then v_now else closed_at end
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

  -- Open, at the snapshotted price. amount_cents is the rounded charge, and
  -- open_cost_cents starts equal to it.
  if v_open_units > 0 then
    insert into public.positions (user_id, person_id, direction, amount_cents, open_cost_cents, entry_score, units, open_units, entry_price_cents, order_id, opened_at)
    values (v_user_id, p_person_id, v_open_direction, v_cost, v_cost, v_price_cents::numeric / 100, v_open_units, v_open_units, v_price_cents, v_order_id, v_now)
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

  -- The tape the Trading Activity force reads: notional, in cents, through
  -- the same rule as the charge, so the force reads money that moved.
  insert into public.trade_events (person_id, user_id, side, amount_cents, created_at)
  values (p_person_id, v_user_id, p_side, v_notional, v_now);

  update public.trade_orders
     set opened_units = v_open_units, closed_units = v_closed_units, realized_pnl_cents = v_total_pnl, balance_after_cents = v_balance_after
   where id = v_order_id;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'id', v_order_id, 'person_id', p_person_id, 'side', p_side, 'units', v_units,
      'fill_price_cents', v_price_cents, 'gross_cents', v_notional,
      -- units, opened_units and closed_units are all in THIS scale, whatever
      -- scale the caller asked in. See the note at the head of 7.
      'units_per_share', public.units_per_share(),
      'requested_spend_cents', p_max_spend_cents, 'quantity_scale', v_scale,
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
$function$;

revoke execute on function public.place_order(uuid, text, bigint, bigint, text, bigint, text) from public, anon;
grant  execute on function public.place_order(uuid, text, bigint, bigint, text, bigint, text) to authenticated, service_role;

comment on function public.place_order(uuid, text, bigint, bigint, text, bigint, text) is
  'Phase 27: the one write path for a trade. Quantities are stored as thousandths of a share. Give p_units (Shares mode) or p_max_spend_cents (Dollars mode, resolved against the server snapshot), never both. p_quantity_scale says which scale p_units is in — "milli" for thousandths, absent or "share" for a pre-Phase-27 caller; it is never inferred from the number. Cost rounds up, proceeds round down, one cent at most, never in the user''s favour.';
