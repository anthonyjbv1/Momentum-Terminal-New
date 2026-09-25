-- Phase 29b — post-ship fixes to the market price.
--
-- 1. FLAT IS A NAMED MODE, NEVER A NULL. Phase 29 let a NULL depth on
--    market_tier_settings stand for "a flat market", and a NULL per-person
--    override already meant "the tier's value" — so one NULL meant two
--    things, and the only way to reach the flat market was an absent number.
--    From here:
--
--      market_tier_settings.pricing_mode   'curve' | 'flat', default 'curve'.
--                                          The explicit opt-in to a flat market.
--      market_tier_settings.depth_units    NOT NULL, > 0. Always a number; a flat
--                                          tier keeps its depth for when it is
--                                          switched back.
--      people.pricing_mode_override        NULL: the tier's mode. 'curve' or
--                                          'flat' overrides it for one person.
--      people.depth_units_override         NULL: the tier's depth (unchanged).
--
--    market_params_for() resolves both. Its depth_units is NULL EXACTLY WHEN
--    the effective mode is 'flat' — that resolved NULL is the signal
--    place_order(), apply_market_decay() and the client's preview already
--    read as "flat", so none of them change; what changes is that it can now
--    only come from the named mode. Switching a person or tier to 'flat' is
--    the soft rollback of Phase 29: Phase 27 prices at the next order, and the
--    next tick returns any inventory to zero with a 'reset' premium row.
--
-- 2. THE PORTFOLIO'S BOOK. portfolio_summary_for() now carries, per
--    position, the same book trade_quote() gives the profile — base prices,
--    inventory, resolved depth, premium cap, pricing mode — so the portfolio's
--    close sheet previews the walk down the curve (average and worst fill)
--    and quotes the average, exactly as the profile's sheet does.
--
-- Nothing here writes a score, a price, an inventory or a premium.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The tier's pricing mode; depth always a number
-- ---------------------------------------------------------------------------
alter table public.market_tier_settings
  add column pricing_mode text not null default 'curve';

-- A tier Phase 29 had switched off with a NULL depth keeps that choice, now
-- by name, and gets its shipped depth back so the column can be NOT NULL.
-- (None is NULL on production when this ships; the statement is for any
-- other database.)
update public.market_tier_settings
   set pricing_mode = 'flat',
       depth_units  = case tier when 'private_individual' then 100000 else 300000 end,
       updated_at   = now()
 where depth_units is null;

alter table public.market_tier_settings
  alter column depth_units set not null,
  drop constraint market_tier_settings_depth_positive,
  add constraint market_tier_settings_depth_positive check (depth_units > 0),
  add constraint market_tier_settings_pricing_mode check (pricing_mode in ('curve', 'flat'));

comment on table public.market_tier_settings is
  'Phase 29: the market price''s parameters per subject tier. Pricing mode (Phase 29b: ''curve'', or ''flat'' — the explicit opt-in to a flat market at Phase 27 prices, no premium and no impact), depth (units per point of premium; always a number, kept while flat), decay half-life (ticks), premium cap, minimum hold, largest order as a share of depth, the platform''s aggregate exposure cap, the premium breaker (X cents in Y seconds halts Z seconds), the total-price breaker (private individuals only), whether the tier may ever be shorted, and whether a halt alerts. Service-role writes only; every value is read at order time.';
comment on column public.market_tier_settings.pricing_mode is
  'Phase 29b: ''curve'' (the cost curve and the premium) or ''flat'' (a flat market at Phase 27 prices: no premium, no impact; the next tick resets any inventory). The ONLY way to a flat market; a person''s pricing_mode_override can say otherwise for one person.';
comment on column public.market_tier_settings.depth_units is
  'Units of inventory per point of premium (300,000 units = 300 shares move the price one point). Never NULL (Phase 29b): a flat market is pricing_mode, not an absent depth.';

-- ---------------------------------------------------------------------------
-- 2. The person's override of the mode
-- ---------------------------------------------------------------------------
alter table public.people
  add column pricing_mode_override text;

alter table public.people
  add constraint people_pricing_mode_override_check check (pricing_mode_override is null or pricing_mode_override in ('curve', 'flat'));

comment on column public.people.pricing_mode_override is
  'Phase 29b: per-person pricing mode overriding the tier''s. Null: the tier''s. ''flat'' puts one person on a flat market; ''curve'' keeps one person on the curve while the tier is flat.';
comment on column public.people.depth_units_override is
  'Phase 29: per-person depth (units per point), overriding the tier''s. Null: the tier''s depth — never a flat market (Phase 29b: flat is pricing_mode_override).';
comment on column public.trade_orders.depth_units is
  'Phase 29: the depth in force. NULL marks an order filled flat: pre-Phase-29, or while the person''s effective pricing mode was ''flat''.';

-- ---------------------------------------------------------------------------
-- 3. The resolution
-- ---------------------------------------------------------------------------
-- The parameters a person's market runs on: the tier's row with the person's
-- overrides applied. A NULL override is the tier's value, always. The
-- returned pricing_mode is the EFFECTIVE mode, and the returned depth_units
-- is NULL exactly when that mode is 'flat' — the one flat signal every
-- caller reads.
create or replace function public.market_params_for(p_person_id uuid)
returns public.market_tier_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_params public.market_tier_settings%rowtype;
  v_person record;
begin
  select p.tier, p.pricing_mode_override, p.depth_units_override, p.decay_half_life_ticks_override, p.premium_cap_cents_override, p.shorting_override
    into v_person
    from public.people p
   where p.id = p_person_id;
  if not found then
    raise exception 'market_params_for: unknown person %', p_person_id using errcode = 'P0002';
  end if;
  select t.* into v_params from public.market_tier_settings t where t.tier = v_person.tier;
  if not found then
    raise exception 'market_params_for: no market_tier_settings row for tier %', v_person.tier using errcode = 'P0002';
  end if;
  v_params.pricing_mode          := coalesce(v_person.pricing_mode_override, v_params.pricing_mode);
  v_params.depth_units           := case when v_params.pricing_mode = 'flat' then null
                                         else coalesce(v_person.depth_units_override, v_params.depth_units) end;
  v_params.decay_half_life_ticks := coalesce(v_person.decay_half_life_ticks_override, v_params.decay_half_life_ticks);
  v_params.premium_cap_cents     := coalesce(v_person.premium_cap_cents_override, v_params.premium_cap_cents);
  v_params.shorting_allowed      := coalesce(v_person.shorting_override, v_params.shorting_allowed);
  return v_params;
end;
$$;

comment on function public.market_params_for(uuid) is
  'Phase 29 / 29b: the market parameters one person trades on — the tier''s row with the person''s overrides applied (a NULL override is the tier''s value). pricing_mode is the effective mode; depth_units is NULL exactly when it is ''flat''.';

revoke execute on function public.market_params_for(uuid) from public, anon;
grant  execute on function public.market_params_for(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The quote names the mode
-- ---------------------------------------------------------------------------
create or replace function public.trade_quote(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'person_id',        p.id,
           'score',            p.current_score,
           'spread',           p.spread,
           'buy_cents',        public.points_to_cents(p.buy_price),
           'sell_cents',       public.points_to_cents(p.sell_price),
           'base_buy_cents',   public.points_to_cents(p.current_score + p.spread),
           'base_sell_cents',  public.points_to_cents(p.current_score - p.spread),
           'premium_cents',    p.premium_cents,
           'market_price',     p.market_price,
           'inventory_units',  p.market_inventory_units,
           'depth_units',      m.depth_units,
           'premium_cap_cents', m.premium_cap_cents,
           'pricing_mode',     m.pricing_mode,
           'tier',             p.tier,
           'trading_mode',     p.trading_mode,
           'halted_until',     case when p.halted_until > now() then p.halted_until end,
           'halt_reason',      case when p.halted_until > now() then p.halt_reason end,
           'tolerance_cents',  (select s.price_tolerance_cents from public.platform_settings s where s.id),
           'units_per_share',  public.units_per_share(),
           'as_of',            now()
         )
    from public.people p
   cross join lateral public.market_params_for(p.id) m
   where p.id = p_person_id
     and p.is_active;
$$;

comment on function public.trade_quote(uuid) is
  'Phase 29: the current Buy and Sell quotes (market price ± half-spread) in integer cents, the base prices without the premium, the premium, the dealer inventory and depth the cost curve runs on (depth null exactly when pricing_mode is ''flat'', Phase 29b), the tier, the trading mode and any halt. Null for an unknown or inactive person.';

revoke execute on function public.trade_quote(uuid) from public, anon;
grant  execute on function public.trade_quote(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The portfolio carries each position's book
-- ---------------------------------------------------------------------------
-- As in 20260925012938 plus base_buy_cents, base_sell_cents, inventory_units,
-- depth_units, premium_cap_cents and pricing_mode per position, resolved by
-- market_params_for() exactly as trade_quote() resolves them.
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
           p.slug, p.display_name, p.category, p.avatar_url, p.is_active, p.current_score, p.spread, p.premium_cents, p.market_price,
           p.trading_mode, case when p.halted_until > v_now then p.halted_until end as halted_until,
           public.points_to_cents(p.buy_price)  as buy_cents,
           public.points_to_cents(p.sell_price) as sell_cents,
           public.points_to_cents(p.current_score + p.spread) as base_buy_cents,
           public.points_to_cents(p.current_score - p.spread) as base_sell_cents,
           p.market_inventory_units as inventory_units,
           mp.depth_units, mp.premium_cap_cents, mp.pricing_mode,
           case when lo.direction = 'HIGH' then public.points_to_cents(p.sell_price)
                                          else public.points_to_cents(p.buy_price) end as mark_cents,
           (select coalesce(sum(c.pnl_cents), 0)::bigint
              from public.position_closes c
             where c.user_id = p_user_id and c.person_id = lo.person_id) as realized_cents
      from lots lo
      join public.people p on p.id = lo.person_id
     cross join lateral public.market_params_for(p.id) mp
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
           'premium_cents',        v.premium_cents,
           'market_price',         v.market_price,
           'trading_mode',         v.trading_mode,
           'halted_until',         v.halted_until,
           'buy_cents',            v.buy_cents,
           'sell_cents',           v.sell_cents,
           'base_buy_cents',       v.base_buy_cents,
           'base_sell_cents',      v.base_sell_cents,
           'inventory_units',      v.inventory_units,
           'depth_units',          v.depth_units,
           'premium_cap_cents',    v.premium_cap_cents,
           'pricing_mode',         v.pricing_mode,
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
    'units_per_share',       public.units_per_share(),
    'positions',             v_positions
  );
end;
$function$;

revoke execute on function public.portfolio_summary_for(uuid) from public, anon, authenticated;
grant  execute on function public.portfolio_summary_for(uuid) to service_role;
