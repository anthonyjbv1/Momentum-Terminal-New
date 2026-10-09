# Plan: a real guard boundary for the admin-only columns

Status: queued, 2026-10-09. Not built. Scheduled by the operator after the freeze.

## The finding it answers

The guards on the admin-only columns are BEFORE UPDATE triggers that check a
transaction-local setting, `momentum.market_write = 'admin'`. Any session can
set it, and the service role holds UPDATE on every guarded table and bypasses
row-level security. So a direct write is refused only when it is careless:
one `set_config()` in the same transaction opens every guard. The 11:54 UTC
hide of 2026-10-09 was done exactly that way. `platform_settings` (the detector
thresholds) has no guard at all.

Guarded today, all by the same mechanism:

| Table | Columns | Admin functions that write them |
|---|---|---|
| `signals` | `voided_at`, `void_reason`; `hidden_at`, `hide_reason`; `allegation`, `allegation_held` | `admin_void_signal`, `admin_hide_signal`, `admin_unhide_signal`, `admin_lift_allegation_hold`, `record_allegation_holds` (the Engine's) |
| `narratives` | `voided_at`, `void_reason` | `admin_void_narrative` |
| `people` | `tier`, `trading_mode`, `halted_until`, `halt_reason`, the five market overrides | `admin_set_person_market_parameter`, `admin_set_trading_mode`, `admin_halt_person`, `admin_lift_halt` |
| `market_tier_settings` | every column but `updated_at` | `admin_set_tier_market_parameter` |
| `engine_parameters` | `value` | `admin_set_engine_parameter` |
| `platform_settings` | the thresholds (unguarded today) | `admin_set_market_parameter` |

## The boundary

Make the privilege the boundary, not a setting.

1. **A new role, `momentum_admin_writer`**, `NOLOGIN`, created by the migration.
   It alone holds `UPDATE (column list)` on the guarded columns of each table
   above. Nobody can connect as it; it is only ever assumed by a function.

2. **Column-level privileges.** For each guarded table:
   `REVOKE UPDATE ON <table> FROM service_role`, then
   `GRANT UPDATE (<every column except the guarded ones>) ON <table> TO service_role`.
   The service role keeps SELECT, INSERT and DELETE as today, and UPDATE on
   every other column, so the Engine and ingestion are untouched. The same for
   `authenticated` where it holds UPDATE today (it should not on these tables;
   the migration asserts it).

3. **The admin functions become `SECURITY DEFINER` owned by `momentum_admin_writer`**
   (`ALTER FUNCTION ... OWNER TO momentum_admin_writer`), keeping
   `SET search_path = ''` and `assert_admin()` as the first line. The function
   body runs with the owner's privileges, so the guarded columns are writable
   inside it and nowhere else. `record_allegation_holds()` and any other
   Engine-side writer of a guarded column (today: only that one) are owned the
   same way and stay `EXECUTE`-granted to `service_role` alone.

4. **The triggers stay** as a second line and for their messages, with one
   change: the setting they check is replaced by `current_user = 'momentum_admin_writer'`
   (inside a definer function `current_user` is the owner), so there is no
   setting left for a session to set. `market_write_is_admin()` becomes that
   test, and the comment on it says why.

5. **`platform_settings` gets the same treatment**: UPDATE revoked from
   `service_role` on the threshold columns, `admin_set_market_parameter` owned
   by the writer role, the guard trigger added.

6. **Migrations** that must touch a guarded column (a backfill, a seed) run as
   the migration role, which is the table owner and outside this boundary;
   each such migration says so in its header, as the market-controls
   migration does today for the setting.

## What must not change

- No score, weight, Gravity, drift, tune or market path.
- Every Engine and ingestion write succeeds exactly as before: the tick
  (`apply_engine_tick`, `record_story_clusters`, `record_allegation_holds`,
  narratives, memory, score history, score events), ingestion (signals,
  source polls, raw snapshots and observations, live sessions and samples,
  identity and avatar writes to `person_data_sources`), trading
  (`place_order`, decay, the house book), forecasts.
- Every admin action still works from the console, audit row and all.

## The replay that proves it: zero refusals

The same shape as the market-controls proof, run in PGlite before anything
touches production and again against a Supabase branch:

1. Apply every migration including the new one; assert the privilege table
   matches the plan (`has_column_privilege` for `service_role` on each guarded
   and unguarded column; `EXECUTE` on each admin function for `authenticated`
   and `service_role`; the writer role owns each function).
2. **Engine replay, as `service_role`:** seed the roster and a day of signals,
   run 50 ticks through `createSupabaseEngineStore` against the test database
   (not the memory store), with the news-volume tune, the quality rules and an
   allegation story in the batch so `record_allegation_holds` fires; then
   `runPostTick` for narratives and memory. Assert: no error, no
   `permission denied` anywhere, tick count 50, score history 50 rows per
   person, allegation rows recorded.
3. **Ingestion replay, as `service_role`:** run `runIngestion` and the live
   runner against the test database with fake connectors for every source
   (rss, publisher_rss, youtube, youtube_trending, twitch with a live session,
   apisports, finnhub), including the identity resolver and avatar refresh
   paths that update `person_data_sources`. Assert zero refusals and the same
   row counts as the run on the current schema.
4. **Trading and forecasts, as `authenticated`:** place and close orders,
   decay, cast forecasts. Assert zero refusals.
5. **The boundary itself:** as `service_role`, every direct UPDATE of a
   guarded column is refused with `permission denied for table ...` even
   after `set_config('momentum.market_write', 'admin', true)`; as
   `authenticated`, the same; through each admin function as an admin, the
   write lands with its audit row; as a non-admin, `Not an admin`.
6. **Byte-identical check:** the Engine replay's score history, score events
   and signals under the new schema equal the same replay under the current
   schema, row for row.

Production rollout: backup export of the five tables' guarded columns and
the function definitions to a timestamped schema; apply in chunks (roles and
grants, then function ownership, then triggers); watch two ingestion cycles
and ten ticks for any `permission denied` in `source_polls.reason`,
`ingest_runs`, the engine tick log and the Vercel runtime log; then the
console's actions one by one. Rollback is the exported function definitions
and `GRANT UPDATE ON <table> TO service_role`.

## Decided 2026-10-09 (plan approved; build after the freeze)

**The rolcreaterole check, run first as asked (read-only, production, 19:05 UTC).**

| Role | CREATEROLE | superuser | BYPASSRLS | login |
|---|---|---|---|---|
| `postgres` (the migration role; `current_user` of the SQL tool) | yes | no | yes | yes |
| `service_role` | no | no | yes | no |
| `authenticated`, `anon` | no | no | no | no |
| `authenticator` | no | no | no | yes |
| `supabase_admin` (Supabase's own) | yes | yes | yes | yes |

PostgreSQL 17.6. `postgres` owns every guarded table (`signals`, `narratives`,
`people`, `market_tier_settings`, `engine_parameters`, `platform_settings`,
`allegation_claims`, `admin_audit_log`) and every admin function, all of
which are already `SECURITY DEFINER`; it is a member of `service_role`,
`authenticated`, `anon` and `authenticator`. So the migration role CAN create
the writer roles (`CREATEROLE` without superuser), and three things the
check adds to the plan:

1. **Membership for the ownership change.** `ALTER FUNCTION ... OWNER TO
   <writer>` needs the migration role to be a member of the new owner. On
   17 a role created by a `CREATEROLE` role gives its creator `ADMIN OPTION`
   but membership depends on `createrole_self_grant`; the migration grants
   it explicitly: `grant momentum_admin_writer to postgres with admin option`
   (the same for the allegation writer). The grant makes `postgres` able to
   SET ROLE to the writers, which it already can do to everything that
   matters; it is not a widening.
2. **Row-level security on the guarded tables.** Every guarded table has RLS
   enabled (not forced) with SELECT policies for `authenticated` only; the
   writes work today because `postgres` owns the tables and `service_role`
   is `BYPASSRLS`. A definer function owned by a writer role runs as a role
   that neither owns the table nor bypasses RLS, so its UPDATE would be
   refused by RLS, not by privilege. The writer roles are therefore created
   WITHOUT `BYPASSRLS` (a `CREATEROLE` non-superuser may not be able to grant
   it on 17 anyway, and the narrower the better) and each guarded table gets
   one UPDATE policy per writer role, `using (true) with check (true)`,
   restricted to that role; the column privileges decide which columns. The
   replay's privilege assertions gain a `pg_policies` check for exactly these
   policies and no others.
3. **The guard's test.** `market_write_is_admin()` becomes
   `current_user in ('momentum_admin_writer', 'momentum_allegation_writer')`;
   which columns each may touch is the column grant, not the trigger.

**The allegation writer, as decided: its own narrower role.**
`momentum_allegation_writer`, `NOLOGIN`, no `BYPASSRLS`, holding exactly
`UPDATE (allegation, allegation_held)` on `signals` and
`SELECT, INSERT, UPDATE` on `allegation_claims`, and nothing else: no hide,
no void, no market or engine parameter. `record_allegation_holds()` is owned
by it (and by nothing of the admin writer's), `SECURITY DEFINER`,
`SET search_path = ''`, `EXECUTE` granted to `service_role` alone (the
Engine's role; `authenticated` and `anon` revoked). `admin_lift_allegation_hold()`
stays with `momentum_admin_writer`, which holds the allegation columns too
(a lift is an admin action with an audit row). `service_role` keeps
SELECT/INSERT/DELETE on `allegation_claims` for the console's reads and the
backlog scripts, loses UPDATE on it and on the two signal columns. The
boundary replay adds: as `service_role`, a direct UPDATE of
`signals.allegation_held` and of `allegation_claims.lifted_at` is refused;
through `record_allegation_holds()` the same write lands; the allegation
writer cannot execute `admin_hide_signal()` (`SET ROLE` to it in the test,
expect `permission denied`) and a direct UPDATE of `hidden_at` as it is
refused.

**Still open, for the build:** none. The build is scheduled after the freeze.
