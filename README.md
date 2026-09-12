# Momentum Terminal

A social data terminal where users take **HIGH** or **LOW** positions on individual people. Each person has a continuously updating Momentum Score driven by their observable real-world data. Users profit when a score moves in their predicted direction; the platform is the sole counterparty. The scoring system is called **the Engine**; its five forces are **Gravity**, **Signals**, **Market Mood**, **Conviction** and **Trading Activity**.

> **Status: Phase 7 (metric connectors + auth gate) complete.** The whole app now sits behind a signed-in session while the test is closed (`lib/auth-gate.ts`, one file, removable in one step; robots disallowed, every response `noindex`). Four data sources are registered as data, not code — `youtube` (channel metrics and commentary volume), `youtube_comments`, `rss`, `spotify` — with MrBeast and Drake mapped; every metric a connector reads is snapshotted into a service-role-only raw table, differenced, normalised against the person's own trailing baseline (the same `lib/engine/baseline.ts` Trading Activity uses) and turned into a signal that carries **direction and sigma only**, never a level; a trigger on `signals` refuses anything more, and the metric scorer feeds the Signals force in the same units as a headline with an explicit per-metric polarity. Every poll and observation is logged; `/api/admin/health` reads per-source health and LLM cost per tick. On top of the scaffold, schema, auth, ingestion, the Engine, the LLM reasoning layer, the behavioral logging foundation, the editorial-monochrome shell, the live Home board, the person profile page and the Feed, **trading is live, on paper**: Buy opens a HIGH position at the server-read Buy quote, Sell closes it FIFO at the Sell quote, every amount is integer cents, and every order is one atomic RPC (`place_order()`) behind a tolerance band, the long-only gate and four inert risk levers. **`/portfolio` closes the loop**: total value, cash, unrealized and realized P&L, every open position marked at the Sell quote with its weighted-average entry, a value line recorded at every tick and every trade, and the full trade history with a keyset cursor — all computed by the database in integer cents, never by the browser; a close on the portfolio routes into the same 6e trade sheet. The paper balance starts at $10,000 and the close cooldown is 60 s (one full tick and more; policy pending). `/design` is the living reference. The 30-second heartbeat is wired (Vercel Cron → `/api/engine/cron`) but **switched off** by `ENGINE_CRON_ENABLED=false`, so until it runs every score sits at its seeded 50.0, every chart is honestly empty, every STATE reads Stable, every force reads idle, the Feed is quiet and the value line has only the points that orders record, and each surface says so. The profile screen, search results and the recommendation layer are later phases.

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
| `npm test`          | Vitest unit tests (connectors, ingestion, Engine, LLM layer, memory, narratives, behavioral logging, Home and profile models, design-token guard) |
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
| `YOUTUBE_API_KEY`                      | server only (ingestion)      | YouTube Data API v3 key for the `youtube` and `youtube_comments` connectors. Unset → both sources are inactive for the run, logged as skipped. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | server only (ingestion) | Spotify Web API client credentials (public artist data). Unset → the `spotify` source is inactive for the run. |
| `INGEST_SECRET`                        | server only (ingestion)      | Random string that authorises `/api/ingest` and `/api/admin/health`. Generate with `openssl rand -hex 32`. |
| `ENGINE_SECRET`                        | server only (Engine)         | Random string that authorises `/api/engine/tick` (and manual calls to `/api/engine/cron`). |
| `SCORER`                               | server only (Engine)         | `llm` (default) or `rules` — the instant fallback to the Phase 3 keyword scorer.        |
| `ENGINE_CRON_ENABLED`                  | server only (heartbeat)      | **The switch.** Only the exact string `true` lets `/api/engine/cron` tick; anything else (including unset) logs `skipped (disabled)` and returns. Default `false`. |
| `ENGINE_TRADING_MIN_POPULATED_WINDOWS` | server only (Engine), optional | Controlled-test override of the Trading Activity minimum-sample guard (`minPopulatedWindows`, code default **30**, unchanged). A positive integer lowers it deliberately for a small beta; anything else is ignored. The tick logs an active override. |
| `CRON_SECRET`                          | server only (heartbeat)      | Vercel's cron secret. Once set in the Vercel project, Vercel sends it as `Authorization: Bearer` on every scheduled call and the handler rejects anything else. |
| `LLM_PROVIDER`                         | server only (LLM)            | `anthropic` (default), `openai`, `gemini` or `openai-compatible`. One variable swaps vendors. |
| `LLM_MODEL`                            | server only (LLM)            | Model string for the active provider; empty = provider default (`claude-opus-5`).       |
| `ANTHROPIC_API_KEY`                    | server only (LLM)            | Anthropic Messages API key.                                                              |
| `LLM_MODEL_<TASK>`, `LLM_PROVIDER_<TASK>`, `LLM_EFFORT_<TASK>` | server only, optional | Per-task routing for `SENTIMENT`, `ANOMALY`, `NARRATIVE`, `MEMORY` (e.g. a cheap model for scoring). |

Reserved for later phases (listed as comments in the example file): `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `FINNHUB_API_KEY`, `NEWSDATA_KEY`, `RAPIDAPI_KEY`, `APISPORTS_KEY`.

Credentials come from the environment only: never from the repo, never from the bundle. A connector whose credentials are missing reports itself unavailable and its source is skipped for the run; nothing else is affected.

## Project structure

```
app/
  layout.tsx               root: fonts, metadata, viewport
  globals.css              Tailwind + base styles + the signature utilities (num, text-label, skeleton)
  styles/tokens.css        THE design tokens (colour, type, spacing, radius, shadow, motion)
  (app)/                   every product route, inside the shell
    layout.tsx             AppShell with the @rail parallel slot
    (home)/                Home: the live board, with its route-level loading skeleton
    person/[slug]/         the person page (slug resolved in the shell for a real 404; sections stream behind a skeleton) + not-found
    feed/                  the Feed (page, loading skeleton); its rail is a glance at the board
    portfolio/             the portfolio (page, loading skeleton; signed in only); its rail is the board glance
    profile/               placeholder page
    design/                living design-system reference
    @rail/                 per-route desktop rail content (Home, person, Feed and portfolio pages have one; the rest return null)
    error.tsx              error boundary for every page in the shell
  (auth)/                  login + signup pages (inside a minimal banner layout) and their Server Actions
  auth/callback/route.ts   email confirmation / magic-link landing
  account/page.tsx         redirects to /profile
  not-found.tsx            404, with the banner
  icon.png                 favicon (512px downscale of the brand mark)
  api/ingest/route.ts      ingestion runner endpoint (INGEST_SECRET; ?source=, ?force=1)
  api/admin/health/route.ts per-source health, recent runs, LLM cost per tick (INGEST_SECRET or ENGINE_SECRET)
  api/engine/tick/route.ts Engine tick endpoint (ENGINE_SECRET, ?dryRun=1)
  api/engine/cron/route.ts the heartbeat: Vercel Cron target, gated by ENGINE_CRON_ENABLED
  api/behavioral/log/route.ts client-side behavioral logging (cookie auth, batched, RLS-scoped insert)
  api/trade/order/route.ts the one way an order reaches place_order() (cookie auth)
  api/portfolio/live/route.ts the portfolio's tick poll: the summary as computed now + new value points (cookie auth)
  api/portfolio/history/route.ts the next page of the trade history, keyset cursor (cookie auth)
components/
  ui/                      the primitives: Button, Card, Badge, Avatar, ScoreDisplay, DirectionIndicator,
                           CountdownTimer, Skeleton*, Input/Field, Sheet, PageHeader, PhaseNotice, LocalTime
  shell/                   AppShell, TopBanner (+ BalanceChip), DesktopNav, BottomNav, RightRail, PulseIndicator, SearchButton, ProfileButton
  home/                    PersonCard + PersonRow, Sparkline, CategoryFilter, PeopleBoard, FeedPreview, impression logging
  person/                  Dossier, ScorePanel (+ ScoreChart, RangeToggle), ForcesPanel, SignalsList, TradeBar / TradeActions, BackLink, profile logging
  feed/                    FeedStream, FeedEntry, FeedEmpty, BoardGlance (the rail), feed logging (impressions, dwell, scroll depth)
  trade/                   TradeSheet (compose → confirm → result), PositionCard, Money
  portfolio/               PortfolioView, SummaryStrip, ValueChart, PositionsList, TradeHistory, PortfolioEmpty, live poll + logging hooks
  charts/live-line-chart.tsx THE live line: cadence-locked breath, tick reveal, reduced motion; ScoreChart and ValueChart are it with different rules
  engine/engine-clock.ts   shared 30-second Engine clock (useEngineClock)
  engine/use-tick-polling.ts polling on the Engine's cadence, shared by the profile and the portfolio
  brand/momentum-mark.tsx  renders public/brand/momentum-mark.png (the brand asset, unmodified) + wordmark
  auth/                    LoginForm, SignupForm, SignOutButton, FormError
docs/design-system.md      how to change the look; token, component and shell reference
lib/
  fonts.ts                 Inter + JetBrains Mono via next/font (self-hosted)
  cn.ts                    class-name composer (clsx + tailwind-merge)
  env.ts                   environment variable access
  api-auth.ts              constant-time shared-secret check for internal endpoints
  supabase.ts              typed browser client
  supabase-server.ts       typed cookie-based server client
  supabase-admin.ts        typed service-role client (server only, bypasses RLS)
  supabase-proxy.ts        session refresh (resolveSession) + route rules (applyRouteRules) used by proxy.ts
  auth-gate.ts             THE AUTH GATE: the whole app behind a session while the test is closed; one file, one call, removable in one step
  auth.ts                  getCurrentUser, getCurrentSession, getCurrentProfile, requireUser
  money.ts, format.ts      integer-cents and headline number formatting
  connectors/              DataConnector interface (events + metrics + availability), registry; youtube, youtube-comments, rss, spotify implemented; 6 stubs
  ingest/                  runIngestion(), the metric pipeline (metrics.ts: config, observation, derivation, the signal), IngestStore (Supabase + in-memory)
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
    narratives.ts          narratives for meaningful moves (LLM sentence reuse or templates), each with the signals that produced it
    post-tick.ts           after a persisted tick: narratives + memory updates (never fail the tick)
    forces/                gravity, signals, market-mood, conviction, trading-activity
    inverse-pairs.ts       second-pass inverse-pair adjustments
    spread.ts              LMSR dynamic spread, Buy / Sell prices
    tick.ts                runEngineTick(): the orchestrator
    run-tick.ts            runFullTick(): the ONE production tick path (store + scorer + post-tick)
    cron.ts                heartbeat scheduling (two ticks per invocation, time budget) + cron auth
    store.ts               EngineStore (Supabase via apply_engine_tick RPC + in-memory)
  behavioral/
    events.ts              BEHAVIORAL_EVENT_TYPES, per-type metadata contracts, validation (isomorphic)
    core.ts                prepare / write / HTTP contract of the log route, stores, rate limiter (pure)
    log.ts                 server-side logEvent, logEvents, logEventInBackground (server only)
    client.ts              browser trackEvent, startDwell, flushBehavioralEvents (batched queue)
    session.ts             mt_bsid browsing-session cookie: tracker + server-side reader
    queries.ts             read side for the future recommender (service role only)
  home/
    board.ts               Home's server reads: the board and the feed preview (service role)
    board-model.ts         pure ranking, mover selection and category options
    relative-time.ts       compact "3m" / "2h" feed stamps
  person/
    profile.ts             the person page's server reads: person, chart series, forces, signals (service role, per-request cached)
    profile-model.ts       pure rules: ranges, period change, the STATE threshold, CONVICTION bands, force readings, signal merge
  feed/
    feed.ts                the Feed's server reads: a page of entries, the roster (service role)
    feed-model.ts          pure rules: the entry, the Engine's framing of a raw signal, HIGH_IMPACT_THRESHOLD and the pinned selection, filtering, paging
    ranking.ts             THE ORDERING SWAP POINT: chronological now, a personalised ranker plugs in here later
  trading/
    model.ts               Cents / Points branded types, POINT_CENTS, pointsToCents, the constants mirror, order / position / quote shapes, previews
    direction.ts           the netting rule mirror of resolve_position_order() (6c+)
    settings.ts            platform_settings: the gate, the tolerance band, the four risk levers (server)
    server.ts              getMyPosition, getWalletBalanceCents, placeOrderAsUser: the RPCs as the signed-in user (server)
    trading.db.test.ts     the trading SQL against PGlite: money types, tolerance, FIFO, basis, gate both ways, levers, atomicity, rounding
    trading.concurrency.test.ts  concurrent orders on a real multi-connection server
  portfolio/
    model.ts               the summary, position, history and value-series shapes; parsing only, no arithmetic; the chart floor; the page's three states
    server.ts              getMyPortfolio, getMyValueSeries, getMyTradeHistory, getMyValuePointsAfter: the RPCs as the signed-in user (server)
    portfolio.db.test.ts   the portfolio SQL against PGlite: reconciliation to the cent, realized from close records, the basis and rounding, recorded value history, keyset history across identical timestamps
  __tests__/
    migrations.ts          the migrations in order + the Supabase stubs every database harness shares
    pglite.ts              Postgres in WebAssembly, one session, fast
    postgres.ts            embedded-postgres: a real server on a free port, for concurrency
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
| `20260907002303_source_snapshots.sql`      | `source_snapshots` table + RLS (renamed `raw_source_snapshots` and closed to users in Phase 7), `signals.occurred_at`, `signals.dedupe_key` |
| `20260907002801_seed_rss_data_source.sql`  | Registers the inactive `rss` data source                                                     |
| `20260907143920_engine_tables.sql`         | `people.last_tick_at` + generated `buy_price`/`sell_price`, `engine_ticks`, `score_events`, `trade_events`, `apply_engine_tick()` |
| `20260907195432_behavioral_logging_foundation.sql` | `behavioral_events.session_id`, format-only `event_type` check, metadata check, recommender indexes, column-level insert grant, three service-role-only aggregate functions |
| `20260908114758_home_board_reads.sql`      | `home_momentum()` (per-person change + sparkline over a trailing window), `signals`/`narratives` newest-first indexes for the feed rail |
| `20260909010607_person_profile_reads.sql`  | `person_score_series()` (one person's history since a point in time, downsampled by time into bounded slices with open / close / tick count) for the profile chart |
| `20260910172052_position_direction_gating.sql` | `platform_settings` (one row, `shorting_enabled` default false), `shorting_enabled()`, `net_position_cents()`, the pure `resolve_position_order()` netting rule, the service-role `assert_position_direction()` guard, and the `positions_enforce_direction` trigger |
| `20260910181957_feed_reads.sql`            | `feed_entries()`: narratives and the signals no narrative explains, across all active people, newest first with keyset pagination on `(occurred_at, id)` (its tick-window evidence join was replaced in the next migration) |
| `20260911200110_trading_flow.sql`          | `starting_balance_cents()` and the signup trigger on it; the tolerance band and four risk levers on `platform_settings`; `positions` become integer lots (`units`, `open_units`, `entry_price_cents`); `trade_orders`, `position_closes`, `transactions.order_id`; `net_position_units()`, `points_to_cents()`, `trade_quote()`, `position_summary_for()` / `my_position()`; **`place_order()`**; `reset_paper_balance()` |
| `20260910191918_narrative_signals.sql`     | `narrative_signals` (narrative ↔ signal, many-to-many, `relation` direct / inverse_pair) with the `narrative_signals_enforce_person` integrity trigger, the service-role `record_narratives()` write path (sentence and links in one transaction), and `feed_entries()` rewritten to read evidence from the link only — no tick-window inference, no fallback |
| `20260912153309_portfolio.sql`             | Part 0: `close_cooldown_seconds` → 60 (policy floor: one full tick), `starting_balance_cents()` → 1,000,000, service-role `credit_paper_balance()`; `portfolio_history` gains `tick_number` / `order_id` and is written by `record_portfolio_snapshot()` (a trigger after every order) and `snapshot_portfolios()` (inside `apply_engine_tick()` at every tick); `portfolio_value_cents()`; **`portfolio_summary_for()` / `my_portfolio()`**, `portfolio_value_series_for()` / `my_portfolio_value_series()`, `trade_history_for()` / `my_trade_history()` (keyset on `(created_at, id)`) |
| `20260907153228_llm_memory_narratives.sql` | `person_memory` (+ 16 seeded profiles), `llm_usage`, `narratives`, with RLS                  |
| `20260912211216_phase7_metric_connectors.sql` | `source_snapshots` → **`raw_source_snapshots`** (read policy dropped, service role only); `raw_metric_observations`, `ingest_runs`, `source_polls` (all service role only); the `source_health` and `llm_cost_per_tick` views; `llm_model_prices`; the `signals_enforce_metric_privacy` trigger; the registry rows for `youtube`, `youtube_comments`, `rss`, `spotify` with their metric declarations, and the MrBeast / Drake mappings |

All of these are applied to the `Momentum Terminal` Supabase project and recorded under the same versions, so `npm run db:push` treats them as applied and only pushes new files. To add a migration: create `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, run `npm run db:push`, then `npm run db:types`.

### Tables

| Table                 | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `users`               | Profile + wallet for each `auth.users` row                                                    |
| `people`              | Each tracked individual: `current_score`, `revert_target`, `spread`, generated `buy_price` / `sell_price`, `last_tick_at` |
| `data_sources`        | Pluggable registry of external feeds (`is_active` switches a connector on)                    |
| `person_data_sources` | Which sources feed which person, with the external identifier                                 |
| `inverse_pairs`       | Unordered pairs whose scores move against each other (with `dampening`)                       |
| `positions`           | A user's lots: `direction`, `units`, `open_units`, `entry_price_cents` (server snapshot), `amount_cents` = cost; FIFO closes reduce `open_units` |
| `trade_orders`        | Every accepted order: side, units, the price it filled at, how it split into units opened / closed, realized P&L, balance after |
| `position_closes`     | Realized P&L, one row per lot touched by a close (FIFO), with the arithmetic enforced by check   |
| `transactions`        | Wallet ledger (`DEPOSIT`, `ALLOCATION`, `REDEMPTION`, `WITHDRAWAL`), each with its `order_id`   |
| `signals`             | Raw data points from connectors; the Engine writes `impact_score`, sentiment and `processed`  |
| `raw_source_snapshots` | **RAW** metric levels as connectors read them (a subscriber count, a follower total, a popularity index), one row per poll. Service role only; no user-facing surface reads it |
| `raw_metric_observations` | **RAW**: every metric reading judged against the person's own baseline: level, previous, delta, mean, sd, sigma, outcome, the signal it produced. Service role only |
| `ingest_runs`, `source_polls` | Every ingestion run, and every poll of a source for a person (ok / error / skipped with the reason, latency, what it produced). Service role only |
| `llm_model_prices`    | USD per million tokens by model, for the `llm_cost_per_tick` view. Service role only            |
| `score_history`       | One row per person per tick (`tick_number`, `score`)                                          |
| `engine_ticks`        | One row per Engine tick: timing, counts, market mood, summary                                 |
| `score_events`        | Per-force audit trail (`force`, `impact`, `details`); zero-impact entries are never written   |
| `trade_events`        | Live Buy/Sell tape read by Trading Activity; one row per filled order, notional in cents      |
| `person_memory`       | Per-person profile, baseline patterns and rolling recent context used by the LLM scorer       |
| `llm_usage`           | One row per LLM call: provider, model, task, input/output/cache tokens, latency, person, tick  |
| `narratives`          | The Engine's one-sentence explanation of a meaningful move (`source` = llm or template)       |
| `portfolio_history`   | Recorded total portfolio value per user (cash + open positions at their closing quotes), one row per tick for each user holding a position and one after each order, with the `tick_number` or `order_id` it came from. Never interpolated |
| `behavioral_events`   | Append-only interaction log with `session_id`; canonical `event_type` list lives in code       |
| `platform_settings`   | One row of platform-wide switches and tunables: `shorting_enabled` (default false), `price_tolerance_cents`, the four risk levers. Service-role write only |

### Row level security

RLS is enabled on every table. The `anon` role has no policies anywhere.

| Tables                                                                                                                                              | Authenticated users                                                          | Service role       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `users`                                                                                                                                             | read own row; update own `username`, `display_name`, `avatar_url` only       | full               |
| `positions`, `transactions`, `portfolio_history`, `trade_orders`, `position_closes`                                                                | read own rows only                                                           | full (only writer) |
| `trade_events`                                                                                                                                      | read own rows only                                                           | full (only writer) |
| `behavioral_events`                                                                                                                                 | read own; insert own (`user_id, event_type, person_id, metadata, session_id` only); no update/delete | full               |
| `people`, `data_sources`, `person_data_sources`, `inverse_pairs`, `score_history`, `signals`, `engine_ticks`, `score_events`, `person_memory`, `narratives` | read all                                                | full (only writer) |
| `llm_usage`, `llm_model_prices`, **`raw_source_snapshots`**, **`raw_metric_observations`**, `ingest_runs`, `source_polls`, and the `source_health` / `llm_cost_per_tick` views | no access (no grant, no policy; a test asserts no function or view they can reach references the raw tables) | full (only writer) |
| `platform_settings`                                                                                                                                 | read                                                                         | full (only writer) |

### Financial writes

Clients never write money. Every write to `positions`, `transactions`, `portfolio_history`, `trade_events` and to `users.wallet_balance_cents` / `users.buying_power_cents` goes through exactly one of:

1. **Trusted server code** using the service-role client (`lib/supabase-admin.ts`): the Engine tick, cron jobs, admin tooling.
2. **A `SECURITY DEFINER` function (RPC)** that runs with an empty `search_path`, derives the actor from `auth.uid()`, validates every input, performs all related writes in one transaction, and is granted to `authenticated` explicitly.

`place_order(...)` (Phase 6e) is the trading RPC built on that template: granted to `authenticated`, actor from `auth.uid()`, every check before any write, one transaction. `reset_paper_balance(user)`, `credit_paper_balance(user, cents)` (the 6f top-up path, through the ledger), `position_summary_for(user, person)`, `portfolio_summary_for(user)`, `portfolio_value_series_for(user, …)` and `trade_history_for(user, …)` are service-role only; their `my_*` wrappers bind them to `auth.uid()` for `authenticated`. `portfolio_history` is written only by `record_portfolio_snapshot()` (the `trade_orders_snapshot_portfolio` trigger) and `snapshot_portfolios()` (inside the tick). `placeholder_financial_mutation(p_amount_cents)` remains as the documented shape. `apply_engine_tick(jsonb)` is the Engine's own atomic write path and is executable by the service role only.

## Authentication

- **Signup** (`/signup`): the Server Action validates the input, pre-checks the username through the `username_available()` RPC, then calls `supabase.auth.signUp` with `username` and `display_name` in the user metadata. The `on_auth_user_created` trigger inserts the `public.users` row with the $10,000 paper balance (`starting_balance_cents()`) and a matching `DEPOSIT` transaction.
- **Login** (`/login`): `signInWithPassword`, then redirect to `next` (defaults to `/account`). Email confirmation links land on `/auth/callback`.
- `proxy.ts` refreshes expired sessions on every request (`resolveSession`), then applies **the auth gate** (`lib/auth-gate.ts`, Phase 7): while the test is closed, a signed-out request to any page is redirected to `/login?next=…`, a signed-out call to any API route gets `401` JSON (never a redirect), `/login`, `/signup`, `/auth/*` and static assets stay reachable, the shared-secret routes (`/api/ingest`, `/api/engine/*`, `/api/admin/*`) are left to their own check, `/robots.txt` is `Disallow: /`, and every response carries `X-Robots-Tag: noindex, nofollow, noarchive`. The gate is one file with one call site; a test asserts nothing else imports it, so reopening the app is deleting the file and restoring one line, after which the per-route rules in `lib/supabase-proxy.ts` (`/account`, `/portfolio`, `/profile` need a session; `/login`, `/signup` need none) keep working.
- Use `getCurrentUser()` / `requireUser()` from `lib/auth.ts` in server code for anything that depends on identity.

Set the Supabase Auth **Site URL** and **Redirect URLs** (Authentication → URL Configuration) to include your local and Vercel origins plus `/auth/callback`.

## Data ingestion

Connectors under `lib/connectors/` implement `DataConnector` and are registered by `data_sources.name`. A connector produces **events** (`fetchForPerson → RawSignal[]`: news items, comments, real text the sentiment scorer reads), **metrics** (`fetchMetrics → MetricReading[]`: raw levels the runner normalises before anything sees them), or both, and may report `available()` (credentials present or not). `youtube` (channel metrics and commentary volume), `youtube_comments` (viewer comments), `rss` (a person-scoped feed: articles and news volume) and `spotify` (popularity and followers) are implemented; `twitch`, `forbes`, `finnhub`, `newsdata`, `billboard` and `apisports` are interface-compliant stubs.

A **source** is a `data_sources` row (tier, poll interval, and the metric declarations in `config`) plus its credentials in the environment; a connector is only the code that can talk to that kind of upstream. Adding a source is inserting the row and mapping people in `person_data_sources`; removing one is flipping `is_active`. No code names a source. The runner (`lib/ingest/runner.ts`) reads the active sources, skips the ones whose connector is unavailable (missing credentials) or was polled within `poll_interval_minutes`, calls each connector per mapped person, stores events with `processed = false` (dedupe keys prevent duplicates), and runs every metric reading through the pipeline in [Metric connectors and the privacy rule](#metric-connectors-and-the-privacy-rule-phase-7). Every run, poll and observation is recorded.

```bash
# every active source that is due; add ?force=1 to poll regardless of the interval, ?source=youtube to narrow
curl -X POST -H "x-ingest-secret: $INGEST_SECRET" "https://<host>/api/ingest?force=1"
# per-source health, recent runs, LLM cost per tick
curl -H "x-ingest-secret: $INGEST_SECRET" "https://<host>/api/admin/health"
```

The registry as shipped: MrBeast ↔ `youtube`, `youtube_comments` (`UCX6OQ3DkcsbYNE6H8uQQuVA`) and `rss` (a Google News query for his name); Drake ↔ `rss` and `spotify` (`3TVXtAsR1Inumwj472S9r4`). All four sources are active; the credentialed ones run once their keys are set.

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
| **Trading Activity** | flow score = net Buy−Sell flow in the last 60 s / `max_allocation_cents` (clamped ±1); **baseline** = the same score for every 60 s window over the trailing **24 h** (`baselineHours`); deviation = flow score − baseline mean; a deadband at **1.0 σ** (`thresholdStdDevs`) of the baseline sd, which is floored at **0.01** (`sdFloor`); outside the band adjustment = deviation · 0.25 (`weight`), inside it deviation · 0.25 · 0.25 (`inBandScale`) but never smaller in magnitude than **0.01** (`inBandMinImpact`, signed by the deviation, so normal trading reads alive rather than idle); × 0.4 when no signal confirms the move, capped ±0.30, skipped below 15 % concentration, and **0 with "insufficient baseline" until 30 windows** (`minPopulatedWindows`) in the trailing day have seen a trade. Baseline-relative so that long-only flow (which can only be ≥ 0) is not a permanent lift: steady inflow is the baseline, a burst above it lifts, a lull below it lowers. Unchanged when shorting is enabled. | 0 (no trades) |

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
select slug, current_score, spread, buy_price, sell_price, last_tick_at from public.people order by current_score desc, id;
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

## Behavioral logging (Phase 5)

The collection layer for a future recommendation algorithm ("For You"). It records what users do so the algorithm has data to learn from; the algorithm itself, its ranking and any feed UI are deliberately not built.

### The table

`behavioral_events` is one row per interaction: `id`, `user_id`, `event_type`, `person_id` (nullable), `metadata` (jsonb object), `session_id` (uuid, nullable), `created_at`.

- `event_type` is checked by **format only** (`^[a-z][a-z0-9_]{1,63}$`). The canonical list is `BEHAVIORAL_EVENT_TYPES` in `lib/behavioral/events.ts`, enforced by the logging service, so adding a type is a code change with no migration.
- `metadata` must be a JSON object of at most 8 KiB (the service caps it at 4 KiB, 32 keys, depth 3, 512-character strings).
- `session_id` groups events into browsing sessions for sequence features.
- Indexes: `(user_id, created_at)`, `(person_id, event_type, created_at)`, `(event_type, created_at)` and a partial `(session_id, created_at)`.
- `id` and `created_at` are always set by the database: the client insert grant covers only `user_id, event_type, person_id, metadata, session_id`, so nobody can choose ids or backdate events.

### Event vocabulary

| `eventType`       | `personId` | `metadata`                                                              |
| ----------------- | ---------- | ----------------------------------------------------------------------- |
| `view_person`     | required   | `{ source?: string }` (feed, search, swipe, profile_link, …)            |
| `time_spent`      | optional   | `{ duration_ms: number, surface?: string }` (coalesced client-side; without a `personId` a non-empty `surface` is required — the portfolio's dwell) |
| `expand_signal`   | required   | `{ signal_id?: uuid, headline?: string }`                               |
| `take_position`   | required   | `{ direction: "HIGH" \| "LOW", amount_cents: integer, position_id?: uuid, units?, price_cents?, order_id?, surface? }` (server-side, on a fill that opened units) |
| `close_position`  | required   | `{ position_id?: uuid, direction?, amount_cents?, pnl_cents?, units?, price_cents?, order_id?, surface? }` (server-side, on a fill that closed units) |
| `follow_person`   | required   | `{}`                                                                    |
| `unfollow_person` | required   | `{}`                                                                    |
| `search`          | optional   | `{ query: string, result_count?: integer }`                             |
| `view_feed`       | optional   | `{ feed?: string }` (home, trending, for_you, …)                        |
| `swipe`           | required   | `{ action: "left" \| "right" \| "up" \| "down" }`                       |
| `change_range`    | required   | `{ range: string, surface?: string }` (1h, 24h, 7d, all — the profile chart) |
| `view_entry`      | required   | `{ entry_id: string, kind: "narrative" \| "signal", feed?: string, position?: integer, pinned?: boolean }` (a feed entry came into view) |
| `scroll_depth`    | optional   | `{ feed: string, depth_pct: integer 0..100, entries_seen?: integer }` (logged at 25 / 50 / 75 / 100 % and on leaving) |
| `filter_change`   | optional   | `{ surface: string, filter: string, value: string }`                    |
| `open_trade_sheet` | required  | `{ side: "BUY" \| "SELL", surface?: string }`                           |
| `abandon_trade_sheet` | required | `{ side, step: "compose" \| "confirm" \| "result", units?: integer, surface? }` (closed without a fill) |
| `reject_trade`    | required   | `{ side, code: string, units?: integer, surface? }` (the server refused: price moved, a limit hit, …) |
| `view_portfolio`  | optional   | `{ positions?: integer, orders?: integer }` (what the portfolio showed on arrival) |

`validateBehavioralEvent()` enforces all of this (and normalises: uppercase direction, trimmed query, lowercase swipe action, range and entry kind, rounded and clamped duration). All money is integer cents, as everywhere else. `time_spent` events are coalesced client-side per person, surface and `entry_id`, so two feed entries about the same person keep separate dwells.

### Logging from server code

```ts
import { logEventInBackground } from "@/lib/behavioral/log";

// inside a Server Action or Route Handler, after the real work succeeded:
logEventInBackground({ eventType: "take_position", personId, metadata: { direction: "HIGH", amount_cents: 5000 } });
```

`logEventInBackground` defers the write with Next's `after()`, so it runs once the response has been sent and adds nothing to the user's wait. `logEvent` / `logEvents` are the awaitable forms (they resolve to `{ accepted, dropped, error? }` and never reject). All three take the user from the verified auth session, the browsing session from the `mt_bsid` cookie, and insert through the user's own RLS-scoped client, so a row can only ever belong to the caller. Not signed in, invalid event, database down: the action proceeds and the event is dropped (with a `[behavioral]` warning in the server log).

### Logging from the browser

```ts
import { trackEvent, startDwell } from "@/lib/behavioral/client";

trackEvent({ eventType: "view_person", personId, metadata: { source: "feed" } });
trackEvent({ eventType: "search", metadata: { query, result_count: results.length } });

// dwell time, in a Client Component:
useEffect(() => startDwell({ personId, surface: "profile" }), [personId]);
```

`trackEvent` validates, queues and returns immediately. The queue posts to `POST /api/behavioral/log` after a 2-second lull, once 20 events are pending, or when the tab is hidden or unloaded (`sendBeacon` / `fetch keepalive`, so the request outlives the page). Pending `time_spent` events for the same person are merged into one. The queue holds at most 200 events (oldest dropped), each request carries at most 50, and the route also caps body size (128 KiB) and requests per user per minute (120, per server instance). Nothing throws and no call awaits the network; on the server the functions are no-ops.

The route reads the user from the auth cookies via `getClaims()`, ignores any user id in the body, and inserts through the caller's RLS-scoped client. It responds with `{ accepted, dropped: [{ index, reason }] }`; `401` when signed out, `400` for malformed JSON, `413` / `429` for the caps, `500` when storage failed (the client just drops the batch).

### Sessions

The client mints a v4 UUID and keeps it in a plain session cookie, `mt_bsid`, as `<uuid>.<lastActiveMs>`. It dies with the browser, rolls over after 30 minutes of inactivity, is shared across tabs, and is readable by Server Actions, so a trade logged server-side lands in the same session as the clicks that led to it without the client passing anything. It authorises nothing; it is only a grouping key. This was chosen over `sessionStorage` (per tab, invisible to the server) and over a server-issued token (extra round trip and server state for no gain). Call `resetBehavioralSession()` on sign-out.

### Read side (foundation for the recommender)

`lib/behavioral/queries.ts` is the data-access layer the algorithm will sit on. Every function takes a `SupabaseAdminClient` (the branded service-role client from `lib/supabase-admin.ts`) and calls SQL aggregates whose `EXECUTE` is granted to `service_role` only:

- `getUserInteractionHistory(admin, userId, { since?, eventTypes?, recentLimit? })` → totals per event type, a per-person summary (views, dwell, expands, positions, follows, swipes, first/last interaction) sorted by recency, and the raw recent events for sequence features.
- `getPersonEngagement(admin, personId, { since? })` → total events, exact distinct users overall and per type, dwell, HIGH/LOW split, swipe split, net follows.
- `getCoEngagementPairs(admin, { since?, eventTypes?, minSharedUsers?, limit? })` → pairs of people engaged by the same users, with per-person audience sizes and a Jaccard overlap: the raw material for "users who traded A also traded B".

The default window is 90 days. Only canonical event types are counted.

### Privacy and integrity

- Append-only: clients can insert and read their own rows and nothing else (no update, no delete).
- A user can only insert as themselves (`behavioral_events_insert_own`), enforced by RLS regardless of what the application sends; anon has no access at all.
- Reading anyone else's behavior requires the service role: RLS hides other users' rows and the aggregate functions refuse `authenticated`.
- Verified on the live project under simulated roles: own inserts succeed; inserts as another user, malformed types, array metadata, client-chosen `id` / `created_at`, updates, deletes, anon access and user calls to the aggregate functions are all rejected.
- This data exists for personalisation. Retention, export and deletion must follow whatever privacy policy the platform adopts; deleting an account already cascades to its events.

## Design system and app shell (Phase 6a)

The visual foundation every screen inherits, plus the navigation frame. Full reference: [`docs/design-system.md`](docs/design-system.md).

### Tokens

Every visual value lives in **`app/styles/tokens.css`** as a Tailwind 4 `@theme` block: semantic colours (`canvas`, `surface*`, `line*`, `fg*`, `positive`, `negative`, `neutral`, `accent`), the two typefaces, a type scale, the spacing base plus the shell's structural sizes (`banner`, `tabbar`, `rail`, `shell`, `touch`), radii, shadows (glows derive from the semantic colours) and motion. Tailwind's stock palette, fonts, radii and shadows are reset, so `bg-red-500` does not exist; components can only use tokens. Changing a token is a one-line edit that cascades platform-wide, and `lib/__tests__/design-tokens.test.ts` fails the build if a component ever hardcodes a colour, pixel size or arbitrary value.

The look is editorial monochrome: a jet-black ground, neutral grey cards with no borders, white type with a strong hierarchy, generous space. Green and red are the only saturated colours and appear only on Buy / Sell and directional score movement; navigation, focus, status and the timer are white or grey. Inter carries the interface; JetBrains Mono appears only on numbers, through the `num` utility. Both fonts are self-hosted through `next/font`.

Two signature utilities are defined once in `globals.css`: `num` (mono, tabular figures) for every number and `text-label` (small uppercase section caption) for section headers.

### Components (`components/ui`)

Button (`primary`, `buy`, `sell`, `outline`, `ghost`), Card, Badge, Avatar, **ScoreDisplay** (the signature number: bright integer, quiet decimal, direction read at the baseline), DirectionIndicator (heating / cooling / flat), **CountdownTimer**, Skeleton family, Input + Field, Sheet (modal), PageHeader, PhaseNotice. `/design` renders all of them with sample values.

### The shell

- **Top banner**, fixed on every page and modal: the orbital mark, desktop navigation (active item white), the Mood pill (on standby until the heartbeat is on), the **30-second countdown to the next Engine tick** as quiet mono digits over a hairline that fills, search (`⌘K`) and profile. Ticks are aligned to wall-clock multiples of 30 s, the cron's cadence, so the countdown is deterministic and identical on every client (`components/engine/engine-clock.ts`).
- **Bottom tab bar** on mobile: four icons for Home, Portfolio, Feed, Profile, the active one white.
- **Desktop two-panel layout**: main column plus a sticky right rail. A route provides rail content through the `@rail` parallel slot in `app/(app)`; Home does (the live feed lands there in 6b), the others render none and the column takes the full width.
- Sheets open **below** the banner, so the timer stays visible above any modal.

### Routes

`/` Home, `/portfolio`, `/feed`, `/profile` (signed in), `/person/[slug]`, `/design`, plus `/login`, `/signup`, `/account` (redirects to `/profile`). All are styled placeholders with skeletons and a "Phase 6x" notice where real content lands.

## Home (Phase 6b)

The discovery surface, and the first screen reading live data.

### What it shows

- **Top movers** — four featured cards: the biggest absolute score moves over the trailing hour. Before the Engine has ticked nobody has moved, so the section becomes **Leading the board** with an *Awaiting first tick* badge and simply shows the top of the ranking.
- **People** — every active person as a ranked row: position, avatar, name, category, sparkline, score and direction.
- **Category filter** — All / Executive / Creator / Musician / Athlete / Founder, derived from the `people` rows and counted. Filtering is instant: the server sends all 16 and the client only chooses which to show. The featured row follows the filter, while rank numbers stay board-wide.
- **Live feed rail** (desktop, ≥ lg) — the newest Engine narratives and raw signals merged newest first, each linking to its person, with a *Nothing in the Feed yet* empty state.

Colour discipline holds: the score is white, the sparkline grey, and only the direction indicator is ever green or red. A person with no history yet shows a bare `—` rather than an arrow, because there is no measurement to point anywhere.

### Data

`lib/home/board.ts` reads on the server through the **service-role client**. `people` and friends are readable by signed-in users under RLS and carry no per-user data, but Home is public — a signed-out visitor using the publishable key would see nothing, since anon has no policies anywhere. Reading in trusted server code keeps the board public without granting anon a blanket read on the schema.

Movement comes from `home_momentum()` (see the migration table): per person, the change over a trailing window plus a downsampled sparkline, computed in Postgres so the page never pulls a growing history table over the network. A person with no rows in the window is treated as *no movement yet*, not as a change of zero.

`lib/home/board-model.ts` holds the pure half — ranking, mover selection, category options — so it is unit-tested without any I/O. Ranking is score descending, then name, which keeps the order stable while every score is tied at 50.0.

### Behavioural logging

Wired to the Phase 5 client, fire-and-forget:

| Event | When |
| --- | --- |
| `view_feed` | Home mounts (`{ feed: "home" }`) |
| `view_person` | a card scrolls at least halfway into view, once per person (`{ source: "home" }`) |
| `view_person` | a card is tapped (`{ source: "home_tap" }`) — the intentional click, distinct from the impression |
| `time_spent` | for as long as a card stays visible; the client queue coalesces per person, so scrolling up and back down costs one row |
| `search` | a query in the search sheet settles for 700 ms |

Logging is skipped entirely when nobody is signed in, since the log endpoint would reject those events anyway.

## Person profile (Phase 6c)

`/person/[slug]` — the page every Home card routes to. Desktop is two panels (identity, score and history, the five forces in the main column; signals in the right rail); mobile is one column in the same order with the signals last and Buy / Sell fixed above the tab bar.

An unknown slug is a real HTTP 404 inside the shell. The slug is resolved before anything streams (Home's `loading.tsx` therefore lives in its own `(home)` route group rather than above every page, since a `notFound()` thrown inside a Suspense boundary can only ever be a 200); the readings behind the sections then stream in behind a skeleton of the page's own shape.

### What it shows

- **Identity** — a labelled dossier grid: small grey uppercase label, large white value, hairline rules. NAME (the largest value after the score), CATEGORY, TRACKED SINCE (`people.created_at`), STATE and CONVICTION, with the avatar alongside (monogram when there is no image). REGION is not shown: `people` has no such column, and the page invents nothing. Every label describes market or score state; the only coloured value is STATE, and only because it reads direction.
- **Momentum score** — the score in large monospaced numerals; beneath it the change over the selected range in points and percent, coloured by direction; the gravity target (`revert_target`), spread, and the Buy / Sell quotes in small type.
- **Score history** — one thin white line, a recessive grid, a single score axis, three time marks, the gravity target as a faint dashed reference (or a note that it sits above / below the visible range), and a crosshair with the exact score and time on hover or touch. Ranges are 1H / 24H / 7D / ALL; a range with fewer than two slices of history is disabled, never drawn flat. A gap between ticks wider than three slices breaks the line, so a pause in the Engine reads as a pause. No history at all is an empty state that says so.
- **The five forces** — Gravity, Signals, Market Mood, Conviction, Trading Activity, each with what it measures and the points it contributed on the person's **latest tick**, as a diverging bar from a centre line. A force with no row on that tick did nothing and reads 0.00; before the first tick every force is present and marked *Idle*.
- **Signals** — the person's signals and Engine narratives merged newest first: source (data source name, or *The Engine*), age, headline, and the recorded score impact where there is one. Tapping an item opens its detail (exact time, sentiment and confidence, score before → after for a narrative). Read-only, with a real empty state.
- **Buy / Sell** — Buy is the light pill (near-white, black label), Sell the dark pill (near-black, white label), each showing the current quote. Monochrome: direction colour stays on the change figures. Tapping shows a one-line note that trading opens with Phase 6e and does nothing else.

### The STATE threshold

`STATE_RULE` in `lib/person/profile-model.ts`: over the **trailing 24 hours** of `score_history`, a person is **Heating** when at least **10 ticks** were recorded and the score rose by **≥ 1.0 point** from the first of those ticks to the last, **Cooling** when it fell by ≥ 1.0, and **Stable** otherwise — including when fewer than ten ticks exist, and when there is no history at all. The caption under the value says which case applies (the 24h change, or how many ticks exist against the ten needed). With the Engine dormant every person reads Stable, which is the honest reading.

### CONVICTION

Read from the Conviction force on the latest tick, using the concentration the Engine recorded (open capital on the person over their allocation cap): **Low** at or below 60 %, **Moderate** to 85 %, **High** above — the same bands as `DEFAULT_ENGINE_CONFIG.conviction`, pinned by a test. A ticked person with no Conviction row is Low (the force writes no row when it is zero); before the first tick the value is `—`.

### Data

`lib/person/profile.ts` reads on the server through the service-role client, for the same reason Home does (the page is public; anon has no policies). Per request: the `people` row by slug; `person_score_series()` once per range (time-bucketed in Postgres, so a week of two-ticks-a-minute history is 168 rows, not 20 000); the newest `score_history` row for the latest tick number; that tick's `score_events`; and the newest `signals` and `narratives`. Everything is wrapped in React `cache()`, so the page, its metadata and the rail share one set of queries.

### Behavioural logging

| Event | When |
| --- | --- |
| `view_person` | the page mounts (`{ source: "profile" }`) |
| `time_spent` | the dwell on the page, paused while the tab is hidden, closed on leaving (`{ surface: "profile" }`) |
| `change_range` | the chart range is switched (`{ range, surface: "profile" }`) |
| `expand_signal` | a signal or narrative is opened (`{ signal_id?, headline, kind, surface }`) |

As on Home, everything is fire-and-forget and skipped entirely when nobody is signed in.

### The live chart (Phase 6c+)

The score line is built for a 30-second cadence, not a sub-second one. Between ticks the line is still and a leading-edge dot at the last point breathes: a halo that swells and fades over exactly one 30-second cycle, phase-locked to the banner countdown (the CSS animation runs on the wall clock with a negative delay, so both reset at the same instant). At the tick the page polls `/api/person/[slug]/live` for ticks newer than its last point; when one lands the line grows into the new value over 700 ms with an ease-out curve, the dot travels to the new point, the axis domains glide rather than jump, and the window slides: points older than the range fall off the left edge and the series is capped (`MAX_LIVE_POINTS`) so the DOM and memory stay flat. The line is monotone cubic, white, unfilled; colour lives only in the change figure above it. The y-axis clamps to the data but never spans fewer than `Y_RANGE_FLOOR` = **2.0 points**, so a 0.02-point move stays a flicker instead of a cliff. `prefers-reduced-motion` removes the pulse and applies each tick directly. With no history the empty state stands; nothing is synthesised.

## Position direction gating (Phase 6c+)

The platform launches **long-only**. `public.platform_settings.shorting_enabled` (one row, default `false`) is the gate, and it lives in the database so the write path and the interface read the same value. Flip it with the service role, never from code:

```sql
update public.platform_settings set shorting_enabled = true, updated_at = now() where id;
```

The rule, in `resolve_position_order()` and mirrored by `lib/trading/direction.ts`: a **Buy** first closes any LOW exposure, then opens HIGH with the rest; a **Sell** first closes any HIGH exposure, then opens LOW with the rest. That last step is what the gate controls. While the flag is false a Sell that would take the user's net position on a person below zero is rejected with a clear error; when it is true the same Sell opens a LOW position and net-short exposure is allowed, with no code change.

Enforcement is server-side, twice over:

- `assert_position_direction(user, person, side, cents)` is the service-role guard the trading flow's order RPC (Phase 6e) calls first, inside its transaction; it returns the exact split to apply (cents closed, cents opened, direction, net after).
- `positions_enforce_direction` is an AFTER trigger on `positions`: any change that leaves a user net short on a person while the flag is false is rejected, whatever wrote the row.

`net_position_units()` and `net_position_cents()` (open HIGH minus open LOW, in units and at entry prices) are the measures. The interface reflects the setting through `getPlatformSettings()`: under the gate the Sell control reads *Nothing to close* when nothing is held. The trading flow (Phase 6e, below) runs the same netting in units inside `place_order()`, and its tests exercise both flag states.

## The Feed (Phase 6d)

`/feed` — the ambient surface: the Engine narrating what it observes across the whole board, newest first, for people who scroll rather than search. Reachable from the tab bar and the desktop nav. Read-only.

### One narrator

Two kinds of entry share the stream, and both speak as the Engine. A **narrative** is a sentence the Engine wrote when a score moved meaningfully in a tick, shown exactly as stored, with the move it recorded and, as evidence, exactly the signals the Engine linked to it when it wrote the sentence (`narrative_signals`, decided at generation time in `lib/engine/narratives.ts`: every signal in the batch behind an LLM sentence, the non-zero signals behind a template sentence that quotes a headline, none behind a move carried by Gravity, Market Mood, Conviction or Trading Activity; an inverse-pair sentence links the paired person's signals, marked as theirs). Nothing is inferred from timing, and there is no fallback: a narrative with no links shows no evidence. A **signal** is a raw observation no narrative links to directly: not yet processed, or processed without producing a sentence. Raw headlines from connectors, and the RSS feed in particular, can read like news, so a signal entry is framed in presentation only — *A YouTube signal on Drake read +0.2.*, *An RSS signal on Drake is waiting for the Engine's next read.* — with the headline quoted beneath it. Stored text is never rewritten. Source attribution is the last, smallest, greyest line of every entry: *The Engine · via YouTube*, *Observed via RSS*.

### The entry

Avatar, name and category (a link to the person); the Engine's sentence as the hero; the recorded score impact, the only colour in an entry (green up, red down), beside a recessive relative time; the attribution line; and a quiet *What the Engine saw* that opens the evidence beneath. Entries sit in one card separated by hairlines, with generous vertical rhythm: this is a surface people scroll for minutes.

### Notable moves

An entry whose recorded impact is at or beyond **`HIGH_IMPACT_THRESHOLD` = 1.25 points** in either direction (a starting value, deliberately under the chart's 2.0-point floor so the section can actually appear under constant mean reversion; to be raised once the real distribution of moves is observable), within the last `PINNED_WINDOW_HOURS` (24), takes the pinned treatment at the top: the same composition set larger, with more air, at most `PINNED_MAX` (3), strongest first, and taken out of the stream below so nothing appears twice. Structural prominence only: no banner, no badge, no colour beyond the direction rule. When nothing qualifies the section does not exist. All three are named constants in `lib/feed/feed-model.ts`, to be retuned once real signals exist.

### Filtering, paging, ordering

The category filter is Home's component and options, derived from the people table; it filters the loaded entries instantly. Paging is keyset (`occurred_at`, `id`) through `feed_entries()`, `FEED_PAGE_SIZE` (24) at a time, triggered by a sentinel below the list from `FEED_PREFETCH_MARGIN_PX` (600) away, with the next rows taking shape in place inside the same card; the stream holds at most `FEED_MAX_ENTRIES` (240) and then says so, so memory and the DOM stay bounded. Ordering is chronological, newest first, through `rankFeed()` in `lib/feed/ranking.ts`: that call is the one place a personalised ranker will plug in later. There is no For You toggle and no placeholder heuristic, on purpose.

Every ordering carries a unique tiebreaker: the cursor and the SQL order on `(occurred_at, id)`, so a page boundary inside a run of identical timestamps neither skips nor repeats an entry and identical queries return identical order; the board ranks by score, then name, then id; every newest-first list with a limit (the Home rail preview, a profile's signals and narratives, the Engine's signal intake) orders by its timestamp and then `id`. `lib/feed/feed-entries.db.test.ts` proves the cursor against a real Postgres (PGlite, with the migrations applied verbatim), including forty entries at one microsecond-identical instant across a page boundary.

### Behavioural logging

| Event | When |
| --- | --- |
| `view_feed` | the stream mounts (`{ feed: "feed" }`) |
| `view_entry` | an entry is at least half in view, once per entry, with its position and whether it was pinned |
| `time_spent` | for as long as an entry stays in view, per entry (`{ surface: "feed", entry_id, kind }`) |
| `scroll_depth` | at 25 / 50 / 75 / 100 % of the page, and the furthest point reached on leaving |
| `expand_signal` | an entry's detail opened (`{ entry_id, kind, headline, signal_id? }`) |
| `filter_change` | the category filter changed (`{ surface: "feed", filter: "category", value }`) |
| `view_person` | a tap through to a person (`{ source: "feed_tap", entry_id, kind }`) |

Impressions and dwell come from one IntersectionObserver over the stream; everything goes through the Phase 5 client queue, batched and coalesced, and is skipped entirely when nobody is signed in. `view_entry`, `scroll_depth` and `filter_change` are the three additions to the Phase 5 vocabulary; no migration was needed.

### Empty

With the Engine dormant the Feed is empty, and that is the state it ships in: *Quiet across the board.*, a line on what will land here, and the roster of the sixteen people being tracked as small monograms, each a link to its profile. Nothing is synthesised.

## The trading flow (Phase 6e)

A user opens a position on a person (Buy), holds it while the Engine ticks, and closes it (Sell). Paper money only: no payment rail, no withdrawal path. This is the phase that can fail invisibly, so correctness outranks polish: everything financial lives in the database on the Phase 2 write path, and the client never supplies a price, a balance or a P&L.

### Money and units

Every monetary amount is an **integer number of cents** in a `bigint` column, and every arithmetic step is integer. `lib/trading/trading.db.test.ts` fails if any `*_cents` or units column is not `bigint`, or if any column in the schema is `real`, `double precision` or `money`. In TypeScript, `Cents` and `Points` are branded numbers (`lib/trading/model.ts`): a score cannot be added to a balance by accident.

One score point is one dollar (`POINT_CENTS` = 100). A quote in points becomes a price in cents exactly once, when the server reads it, through `points_to_cents()`: round to the nearest cent, half away from zero. Scores and spreads are persisted at two decimals, so in practice that rounding is exact. From there on:

| Quantity | Rule |
| --- | --- |
| cost | `units × entry_price_cents` |
| realized P&L | `(exit_cents − entry_cents) × units` for HIGH, `(entry_cents − exit_cents) × units` for LOW |
| proceeds | capital returned + P&L, never below zero (paper: a LOW loss is capped at its collateral) |
| weighted-average entry | `round(cost / units)`, display only |

No other rounding exists, so no cent is ever created or lost; `position_closes_pnl_is_fifo` enforces the P&L arithmetic on every close row. The schema and the RPCs say **`units`**; the interface says **shares**. The asymmetry is deliberate: it is the seam that lets the user-facing word change without a migration.

### Quote and execution

`place_order(person, side, units, quoted_price_cents, surface)` is the one order path (`POST /api/trade/order` calls it as the signed-in user). Inside its transaction it locks the caller's wallet row `FOR UPDATE` first, so one user's orders run one after another and can never double-spend, then the person row, so no tick can move the quote under the order; reads the Buy quote (score + spread) or the Sell quote (score − spread) in cents and snapshots it on the lot; and only then checks and writes.

**The tolerance band.** The client may send the price it displayed. If the server's quote differs from it by more than `platform_settings.price_tolerance_cents` (**10¢ per share**, i.e. 0.10 points) the order is refused with code `price_moved` and the new quote, never filled at the stale price. Inside the band the order fills at the *server's* price.

**The 30-second boundary.** A sheet open across a tick is the expected case. The sheet's price is the page's live quote: in the compose step the figures update and the price flashes once; in the confirm step the button always carries the price it will send, and if the quote moves off the one the user reviewed, a notice names both prices and the button re-arms as *Confirm at the new price*. Nothing is sent that the user has not just seen; the server's tolerance check is the backstop, and a `price_moved` refusal lands in the sheet as a re-confirm step.

**Atomicity.** Every check (gate, levers, balance) runs before any write, and a refusal is a returned value with a `code`, a sentence and the current quote. Once writing starts, order, closes, lot, ledger rows, tape row and balance land together or not at all; `users_wallet_balance_nonneg` is the last line under any caller. `lib/trading/trading.concurrency.test.ts` proves it on a real multi-connection server: two simultaneous Buys that together exceed the balance produce exactly one fill; ten simultaneous Buys spend the balance exactly once; two simultaneous Sells of a whole position close it exactly once.

### Closing, lots and P&L

`positions` rows are **lots**: `units`, `open_units`, `entry_price_cents` (the snapshot), `direction`. A Sell closes lots **FIFO**, oldest first, partially where the order runs out, writing one `position_closes` row per lot touched with its realized P&L; a lot is closed when `open_units` reaches zero. The interface shows the **weighted-average entry** on a position (`position_summary_for()` / `my_position()`), a different number for a different job; both are computed server-side. Every order is a `trade_orders` row (what was asked, what it filled at, how it split into units opened and closed), every fill writes a `trade_events` row for the Trading Activity force, and every cash movement is a `transactions` row (`ALLOCATION` on open, `REDEMPTION` on close), so balance always equals the ledger.

The spread is visible on both sides: the sheet shows the Buy and Sell quotes together and says that the gap between them is the platform's spread; the position card marks a HIGH position at the Sell quote.

### The gate, in a real flow

Buy opens or increases a HIGH position; Sell closes or reduces it; a Sell beyond the open position is refused with `exceeds_position` and the most it could close. When nothing is held, Sell sits back as a quiet outline reading *Nothing to close*, not as Buy's equal. The full two-sided path is underneath: with `shorting_enabled` true the same Sell closes the HIGH lots and opens LOW with the rest, and a Buy closes LOW first; the tests flip the flag both ways.

### Risk levers (installed, not calibrated)

Four tunables on `platform_settings`, each enforced in `place_order()` with its own refusal code and sentence, each shipped permissive so that none binds during beta. Calibration waits for real flow.

| Lever | Column | Ships as | Refusal |
| --- | --- | --- | --- |
| Max units per user per person | `max_units_per_person` | 100,000 | `max_units` |
| Max share of a person's open interest held by one user | `max_open_interest_share` | 1.0 (never binds) | `open_interest` |
| Max close value per user per trailing day | `max_daily_close_cents` | $1,000,000 | `daily_limit` |
| Cooldown before a lot may be closed (round-trip guard) | `close_cooldown_seconds` | **60 s** (since 6f; 5 s before) | `cooldown` |

`lib/trading/trading.db.test.ts` tightens each one and shows it refusing at the boundary.

**The cooldown's floor.** 5 s only blocked the within-tick round trip, which already loses the spread; the real exploit is reflexive — buy, let your own flow feed Trading Activity, the tick fires partly on that flow, sell into the move you helped create. 60 s spans two ticks. The final value is a **policy decision pending**, with one constraint that is not tunable: the platform's regulatory positioning describes this cooldown as preventing round-trip score influence, so it must remain at least one full tick (30 s). `CLOSE_COOLDOWN_MIN_SECONDS` in `lib/trading/model.ts` is that floor and `lib/portfolio/portfolio.db.test.ts` pins the shipped default above it.

### Paper balance

Every new user starts with **`starting_balance_cents()` = 1,000,000** ($10,000.00), granted by the signup trigger through the ledger. It was $1,000 in 6e: at one dollar per point a share at score 50 costs $50, so $1,000 bought roughly nineteen shares in total, too coarse for a beta whose purpose is finding out whether a portfolio feels like anything. Existing accounts are topped up with `credit_paper_balance(user, cents)`, a service-role action that writes a `DEPOSIT` and the balance together; no migration rewrites a balance (at the time of the change there were no accounts to top up). `reset_paper_balance(user)` returns a balance to the starting figure, service-role only, refusing while any lot is open; a user can never reset themselves, because a self-serve reset teaches that losses do not matter and destroys the behavioural signal. The balance sits in the banner as *Paper $10,000.00* and every monetary figure in the flow is labelled paper.

### The sheet

The Buy / Sell controls on the profile open a sheet (a bottom sheet on a phone): both quotes, a share input with presets and *Max* / *All*, cost or proceeds, estimated realized P&L on a Sell, the paper balance after, the position after; then a confirm step that states the exact price being accepted; then the result. Refusals are specific: `price_moved` offers the new quote to review, `insufficient_balance` and `exceeds_position` offer the most the order could be, the rest say what was hit. On a fill the balance, the position card and the banner chip update without a reload.

### Behavioural logging

| Event | When |
| --- | --- |
| `open_trade_sheet` | the sheet opens (`{ side, surface }`) |
| `abandon_trade_sheet` | the sheet closes without a fill (`{ side, step, units, surface }`) — high-signal |
| `take_position` | server-side, on units opened (`{ direction, amount_cents, units, price_cents, position_id, order_id, surface }`) |
| `close_position` | server-side, on units closed (`{ direction, amount_cents, units, price_cents, pnl_cents, order_id, surface }`) |
| `reject_trade` | server-side, on any refusal (`{ side, code, units, surface }`) |

The three additions are format-only; no migration. Server events are written after the response, fire-and-forget: they never block or fail a financial write.

### Testing against real Postgres

Two harnesses under `lib/__tests__`: `pglite.ts` (Postgres in WebAssembly, one session, fast) runs the migrations verbatim for everything single-session; `postgres.ts` (embedded-postgres, a real server on a free port, many connections) runs them for the concurrent-order tests. Both share `migrations.ts`, which stubs only what Supabase itself provides (the `auth` schema, the platform roles).

## The portfolio (Phase 6f)

`/portfolio` closes the loop: discovery (Home) → depth (the profile) → narrative (the Feed) → commitment (the trade sheet) → tracking. Signed in only. Every figure on it is computed by the database in integer cents and read as a value; the browser renders and never calculates.

### What it shows

- **Total value** = cash + every open position marked at the quote it would close at, with the return against the paper credit granted so far; **cash**; **unrealized** (open) and **realized** (lifetime) P&L. Colour appears only on the P&L figures and the return, by direction; the total flashes when it changes.
- **Open positions**, one row per person, largest value first (then name, then id): shares held, the weighted-average entry, the value *at Sell x.x* with the per-share mark, unrealized P&L with its percentage, realized so far on that person, and a **Sell** control that opens the 6e trade sheet for that person with `surface: "portfolio"`. There is no second trading path.
- **Value over time**: the 6c+ live line (`components/charts/live-line-chart.tsx`, now shared) with money's rules — whole dollars on the axis where the grid allows, the paper credit as the dashed reference so above the line is profit, and a vertical floor of `VALUE_RANGE_FLOOR_RATIO` (0.5 %: $50 on a $10,000 account) of the latest value, never under a dollar. Same breath, same 700 ms tick reveal, same reduced-motion handling.
- **Trade history**, newest first: who, Buy or Sell, shares, the executed price as recorded on the order (never recomputed), cost or proceeds, the local time, and on a close the realized P&L (the one coloured figure). Older pages on request through `/api/portfolio/history`.

### Marking and arithmetic

A HIGH position is marked at the **Sell quote** (a LOW one at the Buy quote): what the user would actually receive, so it sits below the raw score by the spread, and the page says so beside every value. The 6e rounding rule carries forward unchanged — points become cents exactly once, in `points_to_cents()`, and everything after that is integer:

```
value       = open_units × mark_cents
cost        = Σ open_units × entry_price_cents          (per lot, exact)
unrealized  = value − cost                               (HIGH)
realized    = Σ position_closes.pnl_cents                (read from the 6e close records, never recomputed from lots)
total value = cash + Σ value
```

"Unrealized = (Sell quote − weighted-average entry) × units" is the same number evaluated with the *exact* average (cost ÷ units before any rounding). The average the page shows is `round(cost ÷ units)`, half up, for reading only; a P&L never carries the rounding of a displayed figure (with 7 units at a cost of 35,550 the shown average is 5,079 and the P&L at 5,150 is 500, not the 497 the rounded average would give). Identity, under the long-only gate: **total value = paper credit + realized + unrealized**. `lib/portfolio/portfolio.db.test.ts` asserts every one of these to the cent against an independent computation, across three people, a partial close and a full close, on real Postgres.

### Value history

The value over time cannot be rebuilt from `score_history` alone: the Sell quote is score − spread, and the spread of past ticks is not recorded. So the value is **recorded when it changes**, as the server computes it then, into `portfolio_history`: at every Engine tick for every user holding a position, at that tick's freshly written quotes (`apply_engine_tick()` → `snapshot_portfolios()`), and after every order at the order's own instant (a trigger on `trade_orders` → `record_portfolio_snapshot()`). Between ticks nothing moves, so the recorded points *are* the history; nothing is interpolated or synthesised. `portfolio_value_series_for()` downsamples them by time exactly as `person_score_series()` does, and the page folds new points in on the Engine's cadence through `/api/portfolio/live`. With the Engine dormant the only points are the order-time marks; before the first order there are none, and the chart says which.

### Empty and edge states

- **Never traded** (the state most beta users see first): the summary shows the credit as cash, the chart says the line begins with the first trade, and an invitation replaces the lists — the credit is ready, Home and the Feed are where a position starts, the board's people are one tap away.
- **Holding, no ticks yet**: values show (marked at the Sell quote, so the spread is an honest immediate loss), the chart holds only the order-time points.
- **Closed everything**: the positions section says nothing is open and points at Home and the Feed; realized P&L and the history stay.
- Missing avatars fall back to initials; a single-lot position simply shows no lot count; a person who has left the board keeps their row and loses the Sell control.
- The route-level skeleton has the page's shape; the chart container has a fixed height; older history rows take shape inside the same card.

### Behavioural logging

| Event | When |
| --- | --- |
| `view_portfolio` | the page mounts (`{ positions, orders }`) |
| `time_spent` | the dwell, paused while the tab is hidden (`{ surface: "portfolio" }`, no person) |
| `view_person` | a tap through from a position (`{ source: "portfolio_position" }`) or a history row (`{ source: "portfolio_history", order_id }`) |
| `filter_change` | the value chart's range (`{ surface: "portfolio", filter: "range", value }`) |
| `open_trade_sheet` / `abandon_trade_sheet` / `close_position` / `reject_trade` | the close started here carries `surface: "portfolio"`, so it is told apart from one started on the profile |

`view_portfolio` is the one new type; `time_spent` now accepts a surface in place of a person. Format-only; no migration.

### Part 0, carried from 6e

The close cooldown rose from 5 s to 60 s (see the levers), the starting balance from $1,000 to $10,000 (see the paper balance), the Trading Activity minimum-sample guard became overridable by `ENGINE_TRADING_MIN_POPULATED_WINDOWS` with its default of 30 unchanged (`engineConfigFromEnv()` in `lib/engine/config.ts`, wired into `runFullTick()`), and the local clone's `origin` remote gained its fetch refspec so `origin/main` exists.

## Metric connectors and the privacy rule (Phase 7)

The Signals force now has two kinds of evidence: **events** (a headline, a comment: text the sentiment scorer reads) and **metrics** (a level a connector reads: subscribers, followers, a popularity index, a news count). A metric is never a signal by itself. The pipeline in `lib/ingest/metrics.ts` is:

```
poll → snapshot (raw_source_snapshots) → delta vs the previous snapshot → normalise against the
person's own trailing baseline → a signal only when the baseline is sufficient and the reading is
outside the band
```

The normalisation is the point. What each metric means is declared on its `data_sources.config`, per metric, and never in Engine code:

| Field | Meaning |
| --- | --- |
| `polarity` | `1` when up is good for the person, `-1` when up is bad. **Explicit; a metric without one is snapshot-only** and never scores. Never inferred from the sign of a delta. |
| `delta` | how consecutive snapshots become an observation: `level` (the value itself: a bounded index, a windowed count), `absolute_rate` (change per hour), `relative_rate` (change per hour as a fraction of the previous level) |
| `baseline_window_hours` | how far back the person's own series reaches |
| `min_samples` | observations required before a deviation counts. **Below it the metric emits nothing**, whatever the move |
| `sd_floor` | floor for the baseline sd, in the observation's units, so a flat history cannot make a small move many sigma |
| `scale` | how strongly a sigma of this metric reads (the metric scorer multiplies by it) |
| `threshold_std_devs` | the deadband, default 1.0σ |

`config.derived` declares metrics computed from another metric's snapshot history with no connector of their own: `upload_rate` (`kind: rate`: the change in `video_count` over the trailing week, per day, once the history spans the window) and `viral_moment_rate` (`kind: spike_count`: how many `news_volume_24h` readings in the trailing week sat two sd above the week's own mean). A derived level is snapshotted and normalised like any other.

**One baseline.** `lib/engine/baseline.ts` (`baselineDeviation`) is the single implementation of mean, population sd, sd floor, minimum sample and deadband. Trading Activity consumes it for net order flow; every metric consumes it for its observations; a test fails if either grows its own mean and sd.

**The metric scorer.** `lib/engine/sentiment/metric.ts` sits beside the sentiment scorers behind the same `SentimentScorer` interface: `confidence = clamp(|σ| / 3 × scale, 0, 1)`, `direction = polarity × sign(σ)`, and the Signals force computes `baseImpact × tier × confidence × direction` exactly as for a headline, so metric and news signals flow into one force with the source tier as the relative weight (official APIs tier 2, a curated feed tier 3, viewer comments tier 4). The Engine routes by what a signal *is* (payload `kind: "metric"`), never by where it came from; the LLM scorer's prefilter sends a metric signal to the metric scorer too, and the keyword scorer refuses to give one a direction.

**The privacy rule, schema-enforced.** A metric signal stores direction and normalised magnitude only: the headline reads "MrBeast's YouTube subscriber growth is running +1.4σ above their own trailing week", the payload is limited to an allow-list (`kind, metric, label, sigma, direction, polarity, samples, min_samples, window_hours, delta_kind, threshold_std_devs, scale, source`), and the `signals_enforce_metric_privacy` trigger refuses any other key, a missing polarity, a non-numeric sigma, or a headline carrying a run of four digits, a thousands grouping or a compact count. Raw levels live in `raw_source_snapshots` and `raw_metric_observations`: no grant, no policy, service role only; `lib/ingest/privacy.db.test.ts` asserts on real Postgres that no function or view the user roles can reach references them, and that no page, component or user-facing read in the app does either. The narrative layer only ever sees normalised values: the sentiment prompt's payload allow-list (`PAYLOAD_KEYS`) carries no level, previous level or delta, and a test feeds it a payload full of raw counts and asserts none reach the prompt; memory and narratives are built from headline, label and impact alone.

**Per-person signal volume.** Once several sources feed one person, the number of signals in a tick says more about the sources than the person, so the Signals force (a) keeps at most `maxPerSourcePerTick` (3) non-zero signals per source, the strongest, and (b) divides the sum of the kept signals by `count^volumeExponent` (0.5): four signals of one strength read twice one of them, not four times. The assumption is that a tick's signals about one person are partially redundant evidence of the same day and combine like noise, in quadrature. Where it is weak: it still grows with the number of sources, so adding sources to a person raises their ceiling; it cannot tell a genuinely busy day from four outlets covering one story; it dilutes a lone strong signal beside weak ones; and the source cap may drop a real second story on a three-story day. The honest fix is to normalise each person's signal volume against their own trailing volume, the same baseline the metrics use, once there is history to build it from.

**Observability.** Every run (`ingest_runs`), every poll (`source_polls`: source, person, ok / error / skipped with the reason, latency, what it produced) and every observation (`raw_metric_observations`: level, previous, delta, baseline mean and sd, sigma, samples, outcome, the signal it produced) is recorded and logged as a structured `[ingest]` line, so a score move can be walked back from `score_events.details.signals[].impact` to the signal to the observation to the poll. `source_health` (a view) gives last poll, last success, last error and its reason, the trailing-day poll count, error rate and latency per source; `llm_cost_per_tick` prices `llm_usage` by tick (the sentiment scorer now stamps the tick number on its usage rows) against `llm_model_prices`, and says how many calls had no price row. `GET /api/admin/health` returns all three.

**Running it dry.** The cron stays off. `POST /api/ingest?force=1` with `INGEST_SECRET` runs every active source once: the first run produces snapshots, first-contact observations and no metric signals; later runs produce `insufficient_baseline` observations until `min_samples` is reached, then `inside_band` or, on a real move, `emitted` with a σ signal. Nothing here advances a score; a signal waits for a tick.

## Scope so far

- **Phase 1**: scaffold, schema, RLS, auth, seed data, typed clients.
- **Phase 2**: financial-write lockdown + RPC pattern, connector interface and registry, YouTube connector, stubs, `source_snapshots` (now `raw_source_snapshots`), ingestion runner and endpoint.
- **Phase 3**: swappable sentiment scoring (rules-based), the five forces, inverse pairs, LMSR spread with Buy/Sell prices, the atomic tick with history and per-force audit trail, the tick endpoint.
- **Phase 4**: provider-agnostic LLM abstraction with an Anthropic adapter and three stubs, model routing, per-entity memory with seeded baselines and cheap evolution, the `LLMScorer` with anomaly awareness and rules fallback, usage logging with a per-tick call cap, narratives for meaningful moves.
- **Engine cron**: the 30-second heartbeat via Vercel Cron (two ticks per one-minute invocation with a time budget), one shared `runFullTick()` path, gated by `ENGINE_CRON_ENABLED`, which ships as `false`.
- **Phase 5**: behavioral logging foundation: `session_id` and recommender-shaped indexes on `behavioral_events`, the canonical event vocabulary with per-type metadata contracts, server-side and browser logging services (validated, silent on failure, batched, session-grouped), and the service-role-only query layer.
- **Phase 6a**: the design token system, the core component library, the persistent shell (banner with the 30-second countdown, bottom tabs, desktop two-panel layout) and the route skeleton with styled placeholders.
- **Phase 6b**: Home wired to live data: the person card and ranked row, top movers, category filtering, sparklines, the desktop feed rail, and the behavioural logging that records impressions and dwell.
- **Phase 6c**: the person profile page: the identity dossier with the STATE and CONVICTION readings, the hero score with period change, the score line with ranges and the gravity reference, the five forces, the signal list, the Buy / Sell entry stub, `person_score_series()`, and the `change_range` event.
- **Phase 6c+**: the live chart (monotone spline, phase-locked pulse, 700 ms tick reveal, bounded sliding window, 2.0-point y floor, reduced-motion aware), the monochrome Buy / Sell controls, position direction gating behind `platform_settings.shorting_enabled`, and the baseline-relative Trading Activity force.
- **Phase 6d**: the Feed: `feed_entries()`, the entry in one Engine voice with the raw-signal framing, the pinned high-impact treatment behind `HIGH_IMPACT_THRESHOLD`, the category filter, bounded keyset infinite scroll, the chronological ranker with its swap point, the empty state, the board glance in the rail, and the `view_entry` / `scroll_depth` / `filter_change` events.
- **Phase 6d+**: the Feed correctness pass: `narrative_signals`, written by the Engine at generation time through `record_narratives()` and read by `feed_entries()` with the tick-window inference removed outright; `HIGH_IMPACT_THRESHOLD` lowered to 1.25 as a starting value; the Feed's vocabulary settled; a unique tiebreaker on every ordering, app-wide; and the in-process Postgres test harness (`lib/__tests__/pglite.ts`) that runs the migrations verbatim so SQL is tested as SQL.

- **Phase 6e**: the trading flow: integer-cent lots with a server-snapshotted entry price, `place_order()` (wallet lock, server-read quote, 10¢ tolerance band, unit netting through the gate, four risk levers, FIFO closes with per-lot realized P&L, one transaction), `trade_orders` and `position_closes`, `my_position()` with the weighted-average basis, `reset_paper_balance()` (service role only), the trade sheet with its tick-boundary re-arm, the position card, the paper balance in the banner, three trade events, the Trading Activity guards (minimum sample, sd floor, 1.0 σ deadband with an in-band value), and the real-server concurrency tests.

- **Phase 6f**: the portfolio: `portfolio_summary_for()` / `my_portfolio()` (cash, every position marked at its closing quote, unrealized and realized P&L, the paper credit and the return, all integer cents), value history recorded at every tick and every order into `portfolio_history` and read back through `portfolio_value_series_for()`, `trade_history_for()` with its keyset cursor, the page itself (summary, the shared live line as a value chart, positions with Sell into the 6e sheet, history with older pages, the three empty states), the `view_portfolio` event and the portfolio surface on every trade event; and the carried fixes: the 60 s cooldown, the $10,000 starting balance with `credit_paper_balance()`, the min-sample override, the git refspec.

- **Phase 7**: the auth gate (one removable file), the metric connector kind with the shared baseline, the metric scorer with explicit per-metric polarity feeding the Signals force, the schema-enforced privacy rule (raw levels service-role only, signals carry direction and sigma), the registry rows and mappings for `youtube`, `youtube_comments`, `rss` and `spotify` with derived metrics (upload cadence, viral-moment frequency, commentary volume), per-person signal-volume normalisation, and the run / poll / observation ledger with `source_health`, `llm_cost_per_tick` and `/api/admin/health`.

Deliberately not built yet: the profile screen, search results, the Forecast force, and the recommendation algorithm (For You). Shorting stays switched off; the risk levers stay inert (the cooldown's rise to 60 s is a policy floor, not a calibration); the heartbeat is wired but switched off, and ingestion is manual.
