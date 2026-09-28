-- =============================================================================
-- THE PROFILE BIO (2026-09-28)
--
-- One optional line under the member's name: plain text, at most 150
-- characters, no links (the server refuses them; the database holds the
-- length and the character set). Members may update their own; nobody else
-- reads it while profiles are private. A deleted account has no bio, by
-- CHECK, and delete_my_account() clears it with the rest of the personal
-- details.
-- =============================================================================

alter table public.users add column bio text;

alter table public.users
  add constraint users_bio_shape check (bio is null or (char_length(bio) between 1 and 150 and bio !~ '[\u0000-\u001f\u007f]')),
  add constraint users_deleted_has_no_bio check (deleted_at is null or bio is null);

comment on column public.users.bio is 'The member''s short bio: plain text, 1 to 150 characters, no control characters, no links (refused by the server). Null when empty. Cleared on deletion.';

grant update (bio) on public.users to authenticated;

-- delete_my_account(), as Phase 32 wrote it, with the bio among what goes.
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
         bio                   = null,
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
