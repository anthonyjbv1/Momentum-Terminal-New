-- =============================================================================
-- VOIDED SIGNALS AND NARRATIVES (2026-09-28)
--
-- On 2026-09-28 a namesake's obituary and a bare-name item from a local radio
-- station were scored as the death of Larry Page, who is alive, and the
-- Engine wrote "Larry Page has died." on the Feed. The void that day had to
-- happen before this migration could (the backup rule), so it was recorded as
-- a `voided` object in the signal's payload and the narrative row deleted.
--
-- This gives the void a proper home:
--
--   signals.voided_at / void_reason, narratives.voided_at / void_reason
--     an operator's mark that the row is a demonstrably false input (an
--     "obvious error"). The row, its score event and the score history it
--     moved stay: published history is not rewritten. Both columns are set
--     together or not at all.
--
--   feed_entries()          leaves a voided narrative and a voided signal out,
--                           as a card and as evidence under a narrative.
--   person_signal_volume()  no longer counts a voided signal toward anyone's
--                           daily volume (the volume weight) or trailing day.
--
--   admin_audit_log         gains the `void_signal` action, so every void is
--                           an audit row naming the signal, the person and
--                           the reason.
--
-- The payload markers written on 2026-09-28 are backfilled into the columns
-- and left in place: the wgrv.com signal's marker holds the deleted
-- narrative's full row, which is its only surviving record.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The columns
-- -----------------------------------------------------------------------------

alter table public.signals
  add column voided_at   timestamptz,
  add column void_reason text;

alter table public.signals
  add constraint signals_void_reason_with_time check ((voided_at is null) = (void_reason is null)),
  add constraint signals_void_reason_nonempty  check (void_reason is null or length(trim(void_reason)) > 0);

create index signals_voided_at_idx on public.signals (voided_at) where voided_at is not null;

comment on column public.signals.voided_at   is 'Set by the operator when the signal is a demonstrably false input (an obvious error). The row and what it moved stay; every reader and the Engine leave it out from here.';
comment on column public.signals.void_reason is 'Why the signal was voided, in words. Set with voided_at, never alone.';

alter table public.narratives
  add column voided_at   timestamptz,
  add column void_reason text;

alter table public.narratives
  add constraint narratives_void_reason_with_time check ((voided_at is null) = (void_reason is null)),
  add constraint narratives_void_reason_nonempty  check (void_reason is null or length(trim(void_reason)) > 0);

comment on column public.narratives.voided_at   is 'Set by the operator when the narrative asserts something demonstrably false. The row stays; the Feed, the profile and the rail leave it out.';
comment on column public.narratives.void_reason is 'Why the narrative was voided, in words. Set with voided_at, never alone.';

-- -----------------------------------------------------------------------------
-- 2. Backfill: the markers written on 2026-09-28 before this migration existed
-- -----------------------------------------------------------------------------

update public.signals
   set voided_at   = coalesce((raw_payload->'voided'->>'at')::timestamptz, now()),
       void_reason = coalesce(nullif(trim(raw_payload->'voided'->>'reason'), ''), 'voided by the operator (reason recorded in raw_payload.voided)')
 where raw_payload ? 'voided'
   and voided_at is null;

-- -----------------------------------------------------------------------------
-- 3. The audit action
-- -----------------------------------------------------------------------------

alter table public.admin_audit_log drop constraint admin_audit_log_action_check;
alter table public.admin_audit_log add constraint admin_audit_log_action_check check (action in (
  'freeze_account', 'unfreeze_account', 'halt_person', 'lift_halt', 'set_trading_mode',
  'add_excluded_party', 'remove_excluded_party', 'resolve_alert', 'reopen_alert',
  'issue_invite', 'resend_invite', 'revoke_invite',
  'void_signal'
));

-- -----------------------------------------------------------------------------
-- 4. The Feed: a voided narrative or signal is neither a card nor evidence
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
                 -- Phase 21+: metric payloads only (see the header of 20260920000325).
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
      -- A voided signal is not evidence of anything: the link stays, the row drops out here.
      left join public.signals           s  on s.id  = ns.signal_id and s.voided_at is null
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
     where s.voided_at is null
       and (p_before is null or (s.occurred_at, s.id) < (p_before, (select before_id from params)))
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
  'The Feed, newest first, keyset-paged on (occurred_at, id): narratives with exactly the signals the Engine linked when it wrote them (narrative_signals), plus signals no narrative links directly. A voided narrative or signal (voided_at set) is left out, as a card and as evidence. Each evidence object carries its signal''s raw_payload as `payload` when that signal is a METRIC (Phase 21+) and null otherwise.';

-- -----------------------------------------------------------------------------
-- 5. The volume weight: a voided signal is not a unit of anyone's volume
-- -----------------------------------------------------------------------------

create or replace function public.person_signal_volume(p_days integer default 14)
returns table (
  person_id     uuid,
  tracked_since timestamptz,
  current_24h   bigint,
  daily         bigint[]
)
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
       and s.voided_at is null
       and coalesce(s.raw_payload ->> 'kind', '') <> all (array['metric', 'baseline', 'comment_digest', 'comment', 'live_moment'])
     group by s.person_id, (s.occurred_at at time zone 'utc')::date
  )
  select b.person_id,
         b.tracked_since,
         (select count(*) from public.signals s
           where s.person_id = b.person_id
             and s.occurred_at >= now() - interval '24 hours'
             and s.voided_at is null
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
  'Each active person''s event-signal volume: the regime start (their newest mapping), the trailing 24 hours, and one count per complete UTC day since, oldest first. Sampling artifacts (metrics, baselines, comment digests, live moments) and voided signals are not units of volume.';

revoke execute on function public.person_signal_volume(integer) from public, anon, authenticated;
grant  execute on function public.person_signal_volume(integer) to service_role;
