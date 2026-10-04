-- =============================================================================
-- THE FEED'S SPARKLINES IN ONE READ (2026-10-04, the tab-switch lag fix).
--
-- The Feed's first page drew one person_score_series() call per person on
-- the page: six to sixteen concurrent PostgREST requests of about 25 ms
-- each, and the connection-pool pressure behind the multi-second tail the
-- 10-03 audit measured. person_score_series_many() is the same bucketing,
-- for a set of people, in one statement: the same window (p_since to now),
-- the same number of slices, the same last-tick-per-slice value, with the
-- person id beside each row. Display only; nothing here writes, and
-- person_score_series() itself is untouched.
-- =============================================================================

create or replace function public.person_score_series_many(
  p_person_ids uuid[],
  p_since      timestamptz,
  p_points     integer default 120
)
returns table (
  person_id   uuid,
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
    select least(greatest(coalesce(p_points, 120), 2), 1000) as points,
           p_since as from_at,
           now()   as to_at
  ),
  ranked as (
    select sh.person_id,
           sh.score,
           sh.recorded_at,
           width_bucket(
             extract(epoch from sh.recorded_at),
             extract(epoch from s.from_at),
             extract(epoch from s.to_at) + 0.001,
             s.points
           ) as bucket
      from public.score_history sh
      cross join params s
     where sh.person_id = any (p_person_ids)
       and s.from_at is not null
       and sh.recorded_at >= s.from_at
       and sh.recorded_at <= s.to_at
  )
  select r.person_id,
         max(r.recorded_at)                                        as bucket_at,
         (array_agg(r.score order by r.recorded_at desc))[1]       as score,
         (array_agg(r.score order by r.recorded_at asc))[1]        as open,
         count(*)::int                                              as samples
    from ranked r
   group by r.person_id, r.bucket
   order by r.person_id, bucket_at;
$$;

comment on function public.person_score_series_many(uuid[], timestamptz, integer) is
  'The Feed''s sparklines (2026-10-04): person_score_series() for a set of people in one statement, same window, same slices, same values, the person id beside each row. p_since is required (the Feed always passes the page''s span). Read-only.';

revoke execute on function public.person_score_series_many(uuid[], timestamptz, integer) from public, anon;
grant  execute on function public.person_score_series_many(uuid[], timestamptz, integer) to authenticated, service_role;
