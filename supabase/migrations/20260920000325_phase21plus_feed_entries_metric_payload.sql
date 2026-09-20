-- =============================================================================
-- Momentum Terminal — Phase 21+: the Feed carries each metric signal's payload.
--
-- Phase 21+ says a metric signal in the consumer app shows plain language and,
-- on expand, the counts underneath. Both need the payload at the display
-- layer, and feed_entries() was not carrying it.
--
-- WHY THIS IS A `CREATE OR REPLACE` AND NOT A DROP.
--
-- The obvious shape — a new `signal_payload jsonb` column on the result — would
-- change the function's return type, which Postgres refuses to do in place: it
-- would mean dropping and recreating the function and re-applying its grants,
-- on a security-invoker function the Feed pages through. Every consumer of the
-- payload is a SIGNAL, and every signal already appears in the `evidence`
-- array, which is already jsonb. Adding a key INSIDE those objects changes no
-- column type, so the signature, the grants and the keyset pagination are all
-- untouched.
--
-- For a signal entry, evidence[0] IS the entry, so its payload re-renders the
-- entry's own sentence. For a narrative entry, each linked signal's payload
-- re-renders the headline the narrative QUOTED — which is how 1,950 stored
-- sigma headlines and the 58 narratives that quote them verbatim become plain
-- language without rewriting a single stored row.
--
-- METRIC PAYLOADS ONLY. An event signal's raw_payload carries article links,
-- the publisher domain it resolved through and which allowlist row matched —
-- internal resolution detail the browser has no use for. A metric payload is
-- allow-listed by signals_enforce_metric_privacy, so it is exactly the safe
-- subset by construction. Anything else stays null.
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
    select n.id, n.person_id, n.text, n.score_before, n.score_after, n.tick_number, n.created_at
      from public.narratives n
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
                 'sentiment', s.sentiment_label, 'confidence', s.sentiment_confidence,
                 'processed', s.processed,
                 'relation', ns.relation, 'person_name', sp.display_name, 'person_slug', sp.slug,
                 -- Phase 21+: metric payloads only (see the header).
                 'payload', case when s.raw_payload->>'kind' = 'metric' then s.raw_payload else null end
               )
               order by (ns.relation = 'direct') desc, abs(coalesce(s.impact_score, 0)) desc, s.occurred_at desc, s.id desc
             ) filter (where s.id is not null),
             '[]'::jsonb
           ) as evidence,
           coalesce(
             array_agg(distinct d.display_name) filter (where d.display_name is not null and ns.relation = 'direct'),
             array[]::text[]
           ) as sources
      from narr nr
      left join public.narrative_signals ns on ns.narrative_id = nr.id
      left join public.signals           s  on s.id  = ns.signal_id
      left join public.data_sources      d  on d.id  = s.data_source_id
      left join public.people            sp on sp.id = s.person_id
     group by nr.id
  ),
  sig as (
    select s.id, s.person_id, s.headline, s.impact_score, s.occurred_at, s.processed,
           s.sentiment_label, s.sentiment_confidence, d.display_name as source,
           case when s.raw_payload->>'kind' = 'metric' then s.raw_payload else null end as payload
      from public.signals s
      left join public.data_sources d on d.id = s.data_source_id
     where (p_before is null or (s.occurred_at, s.id) < (p_before, (select before_id from params)))
       and not exists (
         select 1
           from public.narrative_signals ns
          where ns.signal_id = s.id
            and ns.relation = 'direct'
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
             'processed', sg.processed,
             'relation', 'direct', 'person_name', null, 'person_slug', null,
             'payload', sg.payload
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
  'The Feed, newest first, keyset-paged on (occurred_at, id): narratives with exactly the signals the Engine linked when it wrote them (narrative_signals), plus signals no narrative links directly. Each evidence object carries its signal''s raw_payload as `payload` when that signal is a METRIC (Phase 21+) and null otherwise, so the consumer app can render plain language and the counts underneath from the payload rather than from the stored sigma headline. Event payloads are withheld: they carry publisher-resolution detail the browser has no use for.';
