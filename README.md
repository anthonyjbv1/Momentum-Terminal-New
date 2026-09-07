# Momentum Terminal

A social data terminal where users take **HIGH** or **LOW** positions on individual people. Each person has a continuously updating Momentum Score driven by their observable real-world data. Users profit when a score moves in their predicted direction; the platform is the sole counterparty. The scoring system is called **the Engine**; its five forces are **Gravity**, **Signals**, **Market Mood**, **Conviction** and **Trading Activity**.

> **Status: Phase 3 (the Engine) complete.** The repo contains the Next.js scaffold, the database schema, auth, the pluggable data-source connector system with a working YouTube connector, the ingestion runner, and the Engine: a swappable rules-based sentiment scorer, the five forces, inverse pairs, the LMSR dynamic spread and an atomic tick that persists scores, history and a per-force audit trail. The tick is triggered manually; the 30-second schedule, the LLM scorer, trading and the product UI are later phases.

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
| `npm test`          | Vitest unit tests (connectors, ingestion, Engine forces, sentiment, tick)  |
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
| `ENGINE_SECRET`                        | server only (Engine)         | Random string that authorises `/api/engine/tick`.                                        |
| `SENTIMENT_SCORER`                     | server only (Engine), optional | Which scorer the Engine uses. `rules` (default) until the LLM scorer lands in Phase 4.  |

Reserved for later phases (listed as comments in the example file): `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `FINNHUB_API_KEY`, `NEWSDATA_KEY`, `RAPIDAPI_KEY`, `APISPORTS_KEY`.

## Project structure

```
app/
  (auth)/                  login + signup pages and their Server Actions
  auth/callback/route.ts   email confirmation / magic-link landing
  account/page.tsx         minimal protected page
  api/ingest/route.ts      ingestion runner endpoint (INGEST_SECRET)
  api/engine/tick/route.ts Engine tick endpoint (ENGINE_SECRET, ?dryRun=1)
components/auth/           LoginForm, SignupForm, SignOutButton
lib/
  env.ts                   environment variable access
  api-auth.ts              constant-time shared-secret check for internal endpoints
  supabase.ts              typed browser client
  supabase-server.ts       typed cookie-based server client
  supabase-admin.ts        typed service-role client (server only, bypasses RLS)
  supabase-proxy.ts        session refresh + route guards used by proxy.ts
  auth.ts                  getCurrentUser, getCurrentSession, getCurrentProfile, requireUser
  money.ts, format.ts      integer-cents and headline number formatting
  connectors/              DataConnector interface, registry, YouTube connector, 8 stubs
  ingest/                  runIngestion(), IngestStore (Supabase + in-memory)
  engine/
    config.ts              EVERY tuning constant (DEFAULT_ENGINE_CONFIG)
    sentiment/             SentimentScorer interface, RulesBasedScorer, registry
    forces/                gravity, signals, market-mood, conviction, trading-activity
    inverse-pairs.ts       second-pass inverse-pair adjustments
    spread.ts              LMSR dynamic spread, Buy / Sell prices
    tick.ts                runEngineTick(): the orchestrator
    store.ts               EngineStore (Supabase via apply_engine_tick RPC + in-memory)
proxy.ts                   Next.js proxy (formerly middleware)
supabase/migrations/       SQL migrations (applied in order)
types/                     generated database types + row aliases
vitest.config.ts           test runner config
```

## Database

All monetary amounts are **integer cents** stored in `bigint` columns. Floating point is never used for money. Scores are `numeric` on a 0–100 scale.

### Migrations

| File                                       | Contents                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `20260905204224_initial_schema.sql`        | The 11 core tables, constraints, indexes and comments                                        |
| `20260905204557_rls_policies.sql`          | RLS enabled everywhere + the Phase 1 policies                                                |
| `20260905205313_auth_triggers.sql`         | `handle_new_user` trigger, email-sync trigger, `username_available()` RPC                    |
| `20260905205726_seed_phase1.sql`           | 16 people, the Drake ↔ Kendrick Lamar inverse pair, 8 inactive data sources                  |
| `20260907002020_lock_financial_writes.sql` | Removes client write access to financial tables, event_type allow-list, RPC template         |
| `20260907002303_source_snapshots.sql`      | `source_snapshots` table + RLS, `signals.occurred_at`, `signals.dedupe_key`                  |
| `20260907002801_seed_rss_data_source.sql`  | Registers the inactive `rss` data source                                                     |
| `20260907143920_engine_tables.sql`         | `people.last_tick_at` + generated `buy_price`/`sell_price`, `engine_ticks`, `score_events`, `trade_events`, `apply_engine_tick()` |

All of these are applied to the `Momentum Terminal` Supabase project and recorded under the same versions, so `npm run db:push` treats them as applied and only pushes new files. To add a migration: create `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, run `npm run db:push`, then `npm run db:types`.

### Tables

| Table                 | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `users`               | Profile + wallet for each `auth.users` row                                                    |
| `people`              | Each tracked individual: `current_score`, `revert_target`, `spread`, generated `buy_price` / `sell_price`, `last_tick_at` |
| `data_sources`        | Pluggable registry of external feeds (`is_active` switches a connector on)                    |
| `person_data_sources` | Which sources feed which person, with the external identifier                                 |
| `inverse_pairs`       | Unordered pairs whose scores move against each other (with `dampening`)                       |
| `positions`           | A user's HIGH/LOW position on a person                                                        |
| `transactions`        | Wallet ledger (`DEPOSIT`, `ALLOCATION`, `REDEMPTION`, `WITHDRAWAL`)                           |
| `signals`             | Raw data points from connectors; the Engine writes `impact_score`, sentiment and `processed`  |
| `source_snapshots`    | Last known value per person / source / metric, for delta detection                            |
| `score_history`       | One row per person per tick (`tick_number`, `score`)                                          |
| `engine_ticks`        | One row per Engine tick: timing, counts, market mood, summary                                 |
| `score_events`        | Per-force audit trail (`force`, `impact`, `details`); zero-impact entries are never written   |
| `trade_events`        | Live Buy/Sell tape read by Trading Activity; written by the trading flow of a later phase     |
| `portfolio_history`   | Portfolio value time series per user                                                          |
| `behavioral_events`   | Append-only interaction log (`event_type` allow-listed)                                       |

### Row level security

RLS is enabled on every table. The `anon` role has no policies anywhere.

| Tables                                                                                                                                              | Authenticated users                                                          | Service role       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `users`                                                                                                                                             | read own row; update own `username`, `display_name`, `avatar_url` only       | full               |
| `positions`, `transactions`, `portfolio_history`                                                                                                    | read own rows only                                                           | full (only writer) |
| `trade_events`                                                                                                                                      | read own rows only                                                           | full (only writer) |
| `behavioral_events`                                                                                                                                 | read own; insert own with an allow-listed `event_type`; no update/delete     | full               |
| `people`, `data_sources`, `person_data_sources`, `inverse_pairs`, `score_history`, `signals`, `source_snapshots`, `engine_ticks`, `score_events`     | read all                                                                     | full (only writer) |

### Financial writes

Clients never write money. Every write to `positions`, `transactions`, `portfolio_history`, `trade_events` and to `users.wallet_balance_cents` / `users.buying_power_cents` goes through exactly one of:

1. **Trusted server code** using the service-role client (`lib/supabase-admin.ts`): the Engine tick, cron jobs, admin tooling.
2. **A `SECURITY DEFINER` function (RPC)** that runs with an empty `search_path`, derives the actor from `auth.uid()`, validates every input, performs all related writes in one transaction, and is granted to `authenticated` explicitly.

`placeholder_financial_mutation(p_amount_cents)` is the template for the trading RPCs of later phases. `apply_engine_tick(jsonb)` is the Engine's own atomic write path and is executable by the service role only.

## Authentication

- **Signup** (`/signup`): the Server Action validates the input, pre-checks the username through the `username_available()` RPC, then calls `supabase.auth.signUp` with `username` and `display_name` in the user metadata. The `on_auth_user_created` trigger inserts the `public.users` row with a $1,000 demo balance and a matching `DEPOSIT` transaction.
- **Login** (`/login`): `signInWithPassword`, then redirect to `next` (defaults to `/account`). Email confirmation links land on `/auth/callback`.
- `proxy.ts` refreshes expired sessions on every request and guards `/account`, `/login` and `/signup`.
- Use `getCurrentUser()` / `requireUser()` from `lib/auth.ts` in server code for anything that depends on identity.

Set the Supabase Auth **Site URL** and **Redirect URLs** (Authentication → URL Configuration) to include your local and Vercel origins plus `/auth/callback`.

## Data ingestion

Connectors under `lib/connectors/` implement `DataConnector` (`fetchForPerson(person, externalIdentifier, context) → RawSignal[]`) and are registered by `data_sources.name`. `youtube` is implemented (channel statistics with snapshot-based delta detection); `twitch`, `spotify`, `forbes`, `finnhub`, `newsdata`, `billboard`, `apisports` and `rss` are interface-compliant stubs with TODOs. The runner (`lib/ingest/runner.ts`) reads active sources and `person_data_sources` mappings, calls the connectors, upserts signals with `processed = false` (dedupe keys prevent duplicates) and records `source_snapshots`.

```bash
curl -X POST -H "x-ingest-secret: $INGEST_SECRET" "http://localhost:3000/api/ingest?source=youtube"
```

To test the YouTube connector against the live API, set `YOUTUBE_API_KEY`, map a person to a channel (MrBeast is `UCX6OQ3DkcsbYNE6H8uQQuVA`), activate the source and call the endpoint:

```sql
insert into public.person_data_sources (person_id, data_source_id, external_identifier)
select p.id, d.id, 'UCX6OQ3DkcsbYNE6H8uQQuVA' from public.people p, public.data_sources d
 where p.slug = 'mrbeast' and d.name = 'youtube'
on conflict (person_id, data_source_id) do update set external_identifier = excluded.external_identifier, is_active = true;
update public.data_sources set is_active = true where name = 'youtube';
```

## The Engine

`lib/engine/` turns raw signals into moving Momentum Scores. It is pure TypeScript over a `TickContext` loaded up front, so every force is unit-tested without a database. Every tuning constant lives in `lib/engine/config.ts` (`DEFAULT_ENGINE_CONFIG`); the values mirror the proven formulas of the previous platform.

### Sentiment (swappable)

`SentimentScorer` (`lib/engine/sentiment/types.ts`) has one method: `scoreSignal({ headline, rawPayload, sourceName, sourceTier }) → { label, confidence, direction }`. The Engine only ever calls that method. `RulesBasedScorer` matches weighted positive and negative patterns on the headline, scales confidence with the clarity and number of matches, goes neutral on mixed signals, and treats connector `kind: "baseline"` payloads as neutral / direction 0 / confidence 0 (zero impact by design). `getSentimentScorer()` in `lib/engine/sentiment/index.ts` is the registry; Phase 4 registers an LLM scorer there and the Engine does not change.

### The five forces (first pass, per person)

| Force                | Formula                                                                                                                   | With nothing happening |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Gravity**          | `decayed = target + (score − target) · e^(−λ·Δh)`, impact = `decayed − score`; λ = 0.35/h, Δh = hours since `last_tick_at` (30 s on the very first tick, capped at 24 h) | pulls toward `revert_target` |
| **Signals**          | per signal: `baseImpact (1.5) · tier multiplier (T1 1.5, T2 1.0, T3 0.5, T4/5 0.3) · confidence · direction`; summed, capped at ±10 per tick | 0 |
| **Market Mood**      | mood = platform-wide mean of this tick's Signals impacts; impact = `fraction (0.25) · sensitivity (1.0, per-slug overridable) · mood excluding the person's own signals`, mood clamped to ±2 and impact to ±0.5 (the brakes) | 0 |
| **Conviction**       | concentration = open capital on the person / `max_allocation_cents`; 0–60 % → 0, 60–85 % → +0.05…+0.15, > 85 % → −0.05…−0.15, capped at −0.30 | 0 (no positions) |
| **Trading Activity** | conviction score = net Buy−Sell flow in the last 60 s / `max_allocation_cents` (clamped ±1); fires only beyond mean ± 1.5 σ of the 24 h windowed history; adjustment = score · 0.25, × 0.4 when no signal confirms the move, capped ±0.30, skipped below 15 % concentration | 0 (no trades) |

`newScore = clamp(score + Σ forces, 35, 100)`.

### Second pass, spread and persistence

- **Inverse pairs**: after everyone's first pass, for each `inverse_pairs` row, a Signals impact on A gives B `−(impact · dampening)` and vice versa, then re-clamp. Second-pass adjustments never cascade through Gravity or Market Mood.
- **LMSR spread**: the previous platform's `p_i = exp(q_i / b) / Σ exp(q_j / b)` (b = 5000, q = open capital in dollars) measured against the uniform share `1/N`: `thinness = clamp((1/N − p_i)/(1/N), 0, 1)`, `widening = (1.50 − 0.50) · thinness`, `tightening = 0.5·concentration + 0.3·min(signal depth / 10, 1) + 0.2·confidence`, `spread = clamp(0.50 + widening · (1 − tightening), 0.50, 1.50)`. With no positions and no volume it collapses to the base 0.50. **Buy** = score + spread, **Sell** = score − spread, both stored as generated columns on `people`.
- **Persistence**: `apply_engine_tick(jsonb)` writes `people` (score, spread, `last_tick_at`), `score_history` (with the new `tick_number`), `score_events` (non-zero forces only), the processed `signals` (impact, label, confidence, `processed_at`) and the `engine_ticks` row in one transaction under an advisory lock. A tick computed against a stale `tick_number` is refused, so two overlapping ticks can never double-apply a signal.

### Running a tick

`POST` or `GET /api/engine/tick`, protected by `ENGINE_SECRET` (`x-engine-secret` header or `Authorization: Bearer`). Add `?dryRun=1` to compute and return the summary without persisting. Scheduling is deliberately not set up yet.

```bash
# see what the next tick would do, without writing anything
curl -H "x-engine-secret: $ENGINE_SECRET" "http://localhost:3000/api/engine/tick?dryRun=1"

# run a real tick
curl -X POST -H "x-engine-secret: $ENGINE_SECRET" http://localhost:3000/api/engine/tick
```

The response is the `TickSummary`: `tickNumber`, `mood`, `peopleUpdated`, `signalsProcessed`, one entry per person (`previousScore`, `newScore`, `change`, `spread`, `buyPrice`, `sellPrice`, the non-zero `forces`) and one entry per processed signal (label, confidence, direction, impact).

With no signals, a tick moves every score slightly toward its revert target through Gravity alone: from the seeded 50.0, a person with target 68 moves to 50.05 on the first 30-second tick, and only a `gravity` row appears in `score_events`. Conviction and Trading Activity are exactly 0 until positions and trades exist; the spread sits at 0.50.

### Watching a score move

Seed a signal for Drake and tick:

```sql
insert into public.signals (person_id, data_source_id, headline, raw_payload, dedupe_key)
select p.id, d.id, 'Drake crosses 100M monthly listeners on Spotify', '{"kind": "milestone", "test": true}'::jsonb, 'manual-test-1'
  from public.people p, public.data_sources d
 where p.slug = 'drake' and d.name = 'spotify';
```

```bash
curl -X POST -H "x-engine-secret: $ENGINE_SECRET" http://localhost:3000/api/engine/tick
```

Expected: the headline scores positive at confidence 0.8, so Drake gets a Signals impact of `1.5 × 1.0 (tier 2) × 0.8 = +1.20` on top of Gravity; Kendrick Lamar gets the inverse-pair adjustment `−(1.20 × 0.40) = −0.48` plus a small Market Mood lift; everyone else gets Market Mood only (`0.25 × 1.20 / 15 ≈ +0.02`). The signal row now has `processed = true`, `impact_score = 1.2`, `sentiment_label = 'positive'`, `sentiment_confidence = 0.8`. Inspect:

```sql
select slug, current_score, spread, buy_price, sell_price, last_tick_at from public.people order by current_score desc;
select tick_number, person_id, force, impact from public.score_events order by tick_number desc, impact desc;
select tick_number, mood, people_updated, signals_processed from public.engine_ticks order by tick_number desc;
```

## Scope so far

- **Phase 1**: scaffold, schema, RLS, auth, seed data, typed clients.
- **Phase 2**: financial-write lockdown + RPC pattern, connector interface and registry, YouTube connector, stubs, `source_snapshots`, ingestion runner and endpoint.
- **Phase 3**: swappable sentiment scoring (rules-based), the five forces, inverse pairs, LMSR spread with Buy/Sell prices, the atomic tick with history and per-force audit trail, the tick endpoint.

Deliberately not built yet: the LLM sentiment scorer (Phase 4), the 30-second schedule, the user trading flow (which will write `positions`, `transactions` and `trade_events` through RPCs), person profiles, feeds, portfolio pages, and any visual design.
