-- =============================================================================
-- Momentum Terminal — Phase 1 migration 3/4: auth triggers
--
-- * on_auth_user_created: every new auth.users row gets a public.users profile
--   with the $1,000 demo balance (100000 cents) and a matching DEPOSIT ledger
--   entry. Username / display name come from the signup metadata
--   (auth.signUp options.data.username / display_name) with safe fallbacks.
-- * on_auth_user_email_updated: keeps public.users.email in sync with auth.
-- * username_available(): RPC the signup form uses to pre-check a username.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- handle_new_user
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  starting_balance_cents constant bigint := 100000; -- $1,000.00 demo credit
  base_username text;
  candidate     text;
  attempts      integer := 0;
begin
  -- Derive a username: explicit signup metadata first, then the email local
  -- part, then a generic fallback. Normalise to the users_username_format rule.
  base_username := lower(coalesce(
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
        wallet_balance_cents, buying_power_cents
      )
      values (
        new.id,
        new.email,
        candidate,
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), candidate),
        nullif(trim(new.raw_user_meta_data ->> 'avatar_url'), ''),
        starting_balance_cents,
        starting_balance_cents
      );
      exit;
    exception
      when unique_violation then
        -- The username is taken (email uniqueness is already guaranteed by
        -- auth.users). Retry with a random suffix a few times, then give up.
        attempts := attempts + 1;
        if attempts >= 5 then
          raise;
        end if;
        candidate := left(base_username, 25) || '_' || lpad(floor(random() * 10000)::integer::text, 4, '0');
    end;
  end loop;

  -- Record the demo credit in the ledger so wallet balance == sum(transactions).
  insert into public.transactions (user_id, type, amount_cents)
  values (new.id, 'DEPOSIT', starting_balance_cents);

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the public.users profile (with the $1,000 demo balance) and DEPOSIT ledger entry for a new auth user.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- handle_auth_user_email_updated
-- -----------------------------------------------------------------------------
create or replace function public.handle_auth_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is not null then
    update public.users
       set email = new.email
     where id = new.id
       and email is distinct from new.email;
  end if;
  return new;
end;
$$;

comment on function public.handle_auth_user_email_updated() is
  'Keeps public.users.email in sync when an auth user changes their email.';

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_auth_user_email_updated();

-- Trigger functions are only ever invoked by the auth service.
revoke execute on function public.handle_new_user()                from public, anon, authenticated;
revoke execute on function public.handle_auth_user_email_updated() from public, anon, authenticated;
grant  execute on function public.handle_new_user()                to supabase_auth_admin;
grant  execute on function public.handle_auth_user_email_updated() to supabase_auth_admin;

-- -----------------------------------------------------------------------------
-- username_available — pre-check used by the signup form.
-- security definer because RLS hides other users' rows from the caller.
-- -----------------------------------------------------------------------------
create or replace function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from public.users
     where username = lower(trim(p_username))
  );
$$;

comment on function public.username_available(text) is
  'Returns true when no user has the given username (case-insensitive).';

revoke execute on function public.username_available(text) from public;
grant  execute on function public.username_available(text) to anon, authenticated;
