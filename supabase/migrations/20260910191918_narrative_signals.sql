-- =============================================================================
-- Momentum Terminal — Phase 6d+: the narrative ↔ signal link
--
-- Until now a narrative's evidence was inferred after the fact: the signals
-- processed for the same person inside the same tick's time window. That is
-- a heuristic, and once several connectors run for one person two signals
-- landing in the same tick become interchangeable, so a narrative would cite
-- the wrong headline. On a product whose central claim is explainability the
-- link has to be a fact the Engine records when it writes the sentence.
--
-- narrative_signals is that record. It is many-to-many because of how the
-- Engine actually generates narratives:
--
--   * an LLM narrative is the sentence the scorer wrote for a whole batch of
--     one person's signals in one tick — several signals, one narrative;
--   * a template narrative for a Signals-driven move quotes the strongest of
--     the signals that moved the score, but every non-zero one produced it;
--   * an inverse-pair narrative ("… slipped as Drake's surge pulled the pair
--     the other way") is produced by the PAIRED person's signals, which also
--     produced that person's own narrative — one signal, two narratives.
--
-- `relation` says which of those a row is: 'direct' (a signal about the
-- narrative's own person) or 'inverse_pair' (the paired person's signal). A
-- trigger keeps that honest against the people on both rows.
--
-- The Engine writes the rows through record_narratives(), atomically with
-- the narratives themselves. feed_entries() now reads evidence from this
-- table only. The tick-window inference is gone; a narrative with no rows
-- here has no evidence, and the Feed shows none.
--
-- There is nothing to backfill: ingestion has never run and the narratives,
-- signals and engine_ticks tables are empty at the time of this migration.
-- =============================================================================

-- narrative_signals --------------------------------------------------------------
create table public.narrative_signals (
  narrative_id uuid        not null references public.narratives (id) on delete cascade,
  signal_id    uuid        not null references public.signals (id)    on delete cascade,
  relation     text        not null default 'direct',
  created_at   timestamptz not null default now(),

  primary key (narrative_id, signal_id),
  constraint narrative_signals_relation_check check (relation in ('direct', 'inverse_pair'))
);

create index narrative_signals_signal_id_idx on public.narrative_signals (signal_id);

comment on table  public.narrative_signals is
  'Which signals produced which narrative, recorded by the Engine when it writes the narrative. Many-to-many: an LLM narrative covers a batch of signals, and an inverse-pair narrative is produced by the paired person''s signals.';
comment on column public.narrative_signals.relation is
  'direct = a signal about the narrative''s own person; inverse_pair = the paired person''s signal, whose move the narrative reacts to.';

alter table public.narrative_signals enable row level security;

create policy narrative_signals_select_authenticated
  on public.narrative_signals for select
  to authenticated
  using (true);

grant select on public.narrative_signals to authenticated;
grant all    on public.narrative_signals to service_role;
revoke insert, update, delete on public.narrative_signals from anon, authenticated;

-- A link must agree with the people on both rows: a direct link points at a
-- signal about the narrative's person, an inverse_pair link at a signal about
-- someone paired with them.
create or replace function public.narrative_signals_enforce_person()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_narrative_person uuid;
  v_signal_person    uuid;
begin
  select n.person_id into v_narrative_person from public.narratives n where n.id = new.narrative_id;
  select s.person_id into v_signal_person    from public.signals    s where s.id = new.signal_id;

  if v_narrative_person is null or v_signal_person is null then
    raise exception 'narrative_signals: narrative % or signal % does not exist', new.narrative_id, new.signal_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.relation = 'direct' and v_signal_person <> v_narrative_person then
    raise exception 'narrative_signals: a direct link must point at a signal about the narrative''s own person (narrative %, signal %)',
      new.narrative_id, new.signal_id
      using errcode = 'check_violation';
  end if;

  if new.relation = 'inverse_pair' and not exists (
    select 1
      from public.inverse_pairs ip
     where (ip.person_a_id = v_narrative_person and ip.person_b_id = v_signal_person)
        or (ip.person_b_id = v_narrative_person and ip.person_a_id = v_signal_person)
  ) then
    raise exception 'narrative_signals: an inverse_pair link must point at a signal about the person paired with the narrative''s person (narrative %, signal %)',
      new.narrative_id, new.signal_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger narrative_signals_enforce_person
  before insert or update on public.narrative_signals
  for each row execute function public.narrative_signals_enforce_person();

-- record_narratives ---------------------------------------------------------------
-- The Engine's write path for narratives: the sentences and the signals that
-- produced them land in one transaction, so a narrative is never left
-- half-recorded. Each element of p_narratives:
--   { person_id, tick_number, text, score_before, score_after, source,
--     signals: [{ signal_id, relation }] }
-- Returns the number of narratives written.
create or replace function public.record_narratives(p_narratives jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item  jsonb;
  v_id    uuid;
  v_count integer := 0;
begin
  if p_narratives is null or jsonb_typeof(p_narratives) <> 'array' then
    raise exception 'record_narratives: p_narratives must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for v_item in select value from jsonb_array_elements(p_narratives) loop
    insert into public.narratives (person_id, tick_number, text, score_before, score_after, source)
    values (
      (v_item ->> 'person_id')::uuid,
      (v_item ->> 'tick_number')::bigint,
      v_item ->> 'text',
      (v_item ->> 'score_before')::numeric,
      (v_item ->> 'score_after')::numeric,
      coalesce(nullif(v_item ->> 'source', ''), 'template')
    )
    returning id into v_id;
    v_count := v_count + 1;

    insert into public.narrative_signals (narrative_id, signal_id, relation)
    select v_id,
           (link ->> 'signal_id')::uuid,
           coalesce(nullif(link ->> 'relation', ''), 'direct')
      from jsonb_array_elements(coalesce(v_item -> 'signals', '[]'::jsonb)) as link
     where link ->> 'signal_id' is not null
        on conflict (narrative_id, signal_id) do nothing;
  end loop;

  return v_count;
end;
$$;

comment on function public.record_narratives(jsonb) is
  'Engine write path: inserts narratives and their narrative_signals links in one transaction. Service role only.';

revoke execute on function public.record_narratives(jsonb) from public, anon, authenticated;
grant  execute on function public.record_narratives(jsonb) to service_role;

-- feed_entries: evidence from the explicit link only -------------------------------
-- Same signature and row shape as before, two changes of substance:
--   * a narrative's evidence and sources come from narrative_signals; the
--     tick-window join is gone, with no fallback;
--   * a signal is "unexplained" (and so appears as its own entry) when no
--     narrative links to it directly.
-- Evidence rows gain relation, person_name and person_slug so an
-- inverse-pair signal can be shown as the paired person's.
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
                 'relation', ns.relation, 'person_name', sp.display_name, 'person_slug', sp.slug
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
           s.sentiment_label, s.sentiment_confidence, d.display_name as source
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
             'relation', 'direct', 'person_name', null, 'person_slug', null
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
  'Feed read side: the Engine''s narratives and the signals no narrative explains, across all active people, newest first with keyset pagination on (occurred_at, id). A narrative''s evidence is exactly its narrative_signals rows; nothing is inferred.';
