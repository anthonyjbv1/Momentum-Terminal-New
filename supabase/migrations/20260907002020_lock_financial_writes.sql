-- =============================================================================
-- Momentum Terminal — Phase 2 migration 1/3: lock down financial writes
--
-- Phase 1 let authenticated clients insert / update / delete their own rows in
-- positions, transactions, portfolio_history and behavioral_events. A client
-- could therefore mint money by inserting a DEPOSIT transaction, or fabricate a
-- position with an invented cost basis. From now on:
--
--   * positions, transactions, portfolio_history: clients may only SELECT their
--     own rows. Every write happens in trusted server code (service-role
--     client) or in a SECURITY DEFINER function ("RPC") defined in this schema.
--   * behavioral_events: clients may SELECT and INSERT their own rows (it is
--     non-financial telemetry). event_type is validated against an allowed
--     list. No client UPDATE / DELETE: it is an append-only log.
--
-- THE RULE FOR ALL FUTURE FINANCIAL MUTATIONS
-- Every write to positions / transactions / portfolio_history and to
-- users.wallet_balance_cents / users.buying_power_cents goes through exactly
-- one of these two paths, and never through a direct client write:
--
--   1. Trusted server code using the service-role client
--      (lib/supabase-admin.ts): the Engine tick, cron jobs, admin tooling.
--
--   2. A SECURITY DEFINER function in this schema that
--        - is declared with `set search_path = ''` and uses fully-qualified
--          names only,
--        - derives the acting user from auth.uid(), never from a parameter,
--        - validates every input and raises on failure,
--        - performs all related writes (ledger row + balance change + position)
--          inside the one transaction so they can never drift apart,
--        - has EXECUTE revoked from public / anon and granted to authenticated.
--
-- placeholder_financial_mutation() at the bottom of this file is the template
-- that the trading RPCs of later phases (open_position, close_position,
-- deposit, withdraw) will copy. Direct client write privileges are revoked
-- below and must not be re-granted.
-- =============================================================================

-- positions: read-only for clients -------------------------------------------
drop policy if exists positions_insert_own on public.positions;
drop policy if exists positions_update_own on public.positions;
drop policy if exists positions_delete_own on public.positions;
revoke insert, update, delete on public.positions from anon, authenticated;

-- transactions: read-only for clients ----------------------------------------
drop policy if exists transactions_insert_own on public.transactions;
drop policy if exists transactions_update_own on public.transactions;
drop policy if exists transactions_delete_own on public.transactions;
revoke insert, update, delete on public.transactions from anon, authenticated;

-- portfolio_history: read-only for clients -----------------------------------
drop policy if exists portfolio_history_insert_own on public.portfolio_history;
drop policy if exists portfolio_history_update_own on public.portfolio_history;
drop policy if exists portfolio_history_delete_own on public.portfolio_history;
revoke insert, update, delete on public.portfolio_history from anon, authenticated;

-- behavioral_events: append-only telemetry -----------------------------------
-- behavioral_events_select_own and behavioral_events_insert_own remain.
drop policy if exists behavioral_events_update_own on public.behavioral_events;
drop policy if exists behavioral_events_delete_own on public.behavioral_events;
revoke update, delete on public.behavioral_events from anon, authenticated;

alter table public.behavioral_events
  add constraint behavioral_events_event_type_check
  check (event_type in ('view_person', 'expand_signal', 'take_position', 'time_spent', 'follow'));

comment on column public.behavioral_events.event_type is
  'One of: view_person, expand_signal, take_position, time_spent, follow. Extend behavioral_events_event_type_check to add a type.';

-- -----------------------------------------------------------------------------
-- placeholder_financial_mutation — the RPC template.
--
-- Does no work yet: it demonstrates the exact shape every financial RPC must
-- have (definer rights, empty search_path, auth.uid() as the actor, input
-- validation, explicit grants) and raises so nothing can be moved through it.
-- Replace / copy it when the trading RPCs are built in a later phase.
-- -----------------------------------------------------------------------------
create or replace function public.placeholder_financial_mutation(p_amount_cents bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  -- 1. The actor is always the signed-in user, never a parameter.
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- 2. Validate every input before touching any table.
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'p_amount_cents must be a positive integer number of cents'
      using errcode = '22023';
  end if;

  -- 3. A real RPC would now, in this single transaction:
  --      - lock the caller's public.users row (select ... for update),
  --      - check buying power / limits,
  --      - insert the public.transactions ledger row,
  --      - update the balances,
  --      - insert / update the public.positions row.
  raise exception 'Financial mutations are not enabled yet'
    using errcode = 'P0001',
          hint = 'placeholder_financial_mutation() only establishes the security-definer RPC pattern.';
end;
$$;

comment on function public.placeholder_financial_mutation(bigint) is
  'Template for financial RPCs. Always raises. All future money movement goes through service-role code or SECURITY DEFINER functions shaped like this one.';

revoke execute on function public.placeholder_financial_mutation(bigint) from public, anon;
grant  execute on function public.placeholder_financial_mutation(bigint) to authenticated;
