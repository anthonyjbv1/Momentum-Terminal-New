-- PHASE 18+ — the volume denominator counts EVENTS, not sampling artifacts.
--
-- person_signal_volume() feeds the per-person volume weight: how unusual is
-- today's flow of signals for this person, against their own trailing days.
-- The weight multiplies every event signal's impact, so the series must count
-- exactly the signals the weight multiplies. Two kinds were already out
-- (metric and baseline, which carry their own baselines or none). Three more
-- go out now, and the rule behind all five is one rule:
--
--   A SIGNAL COUNTS WHEN ITS RATE IS SET BY THE WORLD, NOT BY OUR POLLING.
--
-- Halve the poll interval and ask what changes. An article does not (a story
-- is published once and deduplicated). A stream summary does not (one per
-- broadcast). A game result does not (one per game). A Form 4 does not.
-- Those are events: they count, and they carry the weight.
--
-- But a comment digest DOES: it is emitted once per video per poll whenever
-- the top-comment sample has churned, so its rate is the poll cadence and
-- YouTube's like ranking, never anything about the person. A live moment does
-- too: it is the live cron's own sampling of a session, bounded by a cooldown
-- that is itself a sampling parameter. The legacy per-comment signals of the
-- same connector (kind 'comment', not emitted since Phase 8+) are the same
-- family. Those are artifacts: they count for nothing and carry no weight.
--
-- Measured before this change: 80 of MrBeast's 92 event signals over
-- 2026-09-14..17 were comment digests, every one of them at 0.000 impact, and
-- all 80 sat in the denominator of his own volume weight — so his real
-- coverage was being scaled down by his viewers' chatter. His seven-day
-- series goes {1,6,4,16,38,27,12} -> {1,0,0,1,6,3,1}, mean 14.86 -> 1.71. He
-- is the only person the change moves; nobody else has a signal of these
-- kinds.
--
-- Phase 16 had already taken the live moment out of this function for exactly
-- this reason, and out of the weight in lib/engine/forces/signals.ts. What it
-- did not do was write the rule down once: the comment digest went on being
-- counted AND weighted, so a person with little news would have had their own
-- viewers' chatter amplified by their thin coverage. The two sides are now one
-- set, held in lib/engine/signal-volume.ts as UNCOUNTED_SIGNAL_KINDS, and a
-- test fails if this function and that array ever disagree again.
--
-- tracked_since is NOT touched: the regime clocks stay honest, and the
-- baseline still becomes sufficient seven complete days after each person's
-- newest mapping.

create or replace function public.person_signal_volume(p_days integer default 14)
returns table (person_id uuid, tracked_since timestamptz, current_24h bigint, daily bigint[])
language sql
stable
security definer
set search_path = ''
as $$
  with tracked as (
    select m.person_id, max(m.created_at) as tracked_since
      from public.person_data_sources m
      join public.people p on p.id = m.person_id and p.is_active
     where m.is_active
     group by m.person_id
  ),
  bounds as (
    select t.person_id, t.tracked_since,
           greatest((t.tracked_since at time zone 'utc')::date + 1, (now() at time zone 'utc')::date - greatest(p_days, 1)) as first_day,
           (now() at time zone 'utc')::date - 1 as last_day
      from tracked t
  ),
  counts as (
    select s.person_id, (s.occurred_at at time zone 'utc')::date as day, count(*) as n
      from public.signals s
     where s.occurred_at >= now() - (greatest(p_days, 1) + 2) * interval '1 day'
       and coalesce(s.raw_payload ->> 'kind', '') <> all (array['metric', 'baseline', 'comment_digest', 'comment', 'live_moment'])
     group by s.person_id, (s.occurred_at at time zone 'utc')::date
  )
  select b.person_id,
         b.tracked_since,
         (select count(*) from public.signals s
           where s.person_id = b.person_id
             and s.occurred_at >= now() - interval '24 hours'
             and coalesce(s.raw_payload ->> 'kind', '') <> all (array['metric', 'baseline', 'comment_digest', 'comment', 'live_moment'])) as current_24h,
         coalesce(
           (select array_agg(coalesce(c.n, 0) order by d.day)
              from generate_series(b.first_day::timestamp, b.last_day::timestamp, interval '1 day') as d(day)
              left join counts c on c.person_id = b.person_id and c.day = d.day::date
             where b.first_day <= b.last_day),
           '{}'::bigint[]) as daily
    from bounds b;
$$;

comment on function public.person_signal_volume(integer) is
  'Per active person: the start of their current volume regime (newest active mapping), event signals in the trailing 24 h, and event signals per complete UTC day since then (oldest first, at most p_days). Counts a signal only when its rate is set by the world rather than by our polling: articles, stream summaries, game results, filings. Metric and baseline signals carry their own baselines or none; comment digests, legacy per-comment signals and live moments are the connectors'' own sampling and are neither counted here nor weighted by the result (lib/engine/signal-volume.ts, UNCOUNTED_SIGNAL_KINDS). Feeds the Engine''s per-person volume weight. Service role only.';

revoke execute on function public.person_signal_volume(integer) from public, anon, authenticated;
grant  execute on function public.person_signal_volume(integer) to service_role;
