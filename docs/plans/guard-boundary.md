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

## Open questions for the operator

- Supabase's managed roles: `service_role` is `BYPASSRLS`, and the migration
  role (`postgres`) owns the tables. The plan keeps both; confirm the writer
  role may be created by a migration on the project's plan.
- Whether `record_allegation_holds()` should stay callable by `service_role`
  (the Engine runs as it) or move behind a narrower role of its own.
