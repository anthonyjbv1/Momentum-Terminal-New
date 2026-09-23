-- Phase 28 — THE FIRST PUBLIC PAGE.
--
-- A landing page needs two things from the database that nothing before it
-- did: somewhere to keep the email addresses of people who want in, and a
-- way for a visitor who is nobody yet to leave a footprint in the behavioural
-- log. Both are built so that the public side of them is as small as it can
-- be: the waitlist has no client access at all, and an anonymous event is a
-- row nobody but the operator can read.
--
-- NOTHING ABOUT ANY OTHER PERSON IS TOUCHED. The public endpoint that feeds
-- the page reads through the service role and names one slug in code; no
-- policy here widens what anon may see of people, scores or signals.

-- ---------------------------------------------------------------------------
-- 0. citext: one row per address, however it is capitalised
-- ---------------------------------------------------------------------------
-- Supabase keeps extensions in their own schema; the type is referenced
-- schema-qualified below so SECURITY DEFINER functions with an empty
-- search_path can name it.

create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. The waitlist
-- ---------------------------------------------------------------------------

create table public.waitlist (
  id           uuid              primary key default gen_random_uuid(),
  email        extensions.citext not null,
  created_at   timestamptz       not null default now(),
  -- When the person agreed to be contacted about the beta: submitting the
  -- form is the consent, so it is stamped with the row. Kept as its own
  -- column so a later change to how consent is gathered has somewhere to go.
  consent_at   timestamptz       not null default now(),
  -- Which form on which page: landing_hero | landing_footer | ...
  source       text,
  -- The campaign parameters the visitor arrived with, verbatim and bounded.
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_content  text,
  utm_term     text,
  -- The referring page, if the browser sent one.
  referrer     text,

  constraint waitlist_email_unique   unique (email),
  constraint waitlist_email_shape    check (email::text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(email::text) between 6 and 254),
  constraint waitlist_source_length  check (source is null or length(source) <= 64),
  constraint waitlist_utm_lengths    check (
    coalesce(length(utm_source), 0) <= 128 and coalesce(length(utm_medium), 0) <= 128 and coalesce(length(utm_campaign), 0) <= 128
    and coalesce(length(utm_content), 0) <= 128 and coalesce(length(utm_term), 0) <= 128
  ),
  constraint waitlist_referrer_length check (referrer is null or length(referrer) <= 512)
);

comment on table public.waitlist is
  'Phase 28: people who asked to join the beta from the landing page. Email (case-insensitive, unique), when, consent, and where they came from. NO client access of any kind: no grant, no policy; rows are written by join_waitlist() from the server route and read by the operator console through the service role. Nothing is ever sent to these addresses by the platform itself in this phase.';
comment on column public.waitlist.consent_at is 'When the person agreed to be contacted about the beta. Submitting the form is the consent, so it is stamped with the row.';
comment on column public.waitlist.source is 'Which form was used: landing_hero, landing_footer, ...';

alter table public.waitlist enable row level security;
revoke all on public.waitlist from public, anon, authenticated;
-- No policy is created on purpose: with row level security on and nothing
-- granted, anon and authenticated cannot read, insert, update or delete a
-- row through any client, and the only path in is the function below.

-- ---------------------------------------------------------------------------
-- 2. join_waitlist(): idempotent, and it never says whether you were already in
-- ---------------------------------------------------------------------------
-- Returns the same shape for a new address and a known one: the position in
-- the list (a real row count, never an estimate) and when the row was made.
-- `created` is for the server's own logging and is not shown to the visitor,
-- so the page cannot be used to test whether an address is on the list.

create or replace function public.join_waitlist(
  p_email    text,
  p_source   text  default null,
  p_utm      jsonb default null,
  p_referrer text  default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $function$
declare
  v_email    text := lower(trim(p_email));
  v_id       uuid;
  v_at       timestamptz;
  v_created  boolean := false;
  v_position bigint;
begin
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254 then
    raise exception 'join_waitlist: not an email address' using errcode = '22023';
  end if;

  insert into public.waitlist (email, source, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer)
  values (
    v_email,
    left(nullif(trim(p_source), ''), 64),
    left(nullif(trim(p_utm ->> 'source'), ''), 128),
    left(nullif(trim(p_utm ->> 'medium'), ''), 128),
    left(nullif(trim(p_utm ->> 'campaign'), ''), 128),
    left(nullif(trim(p_utm ->> 'content'), ''), 128),
    left(nullif(trim(p_utm ->> 'term'), ''), 128),
    left(nullif(trim(p_referrer), ''), 512)
  )
  on conflict (email) do nothing
  returning id, created_at into v_id, v_at;

  if v_id is not null then
    v_created := true;
  else
    select w.id, w.created_at into v_id, v_at from public.waitlist w where w.email = v_email;
  end if;

  -- The position is the count of rows made at or before this one, ties broken
  -- by id so it is stable. A REAL number: what the page shows the visitor.
  select count(*) into v_position from public.waitlist w where (w.created_at, w.id) <= (v_at, v_id);

  return jsonb_build_object('created', v_created, 'position', v_position, 'joined_at', v_at);
end;
$function$;

revoke execute on function public.join_waitlist(text, text, jsonb, text) from public, anon, authenticated;
grant  execute on function public.join_waitlist(text, text, jsonb, text) to service_role;

comment on function public.join_waitlist(text, text, jsonb, text) is
  'Phase 28: adds an address to the waitlist, or finds it if it is already there, and returns {created, position, joined_at}. Position is the real row count at or before this row. Service role only: the server route calls it after the honeypot and the per-IP limit.';

-- ---------------------------------------------------------------------------
-- 3. Anonymous behavioural events
-- ---------------------------------------------------------------------------
-- A landing-page view has no user. Rather than invent one, the actor column
-- becomes nullable and a check insists that an event names SOMEBODY — a user
-- or a browsing session — so a row can never be unattributable. The existing
-- policies compare user_id to auth.uid(), which is never true of a null, so a
-- signed-in user can neither read nor write an anonymous row; they are the
-- server's (service role) alone, and the operator console's to count.

alter table public.behavioral_events alter column user_id drop not null;

alter table public.behavioral_events
  add constraint behavioral_events_actor_check check (user_id is not null or session_id is not null);

comment on column public.behavioral_events.user_id is
  'The acting user. Null for an anonymous event from a public page (Phase 28: view_landing, join_waitlist), which then carries a session_id instead; behavioral_events_actor_check requires one or the other.';
