-- =============================================================================
-- Momentum Terminal — entity disambiguation on person-scoped feeds.
--
-- THE DEFECT. A person-scoped news feed searches for a NAME, and a name is not
-- an identifier. The Drake feed returned
--
--     "Michigan State Adds Non-Conference Game Against Drake"
--
-- which is Drake University's athletics programme, not the musician. This is
-- worse than the junk-publisher problem Phase 8 solved: roundtable.io is a
-- legitimate outlet, so the allowlist cannot catch it, and the item is a real
-- distinct story, so story dedup cannot either. It inflates news_volume_24h —
-- a metric being baselined right now — and it hands the sentiment scorer text
-- about a different entity, so a Drake University loss reads as bad news about
-- the artist.
--
-- It is not a Drake edge case. It is structural for any subject who shares a
-- name with another entity, and it gets worse as the roster moves toward
-- consenting individuals, most of whom are not globally unique strings.
--
-- WHERE THE RULES LIVE. person_data_sources.config — the per-SUBJECT half of a
-- source's configuration, where data_sources.config is the per-SOURCE half.
-- "Which other Drake is this" is a fact about Drake, not about RSS. Adding a
-- term is an update to one row; it must never need a deploy.
-- =============================================================================

alter table public.person_data_sources
  add column if not exists config jsonb;

comment on column public.person_data_sources.config is
  'Per-subject configuration for this source. `disambiguation.exclude_terms` refuses items naming a different entity that shares the subject''s name; `disambiguation.require_any`, when set, admits only items carrying at least one context term. Applied at the query level where the feed supports negative terms, and as a post-fetch filter over the headline and outlet.';

-- Counters, so a refusal is as visible as a blocked domain ---------------------
alter table public.source_polls add column if not exists excluded_filtered integer not null default 0;
alter table public.ingest_runs  add column if not exists excluded_filtered integer not null default 0;

comment on column public.source_polls.excluded_filtered is
  'Items refused by entity disambiguation before they became signals. Over-filtering shows up here as a count that climbs while signals_created falls.';

create or replace view public.source_health with (security_invoker = true) as
select d.id            as data_source_id,
       d.name,
       d.display_name,
       d.tier,
       d.is_active,
       d.poll_interval_minutes,
       (select count(*) from public.person_data_sources pds where pds.data_source_id = d.id and pds.is_active) as people_mapped,
       last.last_poll_at,
       last.last_success_at,
       last.last_error_at,
       last.last_error,
       last.last_skip_reason,
       day.polls_24h,
       day.errors_24h,
       case when day.polls_24h > 0 then round(day.errors_24h::numeric / day.polls_24h, 4) else null end as error_rate_24h,
       day.avg_latency_ms_24h,
       day.signals_24h,
       day.blocked_24h,
       day.collapsed_24h,
       day.excluded_24h
  from public.data_sources d
  cross join lateral (
    select (select max(p.finished_at) from public.source_polls p where p.data_source_id = d.id)                                              as last_poll_at,
           (select max(p.finished_at) from public.source_polls p where p.data_source_id = d.id and p.status = 'ok' and p.person_id is not null) as last_success_at,
           (select max(p.finished_at) from public.source_polls p where p.data_source_id = d.id and p.status = 'error')                       as last_error_at,
           (select p.reason from public.source_polls p where p.data_source_id = d.id and p.status = 'error' order by p.finished_at desc limit 1) as last_error,
           (select p.reason from public.source_polls p where p.data_source_id = d.id and p.status = 'skipped' order by p.finished_at desc limit 1) as last_skip_reason
  ) as last
  cross join lateral (
    select count(*) filter (where p.person_id is not null)                        as polls_24h,
           count(*) filter (where p.status = 'error')                             as errors_24h,
           round(avg(p.latency_ms) filter (where p.status = 'ok'))                as avg_latency_ms_24h,
           coalesce(sum(p.signals_created), 0)                                    as signals_24h,
           coalesce(sum(p.blocked_dropped), 0)                                    as blocked_24h,
           coalesce(sum(p.duplicates_collapsed), 0)                               as collapsed_24h,
           coalesce(sum(p.excluded_filtered), 0)                                  as excluded_24h
      from public.source_polls p
     where p.data_source_id = d.id
       and p.finished_at >= now() - interval '24 hours'
  ) as day;

revoke all on public.source_health from anon, authenticated;

-- Drake ------------------------------------------------------------------------
-- The terms fall into two groups, and the second is the one that matters.
--
-- NAMES of the other entities: "drake university", "drake bulldogs", "drake
-- relays" (its track meet), plus two people the feed genuinely confuses him
-- with — Drake Maye, an NFL quarterback whose name now collides with the sports
-- outlets seeded in Phase 10, and Drake Bell, an actor.
--
-- The DISCOURSE the wrong entity lives in, because the real production example
-- named none of the above: "Michigan State Adds Non-Conference Game Against
-- Drake" gives itself away only through "non-conference". Collegiate athletics
-- vocabulary — "non-conference", "missouri valley" (Drake's conference), "ncaa
-- tournament" — catches the items that name the university only as "Drake".
--
-- Deliberately NOT seeded: a bare "ncaa" (he could legitimately perform at a
-- Final Four), "college" (too common in music writing), and any require_any
-- list. A legitimate story — "Drake sued over sample" — often carries none of
-- the obvious context words, and refusing a real signal is worse than admitting
-- a rare wrong one. What no substring rule can catch is an item naming neither
-- entity nor context, such as "Drake beats Bradley 70-65"; that limit is real
-- and require_any is the lever if it ever becomes worth the trade.
update public.person_data_sources pds
   set config = coalesce(pds.config, '{}'::jsonb) || jsonb_build_object(
         'disambiguation', jsonb_build_object(
           'exclude_terms', jsonb_build_array(
             'drake university', 'drake bulldogs', 'drake relays', 'drake law',
             'drake maye', 'drake bell',
             'non-conference', 'missouri valley', 'ncaa tournament'
           ),
           'require_any', jsonb_build_array()
         )
       )
  from public.people p, public.data_sources d
 where pds.person_id = p.id and pds.data_source_id = d.id
   and p.slug = 'drake' and d.name = 'rss';
