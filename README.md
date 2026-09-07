# Momentum Terminal

A social data terminal where users take **HIGH** or **LOW** positions on individual people. Each person has a continuously updating Momentum Score driven by their observable real-world data. Users profit when a score moves in their predicted direction; the platform is the sole counterparty. The scoring system is called **the Engine**.

> **Status: Phase 2 (Data Ingestion) complete.** The repo contains the Next.js scaffold, the database schema, auth, the pluggable data-source connector system with a working YouTube connector, snapshot storage for delta detection, and a secret-protected ingestion runner. Signals are stored raw (`processed = false`). The Engine, sentiment analysis, the LLM layer, scheduling and the product UI are later phases.

## Stack

| Layer      | Choice                                    |
| ---------- | ----------------------------------------- |
| Framework  | Next.js 16 (App Router, TypeScript)       |
| Database   | PostgreSQL 17 on Supabase                 |
| Auth       | Supabase Auth (email + password)          |
| Styling    | Tailwind CSS 4 (installed, no design yet) |
| Tests      | Vitest                                    |
| Deployment | Vercel                                    |

## Getting started

```bash
npm install
cp .env.local.example .env.local   # then fill in the values (see below)
npm run dev                        # http://localhost:3000
```

Other scripts:

| Script              | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `npm run build`     | Production build                                                           |
| `npm run typecheck` | `tsc --noEmit`                                                             |
| `npm run lint`      | ESLint (Next.js core-web-vitals + TypeScript rules)                        |
| `npm test`          | Vitest unit tests (connectors, ingestion runner, route auth)               |
| `npm run db:link`   | Link the Supabase CLI to the project (one time, after `npx supabase login`) |
| `npm run db:push`   | Apply any migrations in `supabase/migrations` that are not yet applied     |
| `npm run db:types`  | Regenerate `types/database.ts` from the linked database                    |

## Environment variables

All variables are listed in `.env.local.example`. `lib/env.ts` is the only place that reads `process.env`; everything else calls its helpers.

| Variable                               | Where it is used             | Notes                                                                                    |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | browser + server             | `https://<project-ref>.supabase.co`                                                      |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server             | Publishable key (`sb_publishable_…`). The legacy anon JWT also works. Subject to RLS.    |
| `SUPABASE_SERVICE_ROLE_KEY`            | server only                  | Secret key (`sb_secret_…`) or legacy `service_role` JWT. **Bypasses RLS.** Never public. |
| `NEXT_PUBLIC_SITE_URL`                 | server (auth redirect links) | `http://localhost:3000` locally, your Vercel URL in production.                          |
| `YOUTUBE_API_KEY`                      | server only (ingestion)      | YouTube Data API v3 key. Read inside the YouTube connector, never sent to a browser.      |
| `INGEST_SECRET`                        | server only (ingestion)      | Random string that authorises `/api/ingest`. Generate with `openssl rand -hex 32`.       |

Reserved for later phases (listed as comments in the example file): `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `FINNHUB_API_KEY`, `NEWSDATA_KEY`, `RAPIDAPI_KEY`, `APISPORTS_KEY`.

## Project structure

```
app/
  (auth)/                  login + signup pages and their Server Actions
  auth/callback/route.ts   email confirmation / magic-link landing
  account/page.tsx         minimal protected page
  api/ingest/route.ts      ingestion runner endpoint (INGEST_SECRET protected)
components/auth/           LoginForm, SignupForm, SignOutButton
lib/
  env.ts                   environment variable access
  supabase.ts              typed browser client
  supabase-server.ts       typed cookie-based server client
  supabase-admin.ts        typed service-role client (server only, bypasses RLS)
  supabase-proxy.ts        session refresh + route guards used by proxy.ts
  auth.ts                  getCurrentUser, getCurrentSession, getCurrentProfile, requireUser
  money.ts                 integer-cents formatting
  format.ts                compact numbers / percentages for headlines
  connectors/
    types.ts               DataConnector, RawSignal, ConnectorContext, SnapshotStore
    registry.ts            source name -> connector
    youtube.ts             reference connector (YouTube Data API v3)
    twitch.ts spotify.ts forbes.ts finnhub.ts newsdata.ts billboard.ts apisports.ts rss.ts   stubs
  ingest/
    runner.ts              runIngestion(): active sources -> mappings -> connectors -> signals + snapshots
    store.ts               IngestStore (Supabase implementation + in-memory implementation for tests)
    auth.ts                INGEST_SECRET check (constant-time)
proxy.ts                   Next.js proxy (formerly middleware)
supabase/migrations/       SQL migrations (applied in order)
types/
  database.ts              generated from the schema (npm run db:types)
  index.ts                 row aliases and closed vocabularies
vitest.config.ts           test runner config
```

## Database

All monetary amounts are **integer cents** stored in `bigint` columns. Floating point is never used for money. Scores are `numeric` on a 0–100 scale.

### Migrations

| File                                     | Contents                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `20260905204224_initial_schema.sql`      | The 11 core tables, constraints, indexes and comments                                   |
| `20260905204557_rls_policies.sql`        | RLS enabled everywhere + the Phase 1 policies                                           |
| `20260905205313_auth_triggers.sql`       | `handle_new_user` trigger, email-sync trigger, `username_available()` RPC               |
| `20260905205726_seed_phase1.sql`         | 16 people, the Drake ↔ Kendrick Lamar inverse pair, 8 inactive data sources             |
| `20260907002020_lock_financial_writes.sql` | Removes client write access to financial tables, event_type allow-list, RPC template  |
| `20260907002303_source_snapshots.sql`    | `source_snapshots` table + RLS, `signals.occurred_at`, `signals.dedupe_key`             |
| `20260907002801_seed_rss_data_source.sql` | Registers the inactive `rss` data source                                               |

All of these are applied to the `Momentum Terminal` Supabase project and recorded under the same versions, so `npm run db:push` treats them as applied and only pushes new files. To add a migration: create `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, run `npm run db:push`, then `npm run db:types`.

### Tables

| Table                 | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `users`               | Profile + wallet for each `auth.users` row                                              |
| `people`              | Each tracked individual (the core entity)                                               |
| `data_sources`        | Pluggable registry of external feeds (`is_active` switches a connector on)              |
| `person_data_sources` | Which sources feed which person, with the external identifier (channel ID, ticker, URL) |
| `inverse_pairs`       | Unordered pairs whose scores move against each other                                    |
| `positions`           | A user's HIGH/LOW position on a person                                                  |
| `transactions`        | Wallet ledger (`DEPOSIT`, `ALLOCATION`, `REDEMPTION`, `WITHDRAWAL`)                     |
| `signals`             | Raw data points from connectors; `occurred_at`, optional `dedupe_key`; Engine-scored later |
| `source_snapshots`    | Last known value per person / source / metric, for delta detection                      |
| `score_history`       | Score time series per person                                                            |
| `portfolio_history`   | Portfolio value time series per user                                                    |
| `behavioral_events`   | Append-only interaction log (`event_type` allow-listed)                                 |

### Row level security

RLS is enabled on every table. The `anon` role has no policies anywhere.

| Tables                                                                                                          | Authenticated users                                                          | Service role       |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `users`                                                                                                         | read own row; update own `username`, `display_name`, `avatar_url` only       | full               |
| `positions`, `transactions`, `portfolio_history`                                                                | **read own rows only**                                                       | full (only writer) |
| `behavioral_events`                                                                                             | read own rows; insert own rows with an allow-listed `event_type`; no update/delete | full         |
| `people`, `data_sources`, `person_data_sources`, `inverse_pairs`, `score_history`, `signals`, `source_snapshots` | read all                                                                     | full (only writer) |

### Financial writes

Clients never write money. Every write to `positions`, `transactions`, `portfolio_history` and to `users.wallet_balance_cents` / `users.buying_power_cents` goes through exactly one of:

1. **Trusted server code** using the service-role client (`lib/supabase-admin.ts`): the Engine tick, cron jobs, admin tooling.
2. **A `SECURITY DEFINER` function (RPC)** that runs with an empty `search_path`, derives the actor from `auth.uid()`, validates every input, performs all related writes in one transaction, and is granted to `authenticated` explicitly.

`placeholder_financial_mutation(p_amount_cents)` in the lock-down migration is the template for the trading RPCs of later phases. It validates and then always raises, so nothing can move through it yet. Table-level `INSERT`/`UPDATE`/`DELETE` privileges are revoked from client roles on the financial tables and must not be re-granted.

## Authentication

- **Signup** (`/signup`): the Server Action validates the input, pre-checks the username through the `username_available()` RPC, then calls `supabase.auth.signUp` with `username` and `display_name` in the user metadata.
- The `on_auth_user_created` trigger inserts the `public.users` row with `wallet_balance_cents = 100000` and `buying_power_cents = 100000` ($1,000 demo credit) and a matching `DEPOSIT` transaction. A taken username is retried with a random suffix.
- If **Confirm email** is enabled in Supabase Auth, the confirmation link lands on `/auth/callback`; otherwise signup signs the user in immediately.
- **Login** (`/login`): `signInWithPassword`, then redirect to `next` (defaults to `/account`).
- `proxy.ts` refreshes expired sessions on every request, sends signed-out users away from `/account`, and signed-in users away from `/login` and `/signup`.
- In server code use `getCurrentUser()` / `requireUser()` from `lib/auth.ts` for anything that depends on identity.

Set the Supabase Auth **Site URL** and **Redirect URLs** (Authentication → URL Configuration) to include your local and Vercel origins plus `/auth/callback`.

## Data ingestion

The ingestion layer fetches real-world data about tracked people, converts it into standardized signals and stores them raw. Nothing here scores, ranks or weighs anything; that is the Engine's job in Phase 3.

### Connectors

Every source is a self-contained module under `lib/connectors/` implementing `DataConnector` (`lib/connectors/types.ts`):

```ts
interface DataConnector {
  readonly name: string; // equals data_sources.name
  fetchForPerson(person: Person, externalIdentifier: string, context: ConnectorContext): Promise<RawSignal[]>;
}

interface RawSignal {
  headline: string;                    // "MrBeast crosses 516M subscribers on YouTube"
  rawPayload: Record<string, unknown>; // everything behind the headline
  occurredAt: Date;                    // when the event happened
  dedupeKey?: string;                  // optional idempotency key, unique per source
}
```

`ConnectorContext` carries the `data_sources` row, its `config` JSON (thresholds, never secrets), a `SnapshotStore` scoped to the person + source (`latest(metricKey)` / `record(metricKey, value)`), the run's `now`, and a `fetch` with a timeout applied. Secrets always come from env vars read on the server.

`lib/connectors/registry.ts` maps `data_sources.name` to the implementation. Registered today: `youtube` (working) and stubs for `twitch`, `spotify`, `forbes`, `finnhub`, `newsdata`, `billboard`, `apisports`, `rss`. Each stub is interface-compliant, returns `[]`, and carries a TODO describing the API, env vars, identifier and signals it will produce.

**To add or activate a source:** implement `fetchForPerson` in its module, register it (already done for the nine seeded names), add env vars if needed, insert `person_data_sources` rows mapping people to their identifiers, then `update data_sources set is_active = true where name = '<name>'`. No runner changes are required.

### YouTube connector (reference implementation)

`lib/connectors/youtube.ts` calls YouTube Data API v3 `channels.list` (`part=snippet,statistics`) for the channel ID stored in `person_data_sources.external_identifier`, using `YOUTUBE_API_KEY`. Channel statistics are cumulative, so the signal is the change:

- Every run records `subscriber_count`, `view_count` and `video_count` as `source_snapshots` and diffs against the newest previous snapshot.
- **First contact** produces one `baseline` signal ("MrBeast stands at 516M subscribers, 90B total views and 900 videos on YouTube").
- **Milestones**: crossing a round-number boundary (one hundredth of the value's order of magnitude, e.g. every 1M subscribers around 500M) produces "crosses 516M subscribers on YouTube" / "passes 90B total views"; falling back below one produces "drops below …".
- **Relative moves** without a milestone produce "gains 2.6M YouTube subscribers (+0.5%) since last check" when the change exceeds `subscriber_min_relative_change` (default 0.5%) or `view_min_relative_change` (default 1%), both overridable in `data_sources.config`.
- **Uploads**: an increased video count produces "uploads 2 new videos on YouTube (903 total)".
- Hidden subscriber counts are skipped. Every signal has a `dedupeKey`, so re-running never duplicates it. `rawPayload.kind` is one of `baseline`, `milestone`, `milestone_lost`, `change`, `upload`.

### Snapshots

`source_snapshots` stores `(person_id, data_source_id, metric_key, value, recorded_at)`. A single unique index on those four columns (`recorded_at desc`) is both the uniqueness rule and the "latest value" lookup. The runner appends one row per metric per run, so the table doubles as a raw time series. Service role writes; authenticated users read.

### The runner

`lib/ingest/runner.ts` (`runIngestion`) does, for every `data_sources` row with `is_active = true`:

1. look up the connector in the registry (skipped with a reason if none is registered);
2. load active `person_data_sources` mappings for active people (skipped if none);
3. call `fetchForPerson` once per person with a scoped snapshot store;
4. upsert the returned signals into `signals` with `processed = false` (`dedupe_key` conflicts are ignored);
5. persist the snapshots the connector recorded;
6. return an `IngestSummary`: sources run, sources skipped, per-source counts, totals and per-person errors.

One person's failure is recorded and the run continues. Persistence goes through the `IngestStore` interface (`lib/ingest/store.ts`); production uses the Supabase implementation with the service-role client, tests use the in-memory one.

### The endpoint

`POST` or `GET /api/ingest` runs the runner. It is protected by `INGEST_SECRET`, sent as `x-ingest-secret: <secret>` or `Authorization: Bearer <secret>` (the header Vercel Cron uses). Without a configured secret the route answers 503; with a wrong one, 401. `?source=youtube` (repeatable) limits the run to the named sources. Scheduling is intentionally not set up yet.

```bash
curl -X POST -H "x-ingest-secret: $INGEST_SECRET" http://localhost:3000/api/ingest
```

With every source inactive this returns a clean empty summary:

```json
{ "sourcesRun": [], "sourcesSkipped": [], "totals": { "sources": 0, "people": 0, "signalsCreated": 0, "snapshotsRecorded": 0, "errors": 0 }, "errors": [] }
```

### Testing the YouTube connector with a real key

Unit tests (`npm test`) cover the connector with a mocked API and need no key. To run it against the live API:

1. Get a YouTube Data API v3 key in Google Cloud Console (enable the API, create an API key). Put it in `.env.local` as `YOUTUBE_API_KEY`, alongside `SUPABASE_SERVICE_ROLE_KEY` and an `INGEST_SECRET`.
2. Map a person to a channel and switch the source on (SQL editor or `psql`):

   ```sql
   insert into public.person_data_sources (person_id, data_source_id, external_identifier)
   select p.id, d.id, 'UCX6OQ3DkcsbYNE6H8uQQuVA'   -- MrBeast's channel ID
     from public.people p, public.data_sources d
    where p.slug = 'mrbeast' and d.name = 'youtube'
   on conflict (person_id, data_source_id) do update
     set external_identifier = excluded.external_identifier, is_active = true;

   update public.data_sources set is_active = true where name = 'youtube';
   ```

3. Run the app and trigger ingestion:

   ```bash
   npm run dev
   curl -X POST -H "x-ingest-secret: $INGEST_SECRET" "http://localhost:3000/api/ingest?source=youtube"
   ```

   The first run reports one signal (the baseline) and three snapshots. A second run reports zero new signals unless the numbers moved, and three more snapshot rows.

4. Inspect the results:

   ```sql
   select headline, occurred_at, dedupe_key, raw_payload->>'kind' as kind from public.signals order by created_at desc;
   select metric_key, value, recorded_at from public.source_snapshots order by recorded_at desc;
   ```

5. Switch it back off when done: `update public.data_sources set is_active = false where name = 'youtube';`

## Scope so far

- **Phase 1**: scaffold, schema, RLS, auth, seed data, typed clients.
- **Phase 2**: financial-write lockdown + RPC pattern, connector interface and registry, YouTube connector, eight stub connectors, `source_snapshots`, the ingestion runner and endpoint, unit tests.

Deliberately not built yet: the Engine (scoring, sentiment, impact), the LLM layer, cron scheduling, person profiles, feeds, portfolio pages, trading RPCs, and any visual design.
