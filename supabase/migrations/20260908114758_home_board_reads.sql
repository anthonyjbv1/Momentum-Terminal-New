-- =============================================================================
-- Momentum Terminal — Phase 6b: read support for the Home board
--
-- Home ranks every active person and shows how each has moved recently. Doing
-- that in TypeScript would mean pulling every score_history row in the window
-- (16 people x 120 ticks an hour, growing forever), so the aggregation lives
-- here instead: one round trip, bounded output, index-friendly.
--
-- Plus two indexes for the desktop feed rail, which reads the newest signals
-- and narratives across all people. Both tables only had per-person indexes,
-- so an unfiltered "newest first" read would have gone to a sequential scan
-- as they fill.
-- =============================================================================

-- home_momentum ----------------------------------------------------------------
-- Per active person, over the trailing window: the change in score, how many
-- history points that change is based on, and a downsampled sparkline series.
--
-- The per-person LATERAL with a LIMIT rides score_history_person_recorded_idx
-- (person_id, recorded_at) and caps how much is read no matter how dense the
-- ticks are. The sample is then bucketed by row position — not by time — so
-- the sparkline has a stable point count whether the Engine has been running
-- for a minute or a month.
--
-- People with no history in the window return no row at all; the caller treats
-- a missing person as "no movement yet" rather than a change of zero, so a
-- dormant board reads as flat rather than as genuinely unchanged.
create or replace function public.home_momentum(
  p_window interval default interval '1 hour',
  p_points integer  default 24,
  p_sample integer  default 240
)
returns table (
  person_id uuid,
  change    numeric,
  points    integer,
  sparkline numeric[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select least(greatest(coalesce(p_points, 24), 2), 120)  as points,
           least(greatest(coalesce(p_sample, 240), 2), 2000) as sample_size
  ),
  sample as (
    select p.id as person_id,
           h.score,
           row_number() over (partition by p.id order by h.recorded_at) as rn,
           count(*)     over (partition by p.id)                        as total
      from public.people p
      join lateral (
        select sh.score, sh.recorded_at
          from public.score_history sh
         where sh.person_id = p.id
           and sh.recorded_at >= now() - p_window
         order by sh.recorded_at desc
         limit (select sample_size from params)
      ) h on true
     where p.is_active
  ),
  bounds as (
    select s.person_id,
           max(s.total)::int                            as points,
           max(s.score) filter (where s.rn = 1)         as first_score,
           max(s.score) filter (where s.rn = s.total)   as last_score
      from sample s
     group by s.person_id
  ),
  spark as (
    select x.person_id, array_agg(x.score order by x.bucket) as sparkline
      from (
        select distinct on (b.person_id, b.bucket)
               b.person_id, b.bucket, b.score, b.rn
          from (
            select s.*,
                   width_bucket(s.rn::numeric, 1, s.total + 1, (select points from params)) as bucket
              from sample s
          ) b
         order by b.person_id, b.bucket, b.rn desc
      ) x
     group by x.person_id
  )
  select b.person_id,
         case when b.points >= 2 then b.last_score - b.first_score end,
         b.points,
         coalesce(s.sparkline, array[]::numeric[])
    from bounds b
    left join spark s on s.person_id = b.person_id;
$$;

comment on function public.home_momentum(interval, integer, integer) is
  'Home board read side: per active person, the score change over the trailing window, the number of history points behind it, and a downsampled sparkline. People with no history in the window are omitted.';

revoke execute on function public.home_momentum(interval, integer, integer) from public, anon;
grant  execute on function public.home_momentum(interval, integer, integer) to authenticated, service_role;

-- Feed rail indexes -------------------------------------------------------------
create index if not exists signals_occurred_at_idx
  on public.signals (occurred_at desc);

create index if not exists narratives_created_at_idx
  on public.narratives (created_at desc);
