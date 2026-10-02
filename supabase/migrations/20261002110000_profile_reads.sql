-- =============================================================================
-- Momentum Terminal — the profile route's reads (2026-10-02).
--
-- Display only. Nothing here scores, ticks, trades or prices: the two
-- functions below are what the person page reads, rewritten so the page
-- stops waiting on the database.
--
-- 1. person_market_series(): THE SAME ROWS, ONE JOIN. The Phase 29 version
--    called premium_cents_at() twice per bucket — about 1,180 calls per
--    profile load, each a separate indexed lookup the planner could not
--    inline — and sorted the person's whole history to pick each bucket's
--    first and last tick. Measured on 2026-09-30 and again on 2026-10-02:
--    the "all" range alone took 1 to 9 seconds for Elon Musk.
--
--    This version keeps the buckets exactly as they were (same width_bucket
--    over the same span, same points cap) and reads the premium ONCE: the
--    person's premium_history becomes a set of segments — each change holds
--    from its recorded_at until the next change, and a leading segment from
--    the beginning of time carries what the first change started from — and
--    each bucket edge joins the segment it falls in. That is the rule
--    premium_cents_at() applies (the latest change at or before the instant,
--    else what the first change after it started from, else the person's
--    current premium, else 0), written as one join instead of a call per
--    row. A bucket's score and open are read back from score_history by the
--    edge's own recorded_at, so every plotted value is a recorded tick:
--    nothing is interpolated, on any range. The output for 1h, 24h and 7d
--    is identical to the Phase 29 function's, row for row; the "all" range
--    reads the same buckets too (the cost was the per-row calls, not the
--    rows), so it is identical as well.
--
-- 2. person_profile_header(): THE SLUG LOOKUP IN ONE ROUND TRIP. The page
--    resolved a slug with three sequential queries (the person, the avatar
--    credit's mapping configs, then trade_quote), each a cross-country round
--    trip before anything rendered. This returns all three, plus the person's
--    newest score_history row (the forces panel's anchor), in one call.
--    trade_quote() is called unchanged; the quote is the same quote.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- person_market_series(), premium joined once
-- -----------------------------------------------------------------------------
create or replace function public.person_market_series(
  p_person_id uuid,
  p_since     timestamptz default null,
  p_points    integer     default 120
)
returns table (
  bucket_at    timestamptz,
  score        numeric,
  open         numeric,
  market       numeric,
  market_open  numeric,
  samples      integer
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
    select coalesce(p_since, (select min(sh.recorded_at)
                                from public.score_history sh
                               where sh.person_id = p_person_id)) as from_at,
           now() as to_at
  ),
  ranked as (
    select sh.recorded_at,
           width_bucket(
             extract(epoch from sh.recorded_at),
             extract(epoch from s.from_at),
             extract(epoch from s.to_at) + 0.001,
             (select points from params)
           ) as bucket
      from public.score_history sh
      cross join span s
     where sh.person_id = p_person_id
       and s.from_at is not null
       and sh.recorded_at >= s.from_at
       and sh.recorded_at <= s.to_at
  ),
  -- Each bucket's edges: the time of its last tick and of its first.
  edges as (
    select max(r.recorded_at) as bucket_at,
           min(r.recorded_at) as opened_at,
           count(*)::int      as samples
      from ranked r
     group by r.bucket
  ),
  -- The premium's history as segments: each change holds from its moment
  -- until the next change (a zero-width segment, two changes in one instant,
  -- matches nothing, so the later change wins, as the ordered lookup did).
  changes as (
    select ph.recorded_at, ph.id, ph.premium_before_cents, ph.premium_after_cents
      from public.premium_history ph
     where ph.person_id = p_person_id
  ),
  segments as (
    select c.recorded_at                                            as from_at,
           lead(c.recorded_at) over (order by c.recorded_at, c.id) as until_at,
           c.premium_after_cents                                   as premium
      from changes c
    union all
    -- Before the first change: what that change started from.
    select '-infinity'::timestamptz, f.recorded_at, f.premium_before_cents
      from (select c.recorded_at, c.premium_before_cents from changes c order by c.recorded_at, c.id limit 1) f
  ),
  -- A person with no premium history yet: their current premium, else 0.
  fallback as (
    select coalesce((select p.premium_cents from public.people p where p.id = p_person_id), 0) as premium
  )
  select e.bucket_at,
         last_tick.score                                                        as score,
         first_tick.score                                                       as open,
         last_tick.score  + coalesce(at_last.premium,  fb.premium) * 0.01       as market,
         first_tick.score + coalesce(at_first.premium, fb.premium) * 0.01       as market_open,
         e.samples
    from edges e
    cross join fallback fb
    -- The recorded score at each edge: a tick that was written, never a value between ticks.
    cross join lateral (
      select sh.score from public.score_history sh
       where sh.person_id = p_person_id and sh.recorded_at = e.bucket_at
       order by sh.tick_number desc limit 1
    ) last_tick
    cross join lateral (
      select sh.score from public.score_history sh
       where sh.person_id = p_person_id and sh.recorded_at = e.opened_at
       order by sh.tick_number asc limit 1
    ) first_tick
    left join segments at_last  on e.bucket_at >= at_last.from_at  and (at_last.until_at  is null or e.bucket_at < at_last.until_at)
    left join segments at_first on e.opened_at >= at_first.from_at and (at_first.until_at is null or e.opened_at < at_first.until_at)
   order by e.bucket_at;
$$;

comment on function public.person_market_series(uuid, timestamptz, integer) is
  'Phase 29: person_score_series with the market price beside the score — each slice''s last score plus the premium as it stood at that tick (market) and its first score plus the premium then (market_open). Empty slices are omitted. Rewritten 2026-10-02 to join the premium history once per bucket edge instead of calling premium_cents_at() per row; same rows, same values.';

revoke execute on function public.person_market_series(uuid, timestamptz, integer) from public, anon;
grant  execute on function public.person_market_series(uuid, timestamptz, integer) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- person_profile_header(p_slug): the person, the avatar mapping configs, the
-- quote and the newest tick, in one call. Null for an unknown or inactive slug.
-- -----------------------------------------------------------------------------
create or replace function public.person_profile_header(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'person', jsonb_build_object(
             'id', p.id, 'slug', p.slug, 'display_name', p.display_name, 'category', p.category, 'avatar_url', p.avatar_url,
             'current_score', p.current_score, 'revert_target', p.revert_target, 'target_offset', p.target_offset, 'spread', p.spread,
             'buy_price', p.buy_price, 'sell_price', p.sell_price, 'created_at', p.created_at, 'last_tick_at', p.last_tick_at,
             'forecast_paused', p.forecast_paused, 'premium_cents', p.premium_cents, 'market_price', p.market_price,
             'market_inventory_units', p.market_inventory_units, 'tier', p.tier, 'trading_mode', p.trading_mode,
             'halted_until', p.halted_until, 'halt_reason', p.halt_reason, 'max_allocation_cents', p.max_allocation_cents,
             'depth_units_override', p.depth_units_override, 'decay_half_life_ticks_override', p.decay_half_life_ticks_override,
             'premium_cap_cents_override', p.premium_cap_cents_override, 'pricing_mode_override', p.pricing_mode_override,
             'shorting_override', p.shorting_override
           ),
           -- The avatar block of every active mapping that carries one; the page matches it to avatar_url for the credit.
           'avatar_configs', coalesce((
             select jsonb_agg(jsonb_build_object('avatar', ds.config -> 'avatar'))
               from public.person_data_sources ds
              where ds.person_id = p.id and ds.is_active and ds.config ? 'avatar'
           ), '[]'::jsonb),
           'quote', public.trade_quote(p.id),
           'latest_tick', (
             select jsonb_build_object('tick_number', sh.tick_number, 'recorded_at', sh.recorded_at)
               from public.score_history sh
              where sh.person_id = p.id
              order by sh.recorded_at desc, sh.tick_number desc
              limit 1
           )
         )
    from public.people p
   where p.slug = p_slug
     and p.is_active;
$$;

comment on function public.person_profile_header(text) is
  'The person page''s slug lookup in one round trip (2026-10-02): the person row the page reads, the avatar blocks of their active mappings, trade_quote() and their newest score_history row. Null for an unknown or inactive slug. Server-only.';

revoke execute on function public.person_profile_header(text) from public, anon, authenticated;
grant  execute on function public.person_profile_header(text) to service_role;
