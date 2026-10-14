-- =============================================================================
-- THE TUNE BLOCK RECORD, AND THE FEED'S ZERO METRICS (2026-10-14)
--
-- 1. score_events may hold a zero-impact Signals row when it records why a
--    tune zeroed a firing (details ? 'tuneBlocks'). Every other force keeps
--    the rule: a zero force writes no row. The tick builds `tuneBlocks` from
--    the follower, view, news-volume and company-news tunes' own working
--    (lib/engine/tune-blocks.ts); until now the reason reached score_events
--    only when the Signals force was non-zero for another signal in the
--    same tick, so a lone zeroed firing left no row at all.
-- 2. apply_engine_tick() writes exactly those rows. Everything else in the
--    function is byte-identical to the Phase 29 definition.
-- 3. feed_entries() leaves out a metric signal the Engine read as exactly
--    zero: it was never a card (the renderer hides a move that prints as
--    zero) but it still took a slot in every page. Story cards, narratives
--    and every other signal are untouched.
-- =============================================================================

alter table public.score_events drop constraint score_events_impact_nonzero;
alter table public.score_events
  add constraint score_events_impact_nonzero
  check (impact <> 0 or (force = 'signals' and details ? 'tuneBlocks'));

comment on constraint score_events_impact_nonzero on public.score_events is
  'A zero force writes no row, except a Signals row that records a tune''s block (details.tuneBlocks, 2026-10-14).';

create or replace function public.apply_engine_tick(p_tick jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tick_number       bigint;
  v_expected          bigint := nullif(p_tick ->> 'expected_tick_number', '')::bigint;
  v_started_at        timestamptz := (p_tick ->> 'started_at')::timestamptz;
  v_finished_at       timestamptz := (p_tick ->> 'finished_at')::timestamptz;
  v_people_updated    integer := 0;
  v_history_rows      integer := 0;
  v_events            integer := 0;
  v_signals_processed integer := 0;
  v_snapshots         integer := 0;
  v_decays            integer := 0;
  v_halts             integer := 0;
begin
  if v_started_at is null or v_finished_at is null then
    raise exception 'apply_engine_tick: started_at and finished_at are required' using errcode = '22023';
  end if;

  -- One tick at a time.
  perform pg_advisory_xact_lock(hashtext('momentum_engine_tick'));

  v_tick_number := coalesce((select max(tick_number) from public.engine_ticks), 0) + 1;
  if v_expected is not null and v_expected <> v_tick_number then
    raise exception 'apply_engine_tick: stale tick (computed for tick %, next tick is %)', v_expected, v_tick_number
      using errcode = '40001';
  end if;

  insert into public.engine_ticks (tick_number, started_at, finished_at, mood, summary)
  values (v_tick_number, v_started_at, v_finished_at, coalesce((p_tick ->> 'mood')::numeric, 0), p_tick -> 'summary');

  -- THE SCORE. Written here and nowhere else. The premium is not in this
  -- statement and never will be.
  update public.people p
     set current_score    = x.score,
         spread           = x.spread,
         target_attention = x.target_attention,
         target_direction = x.target_direction,
         target_offset    = coalesce(x.target_offset, 0),
         last_tick_at     = v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb))
           as x(id uuid, score numeric, spread numeric, target_attention numeric, target_direction numeric, target_offset numeric)
   where p.id = x.id;
  get diagnostics v_people_updated = row_count;

  insert into public.score_history (person_id, score, tick_number, recorded_at)
  select x.id, x.score, v_tick_number, v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb)) as x(id uuid, score numeric);
  get diagnostics v_history_rows = row_count;

  insert into public.score_events (tick_number, person_id, force, impact, details, created_at)
  select v_tick_number, e.person_id, e.force, e.impact, e.details, v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'events', '[]'::jsonb)) as e(person_id uuid, force text, impact numeric, details jsonb)
   where e.impact <> 0
      or (e.force = 'signals' and e.details ? 'tuneBlocks');
  get diagnostics v_events = row_count;

  update public.signals s
     set processed            = true,
         processed_at         = v_finished_at,
         impact_score         = x.impact_score,
         sentiment_label      = x.sentiment_label,
         sentiment_confidence = x.sentiment_confidence
    from jsonb_to_recordset(coalesce(p_tick -> 'signals', '[]'::jsonb)) as x(id uuid, impact_score numeric, sentiment_label text, sentiment_confidence numeric)
   where s.id = x.id
     and s.processed = false;
  get diagnostics v_signals_processed = row_count;

  -- THE MARKET (Phase 29): the premium decays a step, then the total-price
  -- breakers are read, then the portfolios are marked at the quotes as they
  -- now stand.
  v_decays := public.apply_market_decay(v_finished_at, v_tick_number);
  v_halts  := public.evaluate_price_breakers(v_finished_at, v_tick_number);

  v_snapshots := public.snapshot_portfolios(v_finished_at, v_tick_number);

  update public.engine_ticks
     set people_updated = v_people_updated, signals_processed = v_signals_processed
   where tick_number = v_tick_number;

  return jsonb_build_object(
    'tick_number', v_tick_number,
    'people_updated', v_people_updated,
    'history_rows', v_history_rows,
    'score_events', v_events,
    'signals_processed', v_signals_processed,
    'premium_decays', v_decays,
    'breaker_halts', v_halts,
    'portfolio_snapshots', v_snapshots
  );
end;
$$;

comment on function public.apply_engine_tick(jsonb) is
  'Atomically persists one Engine tick (people scores, spread and the drifting target''s state, score_history, score_events, processed signals, engine_ticks), decays every non-zero premium one step (Phase 29), reads the total-price breakers, and records every position-holding user''s portfolio value at the new quotes. Service role only. Nothing derived from an order is written to the score here.';


-- -----------------------------------------------------------------------------
-- feed_entries(): a metric signal read as exactly zero is not a card
-- -----------------------------------------------------------------------------

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
      -- A voided, hidden or held signal is not evidence of anything: the link stays, the row drops out here.
      left join public.signals           s  on s.id  = ns.signal_id and s.voided_at is null and s.hidden_at is null and not s.allegation_held
      left join public.data_sources      d  on d.id  = s.data_source_id
      left join public.people            sp on sp.id = s.person_id
     group by nr.id
  ),
  -- Stories with two or more DISPLAYABLE signals, led by a displayable one, at their last update.
  story as (
    select st.id, st.person_id, st.headline, st.first_at, st.last_at, st.signal_count, st.impact_total
      from public.stories st
     where st.signal_count >= 2
       and (p_before is null or (st.last_at, st.id) < (p_before, (select before_id from params)))
       and exists (
         select 1 from public.story_signals ss join public.signals s on s.id = ss.signal_id
          where ss.story_id = st.id and ss.role = 'leader' and s.voided_at is null and s.hidden_at is null and not s.allegation_held
       )
       and (
         select count(*) from public.story_signals ss join public.signals s on s.id = ss.signal_id
          where ss.story_id = st.id and s.voided_at is null and s.hidden_at is null and not s.allegation_held
       ) >= 2
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
      left join public.signals       s  on s.id = ss.signal_id and s.voided_at is null and s.hidden_at is null and not s.allegation_held
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
       and s.hidden_at is null
       and not s.allegation_held
       -- A metric the Engine read as exactly zero is no card (2026-10-14); its row stays, as evidence and on the profile.
       and not (coalesce(s.raw_payload->>'kind', '') = 'metric' and s.processed and coalesce(s.impact_score, 0) = 0)
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
  'The Feed, newest first with a keyset cursor: narratives with their linked evidence, stories of two or more displayable signals, and the signals neither links. A voided, hidden or held signal is neither a card nor evidence (2026-10-09); a metric read as exactly zero is no card (2026-10-14).';
