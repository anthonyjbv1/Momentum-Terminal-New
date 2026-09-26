-- Phase 32 — SIGNUP, ONBOARDING AND THE BASIC PROFILE PAGE.
--
-- The way in becomes an invitation, and only an invitation. Everything a
-- person sees of it sits behind BETA_SIGNUP_ENABLED in the app; what this
-- migration adds is the part that holds whatever the app does:
--
--   1. Every new auth user needs an OPEN, ATTESTED invite for the same
--      address, or the account is not created. The rule lives in the
--      on_auth_user_created trigger, so it covers every door at once: the
--      join page, Google, a magic link asked for from anywhere, and a direct
--      call to the auth API with the publishable key (which, before this,
--      created an account for anyone who asked).
--   2. Invites are single-use, expire, can be resent (a new token; the old one
--      dies) and revoked, and say who sent them and when. Only a SHA-256 of
--      the token is stored.
--   3. The 18+ attestation and the acceptance of the Terms and the Privacy
--      notice are recorded against the account, with their versions and times.
--   4. A member has a referral code; a waitlist row keeps the code its visitor
--      arrived with; an invite carries it; the account that accepts it is
--      referred_by the member. The referral-spike detector finally has data.
--   5. Following a person, the onboarding mark, an email preference, a photo.
--   6. Self-serve deletion that keeps the books whole: personal data goes, the
--      auth account goes (identities, sessions and tokens with it), and the
--      money rows stay, attached to an anonymised stub that names nobody.
--
-- NOTHING IN THE ENGINE, SCORING, INGESTION OR THE MARKET IS TOUCHED.

-- ---------------------------------------------------------------------------
-- 0. The profile outlives the auth account
-- ---------------------------------------------------------------------------
-- public.users.id referenced auth.users ON DELETE CASCADE, and positions,
-- orders, lots, closes, transactions and portfolio history cascade from
-- public.users. Deleting an auth user therefore deleted every money row the
-- ledger reconciles against. Worse, admin_audit_log.target_user_id is ON
-- DELETE SET NULL while the log refuses every update, so any account an
-- operator had ever acted on could not be deleted at all. The profile row is
-- now never deleted: deletion anonymises it and removes the auth account
-- instead (delete_my_account below). A profile row without an auth row is a
-- deleted account, and says so in deleted_at.

alter table public.users drop constraint users_id_fkey;

comment on column public.users.id is
  'The auth user''s id at creation. Phase 32: no longer a foreign key to auth.users. A deleted account keeps its row, anonymised, with deleted_at set and no auth user behind it, so the ledger rows that reference it keep reconciling.';

-- Forecast votes hung off auth.users directly and would have vanished with a
-- deleted account, taking the crowd counts with them. They now hang off the
-- profile, which stays.
alter table public.forecast_votes drop constraint forecast_votes_user_id_fkey;
alter table public.forecast_votes
  add constraint forecast_votes_user_id_fkey foreign key (user_id) references public.users (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 1. New profile columns
-- ---------------------------------------------------------------------------

alter table public.users
  add column referral_code  text,
  add column signup_source  jsonb,
  add column onboarded_at   timestamptz,
  add column email_updates  boolean not null default false,
  add column avatar_path    text,
  add column deleted_at     timestamptz;

alter table public.users
  add constraint users_referral_code_format check (referral_code is null or referral_code ~ '^[a-hj-km-np-z2-9]{8}$'),
  add constraint users_avatar_path_shape    check (avatar_path is null or avatar_path ~ '^[0-9a-f-]{36}/[a-z0-9]{16,64}\.(jpg|png|webp)$'),
  add constraint users_deleted_is_anonymous check (deleted_at is null or (referral_code is null and avatar_path is null and avatar_url is null and verified_identity_key is null));

create unique index users_referral_code_key on public.users (referral_code) where referral_code is not null;

comment on column public.users.referral_code is 'Phase 32: the member''s referral code (8 characters, no look-alike letters or digits). A link carrying it puts the code on a waitlist row, the invite carries it, and the account that accepts the invite is referred_by this member.';
comment on column public.users.signup_source is 'Phase 32: where the account came from, copied from the waitlist row through the invite: {form, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host, ref_code}. Null for accounts made before Phase 32.';
comment on column public.users.onboarded_at is 'Phase 32: when the account finished or skipped the onboarding screens. Null until then.';
comment on column public.users.email_updates is 'Phase 32: the one notification preference: occasional beta updates by email. Off by default.';
comment on column public.users.avatar_path is 'Phase 32: the uploaded photo, as a path in the private avatars bucket (<user id>/<random>.<ext>). Served only through a short-lived signed URL.';
comment on column public.users.deleted_at is 'Phase 32: when the account was deleted. The row stays, anonymised, for the ledger.';

-- The self-editable columns: the three there were, plus the email preference.
grant update (email_updates) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Referral codes
-- ---------------------------------------------------------------------------

create or replace function public.new_referral_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  -- No i, l, o, 0 or 1: a code read aloud or copied by hand survives.
  v_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_code     text;
  v_attempt  integer := 0;
begin
  loop
    v_code := '';
    for v_i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.users u where u.referral_code = v_code);
    v_attempt := v_attempt + 1;
    if v_attempt >= 20 then
      raise exception 'new_referral_code: no free code after 20 draws' using errcode = 'P0001';
    end if;
  end loop;
  return v_code;
end;
$$;

revoke execute on function public.new_referral_code() from public, anon, authenticated;

update public.users set referral_code = public.new_referral_code() where referral_code is null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 3. The waitlist remembers the code its visitor arrived with
-- ---------------------------------------------------------------------------

alter table public.waitlist
  add column ref_code text,
  add constraint waitlist_ref_code_format check (ref_code is null or ref_code ~ '^[a-hj-km-np-z2-9]{8}$');

comment on column public.waitlist.ref_code is 'Phase 32: the referral code in the link the visitor arrived by (?ref=), if any. Carried onto the invite, then onto the account as referred_by.';

-- A new argument means a new signature; the old one goes first so a call
-- with four named arguments never finds two candidates. The deployed code
-- calls with four until the new code ships, and the default serves it.
drop function public.join_waitlist(text, text, jsonb, text);

create or replace function public.join_waitlist(
  p_email    text,
  p_source   text  default null,
  p_utm      jsonb default null,
  p_referrer text  default null,
  p_ref      text  default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $function$
declare
  v_email    text := lower(trim(p_email));
  v_ref      text := lower(trim(p_ref));
  v_id       uuid;
  v_at       timestamptz;
  v_created  boolean := false;
  v_position bigint;
begin
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254 then
    raise exception 'join_waitlist: not an email address' using errcode = '22023';
  end if;
  -- A malformed code is dropped, never refused: the visitor still joins.
  if v_ref is not null and v_ref !~ '^[a-hj-km-np-z2-9]{8}$' then
    v_ref := null;
  end if;

  insert into public.waitlist (email, source, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, ref_code)
  values (
    v_email,
    left(nullif(trim(p_source), ''), 64),
    left(nullif(trim(p_utm ->> 'source'), ''), 128),
    left(nullif(trim(p_utm ->> 'medium'), ''), 128),
    left(nullif(trim(p_utm ->> 'campaign'), ''), 128),
    left(nullif(trim(p_utm ->> 'content'), ''), 128),
    left(nullif(trim(p_utm ->> 'term'), ''), 128),
    left(nullif(trim(p_referrer), ''), 512),
    v_ref
  )
  on conflict (email) do nothing
  returning id, created_at into v_id, v_at;

  if v_id is not null then
    v_created := true;
  else
    select w.id, w.created_at into v_id, v_at from public.waitlist w where w.email = v_email;
  end if;

  select count(*) into v_position from public.waitlist w where (w.created_at, w.id) <= (v_at, v_id);

  return jsonb_build_object('created', v_created, 'position', v_position, 'joined_at', v_at);
end;
$function$;

revoke execute on function public.join_waitlist(text, text, jsonb, text, text) from public, anon, authenticated;
grant  execute on function public.join_waitlist(text, text, jsonb, text, text) to service_role;

comment on function public.join_waitlist(text, text, jsonb, text, text) is
  'Phase 28, Phase 32: adds an address to the waitlist (with the referral code it arrived with, if well-formed), or finds it, and returns {created, position, joined_at}. Service role only.';

-- ---------------------------------------------------------------------------
-- 4. Invites
-- ---------------------------------------------------------------------------

create table public.invites (
  id                   uuid              primary key default gen_random_uuid(),
  -- Nulled when the account it made is deleted: the address is personal data.
  email                extensions.citext,
  -- SHA-256 of the token, hex. The token itself exists only in the email.
  token_hash           text              not null,
  waitlist_id          uuid              references public.waitlist (id) on delete set null,
  referrer_user_id     uuid              references public.users (id) on delete set null,
  -- The waitlist's form, campaign and referrer, copied when the invite is made.
  source               jsonb,
  invited_by           uuid              not null references public.users (id) on delete restrict,
  created_at           timestamptz       not null default now(),
  expires_at           timestamptz       not null,
  -- The email: when it last went out, how many times, and why it last failed.
  sent_at              timestamptz,
  send_count           integer           not null default 0,
  last_send_error      text,
  revoked_at           timestamptz,
  revoked_by           uuid              references public.users (id) on delete set null,
  revoke_note          text,
  -- The join form, filled before any account exists.
  attested_at          timestamptz,
  age_attested         boolean           not null default false,
  terms_version        text,
  privacy_version      text,
  desired_username     text,
  desired_display_name text,
  -- SHA-256 (hex) of the one-time secret our server made when the join form
  -- was accepted. The secret travels only in that sign-in request; an email
  -- sign-up must carry it, so nobody who merely knows an invited address can
  -- claim the invite through the public sign-up endpoint.
  join_nonce_hash      text,
  -- The account that accepted it.
  accepted_at          timestamptz,
  accepted_user_id     uuid              references public.users (id) on delete set null,

  constraint invites_token_hash_shape    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint invites_email_shape         check (email is null or (email::text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(email::text) between 6 and 254)),
  constraint invites_email_until_scrubbed check (email is not null or accepted_at is not null or revoked_at is not null),
  constraint invites_expiry_after_create check (expires_at > created_at),
  constraint invites_send_count_nonneg   check (send_count >= 0),
  -- The username goes with the address when an account is deleted; the attestation's facts stay.
  constraint invites_attestation_whole   check (attested_at is null or (age_attested and terms_version is not null and privacy_version is not null and (desired_username is not null or email is null))),
  constraint invites_username_format     check (desired_username is null or desired_username ~ '^[a-z0-9_]{3,30}$'),
  constraint invites_join_nonce_shape    check (join_nonce_hash is null or join_nonce_hash ~ '^[0-9a-f]{64}$'),
  constraint invites_display_name_length check (desired_display_name is null or length(desired_display_name) between 1 and 80),
  constraint invites_user_only_accepted check (accepted_user_id is null or accepted_at is not null),
  constraint invites_note_length         check (revoke_note is null or length(revoke_note) <= 500),
  constraint invites_error_length        check (last_send_error is null or length(last_send_error) <= 500)
);

create unique index invites_token_hash_key on public.invites (token_hash);
-- One OPEN invite per address: a second is a resend, never a duplicate.
create unique index invites_one_open_per_email on public.invites (email) where revoked_at is null and accepted_at is null;
create index invites_created_idx on public.invites (created_at desc, id desc);
create index invites_accepted_user_idx on public.invites (accepted_user_id) where accepted_user_id is not null;

comment on table public.invites is
  'Phase 32: single-use invitations to the beta. Only the SHA-256 of a token is stored. Pending until accepted, revoked or past expires_at; a resend replaces the token and the expiry. No client access of any kind: written by the admin RPCs and read by the server through the service role.';

alter table public.invites enable row level security;
revoke all on public.invites from public, anon, authenticated;
grant all on public.invites to service_role;

/** The one status a row is in, in the order the rules apply. */
create or replace function public.invite_status(p_revoked_at timestamptz, p_accepted_at timestamptz, p_expires_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_accepted_at is not null then 'accepted'
    when p_revoked_at  is not null then 'revoked'
    when p_expires_at <= now()     then 'expired'
    else 'pending'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 5. What an account agreed to
-- ---------------------------------------------------------------------------

create table public.user_consents (
  id          bigint      generated always as identity primary key,
  user_id     uuid        not null references public.users (id) on delete cascade,
  kind        text        not null,
  version     text        not null,
  accepted_at timestamptz not null,
  invite_id   uuid        references public.invites (id) on delete set null,
  recorded_at timestamptz not null default now(),

  constraint user_consents_kind_check    check (kind in ('age_18_plus', 'terms', 'privacy')),
  constraint user_consents_version_shape check (length(version) between 1 and 64)
);

create index user_consents_user_idx on public.user_consents (user_id, kind, accepted_at desc);

comment on table public.user_consents is
  'Phase 32: the 18+ attestation and the acceptance of the Terms and the Privacy notice, one row each, with the version shown and the time it was given. Written only by the account-creation trigger from the attested invite. A user reads their own.';

alter table public.user_consents enable row level security;
revoke all on public.user_consents from public, anon, authenticated;
grant select on public.user_consents to authenticated;
grant all on public.user_consents to service_role;

create policy user_consents_select_own on public.user_consents for select to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 6. Following
-- ---------------------------------------------------------------------------

create table public.follows (
  user_id    uuid        not null references public.users (id) on delete cascade,
  person_id  uuid        not null references public.people (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, person_id)
);

create index follows_person_idx on public.follows (person_id);

comment on table public.follows is
  'Phase 32: the people an account follows. A preference, not money: a user reads, adds and removes their own rows directly under RLS.';

alter table public.follows enable row level security;
revoke all on public.follows from public, anon, authenticated;
grant select, insert, delete on public.follows to authenticated;
grant all on public.follows to service_role;

create policy follows_select_own on public.follows for select to authenticated using ((select auth.uid()) = user_id);
-- The person must exist (the foreign key); the policy checks only whose row it is.
create policy follows_insert_own on public.follows for insert to authenticated with check ((select auth.uid()) = user_id);
create policy follows_delete_own on public.follows for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 7. Account creation: the invite is the only way in
-- ---------------------------------------------------------------------------
-- The trigger GoTrue drives on every new auth user. It now finds the open,
-- attested invite for the address, or refuses the account; the refusal rolls
-- back the auth user with it, so a refused address leaves nothing behind.
--
-- The one bypass is a session setting no client can reach:
-- momentum.signup_without_invite = 'on', set by an operator in the same
-- transaction as a manual insert, and by the test harness. PostgREST never
-- sets it, GoTrue never sets it, and the auth schema is not exposed.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  starting_balance_cents constant bigint := public.starting_balance_cents();
  v_bypass     boolean := coalesce(current_setting('momentum.signup_without_invite', true), '') = 'on';
  v_invite     public.invites%rowtype;
  v_found      boolean := false;
  base_username text;
  candidate     text;
  attempts      integer := 0;
begin
  select i.* into v_invite
    from public.invites i
   where new.email is not null
     and i.email = lower(new.email)
     and i.revoked_at is null
     and i.accepted_at is null
     and i.expires_at > now()
   order by i.created_at desc
   limit 1
   for update;
  v_found := found;

  if not v_bypass then
    if not v_found then
      raise exception 'signup_requires_invite: there is no open invite for this address' using errcode = '42501';
    end if;
    if v_invite.attested_at is null or not v_invite.age_attested then
      raise exception 'signup_requires_attestation: the invite has not been accepted on the join page' using errcode = '42501';
    end if;
    -- An email sign-up must carry the join page's one-time secret. Supabase's
    -- public sign-up endpoint takes any address and a password; without this,
    -- someone who knew an invited address could register it with their own
    -- password between the join form and the link, and sign in once the
    -- invitee confirmed. Another provider (Google) proves the address itself.
    -- raw_app_meta_data is set by GoTrue, never by the caller.
    if coalesce(new.raw_app_meta_data ->> 'provider', 'email') = 'email'
       and (v_invite.join_nonce_hash is null
            or v_invite.join_nonce_hash <> encode(pg_catalog.sha256(convert_to(coalesce(new.raw_user_meta_data ->> 'join_nonce', ''), 'UTF8')), 'hex')) then
      raise exception 'signup_requires_link: an email sign-up must come from the join page' using errcode = '42501';
    end if;
  end if;

  base_username := lower(coalesce(
    nullif(trim(v_invite.desired_username), ''),
    nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'user'
  ));
  base_username := regexp_replace(base_username, '[^a-z0-9_]', '_', 'g');
  base_username := left(base_username, 30);
  if length(base_username) < 3 then
    base_username := rpad(base_username, 3, '0');
  end if;
  candidate := base_username;

  loop
    begin
      insert into public.users (
        id, email, username, display_name, avatar_url,
        wallet_balance_cents, buying_power_cents,
        referral_code, referred_by, signup_source
      )
      values (
        new.id,
        new.email,
        candidate,
        coalesce(nullif(trim(v_invite.desired_display_name), ''), nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), candidate),
        nullif(trim(new.raw_user_meta_data ->> 'avatar_url'), ''),
        starting_balance_cents,
        starting_balance_cents,
        public.new_referral_code(),
        v_invite.referrer_user_id,
        v_invite.source
      );
      exit;
    exception
      when unique_violation then
        attempts := attempts + 1;
        if attempts >= 5 then
          raise;
        end if;
        candidate := left(base_username, 25) || '_' || lpad(floor(random() * 10000)::integer::text, 4, '0');
    end;
  end loop;

  insert into public.transactions (user_id, type, amount_cents)
  values (new.id, 'DEPOSIT', starting_balance_cents);

  if v_found then
    update public.invites set accepted_at = now(), accepted_user_id = new.id where id = v_invite.id;
    if v_invite.attested_at is not null then
      insert into public.user_consents (user_id, kind, version, accepted_at, invite_id) values
        (new.id, 'age_18_plus', 'attestation-v1',          v_invite.attested_at, v_invite.id),
        (new.id, 'terms',       v_invite.terms_version,    v_invite.attested_at, v_invite.id),
        (new.id, 'privacy',     v_invite.privacy_version,  v_invite.attested_at, v_invite.id);
    end if;
  end if;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Phase 1, Phase 32: creates the profile (paper balance, DEPOSIT, referral code) for a new auth user, ONLY when an open invite for the address was attested on the join page; the invite is accepted, its referrer becomes referred_by, its source becomes signup_source, and the attestation becomes three user_consents rows. Anything else raises and the auth user is not created. Bypass: momentum.signup_without_invite = ''on'' in the session.';

revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant  execute on function public.handle_new_user() to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 8. The join page's two calls (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.invite_for_token(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', i.id,
           'email', i.email::text,
           'status', public.invite_status(i.revoked_at, i.accepted_at, i.expires_at),
           'expires_at', i.expires_at,
           'attested', i.attested_at is not null,
           'desired_username', i.desired_username,
           'desired_display_name', i.desired_display_name
         )
    from public.invites i
   where i.token_hash = lower(p_token_hash);
$$;

create or replace function public.invite_attest(
  p_token_hash      text,
  p_username        text,
  p_display_name    text,
  p_age_attested    boolean,
  p_terms_version   text,
  p_privacy_version text,
  p_join_nonce_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite   public.invites%rowtype;
  v_status   text;
  v_username text := lower(trim(p_username));
  v_display  text := nullif(trim(p_display_name), '');
begin
  select * into v_invite from public.invites i where i.token_hash = lower(p_token_hash) for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'unknown');
  end if;
  v_status := public.invite_status(v_invite.revoked_at, v_invite.accepted_at, v_invite.expires_at);
  if v_status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', v_status);
  end if;
  if p_age_attested is distinct from true then
    return jsonb_build_object('ok', false, 'code', 'age_not_attested');
  end if;
  if coalesce(trim(p_terms_version), '') = '' or coalesce(trim(p_privacy_version), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'terms_not_accepted');
  end if;
  if v_username is null or v_username !~ '^[a-z0-9_]{3,30}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_username');
  end if;
  if exists (select 1 from public.users u where u.username = v_username) then
    return jsonb_build_object('ok', false, 'code', 'username_taken');
  end if;
  if p_join_nonce_hash is null or lower(p_join_nonce_hash) !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_nonce');
  end if;
  if v_display is not null and length(v_display) > 80 then
    v_display := left(v_display, 80);
  end if;

  update public.invites
     set attested_at = now(),
         age_attested = true,
         terms_version = left(trim(p_terms_version), 64),
         privacy_version = left(trim(p_privacy_version), 64),
         desired_username = v_username,
         desired_display_name = v_display,
         join_nonce_hash = lower(p_join_nonce_hash)
   where id = v_invite.id;

  return jsonb_build_object('ok', true, 'email', v_invite.email::text);
end;
$$;

revoke execute on function public.invite_status(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.invite_for_token(text) from public, anon, authenticated;
revoke execute on function public.invite_attest(text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant  execute on function public.invite_status(timestamptz, timestamptz, timestamptz) to service_role;
grant  execute on function public.invite_for_token(text) to service_role;
grant  execute on function public.invite_attest(text, text, text, boolean, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. The operator's invite actions, audited
-- ---------------------------------------------------------------------------

alter table public.admin_audit_log drop constraint admin_audit_log_action_check;
alter table public.admin_audit_log add constraint admin_audit_log_action_check check (action in (
  'freeze_account', 'unfreeze_account', 'halt_person', 'lift_halt', 'set_trading_mode',
  'add_excluded_party', 'remove_excluded_party', 'resolve_alert', 'reopen_alert',
  'issue_invite', 'resend_invite', 'revoke_invite'
));

-- Issues invites to typed addresses and to the oldest N waitlist rows that
-- are neither members nor already invited. The caller hands in one token
-- hash per invite it might create (it holds the tokens, to put them in the
-- emails); each created invite reports the index of the hash it took. The
-- audit row names invite ids, never addresses: the log is append-only, and
-- an address in it could never be removed on request.
create or replace function public.admin_issue_invites(
  p_emails        text[],
  p_from_waitlist integer,
  p_token_hashes  text[],
  p_expires_days  integer default 14
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := public.assert_admin();
  v_targets  text[] := array[]::text[];
  v_email    text;
  v_wait     public.waitlist%rowtype;
  v_listed   boolean;
  v_referrer uuid;
  v_next     integer := 1;
  v_id       uuid;
  v_created  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_ids      uuid[] := array[]::uuid[];
  v_days     integer := least(greatest(coalesce(p_expires_days, 14), 1), 60);
begin
  -- Typed addresses first, normalised and de-duplicated, then the waitlist's oldest.
  foreach v_email in array coalesce(p_emails, array[]::text[]) loop
    v_email := lower(trim(v_email));
    if v_email = '' then continue; end if;
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254 then
      v_skipped := v_skipped || jsonb_build_object('email', v_email, 'reason', 'invalid');
      continue;
    end if;
    if not (v_email = any (v_targets)) then v_targets := v_targets || v_email; end if;
  end loop;

  if coalesce(p_from_waitlist, 0) > 0 then
    for v_wait in
      select w.* from public.waitlist w
       where not exists (select 1 from public.users u where lower(u.email) = w.email::text)
         -- An open invite (pending or expired) is resent, never duplicated; a revoked one may be replaced.
         and not exists (select 1 from public.invites i where i.email = w.email and i.revoked_at is null)
         and not (w.email::text = any (v_targets))
       order by w.created_at, w.id
       limit least(p_from_waitlist, 500)
    loop
      v_targets := v_targets || v_wait.email::text;
    end loop;
  end if;

  foreach v_email in array v_targets loop
    if exists (select 1 from public.users u where lower(u.email) = v_email and u.deleted_at is null) then
      v_skipped := v_skipped || jsonb_build_object('email', v_email, 'reason', 'member');
      continue;
    end if;
    if exists (select 1 from public.invites i where i.email = v_email and i.revoked_at is null and i.accepted_at is null) then
      v_skipped := v_skipped || jsonb_build_object('email', v_email, 'reason', 'already_invited');
      continue;
    end if;
    if v_next > coalesce(array_length(p_token_hashes, 1), 0) then
      v_skipped := v_skipped || jsonb_build_object('email', v_email, 'reason', 'no_token');
      continue;
    end if;

    select w.* into v_wait from public.waitlist w where w.email = v_email;
    v_listed := found;
    v_referrer := null;
    if v_listed and v_wait.ref_code is not null then
      select u.id into v_referrer from public.users u where u.referral_code = v_wait.ref_code and u.deleted_at is null;
    end if;

    insert into public.invites (email, token_hash, waitlist_id, referrer_user_id, source, invited_by, expires_at)
    values (
      v_email,
      lower(p_token_hashes[v_next]),
      case when v_listed then v_wait.id end,
      v_referrer,
      case when v_listed then jsonb_strip_nulls(jsonb_build_object(
        'form', v_wait.source, 'utm_source', v_wait.utm_source, 'utm_medium', v_wait.utm_medium,
        'utm_campaign', v_wait.utm_campaign, 'utm_content', v_wait.utm_content, 'utm_term', v_wait.utm_term,
        'referrer_host', nullif(substring(v_wait.referrer from '^[a-z]+://([^/:?#]+)'), ''), 'ref_code', v_wait.ref_code,
        'waitlist_joined_at', v_wait.created_at))
      else jsonb_build_object('form', 'operator') end,
      v_actor,
      now() + make_interval(days => v_days)
    )
    returning id into v_id;

    v_created := v_created || jsonb_build_object('id', v_id, 'email', v_email, 'token_index', v_next);
    v_ids := v_ids || v_id;
    v_next := v_next + 1;
  end loop;

  if array_length(v_ids, 1) > 0 then
    insert into public.admin_audit_log (actor_id, action, note, details)
    values (v_actor, 'issue_invite', null, jsonb_build_object('invite_ids', to_jsonb(v_ids), 'from_waitlist', coalesce(p_from_waitlist, 0), 'expires_days', v_days));
  end if;

  return jsonb_build_object('ok', true, 'created', v_created, 'skipped', v_skipped);
end;
$$;

create or replace function public.admin_resend_invite(p_invite_id uuid, p_token_hash text, p_expires_days integer default 14)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.assert_admin();
  v_invite public.invites%rowtype;
  v_days   integer := least(greatest(coalesce(p_expires_days, 14), 1), 60);
begin
  select * into v_invite from public.invites i where i.id = p_invite_id for update;
  if not found then
    raise exception 'Unknown invite %', p_invite_id using errcode = 'P0002';
  end if;
  if v_invite.accepted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'accepted');
  end if;
  if v_invite.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'revoked');
  end if;
  if p_token_hash is null or lower(p_token_hash) !~ '^[0-9a-f]{64}$' then
    raise exception 'A token hash is required' using errcode = '22023';
  end if;
  -- The old token dies here: only the new hash is stored.
  update public.invites set token_hash = lower(p_token_hash), expires_at = now() + make_interval(days => v_days) where id = v_invite.id;
  insert into public.admin_audit_log (actor_id, action, details)
  values (v_actor, 'resend_invite', jsonb_build_object('invite_id', v_invite.id, 'expires_days', v_days));
  return jsonb_build_object('ok', true, 'id', v_invite.id, 'email', v_invite.email::text);
end;
$$;

create or replace function public.admin_revoke_invite(p_invite_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.assert_admin();
  v_invite public.invites%rowtype;
begin
  select * into v_invite from public.invites i where i.id = p_invite_id for update;
  if not found then
    raise exception 'Unknown invite %', p_invite_id using errcode = 'P0002';
  end if;
  if v_invite.accepted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'accepted');
  end if;
  if v_invite.revoked_at is not null then
    return jsonb_build_object('ok', true, 'id', v_invite.id, 'already', true);
  end if;
  update public.invites set revoked_at = now(), revoked_by = v_actor, revoke_note = left(nullif(trim(p_note), ''), 500) where id = v_invite.id;
  insert into public.admin_audit_log (actor_id, action, note, details)
  values (v_actor, 'revoke_invite', left(nullif(trim(p_note), ''), 500), jsonb_build_object('invite_id', v_invite.id));
  return jsonb_build_object('ok', true, 'id', v_invite.id);
end;
$$;

-- The email's outcome, recorded after each send. Mechanical, so not audited.
create or replace function public.admin_record_invite_send(p_invite_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
begin
  if p_ok then
    update public.invites set sent_at = now(), send_count = send_count + 1, last_send_error = null where id = p_invite_id;
  else
    update public.invites set last_send_error = left(coalesce(nullif(trim(p_error), ''), 'failed'), 500) where id = p_invite_id;
  end if;
end;
$$;

revoke execute on function public.admin_issue_invites(text[], integer, text[], integer) from public, anon;
revoke execute on function public.admin_resend_invite(uuid, text, integer)            from public, anon;
revoke execute on function public.admin_revoke_invite(uuid, text)                     from public, anon;
revoke execute on function public.admin_record_invite_send(uuid, boolean, text)       from public, anon;
grant  execute on function public.admin_issue_invites(text[], integer, text[], integer) to authenticated;
grant  execute on function public.admin_resend_invite(uuid, text, integer)            to authenticated;
grant  execute on function public.admin_revoke_invite(uuid, text)                     to authenticated;
grant  execute on function public.admin_record_invite_send(uuid, boolean, text)       to authenticated;

-- The operator console's two lists (service role only; the page calls
-- requireAdmin() before it builds the client that reads them).
create or replace function public.admin_invite_list(p_limit integer default 100)
returns table (
  id uuid, email text, status text, created_at timestamptz, expires_at timestamptz, sent_at timestamptz,
  send_count integer, last_send_error text, invited_by_username text, referrer_username text,
  accepted_at timestamptz, accepted_username text, from_waitlist boolean, revoked_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.email::text, public.invite_status(i.revoked_at, i.accepted_at, i.expires_at), i.created_at, i.expires_at, i.sent_at,
         i.send_count, i.last_send_error, inv.username, ref.username, i.accepted_at, acc.username, i.waitlist_id is not null, i.revoked_at
    from public.invites i
    left join public.users inv on inv.id = i.invited_by
    left join public.users ref on ref.id = i.referrer_user_id
    left join public.users acc on acc.id = i.accepted_user_id
   order by i.created_at desc, i.id desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

create or replace function public.admin_user_list(p_limit integer default 200)
returns table (
  id uuid, username text, display_name text, joined_at timestamptz, deleted_at timestamptz, is_admin boolean,
  frozen_at timestamptz, onboarded_at timestamptz, invited_by_username text, invited_at timestamptz,
  referred_by_username text, signup_source jsonb, last_sign_in_at timestamptz, email_confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.username, u.display_name, u.created_at, u.deleted_at, u.is_admin,
         u.frozen_at, u.onboarded_at, inv.username, i.created_at, ref.username, u.signup_source,
         au.last_sign_in_at, au.email_confirmed_at
    from public.users u
    left join lateral (select x.* from public.invites x where x.accepted_user_id = u.id order by x.accepted_at desc limit 1) i on true
    left join public.users inv on inv.id = i.invited_by
    left join public.users ref on ref.id = u.referred_by
    left join auth.users au on au.id = u.id
   order by u.created_at desc, u.id desc
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

revoke execute on function public.admin_invite_list(integer) from public, anon, authenticated;
revoke execute on function public.admin_user_list(integer)   from public, anon, authenticated;
grant  execute on function public.admin_invite_list(integer) to service_role;
grant  execute on function public.admin_user_list(integer)   to service_role;

-- ---------------------------------------------------------------------------
-- 10. Onboarding
-- ---------------------------------------------------------------------------

create or replace function public.mark_onboarded()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_at  timestamptz;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  update public.users set onboarded_at = coalesce(onboarded_at, now()) where id = v_uid and deleted_at is null returning onboarded_at into v_at;
  return v_at;
end;
$$;

revoke execute on function public.mark_onboarded() from public, anon;
grant  execute on function public.mark_onboarded() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Deleting an account
-- ---------------------------------------------------------------------------
-- Refused while any position is open: selling on someone's behalf could be
-- refused by a halt, and would hide a trade inside a deletion. Refused for an
-- operator account, which the console cannot run without.
--
-- What goes:  the email, name, username, photo, referral code and where the
--             account came from; the browsing log; every fingerprint hash on
--             its orders; its follows; its waitlist row; the address on its
--             invite; and the auth account, with its identities, sessions and
--             tokens.
-- What stays: orders, lots, closes, transactions, portfolio history, the
--             house book's side, forecasts and consents, attached to a row
--             that now reads "Deleted account" and names nobody.
--
-- Returns the photo's storage path, if there was one, for the server to
-- remove the file itself: the storage API owns the object, not SQL.

create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_user  public.users%rowtype;
  v_open  integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  select * into v_user from public.users u where u.id = v_uid and u.deleted_at is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'unknown');
  end if;
  if v_user.is_admin then
    return jsonb_build_object('ok', false, 'code', 'operator');
  end if;
  select count(*) into v_open from public.positions l where l.user_id = v_uid and l.is_open;
  if v_open > 0 then
    return jsonb_build_object('ok', false, 'code', 'open_positions', 'open_lots', v_open);
  end if;

  delete from public.behavioral_events e where e.user_id = v_uid;
  update public.trade_orders o set fingerprint_hash = null where o.user_id = v_uid and o.fingerprint_hash is not null;
  delete from public.follows f where f.user_id = v_uid;
  delete from public.waitlist w where w.email = lower(v_user.email);
  update public.invites i
     set email = null, desired_username = null, desired_display_name = null, join_nonce_hash = null
   where i.accepted_user_id = v_uid
      or (i.email = lower(v_user.email) and (i.accepted_at is not null or i.revoked_at is not null));
  -- An open invite to the same address would keep it: revoke and scrub it.
  update public.invites i
     set revoked_at = now(), revoke_note = 'Account deleted', email = null, desired_username = null, desired_display_name = null, join_nonce_hash = null
   where i.email = lower(v_user.email) and i.accepted_at is null and i.revoked_at is null;

  update public.users
     set email                 = 'deleted-' || replace(gen_random_uuid()::text, '-', '') || '@deleted.invalid',
         username              = 'deleted_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
         display_name          = 'Deleted account',
         avatar_url            = null,
         avatar_path           = null,
         verified_identity_key = null,
         identity_verified_at  = null,
         referral_code         = null,
         referred_by           = null,
         signup_source         = null,
         email_updates         = false,
         frozen_reason         = null,
         deleted_at            = now()
   where id = v_uid;

  delete from auth.users au where au.id = v_uid;

  return jsonb_build_object('ok', true, 'avatar_path', v_user.avatar_path);
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant  execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- 12. The photo bucket
-- ---------------------------------------------------------------------------
-- Private, two megabytes, three image types. No object policy: the server
-- uploads and removes through the service role after its own checks, and
-- serves a photo only as a short-lived signed URL. (Guarded so the test
-- harness, which has no storage schema, can apply this file.)

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;
