-- ROLLBACK for Phase 29 (the market price) and Phase 29b, together.
--
-- NOT under supabase/migrations/, so nothing applies it by accident. It
-- takes the schema back to exactly what 20260923212502_phase28_landing_waitlist
-- left — a test builds that schema, runs Phase 29, Phase 29b and this file,
-- and compares every column, constraint, index, function (body, grants,
-- comment), trigger, policy, grant and comment against it — and keeps every
-- row of every table that existed before Phase 29.
--
-- IT IS THE SECOND RESORT, NOT THE FIRST. The first is the named flat mode
-- (Phase 29b): `update public.market_tier_settings set pricing_mode = 'flat'`
-- puts every person back on Phase 27 prices at the next order, and the next
-- Engine tick returns every inventory to zero. Nothing is lost and nothing is
-- deployed. Use this file only when the schema itself has to go; the README
-- ("Reversing Phase 29") gives the whole procedure, the Vercel step included.
--
-- WHAT IT REFUSES, having changed nothing:
--   * a schema without Phase 29 (it has already been run, or never needed);
--   * any premium or dealer inventory not at zero — the prices this file
--     restores are score ± spread, so the market price must already BE the
--     score (flat mode + one tick does it);
--   * rows the restored Phase 27 CHECKs would reject: orders filled along the
--     curve record an AVERAGE fill, which is not in general gross ÷ units. The
--     refusal gives the counts. `set momentum.phase29_down_curve_rows =
--     'not_valid'` restores those two CHECKs NOT VALID instead — every later
--     row is checked, the rows filled on the curve are kept as filled;
--   * data that exists only in Phase 29's tables (premium history, the house
--     book, alerts, surveillance events, the admin audit log, excluded
--     parties) unless `set momentum.phase29_down_data_exported = 'yes'` says
--     it has been exported first. It is deleted with the tables.
--
-- WHAT IS LOST, by design, with the schema: the tables above; the dealer
-- state and every per-person setting (tier, trading mode, halts, overrides,
-- pricing mode — the founder's display-only included); account freezes, the
-- identity hook and referrals; the detector thresholds; the per-tier market
-- settings; and on existing rows the curve's inputs (orders' base price,
-- inventory, premium, depth, impact, worst fill, cost / proceeds split and
-- fingerprint hash; lots' and closes' entry and exit inputs). The rows
-- themselves — orders, lots, closes, transactions, balances, portfolio
-- history, scores — all stay.
--
-- The six functions Phase 29 replaced are restored byte for byte as a
-- database migrated to Phase 28 holds them (pg_get_functiondef): apply_engine_tick
-- from 20260917202622_phase14_target_drift, trade_quote from
-- 20260911200110_trading_flow, and position_summary_for, portfolio_summary_for,
-- trade_history_for and the seven-argument place_order from
-- 20260922211703_phase27_fractional_units — with their grants and comments.
--
-- Run it as one transaction (it is wrapped in one; in psql also pass
-- -v ON_ERROR_STOP=1). It removes both versions from
-- supabase_migrations.schema_migrations when that table exists, so the
-- recorded history matches the schema again.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Refusals
-- ---------------------------------------------------------------------------

do $applied$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'people' and column_name = 'premium_cents') then
    raise exception 'Phase 29 rollback refused: Phase 29 is not applied (people.premium_cents does not exist). Nothing to reverse.'
      using errcode = '22023';
  end if;
end
$applied$;

lock table public.people, public.users, public.platform_settings, public.trade_orders, public.positions, public.position_closes,
           public.market_tier_settings, public.premium_history, public.house_ledger, public.excluded_parties,
           public.alerts, public.surveillance_events, public.admin_audit_log
  in access exclusive mode;

do $flat$
declare
  v_people integer;
begin
  select count(*) into v_people from public.people where premium_cents <> 0 or market_inventory_units <> 0;
  if v_people > 0 then
    raise exception 'Phase 29 rollback refused: % people still carry a premium or dealer inventory. Set pricing_mode = ''flat'' on market_tier_settings, let one Engine tick reset them, then run this again.', v_people
      using errcode = '22023';
  end if;
end
$flat$;

do $curve$
declare
  v_lots   integer;
  v_orders integer;
begin
  select count(*) into v_lots from public.positions where amount_cents <> public.units_cost_cents(units, entry_price_cents);
  select count(*) into v_orders from public.trade_orders
   where gross_cents <> case when side = 'BUY' then public.units_cost_cents(units, fill_price_cents)
                                               else public.units_proceeds_cents(units, fill_price_cents) end;
  if (v_lots > 0 or v_orders > 0) and coalesce(current_setting('momentum.phase29_down_curve_rows', true), '') <> 'not_valid' then
    raise exception 'Phase 29 rollback refused: % lots and % orders were filled along the curve and fail the Phase 27 CHECKs (amount = units × entry price, gross = units × fill price). Run with set momentum.phase29_down_curve_rows = ''not_valid'' to restore those two CHECKs NOT VALID and keep the rows as filled.', v_lots, v_orders
      using errcode = '22023';
  end if;
  if v_lots > 0 or v_orders > 0 then
    raise notice 'Phase 29 rollback: % lots and % orders filled on the curve are kept; positions_amount_is_cost and trade_orders_gross_is_notional are restored NOT VALID.', v_lots, v_orders;
  end if;
end
$curve$;

do $data$
declare
  v_counts text;
begin
  select string_agg(format('%s %s', n, t), ', ') into v_counts
    from (values ('premium_history',     (select count(*) from public.premium_history)),
                 ('house_ledger',        (select count(*) from public.house_ledger)),
                 ('alerts',              (select count(*) from public.alerts)),
                 ('surveillance_events', (select count(*) from public.surveillance_events)),
                 ('admin_audit_log',     (select count(*) from public.admin_audit_log)),
                 ('excluded_parties',    (select count(*) from public.excluded_parties))) as tables(t, n)
   where n > 0;
  if v_counts is not null and coalesce(current_setting('momentum.phase29_down_data_exported', true), '') <> 'yes' then
    raise exception 'Phase 29 rollback refused: these rows exist only in Phase 29''s tables and would be deleted with them: %. Export them, then run with set momentum.phase29_down_data_exported = ''yes''.', v_counts
      using errcode = '22023';
  end if;
end
$data$;

-- ---------------------------------------------------------------------------
-- 1. Phase 29's own functions (they name its tables and columns)
-- ---------------------------------------------------------------------------

-- The curve CHECKs first: they call the walk functions dropped below.
alter table public.trade_orders
  drop constraint trade_orders_base_positive,
  drop constraint trade_orders_depth_positive,
  drop constraint trade_orders_gross_is_curve,
  drop constraint trade_orders_cost_is_opening_segment,
  drop constraint trade_orders_inventory_walk,
  drop constraint trade_orders_premium_is_derived;

alter table public.positions
  drop constraint positions_entry_base_positive,
  drop constraint positions_entry_depth_positive,
  drop constraint positions_amount_is_curve,
  drop constraint positions_entry_premium_is_derived;

drop function public.admin_resolve_alert(uuid, text, text);
drop function public.admin_remove_excluded_party(uuid, text, uuid);
drop function public.admin_add_excluded_party(uuid, uuid, text, uuid);
drop function public.admin_set_trading_mode(uuid, text, text, uuid);
drop function public.admin_lift_halt(uuid, text, uuid);
drop function public.admin_halt_person(uuid, integer, text, uuid);
drop function public.admin_unfreeze_account(uuid, text, uuid);
drop function public.admin_freeze_account(uuid, text, uuid);
drop function public.assert_admin();
drop function public.place_order(uuid, text, bigint, bigint, text, bigint, text, text);
drop function public.wait_text(numeric);
drop function public.run_surveillance(timestamptz, uuid, uuid, uuid, text);
drop function public.surveillance_emit(timestamptz, timestamptz, uuid, uuid, text, text, integer, integer, uuid[], jsonb);
drop function public.person_market_series(uuid, timestamptz, integer);
drop function public.evaluate_price_breakers(timestamptz, bigint);
drop function public.apply_market_decay(timestamptz, bigint);
drop function public.index_cents_at(uuid, timestamptz);
drop function public.premium_cents_at(uuid, timestamptz);
drop function public.halt_person(uuid, integer, text, timestamptz, text, jsonb, boolean);
drop function public.record_premium_change(uuid, timestamptz, text, bigint, bigint, bigint, numeric, bigint, uuid);
drop function public.market_params_for(uuid);
drop function public.market_cap_inventory_units(bigint, bigint);
drop function public.market_impact_cents(bigint, bigint);
drop function public.market_average_cents(bigint, bigint, bigint, bigint, text);
drop function public.market_lot_amount_cents(text, bigint, bigint, bigint, bigint);

drop function public.market_order_gross_cents(text, bigint, bigint, bigint, bigint, bigint, bigint);
drop function public.market_marginal_cents(bigint, bigint, bigint, text);
drop function public.market_walk_cents(bigint, bigint, bigint, bigint, text, text);
drop function public.market_decay_step(bigint, bigint);
drop function public.market_decay_divisor(integer);
drop function public.market_premium_cents(bigint, bigint);

-- ---------------------------------------------------------------------------
-- 2. Phase 29's tables
-- ---------------------------------------------------------------------------

drop table public.admin_audit_log;
drop function public.admin_audit_log_is_immutable();
drop table public.surveillance_events;
drop table public.alerts;
drop table public.excluded_parties;
drop table public.house_ledger;
drop table public.premium_history;
drop table public.market_tier_settings;

-- ---------------------------------------------------------------------------
-- 3. The columns Phase 29 and 29b added, and the two it changed
-- ---------------------------------------------------------------------------

-- people: the quotes go back to score ± spread, generated exactly as
-- 20260907143920_engine_tables defined them.
alter table public.people
  drop column market_price,
  drop column buy_price,
  drop column sell_price;

alter table public.people
  drop column pricing_mode_override,
  drop column tier,
  drop column trading_mode,
  drop column market_inventory_units,
  drop column premium_cents,
  drop column depth_units_override,
  drop column decay_half_life_ticks_override,
  drop column premium_cap_cents_override,
  drop column shorting_override,
  drop column halted_until,
  drop column halt_reason;

alter table public.people
  add column buy_price  numeric generated always as (current_score + spread) stored,
  add column sell_price numeric generated always as (current_score - spread) stored;

comment on column public.people.buy_price is
  'Buy price = current_score + spread (generated). Buy was "Allocate" on the old platform.';
comment on column public.people.sell_price is
  'Sell price = current_score - spread (generated). Sell was "Redeem" on the old platform.';

-- users
alter table public.users
  drop column frozen_at,
  drop column frozen_reason,
  drop column verified_identity_key,
  drop column identity_verified_at,
  drop column referred_by;

-- platform_settings
alter table public.platform_settings drop constraint platform_settings_surveillance_positive;
alter table public.platform_settings
  drop column surveillance_window_seconds,
  drop column clustered_buying_min_accounts,
  drop column new_account_age_hours,
  drop column new_account_burst_min_accounts,
  drop column shared_infra_min_accounts,
  drop column wash_window_seconds,
  drop column wash_min_round_trips,
  drop column referral_spike_min_accounts,
  drop column fingerprint_retention_days,
  drop column require_verified_identity;

-- trade_orders
alter table public.trade_orders
  drop column base_price_cents,
  drop column inventory_before_units,
  drop column inventory_after_units,
  drop column premium_before_cents,
  drop column premium_after_cents,
  drop column depth_units,
  drop column impact_cents,
  drop column worst_fill_cents,
  drop column cost_cents,
  drop column proceeds_cents,
  drop column fingerprint_hash;

-- positions
alter table public.positions
  drop column entry_base_cents,
  drop column entry_inventory_units,
  drop column entry_depth_units,
  drop column entry_premium_cents,
  drop column entry_index_cents;

alter table public.positions rename column entry_price_points to entry_score;

-- position_closes
alter table public.position_closes
  drop column exit_base_cents,
  drop column exit_inventory_units,
  drop column exit_premium_cents,
  drop column exit_index_cents;

-- The comments Phase 29 rewrote on columns that stay, as they were.
comment on column public.trade_orders.fill_price_cents is
  'The server-read quote the order filled at, in cents per unit.';
comment on column public.positions.entry_score is
  'The same entry quote in score points, for display.';
comment on column public.positions.entry_price_cents is
  'The Buy (HIGH) or Sell (LOW) quote at the moment the server filled the lot, in cents per unit. Snapshot; never recomputed.';
comment on column public.positions.amount_cents is
  'The lot''s cost: units × entry_price_cents.';
comment on column public.position_closes.exit_price_cents is null;

-- ---------------------------------------------------------------------------
-- 4. The Phase 27 CHECKs, as 20260922211703_phase27_fractional_units wrote them
-- ---------------------------------------------------------------------------
-- NOT VALID only when section 0 was told to keep curve-filled rows; then the
-- rows already there are kept as filled and every new row is checked.

do $checks$
declare
  v_not_valid text := case when coalesce(current_setting('momentum.phase29_down_curve_rows', true), '') = 'not_valid' then ' not valid' else '' end;
begin
  execute 'alter table public.positions add constraint positions_amount_is_cost check (amount_cents = public.units_cost_cents(units, entry_price_cents))' || v_not_valid;
  execute 'alter table public.trade_orders add constraint trade_orders_gross_is_notional check (
    gross_cents = case when side = ''BUY'' then public.units_cost_cents(units, fill_price_cents)
                                         else public.units_proceeds_cents(units, fill_price_cents) end
  )' || v_not_valid;
end
$checks$;

-- ---------------------------------------------------------------------------
-- 5. The functions Phase 29 replaced, as they were
-- ---------------------------------------------------------------------------

-- apply_engine_tick, as 20260917202622_phase14_target_drift left it.
CREATE OR REPLACE FUNCTION public.apply_engine_tick(p_tick jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     set current_score    = x.score,
         spread           = x.spread,
         target_attention = x.target_attention,
         target_direction = x.target_direction,
         target_offset    = coalesce(x.target_offset, 0),
         last_tick_at     = v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb))
           as x(id uuid, score numeric, spread numeric, target_attention numeric, target_direction numeric, target_offset numeric)
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
$function$
;

revoke all on function public.apply_engine_tick(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.apply_engine_tick(jsonb) to service_role;
comment on function public.apply_engine_tick(jsonb) is
  'Atomically persists one Engine tick (people scores, spread and the drifting target''s state, score_history, score_events, processed signals, engine_ticks) and records every position-holding user''s portfolio value at the new quotes. Service role only.';

-- trade_quote, as 20260911200110_trading_flow left it.
CREATE OR REPLACE FUNCTION public.trade_quote(p_person_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.trade_quote(uuid) from public, anon, authenticated, service_role;
grant execute on function public.trade_quote(uuid) to authenticated, service_role;
comment on function public.trade_quote(uuid) is
  'The current Buy and Sell quotes for a person in integer cents per unit, as the server reads them. Null for an unknown or inactive person.';

-- position_summary_for, as 20260922211703_phase27_fractional_units left it.
CREATE OR REPLACE FUNCTION public.position_summary_for(p_user_id uuid, p_person_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.position_summary_for(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.position_summary_for(uuid,uuid) to service_role;
comment on function public.position_summary_for(uuid,uuid) is
  'Service-role view of one user''s position on one person: open units, cost, weighted-average entry (display only), mark at the closing quote, unrealized and realized P&L. Integer cents.';

-- portfolio_summary_for, as 20260922211703_phase27_fractional_units left it.
CREATE OR REPLACE FUNCTION public.portfolio_summary_for(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.portfolio_summary_for(uuid) from public, anon, authenticated, service_role;
grant execute on function public.portfolio_summary_for(uuid) to service_role;
comment on function public.portfolio_summary_for(uuid) is
  'Service-role view of one user''s portfolio: cash, every open position marked at its closing quote (value, weighted-average entry for display, unrealized and per-person realized P&L), the totals, lifetime realized P&L, paper credit and return. Integer cents; percentages are display figures. Null for an unknown user.';

-- trade_history_for, as 20260922211703_phase27_fractional_units left it.
CREATE OR REPLACE FUNCTION public.trade_history_for(p_user_id uuid, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, side text, units bigint, fill_price_cents bigint, gross_cents bigint, opened_units bigint, closed_units bigint, cost_cents bigint, proceeds_cents bigint, realized_pnl_cents bigint, balance_after_cents bigint, surface text, person_id uuid, person_slug text, person_name text, person_category text, person_avatar text, units_per_share bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.trade_history_for(uuid,timestamp with time zone,uuid,integer) from public, anon, authenticated, service_role;
grant execute on function public.trade_history_for(uuid,timestamp with time zone,uuid,integer) to service_role;
comment on function public.trade_history_for(uuid,timestamp with time zone,uuid,integer) is null;

-- place_order, as 20260922211703_phase27_fractional_units left it.
CREATE OR REPLACE FUNCTION public.place_order(p_person_id uuid, p_side text, p_units bigint DEFAULT NULL::bigint, p_quoted_price_cents bigint DEFAULT NULL::bigint, p_surface text DEFAULT NULL::text, p_max_spend_cents bigint DEFAULT NULL::bigint, p_quantity_scale text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.place_order(uuid,text,bigint,bigint,text,bigint,text) from public, anon, authenticated, service_role;
grant execute on function public.place_order(uuid,text,bigint,bigint,text,bigint,text) to authenticated, service_role;
comment on function public.place_order(uuid,text,bigint,bigint,text,bigint,text) is
  'Phase 27: the one write path for a trade. Quantities are stored as thousandths of a share. Give p_units (Shares mode) or p_max_spend_cents (Dollars mode, resolved against the server snapshot), never both. p_quantity_scale says which scale p_units is in — "milli" for thousandths, absent or "share" for a pre-Phase-27 caller; it is never inferred from the number. Cost rounds up, proceeds round down, one cent at most, never in the user''s favour.';

-- ---------------------------------------------------------------------------
-- 6. The recorded history
-- ---------------------------------------------------------------------------

do $history$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version in ('20260925012938', '20260925103634');
  end if;
end
$history$;

commit;
