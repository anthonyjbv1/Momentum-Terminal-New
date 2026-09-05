-- =============================================================================
-- Momentum Terminal — Phase 1 migration 2/4: row level security
--
-- Access model
--   * Private per-user tables (users, positions, transactions,
--     portfolio_history, behavioral_events): an authenticated user can read
--     and write only rows they own.
--   * Shared reference tables (people, data_sources, person_data_sources,
--     inverse_pairs, score_history, signals): readable by every authenticated
--     user, writable only by the service role (which bypasses RLS).
--   * The anon role has no policies on any table, so unauthenticated requests
--     see nothing.
--   * auth.uid() is wrapped in (select ...) so Postgres evaluates it once per
--     query instead of once per row.
-- =============================================================================

-- Enable RLS on every table ---------------------------------------------------
alter table public.users               enable row level security;
alter table public.people              enable row level security;
alter table public.data_sources        enable row level security;
alter table public.person_data_sources enable row level security;
alter table public.inverse_pairs       enable row level security;
alter table public.positions           enable row level security;
alter table public.transactions        enable row level security;
alter table public.signals             enable row level security;
alter table public.score_history       enable row level security;
alter table public.portfolio_history   enable row level security;
alter table public.behavioral_events   enable row level security;

-- =============================================================================
-- Private per-user tables
-- =============================================================================

-- users -----------------------------------------------------------------------
create policy users_select_own
  on public.users for select
  to authenticated
  using ((select auth.uid()) = id);

create policy users_update_own
  on public.users for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Profile rows are inserted by the auth trigger and removed by the auth.users
-- cascade, so clients get no insert/delete privilege. Clients may edit only
-- profile columns; wallet_balance_cents, buying_power_cents and is_admin can
-- be changed only through the service role.
revoke insert, update, delete on public.users from anon, authenticated;
grant update (username, display_name, avatar_url) on public.users to authenticated;

-- positions -------------------------------------------------------------------
create policy positions_select_own
  on public.positions for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy positions_insert_own
  on public.positions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy positions_update_own
  on public.positions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy positions_delete_own
  on public.positions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- transactions ----------------------------------------------------------------
create policy transactions_select_own
  on public.transactions for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy transactions_insert_own
  on public.transactions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy transactions_update_own
  on public.transactions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy transactions_delete_own
  on public.transactions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- portfolio_history -----------------------------------------------------------
create policy portfolio_history_select_own
  on public.portfolio_history for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy portfolio_history_insert_own
  on public.portfolio_history for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy portfolio_history_update_own
  on public.portfolio_history for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy portfolio_history_delete_own
  on public.portfolio_history for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- behavioral_events -----------------------------------------------------------
create policy behavioral_events_select_own
  on public.behavioral_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy behavioral_events_insert_own
  on public.behavioral_events for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy behavioral_events_update_own
  on public.behavioral_events for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy behavioral_events_delete_own
  on public.behavioral_events for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- =============================================================================
-- Shared reference tables: read for authenticated users, write for service role
-- =============================================================================

-- people ----------------------------------------------------------------------
create policy people_select_authenticated
  on public.people for select
  to authenticated
  using (true);

revoke insert, update, delete on public.people from anon, authenticated;

-- data_sources ----------------------------------------------------------------
create policy data_sources_select_authenticated
  on public.data_sources for select
  to authenticated
  using (true);

revoke insert, update, delete on public.data_sources from anon, authenticated;

-- person_data_sources ---------------------------------------------------------
create policy person_data_sources_select_authenticated
  on public.person_data_sources for select
  to authenticated
  using (true);

revoke insert, update, delete on public.person_data_sources from anon, authenticated;

-- inverse_pairs ---------------------------------------------------------------
create policy inverse_pairs_select_authenticated
  on public.inverse_pairs for select
  to authenticated
  using (true);

revoke insert, update, delete on public.inverse_pairs from anon, authenticated;

-- score_history ---------------------------------------------------------------
create policy score_history_select_authenticated
  on public.score_history for select
  to authenticated
  using (true);

revoke insert, update, delete on public.score_history from anon, authenticated;

-- signals ---------------------------------------------------------------------
create policy signals_select_authenticated
  on public.signals for select
  to authenticated
  using (true);

revoke insert, update, delete on public.signals from anon, authenticated;
