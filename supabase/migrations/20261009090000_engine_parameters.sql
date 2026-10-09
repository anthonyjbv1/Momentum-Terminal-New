-- =============================================================================
-- ENGINE PARAMETERS (2026-10-09): Gravity's rate as a logged market parameter.
--
-- The Engine's decay rate toward a person's target (gravity.lambdaPerHour,
-- 0.35 since Phase 1) was a code constant. It is now a row in
-- engine_parameters, read by every tick, and changes only through
-- admin_set_engine_parameter(), which writes admin_audit_log (actor, reason,
-- before and after) in the same transaction. The same BEFORE trigger rule as
-- the market parameters (2026-10-05) refuses any other write, from any role,
-- naming the function; the admin function opens the door for its own
-- transaction with the transaction-local setting momentum.market_write =
-- 'admin'. The seed row is written before the guard stands.
--
-- The seed is the current value, 0.35. Nothing changes until the operator
-- sets another; a missing or malformed row leaves the code default in force,
-- and the gravity audit row says which applied (lambdaSource).
-- =============================================================================

create table public.engine_parameters (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  constraint engine_parameters_key_check check (key in ('gravity_rate'))
);

comment on table public.engine_parameters is
  'Engine parameters (2026-10-09): the operator''s logged Engine tunables, read by every tick. gravity_rate: Gravity''s decay rate per hour (0.35 since Phase 1). Changed only through admin_set_engine_parameter(), audit-logged; the guard refuses any other write. Service role only.';

alter table public.engine_parameters enable row level security;
revoke all on table public.engine_parameters from public, anon, authenticated;
grant select, insert, update, delete on table public.engine_parameters to service_role;

create or replace function public.engine_parameters_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.market_write_is_admin() then
    raise exception 'engine_parameters.% is an Engine parameter: change it through admin_set_engine_parameter(), which audit-logs the change', coalesce(new.key, old.key)
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- The seed: the rate as it has stood in code, written before the guard
-- stands so the migration needs no door of its own.
insert into public.engine_parameters (key, value) values ('gravity_rate', '0.35'::jsonb);

create trigger engine_parameters_guard
  before insert or update or delete on public.engine_parameters
  for each row execute function public.engine_parameters_guard();

revoke execute on function public.engine_parameters_guard() from public, anon, authenticated;


alter table public.admin_audit_log drop constraint admin_audit_log_action_check;
alter table public.admin_audit_log add constraint admin_audit_log_action_check check (action in (
  'freeze_account', 'unfreeze_account', 'halt_person', 'lift_halt', 'set_trading_mode',
  'add_excluded_party', 'remove_excluded_party', 'resolve_alert', 'reopen_alert',
  'issue_invite', 'resend_invite', 'revoke_invite',
  'void_signal', 'void_narrative',
  'set_market_parameter', 'set_tier_parameter', 'reset_market',
  'set_engine_parameter'
));

-- The one way to change a parameter. gravity_rate must be a number in
-- (0, 5]: 5 per hour is a half-life of eight minutes, far past anything the
-- replays considered (0.35 down to 0.04); a typo of 35 is refused here
-- rather than applied on the next tick.
create or replace function public.admin_set_engine_parameter(
  p_key      text,
  p_value    jsonb,
  p_reason   text,
  p_alert_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.assert_admin();
  v_before jsonb;
  v_number numeric;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if p_key is distinct from 'gravity_rate' then
    raise exception 'p_key must be gravity_rate' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    raise exception 'gravity_rate must be a number (per hour)' using errcode = '22023';
  end if;
  v_number := (p_value #>> '{}')::numeric;
  if v_number <= 0 or v_number > 5 then
    raise exception 'gravity_rate must be above 0 and at most 5 per hour (got %)', v_number using errcode = '22023';
  end if;

  perform set_config('momentum.market_write', 'admin', true);

  select e.value into v_before from public.engine_parameters e where e.key = p_key for update;
  if not found then
    insert into public.engine_parameters (key, value) values (p_key, p_value);
  else
    update public.engine_parameters set value = p_value where key = p_key;
  end if;

  insert into public.admin_audit_log (actor_id, action, alert_id, note, details)
  values (v_actor, 'set_engine_parameter', p_alert_id, left(p_reason, 500),
          jsonb_build_object('parameter', p_key, 'from', v_before, 'to', p_value));
  return jsonb_build_object('ok', true, 'parameter', p_key, 'from', v_before, 'to', p_value);
end;
$$;

comment on function public.admin_set_engine_parameter(text, jsonb, text, uuid) is
  'Engine parameters (2026-10-09): the only way to change an engine_parameters row (gravity_rate, a number in (0, 5] per hour). Audit-logged (set_engine_parameter: parameter, from, to) in the same transaction; the next tick reads it.';

revoke execute on function public.admin_set_engine_parameter(text, jsonb, text, uuid) from public, anon;
grant  execute on function public.admin_set_engine_parameter(text, jsonb, text, uuid) to authenticated, service_role;
