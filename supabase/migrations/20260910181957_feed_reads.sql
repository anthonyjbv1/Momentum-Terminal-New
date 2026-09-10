-- =============================================================================
-- Momentum Terminal — Phase 6d: read support for the Feed
--
-- The Feed is the Engine narrating what it observes across the whole board,
-- newest first. Two kinds of entry share one stream:
--
--   narrative  a sentence the Engine wrote when a person's score moved
--              meaningfully in a tick, carrying the move (score_after minus
--              score_before) and, as evidence, the signals the Engine
--              processed for that person in that same tick (matched through
--              the tick's time window; signals and narratives have no direct
--              link) with their sources.
--   signal     a signal that no narrative explains: not yet processed, or
--              processed in a tick whose move did not warrant a sentence.
--              Its own source and impact_score come along.
--
-- Keyset pagination on (occurred_at, id) descending; the page never reads
-- more than p_limit rows from either table.
-- =============================================================================

create or replace function public.feed_entries(
  p_before    timestamptz default null,
  p_before_id uuid        default null,
  p_limit     integer     default 24
)
returns table (
  kind            text,
  id              uuid,
  person_id       uuid,
  person_slug     text,
  person_name     text,
  person_category text,
  person_avatar   text,
  text            text,
  impact          numeric,
  score_before    numeric,
  score_after     numeric,
  tick_number     bigint,
  occurred_at     timestamptz,
  sources         text[],
  evidence        jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select least(greatest(coalesce(p_limit, 24), 1), 100)                        as n,
           coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)   as before_id
  ),
  narr as (
    select n.id, n.person_id, n.text, n.score_before, n.score_after, n.tick_number, n.created_at,
           t.started_at, t.finished_at
      from public.narratives n
      join public.engine_ticks t on t.tick_number = n.tick_number
     where p_before is null or (n.created_at, n.id) < (p_before, (select before_id from params))
     order by n.created_at desc, n.id desc
     limit (select n from params)
  ),
  narr_evidence as (
    select nr.id as narrative_id,
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'id', s.id, 'headline', s.headline, 'source', d.display_name,
                 'impact', s.impact_score, 'occurred_at', s.occurred_at,
                 'sentiment', s.sentiment_label, 'confidence', s.sentiment_confidence
               )
               order by abs(coalesce(s.impact_score, 0)) desc, s.occurred_at desc
             ) filter (where s.id is not null),
             '[]'::jsonb
           ) as evidence,
           coalesce(array_agg(distinct d.display_name) filter (where d.display_name is not null), array[]::text[]) as sources
      from narr nr
      left join public.signals s
        on s.person_id = nr.person_id
       and s.processed
       and s.processed_at >= nr.started_at
       and s.processed_at <= nr.finished_at
      left join public.data_sources d on d.id = s.data_source_id
     group by nr.id
  ),
  sig as (
    select s.id, s.person_id, s.headline, s.impact_score, s.occurred_at, s.processed,
           s.sentiment_label, s.sentiment_confidence, d.display_name as source
      from public.signals s
      left join public.data_sources d on d.id = s.data_source_id
     where (p_before is null or (s.occurred_at, s.id) < (p_before, (select before_id from params)))
       and not exists (
         select 1
           from public.narratives n2
           join public.engine_ticks t2 on t2.tick_number = n2.tick_number
          where n2.person_id = s.person_id
            and s.processed
            and s.processed_at >= t2.started_at
            and s.processed_at <= t2.finished_at
       )
     order by s.occurred_at desc, s.id desc
     limit (select n from params)
  ),
  unioned as (
    select 'narrative'::text as kind, nr.id, nr.person_id, nr.text,
           nr.score_after - nr.score_before as impact, nr.score_before, nr.score_after, nr.tick_number,
           nr.created_at as occurred_at, ne.sources, ne.evidence
      from narr nr
      join narr_evidence ne on ne.narrative_id = nr.id
    union all
    select 'signal', sg.id, sg.person_id, sg.headline,
           sg.impact_score, null::numeric, null::numeric, null::bigint,
           sg.occurred_at,
           case when sg.source is null then array[]::text[] else array[sg.source] end,
           jsonb_build_array(jsonb_build_object(
             'id', sg.id, 'headline', sg.headline, 'source', sg.source,
             'impact', sg.impact_score, 'occurred_at', sg.occurred_at,
             'sentiment', sg.sentiment_label, 'confidence', sg.sentiment_confidence,
             'processed', sg.processed
           ))
      from sig sg
  )
  select u.kind, u.id, u.person_id, p.slug, p.display_name, p.category, p.avatar_url,
         u.text, u.impact, u.score_before, u.score_after, u.tick_number, u.occurred_at, u.sources, u.evidence
    from unioned u
    join public.people p on p.id = u.person_id and p.is_active
   order by u.occurred_at desc, u.id desc
   limit (select n from params);
$$;

comment on function public.feed_entries(timestamptz, uuid, integer) is
  'Feed read side: the Engine''s narratives and the signals no narrative explains, across all active people, newest first with keyset pagination on (occurred_at, id). Narratives carry the signals processed for the person in the same tick as evidence.';

revoke execute on function public.feed_entries(timestamptz, uuid, integer) from public, anon;
grant  execute on function public.feed_entries(timestamptz, uuid, integer) to authenticated, service_role;
