-- =============================================================================
-- Momentum Terminal — Phase 6c: read support for the person profile page
--
-- The profile chart shows one person's score over a chosen range (1H, 24H,
-- 7D, ALL). At two ticks a minute the raw history for a week is ~20k rows,
-- so the page never pulls it: the database buckets the range into a bounded
-- number of time slices and returns one point per slice that has data.
-- =============================================================================

-- person_score_series -----------------------------------------------------------
-- One person's score_history over the trailing window, downsampled by TIME:
-- the window is cut into p_points equal slices and each slice that contains
-- at least one tick returns its last score (plus its first, `open`, so the
-- change over the window is first tick to last tick exactly). Slices with no
-- ticks return nothing (the chart draws a gap, never an invented flat line),
-- and a person with no history in the window returns no rows at all.
--
-- p_since null means "all history": the window starts at the person's first
-- recorded tick. The read rides score_history_person_recorded_idx
-- (person_id, recorded_at).
create or replace function public.person_score_series(
  p_person_id uuid,
  p_since     timestamptz default null,
  p_points    integer     default 120
)
returns table (
  bucket_at   timestamptz,
  score       numeric,
  open        numeric,
  samples     integer
)
language sql
stable
security invoker
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
    select sh.score,
           sh.recorded_at,
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
  )
  select max(r.recorded_at)                                        as bucket_at,
         (array_agg(r.score order by r.recorded_at desc))[1]       as score,
         (array_agg(r.score order by r.recorded_at asc))[1]        as open,
         count(*)::int                                              as samples
    from ranked r
   group by r.bucket
   order by bucket_at;
$$;

comment on function public.person_score_series(uuid, timestamptz, integer) is
  'Profile chart read side: one person''s score history since p_since (null = all), downsampled by time into at most p_points slices; each slice reports the time and value of its last tick, the value of its first tick (open) and how many ticks it holds. Empty slices are omitted.';

revoke execute on function public.person_score_series(uuid, timestamptz, integer) from public, anon;
grant  execute on function public.person_score_series(uuid, timestamptz, integer) to authenticated, service_role;
