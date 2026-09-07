# Momentum Terminal

A social data terminal where users take **HIGH** or **LOW** positions on individual people. Each person has a continuously updating Momentum Score driven by their observable real-world data. Users profit when a score moves in their predicted direction; the platform is the sole counterparty. The scoring system is called **the Engine**; its five forces are **Gravity**, **Signals**, **Market Mood**, **Conviction** and **Trading Activity**.

> **Status: Phase 4 (LLM reasoning layer + memory) complete.** On top of the scaffold, schema, auth, ingestion and the Engine, the repo now has a provider-agnostic LLM abstraction (Anthropic adapter live, OpenAI / Gemini / OpenAI-compatible stubs), per-entity memory, an `LLMScorer` that reasons about each signal relative to the person's own baseline and falls back to the rules scorer on any failure, token-usage logging with a per-tick call cap, and narratives for meaningful score moves. The five forces, inverse pairs, LMSR and tick persistence are unchanged from Phase 3. The 30-second heartbeat is wired (Vercel Cron → `/api/engine/cron`) but **switched off** by `ENGINE_CRON_ENABLED=false`; the trading flow, behavioral logging and the product UI are later phases.

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
| `npm test`          | Vitest unit tests (connectors, ingestion, Engine, LLM layer, memory, narratives) |
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
| `ENGINE_SECRET`                        | server only (Engine)         | Random string that authorises `/api/engine/tick` (and manual calls to `/api/engine/cron`). |
| `SCORER`                               | server only (Engine)         | `llm` (default) or `rules` — the instant fallback to the Phase 3 keyword scorer.        |
| `ENGINE_CRON_ENABLED`                  | server only (heartbeat)      | **The switch.** Only the exact string `true` lets `/api/engine/cron` tick; anything else (including unset) logs `skipped (disabled)` and returns. Default `false`. |
| `CRON_SECRET`                          | server only (heartbeat)      | Vercel's cron secret. Once set in the Vercel project, Vercel sends it as `Authorization: Bearer` on every scheduled call and the handler rejects anything else. |
| `LLM_PROVIDER`                         | server only (LLM)            | `anthropic` (default), `openai`, `gemini` or `openai-compatible`. One variable swaps vendors. |
| `LLM_MODEL`                            | server only (LLM)            | Model string for the active provider; empty = provider default (`claude-opus-5`).       |
| `ANTHROPIC_API_KEY`                    | server only (LLM)            | Anthropic Messages API key.                                                              |
| `LLM_MODEL_<TASK>`, `LLM_PROVIDER_<TASK>`, `LLM_EFFORT_<TASK>` | server only, optional | Per-task routing for `SENTIMENT`, `ANOMALY`, `NARRATIVE`, `MEMORY` (e.g. a cheap model for scoring). |

Reserved for later phases (listed as comments in the example file): `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `FINNHUB_API_KEY`, `NEWSDATA_KEY`, `RAPIDAPI_KEY`, `APISPORTS_KEY`.

## Project structure

```
app/
  (auth)/                  login + signup pages and their Server Actions
  auth/callback/route.ts   email confirmation / magic-link landing
  account/page.tsx         minimal protected page
  api/ingest/route.ts      ingestion runner endpoint (INGEST_SECRET)
  api/engine/tick/route.ts Engine tick endpoint (ENGINE_SECRET, ?dryRun=1)
  api/engine/cron/route.ts the heartbeat: Vercel Cron target, gated by ENGINE_CRON_ENABLED
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
  llm/
    types.ts               LLMProvider / LLMRequest / LLMResponse / LLMError — the only LLM surface the app sees
    providers/             anthropic.ts (live), openai.ts, gemini.ts, openai-compatible.ts (stubs)
    registry.ts            LLM_PROVIDER -> adapter
    routing.ts             task type -> provider / model / effort (LLM_MODEL_<TASK> ...)
    usage.ts               token usage logging into llm_usage
    json.ts                tolerant JSON extraction from model text
  engine/
    config.ts              EVERY tuning constant (DEFAULT_ENGINE_CONFIG), incl. llm / narratives / memory
    sentiment/             SentimentScorer interface, RulesBasedScorer, LLMScorer (+ prompts), registry
    memory/                person_memory types, store (Supabase + cache + in-memory), update logic
    narratives.ts          narratives for meaningful moves (LLM sentence reuse or templates)
    post-tick.ts           after a persisted tick: narratives + memory updates (never fail the tick)
    forces/                gravity, signals, market-mood, conviction, trading-activity
    inverse-pairs.ts       second-pass inverse-pair adjustments
    spread.ts              LMSR dynamic spread, Buy / Sell prices
    tick.ts                runEngineTick(): the orchestrator
    run-tick.ts            runFullTick(): the ONE production tick path (store + scorer + post-tick)
    cron.ts                heartbeat scheduling (two ticks per invocation, time budget) + cron auth
    store.ts               EngineStore (Supabase via apply_engine_tick RPC + in-memory)
proxy.ts                   Next.js proxy (formerly middleware)
vercel.json                cron schedule: /api/engine/cron every minute
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
| `20260907153228_llm_memory_narratives.sql` | `person_memory` (+ 16 seeded profiles), `llm_usage`, `narratives`, with RLS                  |

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
| `person_memory`       | Per-person profile, baseline patterns and rolling recent context used by the LLM scorer       |
| `llm_usage`           | One row per LLM call: provider, model, task, input/output/cache tokens, latency, person, tick  |
| `narratives`          | The Engine's one-sentence explanation of a meaningful move (`source` = llm or template)       |
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
| `people`, `data_sources`, `person_data_sources`, `inverse_pairs`, `score_history`, `signals`, `source_snapshots`, `engine_ticks`, `score_events`, `person_memory`, `narratives` | read all                                                | full (only writer) |
| `llm_usage`                                                                                                                                         | no access                                                                    | full (only writer) |

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

`SentimentScorer` (`lib/engine/sentiment/types.ts`) has one method: `scoreSignal({ id, personId, headline, rawPayload, sourceName, sourceTier }) → { label, confidence, direction, anomaly?, rationale?, narrative? }`. The Engine only ever calls that method. `getSentimentScorer()` picks the implementation from the `SCORER` env var:

- `llm` (default) — `LLMScorer`, the Phase 4 reasoning layer described below.
- `rules` — `RulesBasedScorer`, the Phase 3 keyword scorer. Setting `SCORER=rules` switches back instantly; it is also what the LLM scorer falls back to per signal whenever the provider errors, times out, refuses, returns something unparseable, or the per-tick call cap is hit.

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

`POST` or `GET /api/engine/tick`, protected by `ENGINE_SECRET` (`x-engine-secret` header or `Authorization: Bearer`). Add `?dryRun=1` to compute and return the summary without persisting. Both this route and the scheduled heartbeat (see [The heartbeat](#the-heartbeat-autonomous-ticking)) call `runFullTick()` in `lib/engine/run-tick.ts`, so there is exactly one tick path; the summary carries `trigger: "manual"` or `"cron"`.

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

## LLM reasoning layer

### Provider abstraction

`lib/llm/types.ts` defines the only LLM surface the application knows: `LLMProvider.complete({ systemPrompt, userPrompt, maxTokens, temperature, responseFormat, model?, effort?, timeoutMs? }) → { text, structuredData?, usage, provider, model, stopReason, latencyMs }`, plus `LLMError` with a vendor-neutral `kind` (`not_configured`, `rate_limit`, `timeout`, `refusal`, `invalid_response`, ...). Everything vendor-specific lives inside one adapter under `lib/llm/providers/`:

- **`anthropic`** (live) — the Messages API through the official SDK. Cached system prompt, `output_config.effort`, JSON schema via `output_config.format` (with an automatic retry on prompt-only JSON if a model rejects the schema), refusal stop reason → `LLMError(kind: "refusal")`, typed error mapping. `temperature` is only forwarded to models that still accept sampling parameters.
- **`openai`**, **`gemini`**, **`openai-compatible`** (Groq, Together.ai, Fireworks, vLLM, Ollama...) — interface-compliant stubs that throw a clean `not_configured` error with the steps to activate them.

**Swapping providers** is one env var: `LLM_PROVIDER=gemini` routes every call to the Gemini adapter with no other change. **Model routing** (`lib/llm/routing.ts`) resolves each task type (`sentiment`, `anomaly`, `narrative`, `memory`) to a provider, model and effort. Everything points at `LLM_PROVIDER` / `LLM_MODEL` until you set `LLM_MODEL_SENTIMENT=claude-haiku-4-5` (cheap scoring) or `LLM_MODEL_ANOMALY=claude-opus-5` (premium reasoning), or route one task to a different provider entirely.

### Per-entity memory

`person_memory` holds, per person: `profile` (who they are, what drives their momentum), `baseline_patterns` (typical signal volume and change magnitude, what is routine vs notable, a noise note such as "a 2% net worth move is noise for Musk") and `recent_context` (a rolling prose summary plus the last 8 notable events). The 16 people are seeded with concise factual baselines. After every persisted tick, notable signals (|impact| ≥ 0.5 or flagged notable / anomalous) are merged into `recent_context`; events that fall off the end are folded into the summary, by the LLM when `memory.llmSummaries` is on (one small call) or deterministically otherwise. Raw logs are never accumulated.

### The LLM scorer

`LLMScorer` (`lib/engine/sentiment/llm.ts`) implements `SentimentScorer`, so the Engine calls it exactly as it called the rules scorer. Internally, the `scoreSignal` calls a tick makes are coalesced into **one LLM call per person**, with that person's memory in the prompt. The model returns, per signal, `label`, `confidence`, `direction`, an `anomaly` assessment (`routine` / `notable` / `anomalous` for this person) and a rationale, plus one narrative sentence for the person. Anomaly is folded into confidence (routine × 0.5, notable × 1.0, anomalous × 1.2 capped at 1), so a routine daily upload moves a score far less than a genuine surprise.

Cost controls (all in `DEFAULT_ENGINE_CONFIG.llm`):

- **Pre-filter**: baseline signals (`kind: "baseline"`), empty headlines and tiny `change` signals (below `minRelativeChangeForLlm`) never reach the LLM.
- **Memory cache**: a person's memory is read once per batch and cached for `memoryCacheTtlMs`.
- **Batching**: up to `maxSignalsPerCall` signals about one person are reasoned together in one call.
- **Hard cap**: at most `maxCallsPerTick` calls per tick interval; beyond it, signals use the rules scorer.
- **Usage ledger**: every call writes `llm_usage` (provider, model, task, input / output / cache tokens, latency, person).

Resilience: any provider error, timeout, refusal, malformed response or omitted signal makes the affected signals fall back to the rules scorer (result `scorer: "rules-fallback"`, reason in the rationale) and logs the fallback. The tick never fails because the LLM had a hiccup.

### Narratives

After a persisted tick, `runPostTick` writes a narrative for every person whose |change| ≥ `narratives.minAbsChange` (0.5), at most `narratives.maxPerTick`. Signal-driven moves reuse the sentence the LLM already produced during scoring (no extra call, `source = "llm"`); moves driven by Gravity, Market Mood, Conviction, Trading Activity or an inverse pair get a deterministic sentence from the force breakdown (`source = "template"`). Narratives, memory updates and usage logging never fail the tick: errors are reported in the response's `postTick` block.

### Testing with a real API key

The sandbox this was built in cannot reach external hosts, so the provider was verified against a mocked SDK client and the scorer against a mocked provider (`npm test`). To exercise the live path locally:

1. Put `ANTHROPIC_API_KEY`, `ENGINE_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`. Leave `SCORER=llm`, `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-opus-5` (or set `LLM_MODEL_SENTIMENT=claude-haiku-4-5` for cheap scoring).
2. Seed a signal (see *Watching a score move* above) and run a tick:

   ```bash
   npm run dev
   curl -X POST -H "x-engine-secret: $ENGINE_SECRET" http://localhost:3000/api/engine/tick
   ```

3. In the response, `signals[].scorer` is `"llm"`, `anomaly` and `rationale` are filled in, and `postTick` reports the narratives and memory updates. In the database:

   ```sql
   select provider, model, task_type, input_tokens, output_tokens, latency_ms, created_at from public.llm_usage order by created_at desc;
   select p.slug, n.text, n.source, n.score_before, n.score_after from public.narratives n join public.people p on p.id = n.person_id order by n.created_at desc;
   select p.slug, pm.recent_context from public.person_memory pm join public.people p on p.id = pm.person_id where p.slug = 'drake';
   ```

4. To prove the fallback, set a wrong `ANTHROPIC_API_KEY` (or `LLM_PROVIDER=gemini`) and tick again: the tick succeeds, `scorer` is `"rules-fallback"` and the server log shows the reason. `SCORER=rules` skips the LLM entirely.

### Cost per tick (estimate)

One person-call sends roughly 1,000 input tokens (stable ~450-token system prompt + the person's memory + the signals) and returns 100–250 output tokens. Ticks with no new signals make no LLM calls at all.

| Model (via `LLM_MODEL` or `LLM_MODEL_SENTIMENT`) | Per person-call | Worst-case tick (16 people with news) | Hourly YouTube for 16 people, per day |
| ------------------------------------------------- | --------------- | ------------------------------------- | ------------------------------------- |
| `claude-opus-5` ($5 / $25 per MTok)               | ≈ $0.009        | ≈ $0.15                               | ≈ $3.50                               |
| `claude-sonnet-5` ($2 / $10 per MTok)             | ≈ $0.0035       | ≈ $0.06                               | ≈ $1.30                               |
| `claude-haiku-4-5` ($1 / $5 per MTok)             | ≈ $0.002        | ≈ $0.03                               | ≈ $0.70                               |

Memory summaries add one ~$0.003 (Opus) call per person every ~8 notable events; narratives add nothing. `llm_usage` gives the observed numbers once real ticks run.

## The heartbeat (autonomous ticking)

The Engine can tick on its own every 30 seconds, but the switch ships **OFF**.

`vercel.json` registers a Vercel Cron job that calls `GET /api/engine/cron` every minute (`* * * * *`, the finest schedule Vercel offers). The handler (`app/api/engine/cron/route.ts`) does, in this order:

1. **Checks `ENGINE_CRON_ENABLED` first.** Unless it is exactly `"true"`, it logs `skipped (disabled)` and returns `{ status: "skipped", enabled: false }` immediately: no database read, no tick, no LLM call, no cost. This check runs before authentication, so an unset flag makes the endpoint a no-op for everyone.
2. **Authenticates the caller.** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically once `CRON_SECRET` exists in the project; an operator can also call it with `ENGINE_SECRET` (`x-engine-secret` header or Bearer). Both comparisons are constant-time (`lib/api-auth.ts`). Anything else gets `401`; with neither secret configured, `503`.
3. **Runs the ticks** through `runScheduledTicks()` (`lib/engine/cron.ts`), which calls the very same `runFullTick()` the manual route uses.

### Cadence: two ticks per one-minute invocation

Vercel Cron cannot fire more often than once a minute, so each invocation runs **two** ticks: the first immediately, the second 30 seconds after the first *started* (not after it finished, so the cadence stays anchored to the minute). Per-tick fields in the log and the response include `tickNumber`, `signalsProcessed`, `llmScored`, `fallbacks`, `narratives` and `durationMs`.

The route declares `maxDuration = 60` and the scheduler works inside a **55-second budget**. Before the second tick it estimates how long that tick will take (the first tick's duration, floored at 5 s) and, if `start offset + estimate` would exceed the budget, it skips the second tick with a `tick skipped` log line and `skippedTicks: [{ index: 1, reason }]` in the response. So a slow tick (a big batch of LLM calls, a slow provider) degrades the cadence to 60 s for that minute rather than risking a function timeout that could leave the invocation half-logged. A tick that throws is logged as `tick failed`, the next tick in the invocation is still attempted, and the response status is `500` so Vercel's cron dashboard shows the failure. Overlap between invocations is harmless: `apply_engine_tick` refuses a tick computed against a stale `tick_number`.

Every invocation writes JSON lines to the function log with `"source":"engine-cron"`: `skipped (disabled)`, `tick ran`, `tick failed`, `tick skipped` and a final `invocation finished` line with `ticksPlanned`, `ticksRun`, `signalsProcessed`, `fallbacks`, `failures`, `skippedTicks` and `durationMs`.

The numbers live in `CRON_DEFAULTS` (`lib/engine/cron.ts`): `ticksPerInvocation: 2`, `spacingMs: 30000`, `budgetMs: 55000`, `minTickEstimateMs: 5000`. Setting `ticksPerInvocation` to `1` gives a plain 60-second heartbeat.

### Enabling it later

Nothing ticks until you do all of this in the Vercel project:

1. Make sure the Engine's own variables are set for Production: `SUPABASE_SERVICE_ROLE_KEY`, `ENGINE_SECRET`, and for LLM scoring `ANTHROPIC_API_KEY` (or set `SCORER=rules` to run without any LLM cost).
2. Add `CRON_SECRET` (generate with `openssl rand -hex 32`). Vercel attaches it to every scheduled call.
3. Set `ENGINE_CRON_ENABLED` to `true` (exactly that string).
4. Redeploy so the new values are baked in. Vercel picks the schedule up from `vercel.json` on deploy; check **Project → Settings → Cron Jobs** to confirm `/api/engine/cron` is listed.
5. Watch the function logs for `"source":"engine-cron"` lines and `engine_ticks` rows appearing every ~30 seconds.

To pause: set `ENGINE_CRON_ENABLED` back to `false` (or delete it) and redeploy. The cron keeps firing but every call returns `skipped (disabled)` in a few milliseconds.

Plan note: per-minute cron schedules require a Vercel **Pro** plan (Hobby is limited to daily jobs and would silently run the job once a day). On Pro, `maxDuration` on the cron route could be raised above 60 if ticks ever need more room.

Locally, the same endpoint is testable without any cron: with `ENGINE_CRON_ENABLED` unset, `curl http://localhost:3000/api/engine/cron` returns the skipped payload; with `ENGINE_CRON_ENABLED=true` in `.env.local`, `curl -H "x-engine-secret: $ENGINE_SECRET" http://localhost:3000/api/engine/cron` runs two real ticks 30 seconds apart.

## Scope so far

- **Phase 1**: scaffold, schema, RLS, auth, seed data, typed clients.
- **Phase 2**: financial-write lockdown + RPC pattern, connector interface and registry, YouTube connector, stubs, `source_snapshots`, ingestion runner and endpoint.
- **Phase 3**: swappable sentiment scoring (rules-based), the five forces, inverse pairs, LMSR spread with Buy/Sell prices, the atomic tick with history and per-force audit trail, the tick endpoint.
- **Phase 4**: provider-agnostic LLM abstraction with an Anthropic adapter and three stubs, model routing, per-entity memory with seeded baselines and cheap evolution, the `LLMScorer` with anomaly awareness and rules fallback, usage logging with a per-tick call cap, narratives for meaningful moves.
- **Engine cron**: the 30-second heartbeat via Vercel Cron (two ticks per one-minute invocation with a time budget), one shared `runFullTick()` path, gated by `ENGINE_CRON_ENABLED`, which ships as `false`.

Deliberately not built yet: behavioral logging (Phase 5), the user trading flow (which will write `positions`, `transactions` and `trade_events` through RPCs), person profiles, feeds, portfolio pages, and any visual design. The heartbeat is wired but switched off.
