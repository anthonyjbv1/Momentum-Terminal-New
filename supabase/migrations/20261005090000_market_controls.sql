-- =============================================================================
-- MARKET CONTROLS (2026-10-05): four rules for the operator's hand on the
-- market, each enforced in SQL so no code path and no console session can
-- step around it.
--
--   1. A HALT FREEZES THE PREMIUM. apply_market_decay() leaves a halted
--      person alone: no decay step, no premium change, no premium_history row,
--      no decay_mark in the house book. Decay resumes from where it stood on
--      the first tick after the halt lifts; there is no catch-up.
--
--   2. LOGGED OVERRIDES ONLY. A person's market parameters (tier, trading
--      mode, pricing mode, depth, decay half-life, premium cap, shorting) and
--      a tier's parameters change only through an admin function that writes
--      admin_audit_log (actor, reason, before and after) in the same
--      transaction. A BEFORE UPDATE trigger refuses any other write to those
--      columns, from any role, naming the function to use. The admin functions
--      open the door for their own transaction with a transaction-local
--      setting (momentum.market_write = 'admin'); a migration that must touch
--      these columns sets the same setting first, deliberately, in its own
--      text.
--
--   3. RESETS. A reset of a person's market (inventory and premium to zero)
--      is refused while anyone holds an open position on the person, from the
--      admin function and from the flat-mode reset in apply_market_decay()
--      alike. When it goes through it goes through ONE function,
--      market_reset_inventory(): a 'reset' premium_history row, a 'reset'
--      house_ledger row carrying the inventory and premium written off and the
--      change in the mark of everything held (zero, exactly because nothing is
--      held), and, from the admin function, the audit row.
--
--   4. VOIDS. A signal or narrative is voided through admin_void_signal() /
--      admin_void_narrative(), which set the columns and write the audit row
--      in one transaction; the same trigger rule refuses a direct write of
--      voided_at / void_reason.
--
-- Nothing here changes a weight, a force, the volume metric, the drift, the
-- news-volume tune or a market price. No row is rewritten.
-- =============================================================================

set local lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 0. The door: a transaction-local setting the admin functions open
-- -----------------------------------------------------------------------------

create or replace function public.market_write_is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('momentum.market_write', true), '') = 'admin';
$$;

comment on function public.market_write_is_admin() is
  'Market controls (2026-10-05): true inside a transaction an admin function opened with set_config(''momentum.market_write'', ''admin'', true). The guards below refuse a write to a market parameter or a void column unless it is.';

revoke execute on function public.market_write_is_admin() from public, anon, authenticated;
grant  execute on function public.market_write_is_admin() to service_role;

-- -----------------------------------------------------------------------------
-- 1. The guards
-- -----------------------------------------------------------------------------

-- people: the market parameters. halted_until / halt_reason are not here: the
-- breakers set them from place_order() and evaluate_price_breakers(), and the
-- admin path (admin_halt_person, admin_lift_halt) is already audit-logged.
create or replace function public.people_market_parameters_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_column text;
begin
  v_column := case
    when new.tier                           is distinct from old.tier                           then 'tier'
    when new.trading_mode                   is distinct from old.trading_mode                   then 'trading_mode'
    when new.pricing_mode_override          is distinct from old.pricing_mode_override          then 'pricing_mode_override'
    when new.depth_units_override           is distinct from old.depth_units_override           then 'depth_units_override'
    when new.decay_half_life_ticks_override is distinct from old.decay_half_life_ticks_override then 'decay_half_life_ticks_override'
    when new.premium_cap_cents_override     is distinct from old.premium_cap_cents_override     then 'premium_cap_cents_override'
    when new.shorting_override              is distinct from old.shorting_override              then 'shorting_override'
  end;
  if v_column is not null and not public.market_write_is_admin() then
    raise exception 'people.% is a market parameter: change it through admin_set_person_market_parameter() (trading_mode: admin_set_trading_mode()), which audit-logs the change', v_column
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists people_market_parameters_guard on public.people;
create trigger people_market_parameters_guard
  before update of tier, trading_mode, pricing_mode_override, depth_units_override, decay_half_life_ticks_override, premium_cap_cents_override, shorting_override
  on public.people
  for each row execute function public.people_market_parameters_guard();

-- market_tier_settings: every parameter column.
create or replace function public.market_tier_settings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') and not public.market_write_is_admin() then
    raise exception 'market_tier_settings.% is a market parameter: change it through admin_set_tier_market_parameter(), which audit-logs the change', old.tier
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists market_tier_settings_guard on public.market_tier_settings;
create trigger market_tier_settings_guard
  before update on public.market_tier_settings
  for each row execute function public.market_tier_settings_guard();

-- signals and narratives: the void columns.
create or replace function public.void_columns_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.voided_at is distinct from old.voided_at or new.void_reason is distinct from old.void_reason) and not public.market_write_is_admin() then
    raise exception '%.voided_at is set through admin_void_%(), which writes the audit row in the same transaction', tg_table_name, rtrim(tg_table_name, 's')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists signals_void_guard on public.signals;
create trigger signals_void_guard
  before update of voided_at, void_reason on public.signals
  for each row execute function public.void_columns_guard();

drop trigger if exists narratives_void_guard on public.narratives;
create trigger narratives_void_guard
  before update of voided_at, void_reason on public.narratives
  for each row execute function public.void_columns_guard();

revoke execute on function public.people_market_parameters_guard() from public, anon, authenticated;
revoke execute on function public.market_tier_settings_guard()     from public, anon, authenticated;
revoke execute on function public.void_columns_guard()             from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. The audit actions and the house-book category
-- -----------------------------------------------------------------------------

alter table public.admin_audit_log drop constraint admin_audit_log_action_check;
alter table public.admin_audit_log add constraint admin_audit_log_action_check check (action in (
  'freeze_account', 'unfreeze_account', 'halt_person', 'lift_halt', 'set_trading_mode',
  'add_excluded_party', 'remove_excluded_party', 'resolve_alert', 'reopen_alert',
  'issue_invite', 'resend_invite', 'revoke_invite',
  'void_signal', 'void_narrative',
  'set_market_parameter', 'set_tier_parameter', 'reset_market'
));

alter table public.house_ledger drop constraint house_ledger_category_check;
alter table public.house_ledger add constraint house_ledger_category_check
  check (category in ('score_move', 'premium_change', 'spread_and_impact', 'decay_mark', 'reset'));

comment on table public.house_ledger is
  'Phase 29: the platform''s side of every realised close (score_move + premium_change + spread_and_impact = −pnl_cents, exactly), of every decay step (decay_mark: the change in the marked value of everything held on the person) and, since 2026-10-05, of every reset (reset: the inventory and premium written off, and the change in the mark of everything held, which the refusal while anyone holds keeps at zero). Integer cents; positive is a house gain. Service role only.';

-- -----------------------------------------------------------------------------
-- 3. The reset, one function
-- -----------------------------------------------------------------------------
-- Refuses while anyone holds an open position on the person. Otherwise takes
-- the inventory and the premium to zero, records the 'reset' premium row and
-- the 'reset' house-book row, and returns what it did. Called by
-- admin_reset_market() (which adds the audit row) and by apply_market_decay()
-- for a person on a flat market (which skips the person while a position is
-- open, and resets on the first tick after the last close).
create or replace function public.market_reset_inventory(
  p_person_id   uuid,
  p_at          timestamptz,
  p_tick_number bigint,
  p_details     jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p            record;
  v_open         integer;
  v_high_units   bigint;
  v_low_units    bigint;
  v_sell_base    bigint;
  v_buy_base     bigint;
  v_mark_change  bigint;
  v_history_id   bigint;
  v_ledger_id    bigint;
begin
  select p.id, p.slug, p.current_score, p.spread, p.market_inventory_units, p.premium_cents
    into v_p
    from public.people p
   where p.id = p_person_id
     for update;
  if not found then
    raise exception 'Unknown person %', p_person_id using errcode = 'P0002';
  end if;

  select count(*)::int,
         coalesce(sum(case when l.direction = 'HIGH' then l.open_units else 0 end), 0),
         coalesce(sum(case when l.direction = 'LOW'  then l.open_units else 0 end), 0)
    into v_open, v_high_units, v_low_units
    from public.positions l
   where l.person_id = p_person_id and l.is_open;
  if v_open > 0 then
    raise exception 'Cannot reset the market on %: % open position(s) are held on the person', v_p.slug, v_open
      using errcode = '55000';
  end if;

  if v_p.market_inventory_units = 0 and v_p.premium_cents = 0 then
    return jsonb_build_object('ok', true, 'person_id', p_person_id, 'changed', false, 'inventory_before_units', 0, 'premium_before_cents', 0);
  end if;

  update public.people set market_inventory_units = 0, premium_cents = 0 where id = p_person_id;

  insert into public.premium_history
    (person_id, recorded_at, tick_number, cause, inventory_before_units, inventory_after_units, premium_before_cents, premium_after_cents, depth_units, score)
  values
    (p_person_id, p_at, p_tick_number, 'reset', v_p.market_inventory_units, 0, v_p.premium_cents, 0, null, v_p.current_score)
  returning id into v_history_id;

  -- The house book. The mark of everything held moves by the premium times
  -- the units held (HIGH at the Sell side, LOW at the Buy side), the same
  -- arithmetic as a decay step; with the refusal above nothing is held and
  -- the amount is zero, so the row is the record of the write-off: the
  -- inventory and the premium that were taken to zero, and why.
  v_sell_base := public.points_to_cents(v_p.current_score - v_p.spread);
  v_buy_base  := public.points_to_cents(v_p.current_score + v_p.spread);
  v_mark_change :=
      (public.units_proceeds_cents(v_high_units, v_sell_base) - public.units_proceeds_cents(v_high_units, v_sell_base + v_p.premium_cents))
    - (public.units_proceeds_cents(v_low_units,  v_buy_base)  - public.units_proceeds_cents(v_low_units,  v_buy_base  + v_p.premium_cents));
  insert into public.house_ledger (recorded_at, person_id, tick_number, category, amount_cents, details)
  values (p_at, p_person_id, p_tick_number, 'reset', -v_mark_change,
          p_details || jsonb_build_object('inventory_before_units', v_p.market_inventory_units, 'premium_before_cents', v_p.premium_cents,
                                          'high_units', v_high_units, 'low_units', v_low_units, 'open_positions', v_open,
                                          'premium_history_id', v_history_id))
  returning id into v_ledger_id;

  return jsonb_build_object('ok', true, 'person_id', p_person_id, 'changed', true,
                            'inventory_before_units', v_p.market_inventory_units, 'premium_before_cents', v_p.premium_cents,
                            'premium_history_id', v_history_id, 'house_ledger_id', v_ledger_id);
end;
$$;

comment on function public.market_reset_inventory(uuid, timestamptz, bigint, jsonb) is
  'Market controls (2026-10-05): the one reset of a person''s market. Refused (55000) while anyone holds an open position on the person; otherwise inventory and premium to zero, a ''reset'' premium_history row and a ''reset'' house_ledger row. Service role only; admin_reset_market() wraps it with the audit row.';

revoke execute on function public.market_reset_inventory(uuid, timestamptz, bigint, jsonb) from public, anon, authenticated;
grant  execute on function public.market_reset_inventory(uuid, timestamptz, bigint, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 4. Decay: a halt freezes the premium; the flat reset goes through the function
-- -----------------------------------------------------------------------------
-- Body as in 20260925012938 with two changes: the loop leaves a halted person
-- out (halted_until > p_at), and the flat-market reset calls
-- market_reset_inventory(), skipping the person while a position is open.
create or replace function public.apply_market_decay(p_at timestamptz, p_tick_number bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count          integer := 0;
  v_p              record;
  v_params         public.market_tier_settings%rowtype;
  v_k              bigint;
  v_after          bigint;
  v_premium_after  bigint;
  v_high_units     bigint;
  v_low_units      bigint;
  v_sell_base      bigint;
  v_buy_base       bigint;
  v_mark_change    bigint;
begin
  for v_p in
    select p.id, p.current_score, p.spread, p.market_inventory_units, p.premium_cents
      from public.people p
     where p.market_inventory_units <> 0
       -- A HALT FREEZES THE PREMIUM (2026-10-05): no step while the person is
       -- halted; decay resumes from here on the first tick after it lifts.
       and (p.halted_until is null or p.halted_until <= p_at)
     order by p.slug
       for update
  loop
    v_params := public.market_params_for(v_p.id);

    -- THE OFF SWITCH: a flat market (Phase 29b: pricing_mode 'flat', resolved
    -- as a null depth). Any inventory left from before the switch is returned
    -- to zero in one step through the one reset function, which records it
    -- in premium_history and the house book; while anyone holds a position
    -- on the person the reset is refused, so the person is left as they are
    -- until the last position closes.
    if v_params.depth_units is null then
      if exists (select 1 from public.positions l where l.person_id = v_p.id and l.is_open) then
        continue;
      end if;
      perform public.market_reset_inventory(v_p.id, p_at, p_tick_number, jsonb_build_object('source', 'flat_market', 'pricing_mode', v_params.pricing_mode));
      v_count := v_count + 1;
      continue;
    end if;

    v_k := public.market_decay_divisor(v_params.decay_half_life_ticks);
    v_after := public.market_decay_step(v_p.market_inventory_units, v_k);
    v_premium_after := public.market_premium_cents(v_after, v_params.depth_units);

    update public.people
       set market_inventory_units = v_after,
           premium_cents          = v_premium_after
     where id = v_p.id;

    perform public.record_premium_change(v_p.id, p_at, 'decay', v_p.market_inventory_units, v_after, v_params.depth_units, v_p.current_score, p_tick_number, null);

    -- The house book: how the step moved the mark of everything held.
    if v_premium_after <> v_p.premium_cents then
      select coalesce(sum(case when l.direction = 'HIGH' then l.open_units else 0 end), 0),
             coalesce(sum(case when l.direction = 'LOW'  then l.open_units else 0 end), 0)
        into v_high_units, v_low_units
        from public.positions l
       where l.person_id = v_p.id and l.is_open;
      if v_high_units <> 0 or v_low_units <> 0 then
        v_sell_base := public.points_to_cents(v_p.current_score - v_p.spread);
        v_buy_base  := public.points_to_cents(v_p.current_score + v_p.spread);
        v_mark_change :=
            (public.units_proceeds_cents(v_high_units, v_sell_base + v_premium_after) - public.units_proceeds_cents(v_high_units, v_sell_base + v_p.premium_cents))
          - (public.units_proceeds_cents(v_low_units,  v_buy_base  + v_premium_after) - public.units_proceeds_cents(v_low_units,  v_buy_base  + v_p.premium_cents));
        insert into public.house_ledger (recorded_at, person_id, tick_number, category, amount_cents, details)
        values (p_at, v_p.id, p_tick_number, 'decay_mark', -v_mark_change,
                jsonb_build_object('high_units', v_high_units, 'low_units', v_low_units, 'sell_base_cents', v_sell_base, 'buy_base_cents', v_buy_base,
                                   'premium_before_cents', v_p.premium_cents, 'premium_after_cents', v_premium_after,
                                   'inventory_before_units', v_p.market_inventory_units, 'inventory_after_units', v_after, 'divisor', v_k));
      end if;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function public.apply_market_decay(timestamptz, bigint) is
  'Phase 29: one decay step per tick for every person with inventory, recorded in premium_history and (when anything is held) the house book. Since 2026-10-05 a halted person is left out until the halt lifts, and a flat-market reset goes through market_reset_inventory(), refused while a position is open. Service role only.';

-- -----------------------------------------------------------------------------
-- 5. The admin functions: parameters, reset, voids
-- -----------------------------------------------------------------------------

-- A person's market parameter. p_value is JSON: a number, string, boolean, or
-- null to clear an override (never the tier). The column's own CHECK decides
-- the range; the trigger above is opened for this transaction only.
create or replace function public.admin_set_person_market_parameter(
  p_person_id uuid,
  p_parameter text,
  p_value     jsonb,
  p_reason    text,
  p_alert_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.assert_admin();
  v_null   boolean := p_value is null or jsonb_typeof(p_value) = 'null';
  v_text   text := case when p_value is null or jsonb_typeof(p_value) = 'null' then null else p_value #>> '{}' end;
  v_before jsonb;
  v_after  jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if p_parameter not in ('tier', 'pricing_mode_override', 'depth_units_override', 'decay_half_life_ticks_override', 'premium_cap_cents_override', 'shorting_override') then
    raise exception 'p_parameter must be tier, pricing_mode_override, depth_units_override, decay_half_life_ticks_override, premium_cap_cents_override or shorting_override (trading_mode: admin_set_trading_mode)' using errcode = '22023';
  end if;
  if p_parameter = 'tier' and v_null then
    raise exception 'tier cannot be cleared' using errcode = '22023';
  end if;

  perform set_config('momentum.market_write', 'admin', true);

  select to_jsonb(p) -> p_parameter into v_before from public.people p where p.id = p_person_id for update;
  if not found then
    raise exception 'Unknown person %', p_person_id using errcode = 'P0002';
  end if;

  case p_parameter
    when 'tier'                           then update public.people set tier                           = v_text            where id = p_person_id;
    when 'pricing_mode_override'          then update public.people set pricing_mode_override          = v_text            where id = p_person_id;
    when 'depth_units_override'           then update public.people set depth_units_override           = v_text::bigint    where id = p_person_id;
    when 'decay_half_life_ticks_override' then update public.people set decay_half_life_ticks_override = v_text::integer   where id = p_person_id;
    when 'premium_cap_cents_override'     then update public.people set premium_cap_cents_override     = v_text::bigint    where id = p_person_id;
    when 'shorting_override'              then update public.people set shorting_override              = v_text::boolean   where id = p_person_id;
  end case;

  select to_jsonb(p) -> p_parameter into v_after from public.people p where p.id = p_person_id;

  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'set_market_parameter', p_alert_id, p_person_id, left(p_reason, 500),
          jsonb_build_object('parameter', p_parameter, 'from', v_before, 'to', v_after));
  return jsonb_build_object('ok', true, 'person_id', p_person_id, 'parameter', p_parameter, 'from', v_before, 'to', v_after);
end;
$$;

-- A tier's parameter: any column of market_tier_settings but the key. p_value
-- as above; null only for breaker_price_cents (the total-price breaker off).
create or replace function public.admin_set_tier_market_parameter(
  p_tier      text,
  p_parameter text,
  p_value     jsonb,
  p_reason    text,
  p_alert_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.assert_admin();
  v_text   text := case when p_value is null or jsonb_typeof(p_value) = 'null' then null else p_value #>> '{}' end;
  v_type   text;
  v_before jsonb;
  v_after  jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  v_type := case p_parameter
    when 'pricing_mode'                 then 'text'
    when 'depth_units'                  then 'bigint'
    when 'decay_half_life_ticks'        then 'integer'
    when 'premium_cap_cents'            then 'bigint'
    when 'min_hold_seconds'             then 'integer'
    when 'max_order_share_of_depth'     then 'numeric'
    when 'aggregate_exposure_cap_units' then 'bigint'
    when 'breaker_premium_cents'        then 'bigint'
    when 'breaker_window_seconds'       then 'integer'
    when 'breaker_halt_seconds'         then 'integer'
    when 'breaker_price_cents'          then 'bigint'
    when 'shorting_allowed'             then 'boolean'
    when 'alert_on_halt'                then 'boolean'
  end;
  if v_type is null then
    raise exception 'p_parameter must be a market_tier_settings column other than tier' using errcode = '22023';
  end if;
  if v_text is null and p_parameter <> 'breaker_price_cents' then
    raise exception '% cannot be null', p_parameter using errcode = '22023';
  end if;

  perform set_config('momentum.market_write', 'admin', true);

  select to_jsonb(t) -> p_parameter into v_before from public.market_tier_settings t where t.tier = p_tier for update;
  if not found then
    raise exception 'Unknown tier %', p_tier using errcode = 'P0002';
  end if;

  execute format('update public.market_tier_settings set %I = $1::%s, updated_at = now() where tier = $2', p_parameter, v_type)
    using v_text, p_tier;

  select to_jsonb(t) -> p_parameter into v_after from public.market_tier_settings t where t.tier = p_tier;

  insert into public.admin_audit_log (actor_id, action, alert_id, note, details)
  values (v_actor, 'set_tier_parameter', p_alert_id, left(p_reason, 500),
          jsonb_build_object('tier', p_tier, 'parameter', p_parameter, 'from', v_before, 'to', v_after));
  return jsonb_build_object('ok', true, 'tier', p_tier, 'parameter', p_parameter, 'from', v_before, 'to', v_after);
end;
$$;

-- The trading mode, as in 20260925012938, now opening the guard for its own write.
create or replace function public.admin_set_trading_mode(p_person_id uuid, p_mode text, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_before text;
begin
  if p_mode not in ('tradeable', 'display_only', 'paused') then
    raise exception 'p_mode must be tradeable, display_only or paused' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  perform set_config('momentum.market_write', 'admin', true);
  select p.trading_mode into v_before from public.people p where p.id = p_person_id for update;
  if not found then
    raise exception 'Unknown person %', p_person_id using errcode = 'P0002';
  end if;
  update public.people set trading_mode = p_mode where id = p_person_id;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'set_trading_mode', p_alert_id, p_person_id, left(p_reason, 500), jsonb_build_object('from', v_before, 'to', p_mode));
  return jsonb_build_object('ok', true, 'person_id', p_person_id, 'trading_mode', p_mode);
end;
$$;

-- The reset: refused while anyone holds a position; otherwise the one reset
-- function, with the audit row in the same transaction.
create or replace function public.admin_reset_market(p_person_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.assert_admin();
  v_now    timestamptz := now();
  v_tick   bigint;
  v_result jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  select max(t.tick_number) into v_tick from public.engine_ticks t;
  v_result := public.market_reset_inventory(p_person_id, v_now, v_tick,
                jsonb_build_object('source', 'admin_reset', 'actor_id', v_actor, 'reason', left(p_reason, 500)));
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'reset_market', p_alert_id, p_person_id, left(p_reason, 500), v_result - 'ok' - 'person_id');
  return v_result;
end;
$$;

-- The voids: the columns and the audit row in one transaction.
create or replace function public.admin_void_signal(p_signal_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_now   timestamptz := now();
  v_row   record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  perform set_config('momentum.market_write', 'admin', true);
  select s.person_id, s.headline, s.voided_at into v_row from public.signals s where s.id = p_signal_id for update;
  if not found then
    raise exception 'Unknown signal %', p_signal_id using errcode = 'P0002';
  end if;
  if v_row.voided_at is not null then
    raise exception 'Signal % was already voided at %', p_signal_id, v_row.voided_at using errcode = '55000';
  end if;
  update public.signals set voided_at = v_now, void_reason = left(trim(p_reason), 500) where id = p_signal_id;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'void_signal', p_alert_id, v_row.person_id, left(p_reason, 500),
          jsonb_build_object('signal_id', p_signal_id, 'headline', left(v_row.headline, 300), 'voided_at', v_now));
  return jsonb_build_object('ok', true, 'signal_id', p_signal_id, 'person_id', v_row.person_id, 'voided_at', v_now);
end;
$$;

create or replace function public.admin_void_narrative(p_narrative_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_now   timestamptz := now();
  v_row   record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  perform set_config('momentum.market_write', 'admin', true);
  select n.person_id, n.text, n.voided_at into v_row from public.narratives n where n.id = p_narrative_id for update;
  if not found then
    raise exception 'Unknown narrative %', p_narrative_id using errcode = 'P0002';
  end if;
  if v_row.voided_at is not null then
    raise exception 'Narrative % was already voided at %', p_narrative_id, v_row.voided_at using errcode = '55000';
  end if;
  update public.narratives set voided_at = v_now, void_reason = left(trim(p_reason), 500) where id = p_narrative_id;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'void_narrative', p_alert_id, v_row.person_id, left(p_reason, 500),
          jsonb_build_object('narrative_id', p_narrative_id, 'text', left(v_row.text, 300), 'voided_at', v_now));
  return jsonb_build_object('ok', true, 'narrative_id', p_narrative_id, 'person_id', v_row.person_id, 'voided_at', v_now);
end;
$$;

comment on function public.admin_set_person_market_parameter(uuid, text, jsonb, text, uuid) is 'Market controls (2026-10-05): the only way to change a person''s tier, pricing mode, depth, decay half-life, premium cap or shorting override. Audit-logged (set_market_parameter: parameter, from, to) in the same transaction.';
comment on function public.admin_set_tier_market_parameter(text, text, jsonb, text, uuid)   is 'Market controls (2026-10-05): the only way to change a market_tier_settings parameter. Audit-logged (set_tier_parameter: tier, parameter, from, to) in the same transaction.';
comment on function public.admin_reset_market(uuid, text, uuid)                            is 'Market controls (2026-10-05): resets a person''s inventory and premium to zero through market_reset_inventory(); refused while anyone holds a position. Audit-logged (reset_market) in the same transaction.';
comment on function public.admin_void_signal(uuid, text, uuid)                             is 'Market controls (2026-10-05): voids a signal (voided_at, void_reason) and writes the void_signal audit row in the same transaction.';
comment on function public.admin_void_narrative(uuid, text, uuid)                          is 'Market controls (2026-10-05): voids a narrative (voided_at, void_reason) and writes the void_narrative audit row in the same transaction.';

revoke execute on function public.admin_set_person_market_parameter(uuid, text, jsonb, text, uuid) from public, anon;
revoke execute on function public.admin_set_tier_market_parameter(text, text, jsonb, text, uuid)   from public, anon;
revoke execute on function public.admin_reset_market(uuid, text, uuid)                            from public, anon;
revoke execute on function public.admin_void_signal(uuid, text, uuid)                             from public, anon;
revoke execute on function public.admin_void_narrative(uuid, text, uuid)                          from public, anon;
grant  execute on function public.admin_set_person_market_parameter(uuid, text, jsonb, text, uuid) to authenticated, service_role;
grant  execute on function public.admin_set_tier_market_parameter(text, text, jsonb, text, uuid)   to authenticated, service_role;
grant  execute on function public.admin_reset_market(uuid, text, uuid)                            to authenticated, service_role;
grant  execute on function public.admin_void_signal(uuid, text, uuid)                             to authenticated, service_role;
grant  execute on function public.admin_void_narrative(uuid, text, uuid)                          to authenticated, service_role;
