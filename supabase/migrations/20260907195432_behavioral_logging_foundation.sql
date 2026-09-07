-- =============================================================================
-- Momentum Terminal — Phase 5: behavioral logging foundation
--
-- behavioral_events is the raw material for the future recommendation
-- algorithm ("For You"). This migration shapes it for that use:
--
--   * session_id groups events into browsing sessions (sequence features).
--   * event_type is validated by FORMAT only (lowercase snake_case). The
--     canonical list lives in lib/behavioral/events.ts and is enforced by the
--     logging service, so adding an event type needs no migration.
--   * metadata must be a JSON object and stay small.
--   * Indexes match the queries a recommender runs: per user over time, per
--     person by event type over time, per event type over time, per session.
--   * Clients keep SELECT (own rows) and INSERT (own rows, chosen columns
--     only: id and created_at are always set by the database). No UPDATE or
--     DELETE: the log is append-only (Phase 2).
--   * Three read-side aggregate functions for the recommendation layer.
--     EXECUTE is granted to service_role only; a signed-in user cannot call
--     them, and RLS would hide other users' rows even if they could.
--
-- Privacy: this data exists for personalisation. It must be handled under
-- whatever privacy policy the platform adopts (retention, export, deletion
-- on account removal — the user_id foreign key already cascades).
-- =============================================================================

-- 1. session_id -----------------------------------------------------------------
alter table public.behavioral_events
  add column session_id uuid;

comment on column public.behavioral_events.session_id is
  'Client-generated browsing-session id (mt_bsid cookie: one id per browser session, rotated after 30 minutes of inactivity). Groups events into sequences. Null when the event was logged server-side without a session.';

-- 2. event_type: format check instead of an enumerated list --------------------
alter table public.behavioral_events
  drop constraint behavioral_events_event_type_check;

alter table public.behavioral_events
  add constraint behavioral_events_event_type_check
  check (event_type ~ '^[a-z][a-z0-9_]{1,63}$');

comment on column public.behavioral_events.event_type is
  'Canonical values are BEHAVIORAL_EVENT_TYPES in lib/behavioral/events.ts: view_person, time_spent, expand_signal, take_position, close_position, follow_person, unfollow_person, search, view_feed, swipe. The database enforces only the format (lowercase snake_case, 2-64 chars) so a new type needs no migration; the logging service enforces the list.';

-- 3. metadata: a small JSON object or null --------------------------------------
alter table public.behavioral_events
  add constraint behavioral_events_metadata_check
  check (metadata is null or (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 8192));

comment on column public.behavioral_events.metadata is
  'Per-event details, shaped per event type (see lib/behavioral/events.ts): time_spent.duration_ms, take_position.direction/amount_cents, search.query, swipe.action, ...';

-- 4. indexes -------------------------------------------------------------------
-- (user_id, created_at) already exists from Phase 1: behavioral_events_user_created_idx.
create index behavioral_events_person_type_created_idx
  on public.behavioral_events (person_id, event_type, created_at);

create index behavioral_events_type_created_idx
  on public.behavioral_events (event_type, created_at);

create index behavioral_events_session_created_idx
  on public.behavioral_events (session_id, created_at)
  where session_id is not null;

-- Superseded: person_id leads the new (person_id, event_type, created_at) index.
drop index if exists public.behavioral_events_person_id_idx;

-- 5. privileges ----------------------------------------------------------------
-- anon has no policies on this table; drop its grants so that stays true.
revoke all on public.behavioral_events from anon;

-- Clients insert only the columns they own. id and created_at come from the
-- database defaults, so a client can neither choose ids nor backdate events.
revoke insert on public.behavioral_events from authenticated;
grant insert (user_id, event_type, person_id, metadata, session_id)
  on public.behavioral_events to authenticated;

-- (behavioral_events_select_own / behavioral_events_insert_own policies and the
-- Phase 2 revoke of UPDATE / DELETE stay exactly as they are.)

-- 6. read-side aggregates (service_role only) ----------------------------------

-- Per user: one row per (person, event_type) with counts, dwell time and the
-- first / last time they interacted. Folded into UserInteractionHistory in TS.
create or replace function public.behavioral_user_history(
  p_user_id     uuid,
  p_since       timestamptz,
  p_event_types text[] default null
)
returns table (
  person_id         uuid,
  event_type        text,
  event_count       bigint,
  total_duration_ms bigint,
  first_at          timestamptz,
  last_at           timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.person_id,
         e.event_type,
         count(*)::bigint as event_count,
         coalesce(sum(
           case when e.event_type = 'time_spent' and jsonb_typeof(e.metadata -> 'duration_ms') = 'number'
                then floor((e.metadata ->> 'duration_ms')::numeric)
                else 0 end
         ), 0)::bigint as total_duration_ms,
         min(e.created_at) as first_at,
         max(e.created_at) as last_at
    from public.behavioral_events e
   where e.user_id = p_user_id
     and e.created_at >= p_since
     and (p_event_types is null or e.event_type = any (p_event_types))
   group by e.person_id, e.event_type
   order by max(e.created_at) desc;
$$;

comment on function public.behavioral_user_history(uuid, timestamptz, text[]) is
  'Recommendation read side: per (person, event_type) aggregates for one user since p_since. service_role only.';

-- Per person, at three grouping levels so unique-user counts are exact at each
-- (a user holding both a HIGH and a LOW position counts once for take_position):
--   grouping_level 0: per (event_type, detail)   detail = position direction / swipe action
--   grouping_level 1: per event_type
--   grouping_level 3: grand total (event_type null) with the overall unique-user count
create or replace function public.behavioral_person_engagement(
  p_person_id uuid,
  p_since     timestamptz
)
returns table (
  event_type        text,
  detail            text,
  event_count       bigint,
  unique_users      bigint,
  total_duration_ms bigint,
  grouping_level    smallint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ev as (
    select e.event_type,
           case e.event_type
             when 'take_position' then e.metadata ->> 'direction'
             when 'swipe'         then e.metadata ->> 'action'
             else null
           end as detail,
           e.user_id,
           case when e.event_type = 'time_spent' and jsonb_typeof(e.metadata -> 'duration_ms') = 'number'
                then floor((e.metadata ->> 'duration_ms')::numeric)
                else 0 end as duration_ms
      from public.behavioral_events e
     where e.person_id = p_person_id
       and e.created_at >= p_since
  )
  select ev.event_type,
         ev.detail,
         count(*)::bigint as event_count,
         count(distinct ev.user_id)::bigint as unique_users,
         coalesce(sum(ev.duration_ms), 0)::bigint as total_duration_ms,
         (grouping(ev.event_type) * 2 + grouping(ev.detail))::smallint as grouping_level
    from ev
   group by grouping sets ((ev.event_type, ev.detail), (ev.event_type), ())
   order by grouping_level desc, ev.event_type, ev.detail;
$$;

comment on function public.behavioral_person_engagement(uuid, timestamptz) is
  'Recommendation read side: engagement aggregates for one person since p_since. grouping_level 0 = per (event_type, detail), 1 = per event_type, 3 = grand total (event_type null). service_role only.';

-- Co-engagement: pairs of people engaged by the same users. The raw material
-- for "users who engaged with A also engaged with B".
create or replace function public.behavioral_co_engagement(
  p_since            timestamptz,
  p_event_types      text[] default null,
  p_min_shared_users integer default 2,
  p_limit            integer default 200
)
returns table (
  person_a     uuid,
  person_b     uuid,
  shared_users bigint,
  users_a      bigint,
  users_b      bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with engaged as (
    select distinct e.user_id, e.person_id
      from public.behavioral_events e
     where e.person_id is not null
       and e.created_at >= p_since
       and (p_event_types is null or e.event_type = any (p_event_types))
  ),
  per_person as (
    select person_id, count(*)::bigint as users
      from engaged
     group by person_id
  )
  select a.person_id as person_a,
         b.person_id as person_b,
         count(*)::bigint as shared_users,
         pa.users as users_a,
         pb.users as users_b
    from engaged a
    join engaged b on b.user_id = a.user_id and a.person_id < b.person_id
    join per_person pa on pa.person_id = a.person_id
    join per_person pb on pb.person_id = b.person_id
   group by a.person_id, b.person_id, pa.users, pb.users
  having count(*) >= greatest(coalesce(p_min_shared_users, 1), 1)
   order by shared_users desc, a.person_id, b.person_id
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

comment on function public.behavioral_co_engagement(timestamptz, text[], integer, integer) is
  'Recommendation read side: pairs of people engaged by the same users since p_since, with per-person user counts for similarity measures. service_role only.';

revoke execute on function public.behavioral_user_history(uuid, timestamptz, text[])                from public, anon, authenticated;
revoke execute on function public.behavioral_person_engagement(uuid, timestamptz)                    from public, anon, authenticated;
revoke execute on function public.behavioral_co_engagement(timestamptz, text[], integer, integer)  from public, anon, authenticated;

grant execute on function public.behavioral_user_history(uuid, timestamptz, text[])                to service_role;
grant execute on function public.behavioral_person_engagement(uuid, timestamptz)                    to service_role;
grant execute on function public.behavioral_co_engagement(timestamptz, text[], integer, integer)  to service_role;
