-- PHASE 19 — FORECAST: the crowd layer, capture and display.
--
-- A vote is a forecast about TRAJECTORY ("is this person's momentum rising or
-- falling?"), never a rating of worth: ▲ Rising / ▼ Falling, with a reason
-- tag. Every vote snapshots the person's score at the moment it is cast, and
-- that snapshot is the whole point of writing votes down now: it is what
-- makes accuracy computable later ("was this vote directionally right over
-- the next 30 days?"), and it cannot be backfilled.
--
-- THE ONE HARD RULE OF THIS PHASE: votes influence NOTHING. No vote reaches a
-- score, a force, the drifting target, a memory profile or a narrative. This
-- schema is capture and display only. Nothing in the Engine's read path names
-- forecast_votes, and lib/engine/forecast.test.ts fails if that changes.
--
-- Privacy by construction: a voter is pseudonymous to every other user. RLS
-- lets a user read only their own votes; every other reader sees aggregates
-- through forecast_summary(), and only once enough votes exist that an
-- aggregate cannot be read back to an individual.

-- Per-person kill switch. Admin-set (the console is read-only by design, so
-- this is flipped by SQL like every other lever); hides the section and
-- refuses new votes. The spec's abnormal-activity freeze and vote weighting
-- are future work; this is the piece that must exist before any vote is cast.
alter table public.people
  add column forecast_paused boolean not null default false;

comment on column public.people.forecast_paused is
  'Phase 19: when true, the Forecast section is hidden for this person and cast_forecast_vote() refuses new votes. Admin-set by SQL; the console shows it read-only.';

create table public.forecast_votes (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users (id) on delete cascade,
  person_id      uuid        not null references public.people (id) on delete cascade,
  direction      text        not null check (direction in ('rising', 'falling')),
  reason         text        not null check (reason in ('professional', 'social', 'financial', 'cultural', 'performance', 'media', 'other')),
  -- The person's current_score at the instant of the vote, at the score's own four decimals.
  score_at_vote  numeric(8, 4) not null,
  created_at     timestamptz not null default now(),
  -- Null while this is the user's ACTIVE vote on the person; set when a later vote replaced it. Never deleted: the accuracy record needs the trail.
  superseded_at  timestamptz,
  check (superseded_at is null or superseded_at >= created_at)
);

comment on table public.forecast_votes is
  'Phase 19: crowd forecasts of a person''s momentum trajectory (rising | falling) with a reason tag and the score at vote time. One active vote per user per person; re-voting supersedes rather than deletes. Votes influence no score in this phase (Forecast force weight 0.00).';

-- One ACTIVE vote per user per person.
create unique index forecast_votes_one_active_idx on public.forecast_votes (user_id, person_id) where superseded_at is null;
-- The aggregate read and the rate-limit read.
create index forecast_votes_person_active_idx on public.forecast_votes (person_id) where superseded_at is null;
create index forecast_votes_user_recent_idx   on public.forecast_votes (user_id, created_at desc);

-- RLS: a user reads their own votes and nothing else; no client writes at all.
alter table public.forecast_votes enable row level security;

create policy forecast_votes_select_own
  on public.forecast_votes for select
  to authenticated
  using ((select auth.uid()) = user_id);

grant select on public.forecast_votes to authenticated;
grant all    on public.forecast_votes to service_role;
revoke insert, update, delete on public.forecast_votes from anon, authenticated;

-- The two numbers this phase chose, as functions so SQL and TypeScript can be
-- pinned to agree by a test (the starting_balance_cents() pattern).

-- Distinct people one user may vote on in any trailing hour. Sixteen subjects
-- today: a person can forecast the whole roster in a sitting; a script cannot
-- sweep it repeatedly. Re-voting on the same person does not count against it.
create or replace function public.forecast_rate_limit_per_hour()
returns integer language sql immutable as $$ select 20 $$;

-- Active votes a person needs before the Rising / Falling split is shown. A
-- lone vote reading "100% Falling" is the wrong first impression, and below
-- this an aggregate can be read back to the one or two people behind it.
create or replace function public.forecast_min_votes()
returns integer language sql immutable as $$ select 5 $$;

revoke execute on function public.forecast_rate_limit_per_hour() from public;
revoke execute on function public.forecast_min_votes() from public;
grant  execute on function public.forecast_rate_limit_per_hour() to authenticated, service_role;
grant  execute on function public.forecast_min_votes() to authenticated, service_role;

-- One vote as the client sees it: their own, never anybody else's.
create or replace function public.forecast_vote_json(v public.forecast_votes)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id,
    'personId', v.person_id,
    'direction', v.direction,
    'reason', v.reason,
    'scoreAtVote', v.score_at_vote,
    'createdAt', v.created_at,
    'supersededAt', v.superseded_at
  )
$$;

-- Cast a vote. The actor is auth.uid(), never a parameter. Every refusal is a
-- returned value with a code; only a missing session raises.
create or replace function public.cast_forecast_vote(
  p_person_id uuid,
  p_direction text,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id   uuid := auth.uid();
  v_person    record;
  v_active    public.forecast_votes%rowtype;
  v_distinct  integer;
  v_vote      public.forecast_votes%rowtype;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_direction is null or p_direction not in ('rising', 'falling') then
    return jsonb_build_object('ok', false, 'code', 'invalid', 'message', 'direction must be rising or falling.');
  end if;
  if p_reason is null or p_reason not in ('professional', 'social', 'financial', 'cultural', 'performance', 'media', 'other') then
    return jsonb_build_object('ok', false, 'code', 'invalid', 'message', 'reason must be one of the seven tags.');
  end if;

  select p.id, p.is_active, p.forecast_paused, p.current_score
    into v_person
    from public.people p
   where p.id = p_person_id;
  if not found or not v_person.is_active then
    return jsonb_build_object('ok', false, 'code', 'unknown_person', 'message', 'That person is not on the board.');
  end if;
  if v_person.forecast_paused then
    return jsonb_build_object('ok', false, 'code', 'paused', 'message', 'Forecasts are paused for this person.');
  end if;

  -- The same forecast again is a no-op: the trail records changes of mind, not repetition.
  select * into v_active
    from public.forecast_votes v
   where v.user_id = v_user_id and v.person_id = p_person_id and v.superseded_at is null;
  if found and v_active.direction = p_direction and v_active.reason = p_reason then
    return jsonb_build_object('ok', true, 'changed', false, 'vote', public.forecast_vote_json(v_active));
  end if;

  -- Rate limit: distinct OTHER people this user has voted on in the trailing hour.
  select count(distinct v.person_id) into v_distinct
    from public.forecast_votes v
   where v.user_id = v_user_id
     and v.person_id <> p_person_id
     and v.created_at > now() - interval '1 hour';
  if v_distinct >= public.forecast_rate_limit_per_hour() then
    return jsonb_build_object('ok', false, 'code', 'rate_limited',
      'message', format('You can forecast up to %s people an hour. Try again a little later.', public.forecast_rate_limit_per_hour()));
  end if;

  -- Supersede, never delete: the accuracy record needs the full trail.
  update public.forecast_votes
     set superseded_at = now()
   where user_id = v_user_id and person_id = p_person_id and superseded_at is null;

  insert into public.forecast_votes (user_id, person_id, direction, reason, score_at_vote)
  values (v_user_id, p_person_id, p_direction, p_reason, v_person.current_score)
  returning * into v_vote;

  return jsonb_build_object('ok', true, 'changed', true, 'vote', public.forecast_vote_json(v_vote));
end;
$$;

-- What everyone sees: the split and the top reasons, once enough votes exist.
-- Below forecast_min_votes() only the total is returned, never the direction
-- split, so a lone vote cannot be read as "100% Falling" and a second voter
-- cannot subtract their own vote from the aggregate to find the first.
create or replace function public.forecast_summary(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active as (
    select v.direction, v.reason
      from public.forecast_votes v
     where v.person_id = p_person_id and v.superseded_at is null
  ),
  totals as (
    select count(*)::int as total,
           count(*) filter (where direction = 'rising')::int  as rising,
           count(*) filter (where direction = 'falling')::int as falling
      from active
  ),
  reasons as (
    select direction, reason, count(*)::int as n
      from active
     group by direction, reason
  ),
  top as (
    select direction,
           jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc, reason) as tags
      from (
        select direction, reason, n, row_number() over (partition by direction order by n desc, reason) as rank
          from reasons
      ) ranked
     where rank <= 3
     group by direction
  )
  select jsonb_build_object(
    'personId', p_person_id,
    'total', t.total,
    'minVotes', public.forecast_min_votes(),
    'revealed', t.total >= public.forecast_min_votes(),
    'rising',  case when t.total >= public.forecast_min_votes() then t.rising  end,
    'falling', case when t.total >= public.forecast_min_votes() then t.falling end,
    'risingReasons',  case when t.total >= public.forecast_min_votes() then coalesce((select tags from top where direction = 'rising'),  '[]'::jsonb) end,
    'fallingReasons', case when t.total >= public.forecast_min_votes() then coalesce((select tags from top where direction = 'falling'), '[]'::jsonb) end
  )
  from totals t
$$;

revoke execute on function public.cast_forecast_vote(uuid, text, text) from public, anon;
grant  execute on function public.cast_forecast_vote(uuid, text, text) to authenticated, service_role;
revoke execute on function public.forecast_vote_json(public.forecast_votes) from public, anon;
grant  execute on function public.forecast_vote_json(public.forecast_votes) to authenticated, service_role;
revoke execute on function public.forecast_summary(uuid) from public, anon;
grant  execute on function public.forecast_summary(uuid) to authenticated, service_role;

comment on function public.cast_forecast_vote(uuid, text, text) is
  'Phase 19: cast or change the signed-in user''s forecast on a person (rising | falling, with a reason tag). Snapshots the score, supersedes the prior active vote, enforces forecast_rate_limit_per_hour() distinct people an hour and the person''s forecast_paused flag. Refusals are returned values with a code.';
comment on function public.forecast_summary(uuid) is
  'Phase 19: the crowd''s forecast on a person as aggregates only: total active votes, and the Rising / Falling split with the top three reason tags per direction once at least forecast_min_votes() exist. Never an individual vote.';
