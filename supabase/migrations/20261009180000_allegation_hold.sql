-- =============================================================================
-- THE ALLEGATION HOLD (2026-10-09). Display and narrative only.
--
-- THE RULE (settled). An unverified allegation of a serious crime (sexual
-- abuse, violence, a crime against a minor) about a tracked person or their
-- family is held from display. The hold lifts only when a tier 1-2 PUBLISHER
-- reports the claim. Connector tiers (Twitch, YouTube, API-Sports) never
-- count: they measure weighting, not reporting. Several lower-tier outlets
-- never lift it (gossip outlets copy each other). A story reporting a denial
-- still repeats the claim and is held the same way. Once a tier 1-2 story on
-- the claim is admitted, earlier lower-tier cards stay held and only the
-- qualifying story and later tier 1-2 coverage display.
--
-- THE ENGINE KEEPS SCORING COVERAGE EXACTLY AS TODAY. Nothing here changes a
-- score, a weight, a volume count or a market path: a held or hidden signal
-- is processed, scored, counted by person_signal_volume() and summed by the
-- Signals force as before. What changes is what the platform SHOWS and SAYS.
--
-- WHAT THIS ADDS
--
--   signals.allegation / allegation_held
--     The Engine's classification of a story, written by the tick through
--     record_allegation_holds(): the category, which method flagged it (the
--     scoring call, or the 59-term list as the backstop), the publisher's
--     domain and tier, whether it qualifies (a tier 1-2 publisher), and the
--     claim it belongs to. allegation_held is the display decision: true
--     while the card is held.
--
--   allegation_claims
--     One row per person per claim (the category): held until a qualifying
--     story is admitted or an operator lifts it, with who and why.
--
--   signals.hidden_at / hide_reason
--     THE DISPLAY-ONLY HIDE: an operator's flag that removes a card from
--     every surface without voiding it. Volume counts, signals and scores
--     are untouched. Set only through admin_hide_signal(), which writes the
--     audit row in the same transaction; a direct edit is refused by the
--     guard below, like the market controls.
--
--   feed_entries()
--     A held or hidden signal is neither a card nor evidence; a story whose
--     leader is held or hidden, or with fewer than two displayable signals,
--     is no card. The narrative that carries the score move still displays:
--     its text was written as the neutral line at tick time.
--
--   allegation_review
--     The console's list: every held, lifted or hidden item with person,
--     claim, source, tier and date.
--
--   admin_hide_signal / admin_unhide_signal / admin_lift_allegation_hold
--     The operator's actions, each an audit row.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The columns
-- -----------------------------------------------------------------------------

alter table public.signals
  add column hidden_at        timestamptz,
  add column hide_reason      text,
  add column allegation       jsonb,
  add column allegation_held  boolean not null default false;

alter table public.signals
  add constraint signals_hide_reason_with_time check ((hidden_at is null) = (hide_reason is null)),
  add constraint signals_hide_reason_nonempty  check (hide_reason is null or length(trim(hide_reason)) > 0),
  add constraint signals_allegation_held_flagged check (not allegation_held or allegation is not null);

create index signals_hidden_at_idx       on public.signals (hidden_at) where hidden_at is not null;
create index signals_allegation_held_idx on public.signals (person_id, occurred_at desc) where allegation_held;
create index signals_allegation_idx      on public.signals (person_id, occurred_at desc) where allegation is not null;

comment on column public.signals.hidden_at       is 'The display-only hide: set by the operator through admin_hide_signal(); the card leaves every surface, the signal, its score and its volume count stay.';
comment on column public.signals.hide_reason     is 'Why the signal is hidden, in words. Set with hidden_at, never alone.';
comment on column public.signals.allegation      is 'The Engine''s classification of a serious-crime allegation story: category, method, publisher domain and tier, qualifying, claim_id. Written by the tick; null for every other story.';
comment on column public.signals.allegation_held is 'True while the story is held from display under the allegation rule. The score stands; the card does not show.';

create table public.allegation_claims (
  id                   uuid        primary key default gen_random_uuid(),
  person_id            uuid        not null references public.people (id) on delete cascade,
  category             text        not null check (category in ('sexual_abuse', 'violence', 'minors')),
  status               text        not null default 'held' check (status in ('held', 'lifted')),
  first_seen_at        timestamptz not null default now(),
  first_signal_id      uuid        references public.signals (id) on delete set null,
  lifted_at            timestamptz,
  lifted_by_signal_id  uuid        references public.signals (id) on delete set null,
  lifted_by            uuid,
  lift_reason          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (person_id, category),
  constraint allegation_claims_lift_consistent check ((status = 'lifted') = (lifted_at is not null))
);

alter table public.allegation_claims enable row level security;
revoke all on public.allegation_claims from public, anon, authenticated;

comment on table public.allegation_claims is 'One row per person per serious-crime allegation (its category): held until a tier 1-2 publisher story is admitted or an operator lifts it.';

-- -----------------------------------------------------------------------------
-- 2. The guard: the display columns are set through the functions below
-- -----------------------------------------------------------------------------

create or replace function public.display_columns_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.hidden_at is distinct from old.hidden_at or new.hide_reason is distinct from old.hide_reason) and not public.market_write_is_admin() then
    raise exception 'signals.hidden_at is set through admin_hide_signal() or admin_unhide_signal(), which write the audit row in the same transaction'
      using errcode = '42501';
  end if;
  if (new.allegation is distinct from old.allegation or new.allegation_held is distinct from old.allegation_held) and not public.market_write_is_admin() then
    raise exception 'signals.allegation is set through record_allegation_holds() or admin_lift_allegation_hold()'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.display_columns_guard() from public, anon, authenticated;

create trigger signals_display_guard
  before update of hidden_at, hide_reason, allegation, allegation_held on public.signals
  for each row execute function public.display_columns_guard();

-- -----------------------------------------------------------------------------
-- 3. The Engine's write: the tick's classifications, and the claim they belong to
-- -----------------------------------------------------------------------------

-- p_rows: [{signal_id, category, method, publisher_domain, publisher_tier, qualifying}]
-- A qualifying story (a tier 1-2 publisher) lifts the person's claim and
-- displays; any other story on the claim is held, before or after the lift.
create or replace function public.record_allegation_holds(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row      jsonb;
  v_signal   record;
  v_claim    public.allegation_claims%rowtype;
  v_held     boolean;
  v_count    integer := 0;
  v_held_n   integer := 0;
  v_lifted_n integer := 0;
  v_category text;
  v_tier     integer;
  v_qualify  boolean;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  perform set_config('momentum.market_write', 'admin', true);

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_category := v_row ->> 'category';
    if v_category not in ('sexual_abuse', 'violence', 'minors') then
      raise exception 'category must be sexual_abuse, violence or minors (got %)', v_category using errcode = '22023';
    end if;
    select s.id, s.person_id, s.occurred_at into v_signal from public.signals s where s.id = (v_row ->> 'signal_id')::uuid for update;
    if not found then
      continue;
    end if;
    v_tier    := nullif(v_row ->> 'publisher_tier', '')::integer;
    v_qualify := coalesce((v_row ->> 'qualifying')::boolean, false);

    insert into public.allegation_claims (person_id, category, first_seen_at, first_signal_id)
    values (v_signal.person_id, v_category, v_signal.occurred_at, v_signal.id)
    on conflict (person_id, category) do update set updated_at = now()
    returning * into v_claim;

    if v_qualify and v_claim.status = 'held' then
      update public.allegation_claims
         set status = 'lifted', lifted_at = now(), lifted_by_signal_id = v_signal.id, lift_reason = 'a tier ' || coalesce(v_tier::text, '?') || ' publisher reported the claim', updated_at = now()
       where id = v_claim.id
       returning * into v_claim;
      v_lifted_n := v_lifted_n + 1;
    end if;

    -- The display decision: only a qualifying story displays, whether the
    -- claim is held or lifted. Lower-tier coverage is held either way.
    v_held := not v_qualify;
    update public.signals
       set allegation = jsonb_build_object(
             'category', v_category,
             'method', coalesce(v_row ->> 'method', 'model'),
             'publisher_domain', v_row ->> 'publisher_domain',
             'publisher_tier', v_tier,
             'qualifying', v_qualify,
             'claim_id', v_claim.id,
             'claim_status', v_claim.status,
             'recorded_at', now()
           ),
           allegation_held = v_held
     where id = v_signal.id;
    v_count := v_count + 1;
    if v_held then v_held_n := v_held_n + 1; end if;
  end loop;

  return jsonb_build_object('recorded', v_count, 'held', v_held_n, 'lifted', v_lifted_n);
end;
$$;

revoke execute on function public.record_allegation_holds(jsonb) from public, anon, authenticated;
grant  execute on function public.record_allegation_holds(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 4. The operator's actions, each an audit row
-- -----------------------------------------------------------------------------

alter table public.admin_audit_log drop constraint admin_audit_log_action_check;
alter table public.admin_audit_log add constraint admin_audit_log_action_check check (action in (
  'freeze_account', 'unfreeze_account', 'halt_person', 'lift_halt', 'set_trading_mode',
  'add_excluded_party', 'remove_excluded_party', 'resolve_alert', 'reopen_alert',
  'issue_invite', 'resend_invite', 'revoke_invite',
  'void_signal', 'void_narrative',
  'set_market_parameter', 'set_tier_parameter', 'reset_market',
  'set_engine_parameter',
  'hide_signal', 'unhide_signal', 'lift_allegation_hold'
));

create or replace function public.admin_hide_signal(p_signal_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_now   timestamptz := now();
  v_row   record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  perform set_config('momentum.market_write', 'admin', true);
  select s.person_id, s.headline, s.hidden_at into v_row from public.signals s where s.id = p_signal_id for update;
  if not found then
    raise exception 'Unknown signal %', p_signal_id using errcode = 'P0002';
  end if;
  if v_row.hidden_at is not null then
    raise exception 'Signal % was already hidden at %', p_signal_id, v_row.hidden_at using errcode = '55000';
  end if;
  update public.signals set hidden_at = v_now, hide_reason = left(trim(p_reason), 500) where id = p_signal_id;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'hide_signal', p_alert_id, v_row.person_id, left(p_reason, 500),
          jsonb_build_object('signal_id', p_signal_id, 'headline', left(v_row.headline, 300), 'hidden_at', v_now));
  return jsonb_build_object('ok', true, 'signal_id', p_signal_id, 'person_id', v_row.person_id, 'hidden_at', v_now);
end;
$$;

create or replace function public.admin_unhide_signal(p_signal_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_row   record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  perform set_config('momentum.market_write', 'admin', true);
  select s.person_id, s.headline, s.hidden_at, s.hide_reason into v_row from public.signals s where s.id = p_signal_id for update;
  if not found then
    raise exception 'Unknown signal %', p_signal_id using errcode = 'P0002';
  end if;
  if v_row.hidden_at is null then
    raise exception 'Signal % is not hidden', p_signal_id using errcode = '55000';
  end if;
  update public.signals set hidden_at = null, hide_reason = null where id = p_signal_id;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'unhide_signal', p_alert_id, v_row.person_id, left(p_reason, 500),
          jsonb_build_object('signal_id', p_signal_id, 'headline', left(v_row.headline, 300), 'was_hidden_at', v_row.hidden_at, 'was_hidden_for', v_row.hide_reason));
  return jsonb_build_object('ok', true, 'signal_id', p_signal_id, 'person_id', v_row.person_id);
end;
$$;

-- The operator's lift: this one story displays (the operator has verified the
-- reporting), and the person's claim is marked lifted with the reason. Other
-- held stories on the claim stay held, as a publisher's lift would leave them.
create or replace function public.admin_lift_allegation_hold(p_signal_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_now   timestamptz := now();
  v_row   record;
  v_claim uuid;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  perform set_config('momentum.market_write', 'admin', true);
  select s.person_id, s.headline, s.allegation, s.allegation_held into v_row from public.signals s where s.id = p_signal_id for update;
  if not found then
    raise exception 'Unknown signal %', p_signal_id using errcode = 'P0002';
  end if;
  if v_row.allegation is null then
    raise exception 'Signal % carries no allegation classification', p_signal_id using errcode = '55000';
  end if;
  if not v_row.allegation_held then
    raise exception 'Signal % is not held', p_signal_id using errcode = '55000';
  end if;
  v_claim := nullif(v_row.allegation ->> 'claim_id', '')::uuid;
  update public.signals
     set allegation_held = false,
         allegation = v_row.allegation || jsonb_build_object('lifted_by_operator_at', v_now, 'claim_status', 'lifted')
   where id = p_signal_id;
  if v_claim is not null then
    update public.allegation_claims
       set status = 'lifted', lifted_at = coalesce(lifted_at, v_now), lifted_by = v_actor, lift_reason = left(trim(p_reason), 500), updated_at = v_now
     where id = v_claim;
  end if;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'lift_allegation_hold', p_alert_id, v_row.person_id, left(p_reason, 500),
          jsonb_build_object('signal_id', p_signal_id, 'headline', left(v_row.headline, 300), 'claim_id', v_claim, 'lifted_at', v_now));
  return jsonb_build_object('ok', true, 'signal_id', p_signal_id, 'person_id', v_row.person_id, 'claim_id', v_claim);
end;
$$;

revoke execute on function public.admin_hide_signal(uuid, text, uuid)           from public, anon;
revoke execute on function public.admin_unhide_signal(uuid, text, uuid)         from public, anon;
revoke execute on function public.admin_lift_allegation_hold(uuid, text, uuid)  from public, anon;
grant  execute on function public.admin_hide_signal(uuid, text, uuid)           to authenticated, service_role;
grant  execute on function public.admin_unhide_signal(uuid, text, uuid)         to authenticated, service_role;
grant  execute on function public.admin_lift_allegation_hold(uuid, text, uuid)  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. The console's review list
-- -----------------------------------------------------------------------------

create or replace view public.allegation_review
with (security_invoker = true)
as
select s.id as signal_id,
       p.id as person_id, p.slug as person_slug, p.display_name as person_name,
       s.headline, s.occurred_at, s.impact_score,
       d.name as source,
       coalesce(s.raw_payload ->> 'publisher_domain', s.allegation ->> 'publisher_domain') as publisher_domain,
       coalesce((s.allegation ->> 'publisher_tier')::integer, s.tier) as tier,
       s.allegation ->> 'category' as category,
       s.allegation ->> 'method'   as method,
       coalesce((s.allegation ->> 'qualifying')::boolean, false) as qualifying,
       s.allegation_held as held,
       c.status as claim_status,
       c.id as claim_id,
       c.lifted_at as claim_lifted_at,
       s.hidden_at, s.hide_reason,
       s.voided_at is not null as voided
  from public.signals s
  join public.people p on p.id = s.person_id
  left join public.data_sources d on d.id = s.data_source_id
  left join public.allegation_claims c on c.id = nullif(s.allegation ->> 'claim_id', '')::uuid
 where s.allegation is not null or s.hidden_at is not null;

revoke all on public.allegation_review from public, anon, authenticated;
grant select on public.allegation_review to service_role;

-- -----------------------------------------------------------------------------
-- 6. feed_entries(): a held or hidden signal is neither a card nor evidence
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
  'The Feed, newest first with a keyset cursor: narratives with their linked evidence, stories of two or more displayable signals, and the signals neither links. A voided, hidden or held signal is neither a card nor evidence (2026-10-09).';
