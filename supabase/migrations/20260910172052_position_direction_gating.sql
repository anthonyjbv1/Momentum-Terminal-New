-- =============================================================================
-- Momentum Terminal — Phase 6c+: position direction gating
--
-- The platform launches long-only: a user's net position on a person may not
-- go below zero until shorting is deliberately switched on. The gate lives in
-- the database, on the same locked-down financial write path as Phase 2, so
-- neither a client nor server code can route around it, and flipping the one
-- setting is the only change needed to allow net-short positions.
--
--   platform_settings.shorting_enabled  the switch, default false
--   shorting_enabled()                  reads it (any signed-in user may ask)
--   net_position_cents(user, person)    open HIGH cents minus open LOW cents
--   resolve_position_order(...)         the pure netting rule: what a Buy or a
--                                       Sell of N cents closes, what it opens,
--                                       and whether it is allowed
--   assert_position_direction(...)      the RPC-layer guard the order RPC of
--                                       the trading flow calls first
--                                       (service role only)
--   positions_enforce_direction         AFTER trigger: the same invariant on
--                                       the table itself, whatever wrote it
--
-- Netting: a Buy first closes any LOW exposure, then opens HIGH with the rest;
-- a Sell first closes any HIGH exposure, then opens LOW with the rest, and
-- that last step is what shorting_enabled gates. Both sides exist in full;
-- the flag only decides whether net_after may be negative.
-- =============================================================================

-- platform_settings -------------------------------------------------------------
create table public.platform_settings (
  id               boolean     primary key default true,
  shorting_enabled boolean     not null default false,
  updated_at       timestamptz not null default now(),

  constraint platform_settings_singleton check (id)
);

comment on table  public.platform_settings is
  'One row of platform-wide switches. Written only with the service role: update public.platform_settings set shorting_enabled = true, updated_at = now() where id;';
comment on column public.platform_settings.shorting_enabled is
  'False (launch): a user''s net position on a person may not go below zero, so a Sell only closes or reduces. True: a Sell may open LOW positions and net-short exposure is allowed.';

insert into public.platform_settings (id, shorting_enabled) values (true, false);

alter table public.platform_settings enable row level security;

create policy platform_settings_select_authenticated
  on public.platform_settings for select
  to authenticated
  using (true);

revoke insert, update, delete on public.platform_settings from anon, authenticated;

-- shorting_enabled() --------------------------------------------------------------
create or replace function public.shorting_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.shorting_enabled from public.platform_settings s where s.id), false);
$$;

comment on function public.shorting_enabled() is
  'The position direction gate. False until shorting is deliberately switched on in platform_settings.';

revoke execute on function public.shorting_enabled() from public, anon;
grant  execute on function public.shorting_enabled() to authenticated, service_role;

-- net_position_cents() ------------------------------------------------------------
-- Security invoker on purpose: under RLS a signed-in user only sees, and so
-- only sums, their own rows. The definer-rights callers below see everything.
create or replace function public.net_position_cents(p_user_id uuid, p_person_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(case when p.direction = 'HIGH' then p.amount_cents else -p.amount_cents end), 0)::bigint
    from public.positions p
   where p.user_id = p_user_id
     and p.person_id = p_person_id
     and p.is_open;
$$;

comment on function public.net_position_cents(uuid, uuid) is
  'A user''s net exposure on a person in integer cents: open HIGH amounts minus open LOW amounts. Negative means net short.';

revoke execute on function public.net_position_cents(uuid, uuid) from public, anon;
grant  execute on function public.net_position_cents(uuid, uuid) to authenticated, service_role;

-- resolve_position_order() ---------------------------------------------------------
-- Pure: given the net position before the order, what a Buy / Sell of
-- p_amount_cents closes on the opposite side and opens on its own side.
-- Raises when the order would take the net position negative while shorting
-- is disabled. Immutable, so it is unit-testable with a plain SELECT.
create or replace function public.resolve_position_order(
  p_net_before       bigint,
  p_side             text,
  p_amount_cents     bigint,
  p_shorting_enabled boolean
)
returns table (
  reduce_cents   bigint,
  open_cents     bigint,
  open_direction text,
  net_after      bigint
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_net    bigint := coalesce(p_net_before, 0);
  v_reduce bigint;
  v_open   bigint;
begin
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'p_side must be BUY or SELL' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'p_amount_cents must be a positive integer number of cents' using errcode = '22023';
  end if;

  if p_side = 'BUY' then
    -- Close LOW exposure first, then open HIGH with whatever is left.
    v_reduce := least(p_amount_cents, greatest(-v_net, 0));
    v_open   := p_amount_cents - v_reduce;
    return query select v_reduce, v_open, case when v_open > 0 then 'HIGH' end, v_net + p_amount_cents;
  else
    -- Close HIGH exposure first, then open LOW with whatever is left: the
    -- step the gate controls.
    v_reduce := least(p_amount_cents, greatest(v_net, 0));
    v_open   := p_amount_cents - v_reduce;
    if v_open > 0 and not coalesce(p_shorting_enabled, false) then
      raise exception 'Sell of % cents exceeds the open position of % cents and shorting is disabled', p_amount_cents, greatest(v_net, 0)
        using errcode = 'P0001',
              hint = 'While platform_settings.shorting_enabled is false a Sell may only close or reduce an existing position.';
    end if;
    return query select v_reduce, v_open, case when v_open > 0 then 'LOW' end, v_net - p_amount_cents;
  end if;
end;
$$;

comment on function public.resolve_position_order(bigint, text, bigint, boolean) is
  'Netting rule for an order: cents closed on the opposite side, cents opened on the order''s side, the direction opened, and the net position after. Raises when a Sell would go net short while shorting is disabled.';

revoke execute on function public.resolve_position_order(bigint, text, bigint, boolean) from public, anon;
grant  execute on function public.resolve_position_order(bigint, text, bigint, boolean) to authenticated, service_role;

-- assert_position_direction() ------------------------------------------------------
-- The RPC-layer guard. The trading flow's order RPC calls this first, inside
-- its transaction, and applies exactly the split it returns. Definer rights so
-- it sees every position row; service role only, like every financial write.
create or replace function public.assert_position_direction(
  p_user_id      uuid,
  p_person_id    uuid,
  p_side         text,
  p_amount_cents bigint
)
returns table (
  net_before       bigint,
  reduce_cents     bigint,
  open_cents       bigint,
  open_direction   text,
  net_after        bigint,
  shorting_enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.net, r.reduce_cents, r.open_cents, r.open_direction, r.net_after, s.enabled
    from (select public.net_position_cents(p_user_id, p_person_id) as net) n
   cross join (select public.shorting_enabled() as enabled) s
   cross join lateral public.resolve_position_order(n.net, p_side, p_amount_cents, s.enabled) r;
$$;

comment on function public.assert_position_direction(uuid, uuid, text, bigint) is
  'Service-role guard for the order RPC: resolves an order against the user''s current net position and the shorting gate, raising if it is not allowed.';

revoke execute on function public.assert_position_direction(uuid, uuid, text, bigint) from public, anon, authenticated;
grant  execute on function public.assert_position_direction(uuid, uuid, text, bigint) to service_role;

-- positions_enforce_direction trigger -----------------------------------------------
-- Belt and braces: whatever path writes positions, a row change that leaves
-- the user net short on that person is rejected while shorting is disabled.
-- AFTER ROW, so the net is measured with the change applied.
create or replace function public.positions_enforce_direction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_net bigint;
begin
  if not public.shorting_enabled() then
    v_net := public.net_position_cents(new.user_id, new.person_id);
    if v_net < 0 then
      raise exception 'Net position of % cents on person % would be short and shorting is disabled', v_net, new.person_id
        using errcode = 'P0001',
              hint = 'positions_enforce_direction: open LOW cents may not exceed open HIGH cents while platform_settings.shorting_enabled is false.';
    end if;
  end if;
  return null;
end;
$$;

create trigger positions_enforce_direction
  after insert or update of direction, amount_cents, is_open, user_id, person_id
  on public.positions
  for each row
  execute function public.positions_enforce_direction();

comment on trigger positions_enforce_direction on public.positions is
  'Rejects any change that leaves a user net short on a person while platform_settings.shorting_enabled is false.';
