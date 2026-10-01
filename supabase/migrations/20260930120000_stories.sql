-- =============================================================================
-- Momentum Terminal — the story record (Feed upgrade, Part B; ships with
-- Phase 31, never before it).
--
-- WHAT A STORY IS. Phase 31's story confirmation (lib/engine/stories.ts)
-- already judges, at scoring, that a new article repeats a story the Engine
-- scored inside the story window: it bounds the copy's impact and records
-- the cluster in the tick's Signals-force details. That judgement was
-- transient. This migration makes it a record: a STORY groups the signals the
-- Engine judged the same story, across hours or days, so the Feed can show
-- one card for it ("+0.6 today · +1.4 over 3 days", every source in the
-- strip) instead of one card per copy.
--
--   stories         one row per story: the person, the leader's headline,
--                   when it began and was last updated, how many signals it
--                   holds and their impact together.
--   story_signals   which signals belong to which story, with the similarity
--                   and anchor the Engine matched on. A signal belongs to at
--                   most one story. A story with one signal is never written:
--                   a lone signal is its own story and needs no row.
--
-- WHO WRITES IT. The Engine, after each tick, through record_story_clusters()
-- with the clusters confirmStories() produced, only while the Phase 31 switch
-- is on (off, no clusters exist and nothing is called). The call is
-- idempotent: a cluster recorded twice adds nothing, and a story's aggregates
-- are recomputed from its members on every call.
--
-- WHAT THE FEED READS. feed_entries() gains a third kind, 'story', placed at
-- the story's LAST update (the keyset stays (occurred_at, id)), carrying its
-- members as evidence in the same shape as a narrative's; a signal that
-- belongs to a story leaves the signal branch. Two columns are added to the
-- result, story_first_at and story_signals (null for the other kinds), which
-- changes the return type: the function is dropped and recreated with the
-- same grants.
--
-- MERGED WITH MAIN on 2026-10-01: the `voided_at is null` predicates of the
-- voided-signals hotfix (20260928210000) are in the version below on the
-- narrative, signal and story branches and on the evidence joins, and a voided
-- signal is left out of a story's aggregates. Applied against the daily backup
-- of 2026-10-01 09:10:03 UTC, with the touched function and tables copied to
-- the schema backup_phase31_20261001 first.
-- =============================================================================

create table public.stories (
  id            uuid        primary key default gen_random_uuid(),
  person_id     uuid        not null references public.people (id) on delete cascade,
  headline      text        not null,
  first_at      timestamptz not null,
  last_at       timestamptz not null,
  signal_count  integer     not null default 0,
  impact_total  numeric     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint stories_headline_nonempty check (length(trim(headline)) > 0),
  constraint stories_span_check        check (last_at >= first_at)
);

create index stories_person_last_idx on public.stories (person_id, last_at desc);
create index stories_last_idx        on public.stories (last_at desc, id desc);

comment on table  public.stories is 'A story: the signals the Engine judged the same event across the story window (Phase 31 confirmation), grouped so the Feed shows one card for it. Written by record_story_clusters() after a tick; never for a lone signal.';
comment on column public.stories.headline     is 'The leader''s headline: the first copy scored, or the strongest copy in its tick.';
comment on column public.stories.impact_total is 'The members'' impact together, confirmations already bounded; recomputed from story_signals on every write.';

create table public.story_signals (
  story_id    uuid        not null references public.stories (id) on delete cascade,
  signal_id   uuid        not null references public.signals (id) on delete cascade,
  role        text        not null default 'member',
  similarity  numeric,
  anchor      text,
  joined_at   timestamptz not null default now(),

  primary key (story_id, signal_id),
  -- A signal belongs to at most one story.
  constraint story_signals_signal_unique unique (signal_id),
  constraint story_signals_role_check    check (role in ('leader', 'member'))
);

comment on table public.story_signals is 'Which signals make up which story, with the similarity and the anchor the Engine matched on (null for the leader).';

alter table public.stories       enable row level security;
alter table public.story_signals enable row level security;

create policy stories_select_authenticated       on public.stories       for select to authenticated using (true);
create policy story_signals_select_authenticated on public.story_signals for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- record_story_clusters(p_clusters jsonb) → integer
--
-- p_clusters: [{ person_id, leader_id, headline,
--                members: [{ id, similarity, anchor }] }, …]
--
-- For each cluster: the story that already holds the leader (a recent leader
-- may have been recorded by an earlier tick), else a new story with the
-- leader as its first member; then the members, each skipped if it already
-- belongs to a story; then the aggregates, from the members' own rows.
-- Returns how many stories were created or touched.
-- -----------------------------------------------------------------------------
create or replace function public.record_story_clusters(p_clusters jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cluster   jsonb;
  member    jsonb;
  v_story   uuid;
  v_person  uuid;
  v_leader  uuid;
  v_touched integer := 0;
begin
  if p_clusters is null or jsonb_typeof(p_clusters) <> 'array' then
    return 0;
  end if;

  for cluster in select * from jsonb_array_elements(p_clusters) loop
    v_person := (cluster->>'person_id')::uuid;
    v_leader := (cluster->>'leader_id')::uuid;
    if v_person is null or v_leader is null or jsonb_array_length(coalesce(cluster->'members', '[]'::jsonb)) = 0 then
      continue;
    end if;
    -- The leader must be this person's signal; anything else is not a story of theirs.
    if not exists (select 1 from public.signals s where s.id = v_leader and s.person_id = v_person) then
      continue;
    end if;

    select ss.story_id into v_story
      from public.story_signals ss
      join public.stories st on st.id = ss.story_id
     where ss.signal_id = v_leader and st.person_id = v_person;

    if v_story is null then
      insert into public.stories (person_id, headline, first_at, last_at)
      select v_person, coalesce(nullif(trim(cluster->>'headline'), ''), s.headline), s.occurred_at, s.occurred_at
        from public.signals s where s.id = v_leader
      returning id into v_story;
      insert into public.story_signals (story_id, signal_id, role, joined_at)
      select v_story, v_leader, 'leader', s.occurred_at from public.signals s where s.id = v_leader
      on conflict (signal_id) do nothing;
    end if;

    for member in select * from jsonb_array_elements(cluster->'members') loop
      insert into public.story_signals (story_id, signal_id, role, similarity, anchor, joined_at)
      select v_story, s.id, 'member', (member->>'similarity')::numeric, nullif(member->>'anchor', ''), s.occurred_at
        from public.signals s
       where s.id = (member->>'id')::uuid and s.person_id = v_person
      on conflict (signal_id) do nothing;
    end loop;

    update public.stories st
       set first_at     = agg.first_at,
           last_at      = agg.last_at,
           signal_count = agg.n,
           impact_total = agg.impact,
           updated_at   = now()
      from (
        select min(s.occurred_at) as first_at, max(s.occurred_at) as last_at, count(*)::integer as n, coalesce(sum(coalesce(s.impact_score, 0)), 0) as impact
          from public.story_signals ss
          join public.signals s on s.id = ss.signal_id
         where ss.story_id = v_story
           and s.voided_at is null
      ) agg
     where st.id = v_story;

    v_touched := v_touched + 1;
  end loop;

  return v_touched;
end;
$$;

comment on function public.record_story_clusters(jsonb) is
  'Records the story clusters a tick confirmed (Phase 31): the story holding each leader, or a new one; the members, each in at most one story; the aggregates from the members. Idempotent.';

revoke execute on function public.record_story_clusters(jsonb) from public, anon, authenticated;
grant  execute on function public.record_story_clusters(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- feed_entries(), with stories.
-- -----------------------------------------------------------------------------
drop function public.feed_entries(timestamptz, uuid, integer);

create function public.feed_entries(
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
  evidence        jsonb,
  story_first_at  timestamptz,
  story_signals   integer
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
     where n.voided_at is null
       and (p_before is null or (n.created_at, n.id) < (p_before, (select before_id from params)))
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
      left join public.signals           s  on s.id  = ns.signal_id and s.voided_at is null
      left join public.data_sources      d  on d.id  = s.data_source_id
      left join public.people            sp on sp.id = s.person_id
     group by nr.id
  ),
  -- Stories with two or more signals, at their last update.
  story as (
    select st.id, st.person_id, st.headline, st.first_at, st.last_at, st.signal_count, st.impact_total
      from public.stories st
     where st.signal_count >= 2
       and (p_before is null or (st.last_at, st.id) < (p_before, (select before_id from params)))
     order by st.last_at desc, st.id desc
     limit (select n from params)
  ),
  story_evidence as (
    select so.id as story_id,
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'id', s.id, 'headline', s.headline, 'source', d.display_name,
                 'impact', s.impact_score, 'occurred_at', s.occurred_at,
                 'sentiment', s.sentiment_label, 'confidence', s.sentiment_confidence,
                 'processed', s.processed,
                 'relation', 'direct', 'person_name', null, 'person_slug', null,
                 'payload', case when s.raw_payload->>'kind' = 'metric' then s.raw_payload else null end
               )
               order by (ss.role = 'leader') desc, s.occurred_at desc, s.id desc
             ) filter (where s.id is not null),
             '[]'::jsonb
           ) as evidence,
           coalesce(array_agg(distinct d.display_name) filter (where d.display_name is not null), array[]::text[]) as sources
      from story so
      left join public.story_signals ss on ss.story_id = so.id
      left join public.signals       s  on s.id = ss.signal_id and s.voided_at is null
      left join public.data_sources  d  on d.id = s.data_source_id
     group by so.id
  ),
  sig as (
    select s.id, s.person_id, s.headline, s.impact_score, s.occurred_at, s.processed,
           s.sentiment_label, s.sentiment_confidence, d.display_name as source,
           case when s.raw_payload->>'kind' = 'metric' then s.raw_payload else null end as payload
      from public.signals s
      left join public.data_sources d on d.id = s.data_source_id
     where s.voided_at is null
       and (p_before is null or (s.occurred_at, s.id) < (p_before, (select before_id from params)))
       and not exists (
         select 1
           from public.narrative_signals ns
          where ns.signal_id = s.id
            and ns.relation = 'direct'
       )
       -- A signal in a story is shown by its story.
       and not exists (
         select 1
           from public.story_signals ss
           join public.stories st on st.id = ss.story_id
          where ss.signal_id = s.id
            and st.signal_count >= 2
       )
     order by s.occurred_at desc, s.id desc
     limit (select n from params)
  ),
  unioned as (
    select 'narrative'::text as kind, nr.id, nr.person_id, nr.text,
           nr.score_after - nr.score_before as impact, nr.score_before, nr.score_after, nr.tick_number,
           nr.created_at as occurred_at, ne.sources, ne.evidence,
           null::timestamptz as story_first_at, null::integer as story_signals
      from narr nr
      join narr_evidence ne on ne.narrative_id = nr.id
    union all
    select 'story', so.id, so.person_id, so.headline,
           so.impact_total, null::numeric, null::numeric, null::bigint,
           so.last_at, se.sources, se.evidence,
           so.first_at, so.signal_count
      from story so
      join story_evidence se on se.story_id = so.id
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
           )),
           null::timestamptz, null::integer
      from sig sg
  )
  select u.kind, u.id, u.person_id, p.slug, p.display_name, p.category, p.avatar_url,
         u.text, u.impact, u.score_before, u.score_after, u.tick_number, u.occurred_at, u.sources, u.evidence,
         u.story_first_at, u.story_signals
    from unioned u
    join public.people p on p.id = u.person_id and p.is_active
   order by u.occurred_at desc, u.id desc
   limit (select n from params);
$$;

comment on function public.feed_entries(timestamptz, uuid, integer) is
  'The Feed, newest first, keyset-paged on (occurred_at, id): narratives with the signals the Engine linked when it wrote them; stories (two or more signals the Engine judged one event, Phase 31) at their last update with their members as evidence; and signals no narrative or story holds. Metric payloads only, as before.';

revoke execute on function public.feed_entries(timestamptz, uuid, integer) from public, anon;
grant  execute on function public.feed_entries(timestamptz, uuid, integer) to authenticated, service_role;
