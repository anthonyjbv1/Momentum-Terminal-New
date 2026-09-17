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
| `ENGINE_TARGET_DRIFT_ENABLED`          | server only (Engine)         | **The drifting Gravity target** (Phase 14). Only the exact string `true` turns it on; anything else (including unset) leaves every target at its seeded `revert_target` and accumulates nothing. Ships off. The tick logs it as an active override. |
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
| `20260913014045_signup_rate_limit.sql`     | `username_available()` closed to `anon` / `authenticated` (service role only); `rate_limit_buckets` and the service-role `rate_limit_hit()` fixed-window counter behind the sign-up username check |
| `20260912211216_phase7_metric_connectors.sql` | `source_snapshots` → **`raw_source_snapshots`** (read policy dropped, service role only); `raw_metric_observations`, `ingest_runs`, `source_polls` (all service role only); the `source_health` and `llm_cost_per_tick` views; `llm_model_prices`; the `signals_enforce_metric_privacy` trigger; the registry rows for `youtube`, `youtube_comments`, `rss`, `spotify` with their metric declarations, and the MrBeast / Drake mappings |
| `20260913153600_llm_model_prices_verified.sql` | `llm_model_prices`: `claude-opus-5` and `claude-sonnet-5` set to the rates verified 2026-09-13 (input / output / cache read), the ASSUMED marker replaced with a dated Verified note; cache write is the standard 1.25 × input multiplier and the note says so; no batch columns exist and none were added |
| `20260914005711_llm_prices_haiku_exact_match.sql` | `llm_model_prices`: `claude-haiku-4-5-20251001` added at the rates verified 2026-09-14 (the dated ID the API echoes, which is what `llm_usage` carries), the alias row's note corrected; `llm_cost_per_tick` joins on model equality instead of the longest prefix, so an unknown string is unpriced rather than mispriced |
| `20260914152703_phase8plus_connector_corrections.sql` | `publisher_domains`: 17 observed domains promoted at tiers 2–4, plus `amgen.com` and `blog.google` recorded AT the floor with the reasoning; `youtube_comments` gains the `comment_volume` metric declaration |
| `20260914021237_phase8_rss_signal_quality.sql` | `publisher_domains` (the tiered publisher allowlist as configuration: normalised domain, allowed with a tier or blocked, service role only) with its seed; `signals.tier` (per-item credibility tier, null = the source's); `blocked_dropped` / `duplicates_collapsed` on `source_polls` and `ingest_runs`; `source_health` gains `blocked_24h` / `collapsed_24h` |
| `20260914165502_phase9_admin_baseline_progress.sql` | `metric_baseline_progress` (per person / source / metric: samples against the declared minimum, snapshot span against the declared window, snapshot count, last outcome — counts, configuration and timestamps only, service role only); `users.is_admin` documented and set for the operator account |
| `20260915170500_phase10_twitch_apisports.sql` | Configures the existing `twitch` and `apisports` registry rows (metric declarations, poll intervals below the hour, active) and maps the already-seeded Kai Cenat and Patrick Mahomes to them plus curated RSS; seeds nineteen sports and streaming publisher domains |
| `20260915172000_poll_interval_off_the_hour.sql` | `rss`, `youtube` and `youtube_comments` from 60 to 55 minutes: an interval that is an exact multiple of 60 always loses the hourly cron's `59 < 60` comparison, so all three had been polling every second hour |
| `20260915181500_poll_interval_spotify.sql` | The same correction on the dormant `spotify` row, so a rebuild — or turning it back on — does not reintroduce it |
| `20260915190000_entity_disambiguation.sql` | `person_data_sources.config` (per-subject rules for a source); `excluded_filtered` on `source_polls` and `ingest_runs`; `source_health.excluded_24h`; Drake's exclusion terms for the university, its athletics and two namesakes |
| `20260917142813_phase13_publisher_feeds.sql` | `publisher_feeds` (the publisher-direct feed catalogue: configuration plus the health each fetch writes back, service role only) with 94 candidate rows across 60 outlets, 25 of them discovery pages; the `publisher_rss` registry row (events only, 10 minutes) and the four subject mappings with match terms, topics and Drake's extended exclusions; `rss` to 10 and `apisports` to 40 minutes for the fifteen-minute cron |
| `20260917150236_phase13_feed_curation.sql` | What the first production fetch found, applied to the rows: nine discovered feeds promoted, four duplicate finds and the outlets that refuse or declare no feed switched off with the finding in the note, four HTML-answering addresses and one stale feed re-pointed to discovery, two stale feeds switched off |
| `20260917151045_phase13_run_budget.sql` | `record_feed_health(jsonb)`: a run's feed findings written in one statement, health columns only, service role only; the publisher connector's fetch budget and per-feed timeout to 15 s and 6 s so the catalogue fetch fits inside the run budget |
| `20260917151844_phase13_feed_curation_2.sql` | The second fetch's findings on the re-pointed rows: Bleacher Report's discovered feed promoted; HipHopDX, Rap-Up, the Toronto Star and both USA Today pages switched off, nothing feed-like found on any of them |
| `20260917184229_phase13_athlete_metrics.sql` | The API-Sports row's `config.game_stats` (yards, rating and interceptions, each with its group and statistic name in the per-game response) and the `game_passer_rating` (+1) and `game_interceptions` (−1) declarations beside `game_passing_yards`, all at `min_samples` 8; merged onto the existing config |
| `20260917211640_phase15_sixteen_subjects.sql` | The twelve unmapped people on `publisher_rss` (topics, safe aliases, disambiguation) and `rss` (a quoted-name Google News search with the same block); `person_data_sources.created_at` (the start of a person's volume regime); `person_signal_volume()` (event signals per complete day since the newest mapping, plus the trailing day; service role only) with an index on `signals (person_id, occurred_at)`; `poll_concurrency` 4 on the two news doors |
| `20260917202622_phase14_target_drift.sql` | `people.target_attention` / `target_direction` / `target_offset` (the drifting target's state; `revert_target` documented as the seed) and `apply_engine_tick` writing them beside the score; `forbes` and `newsdata` from 60 to 55 minutes; execute on the two SECURITY DEFINER trigger functions (`positions_enforce_direction`, `trade_orders_snapshot_portfolio`) revoked from `anon` and `authenticated` |
| `20260917235241_phase16_twitch_live_mode.sql` | `live_sessions` (one broadcast per source and stream id, with its running aggregates) and `live_samples` (the live ledger), both service role only; `ingest_runs.trigger` admits `live`; the `twitch` row's `config.live` block (on, two-minute samples, the thresholds) and its two session metrics (`session_peak_viewers`, `clips_per_stream_hour`, a month of sessions, five before either says anything); `person_signal_volume()` no longer counts live moments as volume |

All of these are applied to the `Momentum Terminal` Supabase project and recorded under the same versions, so `npm run db:push` treats them as applied and only pushes new files. To add a migration: create `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, run `npm run db:push`, then `npm run db:types`.

### Tables

| Table                 | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `users`               | Profile + wallet for each `auth.users` row                                                    |
| `people`              | Each tracked individual: `current_score`, `revert_target` (the seed of the Gravity target) with the drifting target's `target_attention` / `target_direction` / `target_offset`, `spread`, generated `buy_price` / `sell_price`, `last_tick_at` |
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
| `rate_limit_buckets`  | Fixed-window counters keyed by string (the sign-up username check, per IP), read and written by `rate_limit_hit()`. Service role only |
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
| `llm_usage`, `llm_model_prices`, `rate_limit_buckets`, **`raw_source_snapshots`**, **`raw_metric_observations`**, `ingest_runs`, `source_polls`, and the `source_health` / `llm_cost_per_tick` views | no access (no grant, no policy; a test asserts no function or view they can reach references the raw tables) | full (only writer) |
| `platform_settings`                                                                                                                                 | read                                                                         | full (only writer) |

### Financial writes

Clients never write money. Every write to `positions`, `transactions`, `portfolio_history`, `trade_events` and to `users.wallet_balance_cents` / `users.buying_power_cents` goes through exactly one of:

1. **Trusted server code** using the service-role client (`lib/supabase-admin.ts`): the Engine tick, cron jobs, admin tooling.
2. **A `SECURITY DEFINER` function (RPC)** that runs with an empty `search_path`, derives the actor from `auth.uid()`, validates every input, performs all related writes in one transaction, and is granted to `authenticated` explicitly.

`place_order(...)` (Phase 6e) is the trading RPC built on that template: granted to `authenticated`, actor from `auth.uid()`, every check before any write, one transaction. `reset_paper_balance(user)`, `credit_paper_balance(user, cents)` (the 6f top-up path, through the ledger), `position_summary_for(user, person)`, `portfolio_summary_for(user)`, `portfolio_value_series_for(user, …)` and `trade_history_for(user, …)` are service-role only; their `my_*` wrappers bind them to `auth.uid()` for `authenticated`. `portfolio_history` is written only by `record_portfolio_snapshot()` (the `trade_orders_snapshot_portfolio` trigger) and `snapshot_portfolios()` (inside the tick). `placeholder_financial_mutation(p_amount_cents)` remains as the documented shape. `apply_engine_tick(jsonb)` is the Engine's own atomic write path and is executable by the service role only.

## Authentication

- **Signup** (`/signup`): the Server Action validates the input, checks the username on the server (`lib/auth/username-availability.ts`: the service-role client calls `username_available()`, which the public roles can no longer execute, behind a per-IP limit of 20 checks per 10 minutes kept in `rate_limit_buckets` through `rate_limit_hit()`), then calls `supabase.auth.signUp` with `username` and `display_name` in the user metadata. Nothing in the sign-up flow calls an API route of ours, so the auth gate has nothing to allow beyond `/signup` itself; `lib/auth-gate.test.ts` walks the whole flow against the gate and `lib/auth/signup.db.test.ts` runs it against real Postgres. The `on_auth_user_created` trigger inserts the `public.users` row with the $10,000 paper balance (`starting_balance_cents()`) and a matching `DEPOSIT` transaction.
- **Login** (`/login`): `signInWithPassword`, then redirect to `next` (defaults to `/account`). Email confirmation links land on `/auth/callback`.
- `proxy.ts` refreshes expired sessions on every request (`resolveSession`), then applies **the auth gate** (`lib/auth-gate.ts`, Phase 7): while the test is closed, a signed-out request to any page is redirected to `/login?next=…`, a signed-out call to any API route gets `401` JSON (never a redirect), `/login`, `/signup`, `/auth/*` and static assets stay reachable, the shared-secret routes (`/api/ingest`, `/api/engine/*`, `/api/admin/*`) are left to their own check, `/robots.txt` is `Disallow: /`, and every response carries `X-Robots-Tag: noindex, nofollow, noarchive`. The gate is one file with one call site; a test asserts nothing else imports it, so reopening the app is deleting the file and restoring one line, after which the per-route rules in `lib/supabase-proxy.ts` (`/account`, `/portfolio`, `/profile` need a session; `/login`, `/signup` need none) keep working.
- Use `getCurrentUser()` / `requireUser()` from `lib/auth.ts` in server code for anything that depends on identity.

Set the Supabase Auth **Site URL** and **Redirect URLs** (Authentication → URL Configuration) to include your local and Vercel origins plus `/auth/callback`.

## Data ingestion

Connectors under `lib/connectors/` implement `DataConnector` and are registered by `data_sources.name`. A connector produces **events** (`fetchForPerson → RawSignal[]`: news items, comments, real text the sentiment scorer reads), **metrics** (`fetchMetrics → MetricReading[]`: raw levels the runner normalises before anything sees them), or both, and may report `available()` (credentials present or not). `youtube` (channel metrics and commentary volume), `youtube_comments` (one comment digest per video plus comment volume), `rss` (a person-scoped feed: articles and news volume) and `spotify` (popularity and followers) are implemented; `twitch`, `forbes`, `finnhub`, `newsdata`, `billboard` and `apisports` are interface-compliant stubs.

A **source** is a `data_sources` row (tier, poll interval, and the metric declarations in `config`) plus its credentials in the environment; a connector is only the code that can talk to that kind of upstream. Adding a source is inserting the row and mapping people in `person_data_sources`; removing one is flipping `is_active`. No code names a source. The runner (`lib/ingest/runner.ts`) reads the active sources, skips the ones whose connector is unavailable (missing credentials) or was polled within `poll_interval_minutes`, calls each connector per mapped person, admits the events (`lib/ingest/events.ts`: an event that names a publisher domain is tiered through the publisher allowlist or dropped as blocked, and copies of one story are collapsed into one; see [RSS signal quality](#rss-signal-quality-phase-8)), stores what survives with `processed = false` and its per-item tier (dedupe keys prevent the same item twice), and runs every metric reading through the pipeline in [Metric connectors and the privacy rule](#metric-connectors-and-the-privacy-rule-phase-7). Every run, poll, observation, drop and collapse is recorded.

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
- `rules` — `RulesBasedScorer`, the Phase 3 keyword scorer. Setting `SCORER=rules` switches back instantly; it is also what the LLM scorer falls back to per signal whenever an attempted call errors, times out, refuses or returns something unparseable. A chunk the tick could not attempt at all (deadline, call budget) is not scored by rules: it is deferred to the next tick (see *The tick that always commits*).

### The five forces (first pass, per person)

| Force                | Formula                                                                                                                   | With nothing happening |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Gravity**          | `decayed = target + (score − target) · e^(−λ·Δh)`, impact = `decayed − score`; λ = 0.35/h, Δh = hours since `last_tick_at` (30 s on the very first tick, capped at 24 h); target = `revert_target` + `target_offset` (the seed, plus the [drifting target](#the-drifting-target-phase-14) when it is on) | pulls toward the target |
| **Signals**          | per signal: `baseImpact (1.5) · tier multiplier (T1 1.5, T2 1.0, T3 0.5, T4/5 0.3) · confidence · direction`; summed, capped at ±10 per tick | 0 |
| **Market Mood**      | mood = platform-wide mean of this tick's Signals impacts; impact = `fraction (0.25) · sensitivity (1.0, per-slug overridable) · mood excluding the person's own signals`, mood clamped to ±2 and impact to ±0.5 (the brakes) | 0 |
| **Conviction**       | concentration = open capital on the person / `max_allocation_cents`; 0–60 % → 0, 60–85 % → +0.05…+0.15, > 85 % → −0.05…−0.15, capped at −0.30 | 0 (no positions) |
| **Trading Activity** | flow score = net Buy−Sell flow in the last 60 s / `max_allocation_cents` (clamped ±1); **baseline** = the same score for every 60 s window over the trailing **24 h** (`baselineHours`); deviation = flow score − baseline mean; a deadband at **1.0 σ** (`thresholdStdDevs`) of the baseline sd, which is floored at **0.01** (`sdFloor`); outside the band adjustment = deviation · 0.25 (`weight`), inside it deviation · 0.25 · 0.25 (`inBandScale`) but never smaller in magnitude than **0.01** (`inBandMinImpact`, signed by the deviation, so normal trading reads alive rather than idle); × 0.4 when no signal confirms the move, capped ±0.30, skipped below 15 % concentration, and **0 with "insufficient baseline" until 30 windows** (`minPopulatedWindows`) in the trailing day have seen a trade. Baseline-relative so that long-only flow (which can only be ≥ 0) is not a permanent lift: steady inflow is the baseline, a burst above it lifts, a lull below it lowers. Unchanged when shorting is enabled. | 0 (no trades) |

`newScore = clamp(score + Σ forces, 35, 100)`, stored at **four decimals** (Phase 14; two before). The precision is the stored score's only: every surface formats to one or two decimals and every quote is rounded to whole cents on both sides. Two decimals had a dead zone: at the 30-second cadence Gravity's pull in one tick is gap × 0.0029, under half a cent once a score is within 1.72 points of its target, and the rounding discarded it on every tick. The first 24-hour run showed it: every person without signals stuck 1.3 to 1.7 points short of their target (moved only when Market Mood tipped a tick over the rounding edge), and the board read as frozen. No force changed.

### The drifting target (Phase 14)

The first 24-hour run ended with every score within two points of its seeded `revert_target`, so the board was a ranking of seeds: a person who had never received a signal outranked a quarterback with a nationally covered comeback. A constant target holds a person where they were seeded whatever the world does. Since Phase 14 Gravity's target is **the seed plus an offset the Engine moves over weeks**, behind `ENGINE_TARGET_DRIFT_ENABLED` (off by default):

```
target    = revert_target + offset,  |offset| ≤ bound
attention = EMA over halfLifeHours of |Signals impact| per hour
direction = EMA over halfLifeHours of  Signals impact  per hour
coverage  = min(attention / fullCoverageImpactPerHour, 1)        0..1
lean      = clamp(direction / fullCoverageImpactPerHour, −1, 1)  −1..1
offset    = bound × (coverage × (1 + lean) − 1)
```

The evidence is the Signals force itself, after the source cap and the volume normalisation: the one thing that moves a score because of the world rather than because of the platform (Market Mood, trades and Gravity never feed it). With no evidence the normal sinks to `seed − bound` (**the floor**); full coverage that is balanced holds the seed; full coverage that is as positive as it is full holds `seed + bound` (**the ceiling**); entirely positive coverage earns the seed at about 62 % of full; sustained negative coverage sinks to the floor as an inert person does, while the Signals force keeps pushing the score below it in real time. The three constants, all in `config.targetDrift` and all tunable: **`halfLifeHours` 336** (two weeks: the clock), **`bound` 8** (the ±8 of the previous platform's semi-dynamic drift), **`fullCoverageImpactPerHour` 0.2** (about five points of signal impact a day, roughly twenty scored items at routine confidence; the constant most likely to move, and the design's known weakness: it is global, so more sources reach it more easily, the same weakness the volume normalisation carries and with the same eventual fix, each person's own trailing volume).

**The fourth clock.** Signals freshness weights a signal in the queue (half-life 24 h); memory expiry decides what the model is shown verbatim (a 30-day cutoff); Gravity decays a score toward its target (λ = 0.35/h); this moves the target itself, fourteen times slower than freshness, with its own constants that must stay its own (`config.test.ts` pins the separation). One day of full positive coverage moves a target by under half a point; two weeks by about four; the ceiling takes six to eight.

**Zero signals: sink, not hold, and to a floor of their own.** The case for holding the seed is real: absence of evidence is not evidence of absence, and today nine of the sixteen people have no active source mapping at all, so their silence measures the platform's coverage and not the person. The case for sinking is stronger on a momentum board: a number that never moves is not a momentum reading, and holding the seed is exactly what produced a board where the untracked outranked the covered. The resolution is where the floor sits. It is **per person**, the seed less the bound, never a common number, so the seeded order of prominence survives among the quiet (Warren Buffett's floor stays above a lesser seed's), while any evidence at all ranks above none. The mechanism does not consult the source map, on purpose: it would be measuring the same silence either way, and an untracked person's number is not a measurement whichever way it is held. What their silence does mean is a coverage gap, which the console now shows (a **Sources** column, `none` in warning colour) and a later phase should close.

**Turning it on moves nothing.** A person the drift has never measured is presumed fully covered and balanced (`attention = fullCoverageImpactPerHour`, `direction = 0`, offset 0), so the switch starts every target exactly at its seed and the drift begins from there. Off, the tick writes the dormant state (null evidence, zero offset): nothing accumulates in the dark, and a stale offset on a row is reset on the first tick. The state lives on `people` (`target_attention`, `target_direction`, `target_offset`), written by `apply_engine_tick` beside the score; every read of the target (Home, the profile, the console, the narratives) adds `target_offset` to `revert_target`, and the gravity row in `score_events.details` carries `seedTarget` and the drift's state for the audit trail.

**Where the first run's seven would settle** at their observed rates (gross and net Signals impact per hour over the first 23.9 hours, a day that included the start-up backlog): Drake 73 (net 0.267/h, the ceiling), MrBeast 71.3 (gross 0.5/h but net only 0.082/h: the most covered subject with the most mixed coverage), Patrick Mahomes 69 (net 0.252/h, the ceiling), Kai Cenat 66.8 (net 0.171/h), and Jensen Huang, Kendrick Lamar and Warren Buffett to their floors, 55, 55 and 54. Getting there takes the weeks above; `target-drift.test.ts` pins the projection.

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

With no signals, a tick moves every score slightly toward its revert target through Gravity alone: from the seeded 50.0, a person with target 68 moves to 50.0524 on the first 30-second tick (50.05 as displayed), and only a `gravity` row appears in `score_events`. Conviction and Trading Activity are exactly 0 until positions and trades exist; the spread sits at 0.50.

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

Cost controls (in `DEFAULT_ENGINE_CONFIG.llm` and `.tick`):

- **Pre-filter**: baseline signals (`kind: "baseline"`), metric signals, empty headlines and tiny `change` signals (below `minRelativeChangeForLlm`) never reach the LLM.
- **Memory cache**: a person's memory is read once per batch and cached for `memoryCacheTtlMs`.
- **Batching**: up to `maxSignalsPerCall` (12) signals about one person are reasoned together in one call, and a person gets **one call per tick** (`CALLS_PER_PERSON_PER_TICK` in `sentiment/budget.ts`, a rule rather than a knob: see below).
- **Per-tick call budget**: `callBudgetPerTick` (4) model calls per tick, a plain count owned by the tick. Chunks beyond it are *deferred* to the next tick, not scored by rules. This is distinct from `rollingWindowMaxCalls` (20 per tick interval, process-wide), a rate limit that cannot bound one tick's work; the old `maxCallsPerTick` was that rolling window under the wrong name, and never engaged.
- **One attempt per call**: `timeoutMs` is 15 s and the Anthropic adapter is built with `maxRetries: 0`. The SDK's default retry turned a 20 s timeout into a 40 s pool-slot occupation; the next tick, thirty seconds later, is the retry.
- **Usage ledger, in two halves**: every call writes `llm_usage` *before* it is made (`status: started`) and settles the row when it returns (`completed`, with tokens and latency) or throws (`failed`, with the reason). A row that stays `started` is a call the process died inside — billed by the provider and, before Phase 11, never recorded. `llm_cost_per_tick` carries `completed_calls`, `failed_calls` and `started_calls`, and prices completed calls only.

Resilience: any provider error, timeout, refusal, malformed response or omitted signal makes the affected signals fall back to the rules scorer (result `scorer: "rules-fallback"`, reason in the rationale) and logs the fallback. The tick never fails because the LLM had a hiccup.

### The tick that always commits (Phase 11)

The first cron run failed every minute for ten minutes and committed nothing: the tick loaded the entire backlog (282 signals, 26 model calls), scored it with no deadline, and was killed at the route's 60-second `maxDuration` before its single commit, then paid for the same calls again a minute later. Phase 11 makes the opposite a structural property: **a tick that starts commits**, whatever the scorer managed. A tick that does less but always commits beats one that does everything and sometimes dies.

- **Deadline** (`tick.budgetMs`, 25 s; `lib/engine/deadline.ts`). One instant per tick, started before the store is even read, handed to the scorer and to the post-tick step. It gates *starts*: no model call begins unless it can finish before the deadline (`deadline − timeoutMs − CALL_OVERHEAD_MS`). Nothing is ever aborted, because aborting a non-streaming request recovers none of its cost. The cron hands every tick its own slice, the time left in the invocation less a 2 s commit reserve, so the second tick of a minute gets 23 s and neither can outlive the invocation.
- **Two outcomes** (`ScoringOutcome` in `sentiment/types.ts`). A chunk that was *attempted* and failed falls back to rules — a real answer, the signal is processed. A chunk that was *never attempted* (deadline, budget, person rule, rate limit) comes back as `DeferredSignal`: the tick leaves it out of the forces, the summary's signals and the commit, so it stays `processed = false` and a later tick scores it at one attempt's cost. `apply_engine_tick` already marks processed only the ids it is given, so this needed no migration.
- **Load in LLM shape** (`lib/engine/selection.ts`). The store reads the backlog oldest-first up to `tick.loadCeiling` (500) and the tick selects: every metric and baseline signal (free), then event signals at most `tick.maxEventSignalsPerPersonPerTick` (12, one chunk) per person and `tick.maxEventSignalsPerTick` (48, one wave of the pool) in total. What is not selected stays unprocessed and the next tick sees it again; a backlog drains across ticks.
- **One chunk per person per tick.** In the failed run one subject held half the backlog, and his thirteen contiguous chunks owned all four pool slots for the entire life of every invocation. The selection bound and the call budget both enforce the rule, and `config.test.ts` / `budget.test.ts` pin it. It is a requirement of the Engine, not a tuning.
- **Gravity every tick.** The forces run for every person whatever the scorer did, so a tick with every model call deferred still moves every score toward its target and commits.
- **Observability.** `TickSummary.scoring` (persisted in `engine_ticks.summary`) records `backlogBefore`, `selected`, `attempted`, `llmScored`, `fallbacks`, `withoutModel`, `deferred` (with reasons), `llmCalls`, `processed`, `backlogAfter`, `partial` and the time left when scoring finished; the cron logs the same per tick. The admin console's Engine panel shows the live backlog (the number to watch when the cron is re-enabled) and, per tick, attempted / deferred / fell back / calls / backlog after / full-vs-partial; its LLM panel shows unsettled and failed calls.

### Freshness (Phase 12)

Until Phase 12 there was no freshness weighting anywhere: `occurred_at` was loaded and never read by a force, so an eight-month-old article scored exactly as one published this minute, and the oldest-first tick would have scored the stalest signals in the corpus first. Now:

`impact = baseImpact × tierMultiplier × confidence × direction × freshness`, with `freshness = 2^(−age / freshnessHalfLifeHours)` for `age` = tick time − `occurred_at`, and **exactly 0 at and past `freshnessMaxAgeHours`**. The tunables are `signals.freshnessHalfLifeHours` (24) and `signals.freshnessMaxAgeHours` (168): a day-old headline moves half as much, a three-day-old an eighth, a week-old nothing. Every scored signal records its `ageHours` and `freshness` in the tick summary and in the Signals force's `score_events` details.

- **Expired signals are processed, not skipped.** An event signal past the limit is never sent to the model (it would contribute nothing, so it must not cost a call), gets `scorer: "expired"` with zero impact, and is committed as processed so it cannot linger in the backlog. The selection treats it as free, like a metric, so a stale backlog drains in one tick at no cost instead of moving a score or waiting its turn in twelve-signal chunks.
- **Metric signals are never aged.** Their own baseline windows already say what is stale for them; `signalFreshness` returns weight 1 for `kind: "metric"` whatever the age.
- **Two clocks, kept apart.** This weights staleness in the *queue*, once, at the moment a signal contributes. Staleness in the *score* is Gravity's and nothing here decays a score; `config.test.ts` pins that Gravity's constant is unchanged and that no other age or decay key exists on the config.
- **The model is not shown a signal's date.** `buildSignalsBlock` can print `occurred=` and `buildSentimentUserPrompt` deliberately never passes it: the numeric weight is the one freshness mechanism, and showing the date as well would invite a second, unstated discount on a field whose quality varies by source. The model's question stays "what does this mean for this person"; "when" is the Engine's. (It *is* told today's date and the age of the person's remembered events, which is a different question — see *Memory event expiry* below.)

### Newest first, and the rotation (Phase 12+)

Selection was oldest-first, which was right before freshness existed and wrong after it: the first ticks would have spent their whole call budget on week-old signals weighted near zero while yesterday's news waited. `lib/engine/selection.ts` now takes, **within a person, the newest signals first** (the store reads the backlog by `occurred_at` descending so the ceiling's window holds what freshness weights highest), still at most one 12-signal chunk per person per tick and 48 in total. Free signals — metric, baseline, expired — are all taken whatever the order, so a stale backlog still drains in one tick at no cost.

**Which people** get a call is a separate decision, because "newest first" across people would let a subject with a steady stream of fresh signals crowd out one whose newest signal is a few hours old, forever. People are ordered by when their event signals were **last processed** (`TickContext.lastServedAtByPerson`, from the processed rows in the activity window; metric and baseline rows excluded): never served first, then least recently served, ties to the freshest waiting signal, then id. A person served this tick goes to the back; a person deferred keeps their place. With *P* people waiting, everyone is served within ⌈*P* / `callBudgetPerTick`⌉ ticks whatever anyone's stream looks like; `selection.test.ts` and `tick.test.ts` run eight streamers against one quiet person and check the first nine servings are nine different people. The order the tick used is recorded as `scoring.personOrder`.

### Memory event expiry (Phase 12+)

`memory.maxRecentEvents` (8) was only ever a size cap: an event left a person's verbatim list when eight newer notable events arrived, which for a quiet subject is months, and the model judged every new signal as routine or anomalous against it. Now `memory.maxEventAgeDays` (**30**, TUNABLE) is a clock beside the cap: at merge time an event older than that leaves the list whatever the count and is folded into the summary **with its date**; the summary prompt is given today's date and the horizon and told to write anything older as history ("in June, …"), never as the current picture; and the deterministic fallback dates every folded item. The post-tick step now visits **every** active person's memory each tick (one read), not only those with notable signals, so a quiet person's memory ages too; a memory with nothing new and nothing expired is left untouched. A person whose every event has expired keeps a valid profile: an empty list and a dated history in the summary.

The scoring prompt's person block now opens with **`Today: <date>`** and shows each remembered event with its age (`2026-09-01 (15 days ago): …`), leaving out events past the horizon; a block with no recent events simply has no events line. This is the "what is normal for this person" clock — deliberately much slower than the Signals force's 24 h half-life, a separate constant, and never unified with it (`config.test.ts` pins both).

The one-off purge that preceded this (unprocessed event signals older than 48 h, so the first real run measured the world rather than a replay) was a data operation through the Supabase MCP, deliberately not a migration, and is recorded in the conversation that ran it.

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

Memory summaries add one ~$0.003 (Opus) call per person every ~8 notable events; narratives add nothing. `llm_usage` gives the observed numbers once real ticks run, priced by `llm_cost_per_tick` against `llm_model_prices`.

**The price table.** `claude-opus-5` ($5 / $25, cache read $0.50) and `claude-sonnet-5` ($2 / $10, cache read $0.20; the launch rate is the standard rate, the increase scheduled for 2026-09-01 did not occur) are verified against Anthropic's pricing as of 2026-09-13 (migration `20260913153600_llm_model_prices_verified`); `claude-haiku-4-5-20251001` ($1 / $5, cache read $0.10) as of 2026-09-14 (migration `20260914005711_llm_prices_haiku_exact_match`). The table carries input, output, cache-read and cache-write rates and nothing else: the cache-write column is the standard five-minute multiplier (1.25 × input) rather than a verified figure, and there are no batch-rate columns because nothing here uses the Batches API. **Matching is exact.** A usage row is priced only by the row whose model string equals its own; anything else, a future `claude-opus-5-1` included, lands in `llm_cost_per_tick.unpriced_calls` instead of being quietly billed at the nearest prefix. The string a usage row carries is the one the API echoes in its response, not the one requested: Haiku 4.5's ID is dated and its alias resolves to it, so usage always hits `claude-haiku-4-5-20251001`, and the alias row `claude-haiku-4-5` (same rates) exists only so a configured alias also reads as priced. Opus 5 and Sonnet 5 have undated IDs. `GET /api/admin/health` reports `priced` per route.

**Prompt caching, honestly.** The Anthropic adapter marks the system prompt cacheable, and the cost view prices `cache_read_input_tokens` at the cache-read rate (a tenth of input) and `cache_creation_input_tokens` at the cache-write rate. But the cached prefix never forms: the sentiment system prompt is about 450 tokens and the minimum cacheable prefix is 512 tokens on Opus 5 and 1,024 on Sonnet 5, so the marker is silently ignored and every call bills its full input. The per-person memory block, the part repeated tick after tick, sits in the user turn after the varying signals, where it could not be cached anyway. At today's sizes the whole input side of a call is ~1,000 tokens, so caching everything stable would save under a cent per call; the model choice is the 5× lever, and output tokens (up to 1,500 per sentiment call at $25 / MTok on Opus) the next. `GET /api/admin/health` reports which provider, model and effort each task is routed to in the deployment's own environment.

## The heartbeat (autonomous ticking)

The Engine can tick on its own every 30 seconds, but the switch ships **OFF**.

`vercel.json` registers a Vercel Cron job that calls `GET /api/engine/cron` every minute (`* * * * *`, the finest schedule Vercel offers). The handler (`app/api/engine/cron/route.ts`) does, in this order:

1. **Checks `ENGINE_CRON_ENABLED` first.** Unless it is exactly `"true"`, it logs `skipped (disabled)` and returns `{ status: "skipped", enabled: false }` immediately: no database read, no tick, no LLM call, no cost. This check runs before authentication, so an unset flag makes the endpoint a no-op for everyone.
2. **Authenticates the caller.** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically once `CRON_SECRET` exists in the project; an operator can also call it with `ENGINE_SECRET` (`x-engine-secret` header or Bearer). Both comparisons are constant-time (`lib/api-auth.ts`). Anything else gets `401`; with neither secret configured, `503`.
3. **Runs the ticks** through `runScheduledTicks()` (`lib/engine/cron.ts`), which calls the very same `runFullTick()` the manual route uses.

### Cadence: two ticks per one-minute invocation

Vercel Cron cannot fire more often than once a minute, so each invocation runs **two** ticks: the first immediately, the second 30 seconds after the first *started* (not after it finished, so the cadence stays anchored to the minute). Per-tick fields in the log and the response include `tickNumber`, `budgetMs`, `signalsProcessed`, `attempted`, `llmScored`, `fallbacks`, `deferred`, `llmCalls`, `backlogAfter`, `partial`, `narratives` and `durationMs`.

The route declares `maxDuration = 60` and the scheduler works inside a **55-second budget**, and **every tick is handed its own deadline**: the time left in the invocation when it starts, less a 2 s reserve for the commit and post-tick that follow scoring (`runTick({ index, budgetMs })` → `runFullTick({ budgetMs })`, capped by `tick.budgetMs`). The first tick therefore scores under 25 s and the second, starting at 30 s, under 23 s; each bounds itself (no model call starts that cannot finish in time), so neither can outlive the invocation. The second tick is skipped only when fewer than `minTickBudgetMs` (5 s) remain — a runaway first tick — with a `tick skipped` log line and `skippedTicks: [{ index: 1, reason }]` in the response. A tick that throws is logged as `tick failed`, the next tick in the invocation is still attempted, and the response status is `500` so Vercel's cron dashboard shows the failure. Overlap between invocations is harmless: `apply_engine_tick` refuses a tick computed against a stale `tick_number`.

Before Phase 11 the budget was checked only before the second tick, and the first ran with no deadline at all; a first tick that took ~65 s was killed at 60 s every minute, having committed nothing.

Every invocation writes JSON lines to the function log with `"source":"engine-cron"`: `skipped (disabled)`, `tick ran`, `tick failed`, `tick skipped` and a final `invocation finished` line with `ticksPlanned`, `ticksRun`, `signalsProcessed`, `attempted`, `fallbacks`, `deferred`, `llmCalls`, `backlogAfter`, `failures`, `skippedTicks` and `durationMs`.

The numbers live in `CRON_DEFAULTS` (`lib/engine/cron.ts`): `ticksPerInvocation: 2`, `spacingMs: 30000`, `budgetMs: 55000`, `commitReserveMs: 2000`, `minTickBudgetMs: 5000`. Setting `ticksPerInvocation` to `1` gives a plain 60-second heartbeat.

### Enabling it later

Nothing ticks until you do all of this in the Vercel project:

1. Make sure the Engine's own variables are set for Production: `SUPABASE_SERVICE_ROLE_KEY`, `ENGINE_SECRET`, and for LLM scoring `ANTHROPIC_API_KEY` (or set `SCORER=rules` to run without any LLM cost).
2. Add `CRON_SECRET` (generate with `openssl rand -hex 32`). Vercel attaches it to every scheduled call.
3. Set `ENGINE_CRON_ENABLED` to `true` (exactly that string).
4. Redeploy so the new values are baked in. Vercel picks the schedule up from `vercel.json` on deploy; check **Project → Settings → Cron Jobs** to confirm `/api/engine/cron` is listed.
5. Watch the function logs for `"source":"engine-cron"` lines and `engine_ticks` rows appearing every ~30 seconds.

To pause: set `ENGINE_CRON_ENABLED` back to `false` (or delete it) and redeploy. The cron keeps firing but every call returns `skipped (disabled)` in a few milliseconds.

Plan note: per-minute cron schedules require a Vercel **Pro** plan (Hobby is limited to daily jobs and would silently run the job once a day). `maxDuration` stays at 60 on purpose: a tick bounds its own work to its deadline, so more room is not what a backlog needs.

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

The score line is built for a 30-second cadence, not a sub-second one. Between ticks the line is still and a leading-edge dot at the last point breathes: a halo that swells and fades over exactly one 30-second cycle, phase-locked to the banner countdown (the CSS animation runs on the wall clock with a negative delay, so both reset at the same instant). At the tick the page polls `/api/person/[slug]/live` for ticks newer than its last point; when one lands the line grows into the new value over 700 ms with an ease-out curve, the dot travels to the new point, the axis domains glide rather than jump, and the window slides: points older than the range fall off the left edge and the series is capped (`MAX_LIVE_POINTS`) so the DOM and memory stay flat. The line is monotone cubic, white, unfilled; colour lives only in the change figure above it. The y-axis clamps to the data but never spans fewer than `Y_RANGE_FLOOR` = **0.5 points** (2.0 until Phase 14, when the first 24-hour run showed that floor to be roughly 700 times the mean tick move, and every line read flat), so a 0.02-point move stays a flicker instead of a cliff. Half a point is the Engine's own unit of notable (the Feed's pin threshold, `narratives.minAbsChange`): a notable move fills the chart, a routine signal about half of it, a quiet hour of Gravity a fifth. The floor is absolute on purpose, not relative to recent volatility: a floor set from the window's own volatility would never bind (it only matters when the data span is smaller than it), and one set from a longer window would make a quiet hour look as dramatic as a wild one, which is the difference the chart exists to show. `prefers-reduced-motion` removes the pulse and applies each tick directly. With no history the empty state stands; nothing is synthesised.

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

Two kinds of entry share the stream, and both speak as the Engine. A **narrative** is a sentence the Engine wrote when a score moved meaningfully in a tick, shown exactly as stored, with the move it recorded and, as evidence, exactly the signals the Engine linked to it when it wrote the sentence (`narrative_signals`, decided at generation time in `lib/engine/narratives.ts`: every signal in the batch behind an LLM sentence, the non-zero signals behind a template sentence that quotes a headline, none behind a move carried by Gravity, Market Mood, Conviction or Trading Activity; an inverse-pair sentence links the paired person's signals, marked as theirs). Nothing is inferred from timing, and there is no fallback: a narrative with no links shows no evidence. A **signal** is a raw observation no narrative links to directly: not yet processed, or processed without producing a sentence. Raw headlines from connectors, and the RSS feed in particular, can read like news, so a signal entry is framed in presentation only — *A YouTube signal on Drake read +0.2.* once the Engine has read it; before that, the placeholder *Something new on Drake, waiting for the Engine's next read.* — with the headline quoted beneath it. Stored text is never rewritten. Source attribution is the last, smallest, greyest line of every entry: *The Engine · via YouTube*, *Observed via RSS*; the placeholder deliberately does not name the source, since that line already does.

### The entry

Avatar, name and category (a link to the person); the Engine's sentence as the hero; the recorded score impact, the only colour in an entry (green up, red down), beside a recessive relative time; the attribution line; and a quiet *What the Engine saw* that opens the evidence beneath. Entries sit in one card separated by hairlines, with generous vertical rhythm: this is a surface people scroll for minutes.

### Notable moves

An entry whose recorded impact is at or beyond **`HIGH_IMPACT_THRESHOLD` = 0.5 points** in either direction, within the last `PINNED_WINDOW_HOURS` (24), takes the pinned treatment at the top. The value was 1.25 until Phase 14, when the first 24-hour run made it answerable: 45,360 score moves, none of them reaching 1.25 (the largest was exactly 1.25, once, on a backlog tick), nine clearing 0.5, a mean move of 0.28 when anything moved at all. Half a point is the Engine's own unit of notable (`narratives.minAbsChange` and `memory.notableImpactThreshold` are both 0.5), about twice a routine signal's move, and on a day like that one it qualifies roughly ten moves across the covered subjects, of which the three strongest pin. The pinned treatment is: the same composition set larger, with more air, at most `PINNED_MAX` (3), strongest first, and taken out of the stream below so nothing appears twice. Structural prominence only: no banner, no badge, no colour beyond the direction rule. When nothing qualifies the section does not exist. All three are named constants in `lib/feed/feed-model.ts`, to be retuned once real signals exist.

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

**The metric scorer.** `lib/engine/sentiment/metric.ts` sits beside the sentiment scorers behind the same `SentimentScorer` interface: `confidence = clamp(|σ| / 3 × scale, 0, 1)`, `direction = polarity × sign(σ)`, and the Signals force computes `baseImpact × tier × confidence × direction` exactly as for a headline, so metric and news signals flow into one force with the source tier as the relative weight (official APIs tier 2, viewer comments tier 4; an RSS item carries its own tier, resolved from its publisher, see [RSS signal quality](#rss-signal-quality-phase-8)). The Engine routes by what a signal *is* (payload `kind: "metric"`), never by where it came from; the LLM scorer's prefilter sends a metric signal to the metric scorer too, and the keyword scorer refuses to give one a direction.

**The privacy rule, schema-enforced.** A metric signal stores direction and normalised magnitude only: the headline reads "MrBeast's YouTube subscriber growth is running +1.4σ above their own trailing week", the payload is limited to an allow-list (`kind, metric, label, sigma, direction, polarity, samples, min_samples, window_hours, delta_kind, threshold_std_devs, scale, source`), and the `signals_enforce_metric_privacy` trigger refuses any other key, a missing polarity, a non-numeric sigma, or a headline carrying a run of four digits, a thousands grouping or a compact count. Raw levels live in `raw_source_snapshots` and `raw_metric_observations`: no grant, no policy, service role only; `lib/ingest/privacy.db.test.ts` asserts on real Postgres that no function or view the user roles can reach references them, and that no page, component or user-facing read in the app does either. The narrative layer only ever sees normalised values: the sentiment prompt's payload allow-list (`PAYLOAD_KEYS`) carries no level, previous level or delta, and a test feeds it a payload full of raw counts and asserts none reach the prompt; memory and narratives are built from headline, label and impact alone.

**Per-person signal volume.** Once several sources feed one person, the number of signals in a tick says more about the sources than the person, so the Signals force (a) keeps at most `maxPerSourcePerTick` (3) non-zero signals per source, the strongest, and (b) divides the sum of the kept signals by `count^volumeExponent` (0.5): four signals of one strength read twice one of them, not four times. Before either step, metric signals from one source that share an `occurred_at` are folded into one reading carrying the mean of their impacts (`oneReadingPerMetricMoment`, Phase 13+): the three per-game figures of one football game are one performance, and the fold keeps them from taking three cap slots and reading as √3 of one reading. The assumption is that a tick's signals about one person are partially redundant evidence of the same day and combine like noise, in quadrature. Where it is weak: it still grows with the number of sources, so adding sources to a person raises their ceiling; it cannot tell a genuinely busy day from four outlets covering one story; it dilutes a lone strong signal beside weak ones; and the source cap may drop a real second story on a three-story day. The honest fix is to normalise each person's signal volume against their own trailing volume, the same baseline the metrics use, once there is history to build it from.

**Observability.** Every run (`ingest_runs`), every poll (`source_polls`: source, person, ok / error / skipped with the reason, latency, what it produced) and every observation (`raw_metric_observations`: level, previous, delta, baseline mean and sd, sigma, samples, outcome, the signal it produced) is recorded and logged as a structured `[ingest]` line, so a score move can be walked back from `score_events.details.signals[].impact` to the signal to the observation to the poll. `source_health` (a view) gives last poll, last success, last error and its reason, the trailing-day poll count, error rate and latency per source; `llm_cost_per_tick` prices `llm_usage` by tick (the sentiment scorer now stamps the tick number on its usage rows) against `llm_model_prices`, and says how many calls had no price row. `GET /api/admin/health` returns all three.

**Running it dry.** The cron stays off. `POST /api/ingest?force=1` with `INGEST_SECRET` runs every active source once: the first run produces snapshots, first-contact observations and no metric signals; later runs produce `insufficient_baseline` observations until `min_samples` is reached, then `inside_band` or, on a real move, `emitted` with a σ signal. Nothing here advances a score; a signal waits for a tick.

## RSS signal quality (Phase 8)

The first manual run showed what a news search feed is: a paper of record, a music blog and a scraped page side by side, and one story under eight URLs. Both feed the sentiment scorer, then the Signals force, then the score; and news volume is a baselined metric, so a run on bad input teaches the baseline a wrong normal. Three corrections, all at ingestion, before anything scores.

**A tier per item, from the publisher.** A data source's tier is right for an API and wrong for a feed, so an RSS item now carries its own. The connector names each item's **publisher domain**: Google News wraps every link in a `news.google.com` redirect and names the publisher in `<source url="…">`, which is what is read (never the link's host when that host is a wrapper); a direct outlet feed's items use the link's host. The runner resolves the domain through **`publisher_domains`**, a table and therefore configuration: an `allowed` row carries the tier its items take; a `blocked` row drops the item before scoring, and the drop is logged with the domain and the headline; a domain with no row is **still accepted, at the floor tier (5, the weakest multiplier)**, so an outlet nobody thought to list contributes faintly rather than not at all, and the log shows which unknown domains keep appearing. Domains are normalised (lower case, no `www.`, no trailing dot; the table refuses anything else) and matched by walking up: `music.example.com` resolves through `example.com` unless a more specific row exists, so a subdomain can be blocked under an allowed parent. The tier is stored on `signals.tier` and the Engine reads `coalesce(signals.tier, data_sources.tier)`; every other connector leaves the column null and keeps its source's tier exactly as before. Adding or blocking a domain is one row, no deploy.

The seed is small on purpose (`20260914021237_phase8_rss_signal_quality.sql`): tier 1 for the wires, the papers of record and the major trades (AP, Reuters, BBC, the Times, the Post, the Guardian, the Journal, Bloomberg, CNBC, CBC as Drake's home press, Variety, The Hollywood Reporter, Billboard, Rolling Stone); tier 2 for the established music, entertainment, creator-economy, tech and marketing press (Pitchfork, Complex, Stereogum, NME, The FADER, XXL, HipHopDX, The Needle Drop, VICE, People, USA Today, the Toronto Star, The Verge, TechCrunch, Business Insider, Forbes, Tubefilter, Adweek, Digiday, Marketing Dive, Campaign, Slate, IGN, Polygon); tier 3 for music and creator blogs with an editorial desk and the celebrity press (HotNewHipHop, The Source, Rap-Up, Dexerto, 9to5Google, The A.V. Club, Just Jared); and one blocked domain, the Argentine government ombudsman site the first run found serving scraped Drake concert copy. Everything else is unknown until curated upward.

**One signal per story.** A story syndicates under many URLs, so `dedupe_key` (guid or link) is not story identity. `lib/ingest/stories.ts` reduces each headline to its content words (the outlet suffix Google News appends, the person's own name, stop words and inflection removed) and compares two headlines with the Sørensen–Dice coefficient; at or above **`STORY_SIMILARITY_THRESHOLD` = 0.4** they are one story (lowered from 0.5 after two production runs). Deduplication runs within a poll and against the signals already stored for that person and source inside **`STORY_DEDUP_LOOKBACK_HOURS` = 48**, and two items published further apart than that are never one story. Items are considered best publisher first, so the survivor of a cluster is always its highest-tier copy (then the earliest): a tier-1 outlet and three farms survive as the tier-1 item. A story is a cluster, and an item joins the cluster holding the member it is most similar to (single linkage), which follows a chain of rewordings that the survivor alone would not match. A copy of a story already stored is collapsed into the stored signal; when the copy comes from a better tier and the Engine has not read the stored signal yet, the stored signal is upgraded in place (tier, headline, payload) rather than joined by a second one. `news_volume_24h` counts distinct, non-blocked stories under the same rule, so the baseline learns stories, not URLs. The trade-off, stated: bag-of-words similarity cannot tell "opens a theme park" from "closes the theme park" when both are short and inside the window, and it cannot join two outlets' entirely different framings of one event; the threshold is the knob, and the Signals force's per-source cap and square-root sum still damp what slips through. Both directions are tested: syndicated copies (including the first run's eight-outlet story) collapse; different stories about the same person on the same day do not.

**Observable.** Every drop (`event: "drop"`, with the domain and what it matched) and every collapse (`event: "collapse"`, with the similarity and what it collapsed into) is a structured log line; every stored event signal logs its publisher domain, tier and whether the tier was known or the floor; `source_polls` and `ingest_runs` carry `blocked_dropped` and `duplicates_collapsed`, and `source_health` sums them over the trailing day (`blocked_24h`, `collapsed_24h`); the run summary returned by `/api/ingest` carries both totals. The signal itself carries `publisher_domain`, `publisher_domain_from`, `publisher_tier`, `publisher_status` and `publisher_matched` in its payload.

**The placeholder.** A signal entry the Engine has not read said *An RSS signal on X is waiting for the Engine's next read.* above an attribution line reading *Observed via RSS*: the same fact twice. The placeholder is now *Something new on X, waiting for the Engine's next read.*; the attribution stays, and a signal the Engine has read, or a narrative, renders exactly as before.

**Backfill.** The first run's 60 RSS signals predate all of this and were not touched: under the new rules 1 would be blocked, 24 would sit at the floor tier and 13 would collapse as duplicates, leaving 46. Whether to purge and re-ingest or leave them is a decision recorded outside this file; nothing downstream depends on them yet, since no tick has run.

## Connector corrections (Phase 8+)

Four corrections the first two production runs made visible. All change what enters the pipeline, so all land before the cron.

**Comments aggregate, one digest per video.** A single viewer comment is one person's reaction to one video — *"Cameramen deserve a huge bonus"* is praise for the editing, not information about a person's momentum — and one signal per comment buried everyone else's news in the Feed. `lib/ingest/comments.ts` now aggregates a video's sampled comments into ONE event signal: *Comments on MrBeast's "Escape 100 Cops, Win $500,000" lean positive, 10 sampled.* The comments themselves are kept in the payload as evidence and are never the hero text of anything. The lean is counted with the Engine's own keyword lexicon (`scoreHeadline`), **injected** rather than imported so the ingestion layer keeps no dependency on the Engine; counting is not judging, and `applyPayloadHints` still turns the distribution into a direction and a confidence the way sigma does for a metric. The dedupe key fingerprints the sampled comment ids, so at most one digest per video per poll and none at all when the sample has not moved. A caveat worth knowing: the lexicon is tuned for news headlines, so most casual comments score neutral and a digest usually reads *are mixed* until the lexicon learns the register.

**Comment volume is its own metric.** How much an audience is reacting and which way it leans are different measurements, and a surge in count is arguably the stronger one because it says something happened regardless of what was said. `comment_volume` reads the REAL total comment count across the newest uploads (`videos.list` statistics), never the capped sample a digest reads — a sample could never show a surge. It normalises through the shared baseline like every other metric, with the same 336-hour window and 24-sample minimum as `news_volume_24h` and `commentary_volume_24h`.

**Spotify can no longer be silent.** Two runs polled it, reported `ok` in 130 ms and produced nothing: no snapshot, no observation, no error. The registration was never the problem — both metrics were declared, the mapping was active, the connector ran. The only non-throwing path to an empty reading list was an artist response carrying an id but neither `popularity` nor `followers`, so that path now throws, naming the fields the response did carry, and the poll is recorded as an error with its reason.

**Declared inputs.** A metric that is the `from` of a `config.derived` entry and carries no declaration of its own is an INPUT: snapshotted forever and never scored, on purpose. `readMetricConfigs` names them (`inputs`), and the observation log line carries `inputFor`, so YouTube's `video_count` — the history `upload_rate` is computed from, which needs 160 hours of it before the derived metric can say anything — reads as a declared input rather than an oversight.

## The ingestion cron and the operator console (Phase 9)

### Spotify, for the record

The connector was **already calling `GET /v1/artists/{id}` directly** — `lib/connectors/spotify.ts` builds `https://api.spotify.com/v1/artists/<id>` and reads that response; there is no track, album or search call anywhere in the file, and no nested `artists[]` array is read. The field list the Phase 8+ error printed (`external_urls, href, id, images, name, type, uri`) includes `images`, which Spotify's *simplified* artist object does not carry, so what came back was the **full** object minus exactly its three computed fields — `followers`, `genres` and `popularity`. That is an app-level restriction on the credential, not the wrong endpoint: a wrong token 401s, a wrong id 404s, and a simplified object read out of a nested context would have been missing `images` too. The class of mistake worth recording is therefore the diagnosis, not the code: *an endpoint that returns 200 with fewer fields than documented looks exactly like a code bug and is not one.*

What changed anyway: the single-artist read is now a shared reader, and if it comes back without both a popularity and a follower count the connector tries the plural form (`GET /v1/artists?ids=<id>`) before giving up — different Spotify access modes have historically differed between the two, and it costs one extra call only on a path that was about to fail. When neither carries a level the Phase 8+ error still throws, now naming the endpoint it read as well as the fields it got, so the poll is recorded as an error with its reason rather than silently producing nothing. `popularity` and `followers.total` are both read and both snapshotted.

### Two crons, two flags

`vercel.json` now registers two schedules, and they share nothing:

| Job | Path | Schedule | Flag | Cost |
|---|---|---|---|---|
| Engine | `/api/engine/cron` | `* * * * *` | `ENGINE_CRON_ENABLED` | model calls |
| Ingestion | `/api/ingest/cron` | `*/15 * * * *` (hourly until Phase 13) | `INGEST_CRON_ENABLED` | none |
| Live mode (Phase 16) | `/api/ingest/live` | `* * * * *` | `INGEST_CRON_ENABLED` (shared) plus the source row's `config.live.enabled` | none |

Both ship **unset, which is off**; only the exact string `"true"` enables either. That separation is the point: baselines need a week of history and 24 samples before most metrics say anything, and ingestion can fill that while the Engine stays dormant and nothing costs.

`GET /api/ingest/cron` does three things in this order, and the order matters:

1. **The flag, before anything else.** If `INGEST_CRON_ENABLED` is not `"true"` the handler returns `{ enabled: false, status: "skipped", reason: 'INGEST_CRON_ENABLED is not "true"' }` immediately — no auth check, no database connection, no poll. So the flag's state is observable from outside without holding a secret, and a disabled endpoint cannot be made to do work by anyone.
2. **Authentication.** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; `INGEST_SECRET` is also accepted (`x-ingest-secret` or the same bearer header) so the job can be exercised by hand. `ENGINE_SECRET` is deliberately *not* accepted: the two jobs do not share an authority. Nothing here needs a human to paste a secret into curl — the platform supplies it.
3. **The overlap guard.** An `ingest_runs` row with `finished_at is null` started inside the last 10 minutes (15 until Phase 13) means a run is still in flight, and this invocation returns `status: "skipped", reason: "a run is already in flight"` instead of polling everything twice. The staleness window is what stops a crashed run from blocking the schedule forever: above the route's 60-second `maxDuration` so a live run always wins, below the fifteen-minute schedule so a crashed run is already past the window by the next fire and blocks nothing.

**No model call happens on this path.** `lib/ingest/cron.test.ts` asserts it by reading the source: no file under `lib/ingest` or `lib/connectors`, and neither ingest route, imports `@/lib/llm`, a relative `llm` module, or `@anthropic-ai/sdk`. Sentiment scoring, narratives and memory all live behind the Engine's tick, which this job never enters. The manual `POST /api/ingest` is unchanged and still works exactly as before; the cron is a second door onto the same runner.

### The operator console

`/admin` is **its own route tree**, outside the `(app)` group, and that is structural rather than cosmetic. The Phase 7 auth gate is one file that gets deleted when the beta opens; anything living inside the main tree becomes public at that moment. Here the role check is the only thing that has ever guarded these routes, so removing the gate cannot expose them.

Access is the existing Supabase session plus `users.is_admin`, checked **server-side in the layout and again inside every single read** (`lib/admin/data.ts` calls `requireAdmin()` before it constructs the service-role client, so a non-admin never reaches a query — the privileged client is not even built). A non-admin gets **404, not 403**: a 403 advertises that the route exists. The flag was granted **by migration** (`20260914165502`, `update public.users set is_admin = true where email = 'anthonyjbv1@gmail.com'`), not by a one-off service-role action, so it is reproducible on a fresh database. It cannot be self-granted: the `authenticated` UPDATE grant on `users` covers `username`, `display_name` and `avatar_url` only, and every operational relation the console reads (`llm_usage`, `llm_model_prices`, `llm_cost_per_tick`, `ingest_runs`, `source_polls`, `source_health`, `metric_baseline_progress`) grants nothing at all to `anon` or `authenticated`. Both halves are tested — the application half in `lib/admin/access.test.ts`, the SQL half in `lib/admin/access.db.test.ts`.

Five sections, dense tables, its own stylesheet (`app/admin/admin.css`, scoped under `.adm`) that references no consumer token and is imported by nothing else — the editorial monochrome system is untouched:

- **LLM cost and usage** — total cost, calls and tokens by window; by model and by task type; cost per tick with the per-task split; a daily trend. The **unpriced-calls counter is a headline stat**, names the offending model strings, and is never folded into a total: unknown is not zero.
- **Ingestion health** — per source: last success and its age, last poll, trailing-day polls, errors, error rate, latency, signals, blocked drops, collapsed duplicates, and the last error or skip reason; the recent runs; the recent poll errors with their messages. And the clock: **per-metric baseline progress**, samples against the minimum and span against the window, each as a number and a meter, with the state (`emitted` / `inside_band` / `insufficient_baseline` / `first_contact` / `no_config`) spelled out.
- **Engine state** — both crons named separately with their schedules and paths, never conflated; tick count, last tick, mean latency; the recent ticks with what moved and by how much; the score distribution.
- **Risk levers** — the six from 6e plus the notable-move threshold and the Signals impact brake, read-only. There is no form and no write path on this page at all, and a test asserts the absence.
- **User behaviour** — active users, sessions, events by type, most-viewed people, feed engagement (impressions, distinct entries, dwell, scroll depth, filter changes, tap-throughs, expands), and the trade funnel with the **abandon-to-trade ratio** called out.

**The privacy rule holds here.** Admin is a user-facing path, so no raw metric level appears on it. Baseline progress is read from `metric_baseline_progress`, a view whose columns are counts, configuration and timestamps — `value`, `previous`, `delta`, `mean`, `sd` and `sigma` are not columns of it, so a level is not selectable through it even by mistake. No file under `app/admin`, `components/admin` or `lib/admin` names either raw table; the existing whole-repo scan in `lib/ingest/privacy.db.test.ts` still resolves to `lib/ingest/store.ts` alone.

## Twitch and API-Sports (Phase 10)

Two more tracked subjects, chosen for having data shapes the first two do not: **Kai Cenat**, a creator whose primary platform is Twitch — high cadence, high variance, live most days — and **Patrick Mahomes**, an athlete on a weekly, scheduled, outcome-bearing calendar. Both were already among the sixteen seeded people with the right categories, so Phase 10 configures and maps; it inserts no person and no data source. Both also take curated RSS, which needed no new connector and started producing on the first run after the migration.

### The sampling problem, and what it decided

A live stream either is or is not running at the moment we poll. Hourly polling samples that unevenly and without control: a six-hour broadcast is caught six times, a ninety-minute one once or not at all, and concurrent viewers read at an arbitrary minute is one point on a curve that ramps and decays. Fed to the baseline machinery — mean and standard deviation over a trailing window — an instantaneous viewer count yields a distribution dominated by the online/offline mixture rather than by the audience, and its sigma would describe the cron schedule rather than the person. **So no instantaneous reading is registered as a metric.** Every Twitch metric is one of two robust shapes:

| Metric | Shape | Why the polling moment cannot distort it |
|---|---|---|
| `follower_count` | cumulative, monotone | the same answer at any minute; `relative_rate` over a 168-hour window, 24 samples |
| `stream_hours_7d` | retrospective window aggregate | total broadcast hours in a fixed trailing week, read from the archive of completed streams |
| `stream_days_7d` | retrospective window aggregate | distinct days streamed in that week — cadence rather than volume |

The two aggregates are computed from `/helix/videos?type=archive` and attributed by **start** time, so a broadcast spanning the window's edge is counted whole in the week it began and never split between two polls. That is the same shape as `news_volume_24h`, which is why they can take the ordinary baseline treatment without it meaning something different. The spiky fact — live right now, to this many people — is not discarded: it becomes an **event**, one signal per broadcast keyed on the Twitch stream id, so a six-hour stream caught by six consecutive polls stores once and the viewer count rides in the payload where it is an observation about a moment rather than a level pretending to have a baseline.

One deliberate refusal: an **empty** archive records no aggregate at all rather than a zero. A channel with VODs disabled or past retention returns no videos, and writing "0 hours streamed" would put a false level into the baseline and make a busy week read as a collapse.

### Metric versus event, on a weekly sport

A season is scheduled, periodic and outcome-bearing, which is a shape nothing else here has. **Game results are events**: discrete, dated, and already in language the sentiment path reads, one signal per game keyed on the game id, the week in the headline (`Week 1: Kansas City Chiefs beat Denver Broncos 31-10.`) and the stage in the payload. **The metrics are per-game figures**, read from the **per-game** statistics endpoint (`/games/statistics/players?id={game}`) one finished game at a time and recorded *at the game's date*, so `samples` in the baseline counts performances and not hours. Which figures, and where each lives in the response, is `config.game_stats` on the row (a metric key to a group and statistic name), each key with its own declaration in `config.metrics`. A game is never recorded twice: each metric keeps its own anchor (its last recorded snapshot), a game is fetched when some metric still needs it, and every metric that does is read from that one response, up to `recent_games` on a backfill (older ones queued as snapshots at their dates, the newest observed). A metric registered later therefore backfills the games the others already have and stays in step with them from then on.

**Three figures, and why these (Phase 13+).** Yards alone is a thin proxy: his return game was 184 yards, 2 TD, 1 INT, a 50.2 rating, in a 31-10 win — mediocre on yards, a triumph in every news signal. Registered now:

| metric | polarity | what it is |
|---|---|---|
| `game_passing_yards` | +1 | volume; unchanged (`sd_floor` 25, `scale` 0.8) |
| `game_passer_rating` | +1 | the performance figure: the league's own composite of completion rate, yards per attempt, touchdown rate and interception rate, bounded 0–158.3, so a bad line reads negative on its own (`sd_floor` 12, `scale` 1.0) |
| `game_interceptions` | −1 | the one axis the rating formula dampens (its interception term saturates), discrete, and the failure a bad game announces itself with; an integer 0..4 with a mean near 0.7, so `sd_floor` 1.0 keeps a month of clean games from turning one interception into a catastrophe (`scale` 0.7) |

Passing touchdowns are deliberately **not** registered: the rating already carries the touchdown rate and the game-result event already carries the scoring, so a fourth reading would be one more copy of the same performance. Nothing composite is registered — `"15/27"` (completions/attempts) and `"2-12"` (sacks/yards lost) are refused by the parser, so a `game_stats` entry pointing at one fails the poll out loud rather than recording 15 or 2.

**One game, one reading.** Three figures of one game are one performance, not three pieces of evidence. Without a rule they would take three of the source's cap slots and, summed and divided by √3, read as √3 of one reading: a busier week than it was. So the Signals force folds metric signals from one source that share an `occurred_at` into **one reading carrying the mean of their impacts**, before the per-source cap (`config.signals.oneReadingPerMetricMoment`, on by default; the strongest member stands for the moment, the members stay visible in the tick's details). The mean rather than the strongest, so a mixed line (rating down, yards up) reads mixed. Event signals are never folded: the game's result and its stat line stay two readings.

**What the metric path cannot see.** A per-game figure is judged against the player's own trailing games and nothing else — not the score, not the opponent, not whether the team won. Context is the event's to carry. The two meet only in the Signals force, where a poor line in a big win (say −0.4 for the folded line) and a "commanding win" headline (+1.35) are summed and partly cancel; nothing reconciles them, and a divergence between the stat line and the news on the same game is a limitation to expect, not a defect.

**Preseason does not count.** Games whose `stage` is in `config.excluded_stages` (default `["Pre Season"]`, matched ignoring case, spaces and punctuation) produce neither the metric nor an event. Filtered rather than down-weighted: a preseason game is not a performance sample (starters play a series or two, and three such samples would reach a third of `min_samples` with noise), a preseason tie is not news, and there is no honest weight for a game that says nothing. Postseason games count in full.

What is deliberately **not** registered, and why it never would have worked: season cumulative totals (passing yards, touchdowns, completions to date) are monotone step functions, flat for a week and then a jump. Snapshotted against their own trailing series they give a standard deviation pinned to the sd floor and a maximal signal on every single game — an expensive way of saying "a game happened", which the event says better. Season completion percentage fails the other way: a running aggregate over hundreds of attempts barely leaves its own mean, so it would never emit however the season went.

**What can emit inside a season.** All three declare `min_samples: 8`, reachable at his eighth recorded game — roughly the season's halfway point, early-to-mid November — with a 1680-hour (ten-week) window wide enough to hold eight games. That was the test every candidate had to pass: a metric needing the platform's usual 24 samples would need twenty-four games, which is longer than a regular season. The minimum is the same for every per-game figure on purpose: the sample count is the number of games whichever figure is asked, and what differs between the figures is their noise, which is the `sd_floor`'s job and not the minimum's. Until the eighth game every poll records `insufficient_baseline` observations for all three, and nothing about a score changes.

**Request budget.** Per poll: the `/status` probe (cached six hours per process), the season statistics, the games list (fetched once and shared by the event and metric reads) and one per-game statistics call for each finished counted game not yet recorded — one a week in season, up to `recent_games` on a first backfill. The interval is 40 minutes since Phase 13 (175 before): every third fire of the fifteen-minute cron, so a final is caught within 45 minutes at a freshness weight of 0.98, at about 130 requests a day; the key is on the Pro plan (7,500 a day), and the free plan, which allows 100, does not serve the current season at all.

**The paths are configuration.** api-sports.io is refused by this environment's egress proxy on every domain, so the endpoint paths and statistic field names were written without a live response. They live on the `data_sources` row rather than in the connector for exactly that reason — a path that turns out wrong is a one-row update, not a deploy — and every read validates the envelope (including the `errors` payload API-Sports returns *with a 200* for a wrong key or an unsubscribed sport) and throws naming what actually came back.

**What the first live responses taught (2026-09-17).** The Pro key resolved player 1197 and the season endpoint returned one entry, and the statistic was not under any dotted path because the American Football host does not key statistics at all: it returns named **groups** of name/value pairs, in two arrangements — the season endpoint's `teams[0].groups[{name: "Passing", statistics: [{name: "yards", value: "3,587"}, …]}]`, and the per-game endpoint's `groups[{name: "Passing", players: [{player: {id: 1197}, statistics: [{name: "yards", value: "184"}, …]}]}]`, one entry per team — with `yards` repeated under Rushing and Receiving in both. One reader (`readGroupedStatistic`) handles both: a statistic is addressed by **group and name** (`config.passing_yards_stat` for the season total, `config.game_passing_yards_stat` for the per-game figure, both defaulting to `{group: "Passing", name: "yards"}`; the dotted `passing_yards_keys` kept as a fallback for a keyed shape), and where a group lists players the player id selects the line — no special-casing by URL. Values are **strings with thousands separators** and sometimes **composite** (`"15/27"`, `"2-12"`): `parseStatValue` accepts exactly the numeric grammar and refuses the rest out loud (`"3,587"` is 3587 and can never come back as 3; `"15/27"` can never be registered as 15; an unparseable value fails the poll naming the game and the value, a missing one names the groups and statistics present, and a game the player did not appear in is skipped). The season endpoint carries **last season's totals** under the current season number until the new season accrues (14 games' worth on 17 September), while the games and per-game endpoints are current — one more reason the metric comes from the per-game read; the season total is still snapshotted raw, once per change, under `season_passing_yards` (no observation, no signal) as the fallback. The games list is fetched once per poll and shared by the event and metric reads; with `team_id` on the row, the event read makes no season-statistics request at all.

The same day fixed a runner fault the failure exposed: events and metrics are two reads of one source, and a metrics failure used to abort the poll before the events were stored, so every finished game fetched for a day was lost. A metrics failure is now recorded as an error poll with its queued snapshots discarded, and the events go through.

### Poll intervals below the hour

The runner skips a source when `minutes since last poll < poll_interval_minutes`. The ingestion cron fires on its period and the previous run's poll lands a few seconds after it, so a period later the check sees a fraction **less** than the period: an interval that is an exact multiple of the period always loses that race and the source polls half as often as its interval claims. On the hourly schedule both Phase 10 rows sat off the multiple (55 for Twitch, 175 for API-Sports). Since Phase 13 the period is fifteen minutes and the rule is `poll_interval_minutes % 15 !== 0`, asserted for every active source: 10 (`rss`, `publisher_rss`) polls on every fire, 40 (`apisports`) every third, 55 (`youtube`, `youtube_comments`, `twitch`) every fourth — the hour.

### Credentials

`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` (Helix app access token, Client Credentials — no user auth) and `APISPORTS_API_KEY`. Each connector's `available()` reports the missing variable by name, the runner marks that source inactive for the run with the reason on the poll row, and the run carries on: RSS for both subjects is unaffected, so their news baselines accumulate from day one whatever else is unset.

## Entity disambiguation

A person-scoped news feed searches for a NAME, and a name is not an identifier. The Drake feed returned

> Michigan State Adds Non-Conference Game Against Drake

which is Drake University's athletics programme, not the musician. This is worse than the junk-publisher problem Phase 8 solved: the outlet is legitimate, so the allowlist cannot catch it, and the item is a genuinely distinct story, so story dedup cannot either. It inflates `news_volume_24h` — a metric being baselined right now — and it hands the sentiment scorer text about a different entity, so a Drake University loss reads as bad news about the artist. It is structural for any subject who shares a name with another entity, which is most people.

**Where the rules live.** `person_data_sources.config` — the per-SUBJECT half of a source's configuration, where `data_sources.config` is the per-SOURCE half. Which other Drake this is, is a fact about Drake and not about RSS. Adding a term is an update to one row.

**Where filtering happens, and why both.**

1. **At the query**, for Google News searches, which accept `-term` and `-"a phrase"`. What the feed never sends costs nothing to discard, and it leaves room in a fixed-size window for items that are actually about the subject. Anything that is not a single plain word is quoted: `-non-conference` would otherwise put a second minus inside the term.
2. **Post-fetch**, over the headline and outlet, for everything the query misses and for feeds that are not Google News searches. This runs in `loadFeed`, ahead of the split into signals and the volume metric, because **both must see the same admitted set** — filtering only the signals would fix the Feed and quietly corrupt the baseline.

**What it can and cannot do.** The production example is instructive: it carries neither "Drake University" nor "Bulldogs", and only `non-conference` gives it away. So exclusions have to cover the DISCOURSE the wrong entity lives in, not just its name. What no substring rule catches is an item naming neither — "Drake beats Bradley 70-65" would pass. `require_any` is the lever for that (an item must then carry at least one context term), deliberately left empty for every subject seeded so far: a legitimate story often carries none of the obvious context words, and refusing a real signal is worse than admitting a rare wrong one.

**Visibility.** Each refusal is logged as `[ingest] {"event":"exclude","person":...,"term":...,"headline":...}` and counted onto `source_polls.excluded_filtered`, `ingest_runs.excluded_filtered` and `source_health.excluded_24h`, with an **Excluded · 24h** tile in the operator console — the same treatment blocked domains get. Over-filtering shows up as that count climbing while `signals_created` falls.

## Publisher-direct feeds and the fifteen-minute pulse (Phase 13)

### The aggregator delay

Google News routinely surfaces an item one to three days after the outlet published it, so a real story reaches the Engine already discounted by the Phase 12 freshness curve. The live case: Mahomes' Week 1 win was scored at a freshness weight of **0.245** because it was 48.8 hours old when read; caught promptly it would have carried about 0.92. A publisher's own feed carries the timestamp the outlet wrote and no aggregator in between.

### The inversion, and what it costs

A section feed gives **all** of that section's coverage and the platform filters for the subjects' names, instead of searching for a name and taking what the aggregator ranked. More in, better timestamps, better provenance — and the tier is trivial, because the feed's domain is the publisher and every item resolves through `publisher_domains` like any other. The costs, all bounded and all stated:

- **Request volume is per feed, not per subject.** Every catalogue feed is fetched every poll whether or not it mentions anyone: 69 feed rows every fifteen minutes is about **6,600 requests a day**, against roughly 380 for the four Google News searches at the same cadence. The catalogue is fetched **once per run** and shared across subjects (a module cache keyed on the run's clock, as the API-Sports games list is), at a concurrency of 8, with an 8-second timeout per feed and a 20-second budget for starting fetches; feeds not started inside the budget wait for the next poll, never-fetched and longest-unfetched first so nothing is starved. Conditional requests (`If-None-Match` / `If-Modified-Since` from the last fetch's validators) let an unchanged feed answer 304. A feed that keeps failing backs off — fifteen minutes per consecutive failure, capped at three hours — so a dead URL costs one request an hour, not four.
- **Filtering work is per item per subject.** Every dated item is tested against every subject whose topics select the feed: a whole-word, case-insensitive match over the **headline only** (`matchesTerm`: "Mahomes'" and "Drake-Kendrick" match, "Drakeford" does not), then the same disambiguation rules the Google News row carries, over headline and outlet. A broad feed set surfaces more homonyms — Drake London, Nick Drake, Drake Batherson — so Drake's exclusions were extended on the new row.
- **The same story arrives through two doors.** The publisher copy lands first; Google News surfaces it a day or two later under its own key. The two connectors declare one **story family** (`storyFamily: "news"`), and the runner deduplicates a poll's events against the signals stored by every source in the family, so the later copy collapses into the earlier signal (or upgrades it, if the later publisher is better-tiered and the Engine has not read it yet). A source that declares no family deduplicates against itself alone, exactly as before.

### The catalogue

`publisher_feeds` is configuration plus health, service role only. Configuration: `domain` (the publisher; also the fallback publisher of an item whose link names no host), `url`, `section` (a label), `topics` (a subject reads a feed when their topics intersect its tags; an untagged side reads everything), `mode`, `is_active`, `note`. Health, written by the runner after every fetch and never edited by hand: `last_status` (`ok` / `not_modified` / `empty` / `undated` / `not_feed` / `error` / `discovered` / `no_feed_found`), the HTTP status, the item count, **how many items carry a publication date**, how many carry a body (a feed with none is headline-only), how many named a subject on the last run, the newest date, the discovered URL, the conditional validators, and the failure streak.

Two refusals are structural. An item with no publication date is **never ingested** from this source — dating it "now" would put exactly the assumed timestamp the source exists to avoid into the freshness curve — and is counted on the feed's health instead. Items older than `max_item_age_hours` (72) are not ingested either, so a first fetch of a deep feed cannot backfill a week of stale coverage; per person the poll stores at most `max_items_per_person` (60), newest first.

**Discovery.** A row in mode `discover` names a page rather than a feed. The connector fetches it and, if the page is not itself a feed, reads the `<link rel="alternate" type="application/rss+xml">` declarations in its head, then anchors on the same site that look like feed links, then the conventional paths (`/feed/`, `/rss`, `/rss.xml`, `/feed.xml`, `/index.xml`, `/atom.xml`) — validating each candidate as a feed with dated items and recording the first that passes as `discovered_url`. A discovery row ingests nothing and, once it has reported either way, is not fetched again until an operator resets it; promoting a find is `update publisher_feeds set url = discovered_url, mode = 'feed'`.

### Validated, not assumed

No publisher was reachable from the session that wrote this: every outlet is refused by the egress proxy it runs behind, and so is the tool that fetches pages on its behalf. So nothing in the seed is asserted to work. Each of the 94 rows (60 outlets: every tier-1 and tier-2 allowlist domain that plausibly publishes a feed, plus the tier-3 sports, music and streaming desks closest to the four subjects, and discovery pages for the outlets whose feed address or existence was uncertain — Reuters, AP and Bloomberg among them) is a **candidate**; the first poll after deploy fetches it from production, where egress is open, and writes back what it found. The report of which outlets have working feeds, which are headline-only and which have retired RSS is read off the table, and the operator console shows it per row under **Publisher feeds**. Each fetch is also logged as `[ingest] {"event":"feed",...}` with the same counts.

**What the first fetch found (2026-09-17, 14:45 UTC).** All 94 rows were fetched inside the budget; the whole catalogue took 12.5 s. Of the 69 feed addresses, **63 answered with a feed of dated items** — every item dated and every item carrying a body, so none of the working feeds is headline-only — 3 answered with an HTML page (rap-up.com/feed and both rssfeeds.usatoday.com addresses) and 3 failed (Bleacher Report's tag feed 404, Tubefilter 403, the Kansas City Star feed timed out). Of the 25 discovery pages, **13 declared or linked a feed with dated items** (Complex, Fox Sports, HotNewHipHop, Morning Brew, PFF, The Athletic under nytimes.com, The FADER, The Needle Drop, VICE, and four that duplicated a feed already in the catalogue), 7 refused the fetch by status (AP 403, Bloomberg 403, Reuters 401, People 402, IGN's homepage 403 though its feedburner feed works, the Kansas City Star timed out, the Toronto Star 429) and 5 declared nothing anywhere (Campaign, KCTV5, NFL.com, REVOLT, The Ringer). Two working feeds are stale — NYT Pro Football's newest item is from July (the desk moved to The Athletic), WSJ Technology's from January — and were switched off. So the outlets that **retired RSS**, measured rather than assumed: Reuters, AP, Bloomberg, People, NFL.com, The Ringer, REVOLT, Campaign. The curation migration (`20260917150236_phase13_feed_curation.sql`) applies all of this to the rows: nine promotions, the re-pointing of the four HTML-answering addresses and HipHopDX's stale feed to discovery on the outlet's pages, and the switch-offs, each with the finding in its note.

**The second fetch (15:15 UTC), on the budgeted runner.** All nine promoted feeds answered with dated items on their first read (Complex 50, The Athletic 100, Morning Brew 40, PFF 25, The FADER 20, Fox Sports 18, The Needle Drop 15, HotNewHipHop 10, VICE 10), and four of them already named a subject. Discovery on the re-pointed rows found Bleacher Report's real feed in the head of its NFL section (`feeds.bleacherreport.com/articles`, 571 dated items across every sport) and nothing for HipHopDX, Rap-Up, the Toronto Star or USA Today; the second curation (`phase13_feed_curation_2`) promotes the one and switches off the five. The Kansas City Star's feed and page timed out on three consecutive fetches and are left to the connector's backoff. The working catalogue is therefore **71 feed rows from 51 outlets** — 69 healthy on their last fetch, the Kansas City Star's in backoff, Bleacher Report's awaiting its first read — every one validated against real publication dates by production, and every row that was promoted, re-pointed or switched off carries the finding in its note.

### The subjects

| Subject | Match terms (whole words) | Topics read |
|---|---|---|
| Patrick Mahomes | Patrick Mahomes, Mahomes | nfl, sports, general |
| Drake | Drake (with the extended exclusions) | music, entertainment, general |
| MrBeast | MrBeast, Mr. Beast, Mr Beast, Jimmy Donaldson | creator, tech, business, entertainment, general |
| Kai Cenat | Kai Cenat | creator, streaming, gaming, entertainment, music, general |

The Google News rows are untouched and stay active as the fallback for coverage the catalogue misses; `news_volume_24h` stays on them, because a second volume series over a fixed publisher set would restart a baseline that is already accumulating for no new information. The publisher source declares no metric.

### Fifteen minutes

Between hourly polls the platform read as dead: information arrived in one burst and the 30-second tick spent the other 59 minutes rendering Gravity drift. Lowering a source's interval alone would have changed nothing — the job was not being invoked more often — so `vercel.json` now fires `/api/ingest/cron` at `*/15 * * * *` **and** the intervals moved, each off the multiple of the new period (see *Poll intervals below the hour*):

| Source | Interval | Effective | Why |
|---|---|---|---|
| `rss`, `publisher_rss` | 10 | every fire (15 min) | news is what the faster pulse is for; Google News: 4 searches × 96 = ~380 requests a day; the catalogue: ~6,600 |
| `apisports` | 40 | every third fire (45 min) | a weekly sport; a final is caught within 45 minutes at a freshness of 0.98 rather than 0.92; 3–4 requests a poll, ~130 a day of a 7,500 Pro quota |
| `youtube` | 55 | every fourth fire (the hour) | unchanged: `search.list` costs 100 quota units a poll, and 96 polls a day would spend ~9,600 of the 10,000-unit daily quota on one channel — hourly is ~2,500 |
| `youtube_comments` | 55 | the hour | unchanged: four times the polls is four times the comment digests, and each is scored by the model; comments are not time-critical |
| `twitch` | 55 | the hour | unchanged: weekly aggregates and follower growth, and the stream event is keyed on the broadcast id; nothing improves at fifteen minutes |

The staleness window fell from 15 to 10 minutes: still above the route's 60-second `maxDuration`, now below the schedule, so a crashed run blocks no scheduled poll at all. **No model call happens on the path** — the existing source scan in `lib/ingest/cron.test.ts` covers the new connector like every other — so the faster pulse costs function invocations and HTTP, nothing else.

**The run that always closes.** The first fifteen-minute fire took 38 s for twelve polls. The second hit the platform's 60-second kill: its polls had taken 12 s, and the rest was the database answering in seconds rather than milliseconds for one minute — the feed-health write was ninety-four row updates in batches of ten, and at that latency they alone consumed forty-five seconds. The kill left the run open (no `finished_at`, no summary) and three sources unpolled. Two changes, both structural. The scheduled path now hands the runner a **wall-clock budget** (`INGEST_CRON_DEFAULTS.runBudgetMs`, 35 s) and a shorter per-request timeout (12 s): once the budget is spent the runner starts no further poll, records every remaining source and person as skipped with the reason, and **closes the run** with what it has — the rule the Engine's tick has followed since Phase 11. A source polled for some of its people is due again on the next fire, so the queue resumes; and sources are now polled **least recently polled first**, so the hourly ones are never queued behind the quarter-hourly ones on the fire that makes them due. The poll in flight when the budget runs out may still take one connector timeout, or the catalogue's fetch budget plus one feed timeout (now 15 s + 6 s), so the worst case is about 56 s with the close still inside the kill; a test holds that arithmetic. And the feed-health write is **one round trip**: `record_feed_health(jsonb)` takes the whole catalogue's findings and updates only the health columns, so an operator's edit to `url`, `mode`, `topics` or `is_active` is never overwritten by a run.

## Sixteen subjects on the two news doors (Phase 15)

Twelve of the sixteen tracked people had no source at all, so their silence measured the platform and not them, and the drifting target could not be judged. Each of the twelve now reads the publisher catalogue (`publisher_rss`: the same 71 feeds, fetched once a run, filtered against more names) and a Google News search (`rss`). Configuration only, on `person_data_sources`: topics that select the feeds, whole-word matching on the row's identifier plus the bare surnames headlines actually use where those are safe, and disambiguation where the name is shared.

| person | topics | extra match terms | disambiguation |
|---|---|---|---|
| Elon Musk | business, tech, general | `Musk` | excludes the family (Kimbal, Maye, Errol, Justine, Tosca) and the animal, fruit and scent (`musk ox`, `musk deer`, `musk melon`, `white musk`…) |
| Jeff Bezos | business, tech, general | `Bezos` | excludes `sanchez bezos` / `sánchez bezos`: a story about the couple named that way is about her, and a bare `Bezos` would otherwise take it |
| Mark Zuckerberg | business, tech, general | `Zuckerberg`, `Zuck` | excludes Randi Zuckerberg and the Indianapolis bankruptcy attorney of the same name whose suit against Meta made the wires in 2025 (`indiana lawyer`, `indianapolis attorney`, `bankruptcy attorney`, `mark s. zuckerberg`) |
| Warren Buffett | business, tech, general | `Buffett` | excludes Jimmy Buffett and Margaritaville, and the children (Howard, Peter, Susie) |
| Kendrick Lamar | music, entertainment, general | `Kendrick` | excludes Kendrick Perkins, Anna Kendrick, Kendrick Bourne, Kendrick Nunn, Kendrick Sampson, Lamar Jackson, Lamar Odom; no bare `Lamar`, which is the quarterback in every sports feed |
| Jensen Huang | business, tech, general | none | unique as a phrase; `Huang` alone is a common surname and is not a term |
| Larry Ellison | business, tech, general | none | unique as a phrase; `Ellison` alone is David Ellison's Paramount in the business feeds every day and is not a term, so a story about the son that names the father as `Larry Ellison` still counts and one that does not, does not |
| Larry Page | business, tech, general | none | unique as a phrase; `Page` is a word |
| Sergey Brin | business, tech, general | none | unique as a phrase |
| Michael Dell | business, tech, general | none | unique as a phrase; `Dell` is the company |
| Adin Ross | creator, streaming, gaming, entertainment, general | none | unique as a phrase |
| Anthony Baptiste | business, tech, general | none | the one name with no coverage yet and several namesakes (a visual-effects artist, a defendant, a hundred profiles): an item must name `momentum terminal` or `baptiste facility` or it is refused (`require_any`), the over-filtering error being the safe one here |

The same block goes onto the Google News row of each shared name, pushed into the query as negative terms and applied again after the fetch; a unique name's Google News row carries no config. Nothing was invented for the unique names, and no bare surname that is a word, a company, another newsmaker or a common surname was made a term.

**Volume, normalised per person.** Sixteen subjects span two orders of magnitude of coverage, and the Signals force grew with volume: a hundred routine items a day sum to a permanent lift five a day never reach, so the most-covered subject would outrank everyone on volume alone, and every source added to a person raised their ceiling. Phase 7 named the fix and deferred it for lack of history. It is in now, on the shared baseline (`lib/engine/signal-volume.ts`): the person's event signals per complete UTC day since their newest source mapping was created (`person_signal_volume()`, every event kind the force scores, never metric signals) is the series; the baseline utility gives its mean and the sigma of the trailing 24 hours; every event signal's impact is multiplied by `referenceSignalsPerDay` (20) over that mean, bounded to [0.1, 2] (`config.signals.volume`). A person at the reference reads exactly as before; one covered five times as much reads each item at a fifth; one covered a quarter as much reads each at double. A typical day then moves every score by a comparable amount and a day of three times a person's usual coverage reads as three times that, for them. The weight is exactly 1 until seven complete days exist, and a mapping change restarts a person's series (the days before it are an untracked person, not a quiet one), so every subject's baseline began together at this migration and the weights engage together, seven days on. Nothing already recorded is rewritten: `impact_score` on stored signals and `score_events` keep the values the Engine computed at the time. From then on, at the volumes of the first day, MrBeast's items read at about a half (news plus comment digests, about 40 a day), Patrick Mahomes' at about 0.8, Drake's and Kai Cenat's at double, and Elon Musk's at a fifth to a tenth. The weight and the reading are in the force's details (`volumeWeight`, `volume.sigma`) on every signals row.

**Throughput.** The runner polled a source's people one after another, and sixteen Google News fetches at the measured two seconds each would have filled the scheduled run's 35-second budget on their own, with the same people at the end of the list skipped on every fire. It now polls `poll_concurrency` people at a time (a source-row setting; 4 on `rss` and `publisher_rss`, code default 1, at most 8), each worker taking the next person as it finishes, so a slow host delays one lane. The publisher catalogue is still fetched once per run whoever asks first. Per-tick capacity is untouched: four model calls a tick serve sixteen people with news in four ticks, two minutes, and 48 signals a tick against a few hundred a day.

**Other sources, reported and not wired.** Finnhub for the eight executives (their companies' daily close as a metric on the shared baseline: TSLA, AMZN, META, GOOGL twice, ORCL, DELL, BRK.B, NVDA; one connector, eight subjects, poll-robust) first; YouTube for Kendrick Lamar (channel statistics and uploads) and Adin Ross (his channel; his streaming home is Kick, which no connector serves) second; Spotify for Kendrick Lamar and Drake third, once the artist endpoint is confirmed live; Forbes net worth last, a slow monotone figure that would mostly restate the stock. Nothing for Warren Buffett beyond Berkshire's close, and nothing for Anthony Baptiste. News first, so the board is seen with one source type across everyone before asymmetry returns.

## Live mode (Phase 16)

The Engine ticks every thirty seconds and news arrives every fifteen minutes at best. A live broadcast is the one thing on the platform that moves minute by minute, and it was sampled hourly, at the rate of a subscriber count. Live mode follows a broadcast while it is on air, per broadcaster: the state is a `live_sessions` row per (source, stream id), never a flag on the source, so any number of mapped streamers can be live at once and a streamer added later gets it by mapping. Kai Cenat is the one Twitch subject today; Adin Ross streams on Kick, which no connector serves, and his Twitch channel has been banned since 2023, so there is nothing to map for him yet.

**The cron, plainly.** The fifteen-minute ingestion cron cannot sample every one to five minutes: a function cannot sleep across invocations, the route's `maxDuration` is 60 s, and Fluid compute's ceiling (800 s) is under fifteen minutes, so a fifteen-minute schedule has a fifteen-minute floor. Live mode therefore has its own cron, `/api/ingest/live`, every minute (`vercel.json`), which the plan already allows: the Engine's heartbeat has run on a one-minute schedule since Phase 3. It shares `INGEST_CRON_ENABLED` (it is ingestion: it writes signals, snapshots and observations and advances no score); the finer switch is the source row's `config.live.enabled`, off by a row update with no deploy. An idle fire is one Helix request (`/streams` answers a hundred logins at once) and two database reads, about a second of wall clock; the marginal cost is 43,200 invocations a month, inside the Pro plan's included million, plus perhaps 20 minutes of active CPU and 12 GB-hours of memory a month against the plan's 4 hours and 360 GB-hours: cents, if anything.

**What is sampled, and as what.** Detection runs every fire. A live broadcaster is sampled every `sample_interval_minutes` (2; bounded 1–5; per person on the mapping's `config.live`): the audience and category from the detect response (free), and the clips created since the last window from `/clips`, requested a minute wide on both sides because Helix ignores the seconds of `started_at` / `ended_at`, then counted by each clip's own `created_at` so consecutive windows never double count, lagged two minutes for indexing, at most three pages a window (past that the count is a floor). The within-session facts are **events**, judged against the session itself (`lib/ingest/live/rules.ts`):

| moment | rule | direction · confidence |
|---|---|---|
| `audience_surge` | up ≥ 20 % against the sample ten minutes earlier, after a 20-minute warm-up (every stream ramps), both ends ≥ 500 viewers, once per 30 minutes | +1 · fraction / 0.5, bounded |
| `audience_drop` | the mirror at `drop_fraction`, **off by default** (a ten-minute loss is mostly the stream winding down or a raid moving on); the largest fall is recorded on the session either way | −1 · fraction / 0.5 |
| `clip_burst` | the trailing ten minutes' clip rate at ≥ 3× the session's own pace before the window (floored at 6 clips an hour so a slow start cannot make any pace a burst), at least 5 clips in the window, once per 30 minutes | +1 · (multiple − 1) / 5, bounded |

Phase 10 refused concurrent viewers as an hourly metric because a reading taken at whatever minute the cron fired has a distribution driven by the online/offline mixture, and its sigma describes the schedule. That objection is about comparing a moment against a fortnight of other moments; comparing a session against itself, sampled on a fixed cadence from its start, is legitimate, and "up 24 % in ten minutes" is a statement about this broadcast. There is no sigma anywhere in a moment: a session of thirty samples is one ramp-and-decay curve whose standard deviation would describe how long the stream ran, not how unusual a moment was, so the fraction and the multiple are the units. Each moment is stored as a signal of kind `live_moment` carrying its DECLARED direction and confidence, and the Engine scores it with the prescored scorer (`lib/engine/sentiment/prescored.ts`): never inferred, never sent to the model, free of the call budget and the one-chunk-per-person rotation like a metric, aged like an event, and never volume-weighted (it is the platform's own sampling, not coverage the world produced; `person_signal_volume()` leaves it out). When a stream ends (unlisted on two consecutive checks; one miss is Helix blinking), the session closes at its last sighting with one ordinary event, the summary ("… stream ended after 6h 12m: a peak of 142,300 viewers (98,400 on average), 412 clips (66 an hour), 3 categories"), which the sentiment path reads like any headline.

**What is a metric.** Two per-session aggregates, recorded once per session when it ends, through the ordinary metric pipeline against the person's trailing month of sessions (`session_peak_viewers`, `clips_per_stream_hour`; `min_samples` 5): a session is the person's own choice of when and how long to stream, so a sigma over sessions describes how big and how clippable this stream was for them, and the two-minute cadence moves a peak by less than any two sessions differ. Only a **complete** session feeds them: watched from within five minutes of its start with no gap over six minutes, so a session joined late or half-watched through an outage cannot write a false low into the baseline. Not registered, on purpose: average viewers (redundant with the peak), peak-to-average and time-to-peak (they describe the stream's format and length before the person), category switches (no direction). All four are recorded on the session and said in the summary. Live mode writes no `source_polls` row, so the hourly Twitch poll's clock is untouched; samples are their own ledger, and a closing session's observations go under an `ingest_runs` row of trigger `live`.

**Not available, for the record.** Chat frequency and chat sentiment need a persistent IRC or EventSub WebSocket connection; Helix has no polling endpoint for chat, and EventSub's webhook transport carries no chat-message subscription without a user token for the channel. Vercel functions cannot hold a socket open, so this needs an always-on worker writing into the same `signals` table. Not built.

**Quota and budget.** Helix allows 800 points a minute per client id under an app access token, one point a request. Live mode spends one point a minute per hundred mapped broadcasters plus, for each broadcaster due for a sample, one clip request (up to three pages): ten streamers live at once on the two-minute cadence is about six points a minute, and the hourly poll adds three per person per hour. Per-tick budget: the moments are free (they never reach the model or the 48 / 12 caps), and the per-source cap of three counted signals a tick bounds what one streamer's session can add to the Signals force in any tick; the two model-scored events per session (the "is live" event and the summary) go through the ordinary rotation. LLM cost: two Haiku-scored events per broadcast at about $0.002 a call, and a memory fold or two when a moment is notable, so a daily streamer adds under five cents a day; had every sample been a model-scored event, an eight-hour stream would have been 240 signals and twenty calls a day per streamer, with the person's chunk in the rotation full of them.

**Observability.** Every fire logs a `[live]` check line; every sample, moment, observation and session change is a line and a row (`live_samples`, `live_sessions`); `/admin` lists open and recent sessions. A connector may now also leave a **note** on an otherwise ok poll (`context.note`), written onto the poll row's reason and logged, for a fallback read that came back empty; the API-Sports connector uses it for the season-total endpoint, which stopped gating the per-game metrics in this phase.

## Scope so far

- **Phase 1**: scaffold, schema, RLS, auth, seed data, typed clients.
- **Phase 2**: financial-write lockdown + RPC pattern, connector interface and registry, YouTube connector, stubs, `source_snapshots` (now `raw_source_snapshots`), ingestion runner and endpoint.
- **Phase 3**: swappable sentiment scoring (rules-based), the five forces, inverse pairs, LMSR spread with Buy/Sell prices, the atomic tick with history and per-force audit trail, the tick endpoint.
- **Phase 4**: provider-agnostic LLM abstraction with an Anthropic adapter and three stubs, model routing, per-entity memory with seeded baselines and cheap evolution, the `LLMScorer` with anomaly awareness and rules fallback, usage logging with a per-tick call cap, narratives for meaningful moves.
- **Engine cron**: the 30-second heartbeat via Vercel Cron (two ticks per one-minute invocation with a time budget), one shared `runFullTick()` path, gated by `ENGINE_CRON_ENABLED`, which ships as `false`.
- **Phase 11**: the tick that always commits — a start-gated deadline per tick, deferral (unattempted signals stay unprocessed) distinct from fallback (failed attempts score by rules), the load bounded in LLM shape with one chunk per person per tick, one attempt per call, a real per-tick call budget, the usage ledger written before each call, and the backlog visible tick by tick in the admin console.
- **Phase 12**: freshness — an age weight on the Signals force (half-life 24 h, zero past 7 days; expired signals processed at zero impact without a model call; metrics never aged; the model not shown a signal's date) and the effective per-request model timeout pinned end to end. The purge of the stale backlog was scoped and declined: freshness handles it.
- **Phase 12+**: newest-first selection with a least-recently-served rotation across people, and memory event expiry (30 days, dated folds written as history, today's date and event ages in the person block).
- **Phase 13**: publisher-direct feeds — the `publisher_feeds` catalogue read as one shared fetch per run, whole-word name matching scoped by topic, undated items refused, per-feed health and discovery written back onto the rows, the two news doors deduplicated as one story family with Google News kept as the fallback — and the ingestion cron at every fifteen minutes with every source interval off the multiple.
- **Phase 13+**: athlete metrics beyond passing yards — `config.game_stats` on the API-Sports row (every per-game figure read from one request per game, each with its own anchor), `game_passer_rating` (+1) and `game_interceptions` (−1) registered beside yards with touchdowns and every composite figure refused, and the Signals force folding one source's metric signals of one moment into one reading carrying their mean, so a game is its event and its stat line and never three copies of the line.
- **Phase 16**: live mode — a broadcast followed minute by minute on its own every-minute cron (the fifteen-minute schedule cannot sample faster than itself), per broadcaster by mapping (`live_sessions`, `live_samples`, the connector's `live` capability, Twitch's `/streams` for a hundred logins in one request and `/clips` counted to the second); within-session audience surges and clip bursts as prescored events judged against the session itself (`live_moment`, the prescored scorer, free of the model and the rotation), the session's summary as an ordinary event, and peak viewers and clips per stream hour per complete session as metrics on a month of sessions; chat left unbuilt for want of a socket; and the API-Sports season total no longer gating the per-game metrics, with a notes channel for a poll that limps.
- **Phase 15**: every subject on the two news doors — the twelve unmapped people on `publisher_rss` and `rss` with topics, safe aliases and disambiguation per name; the per-person signal-volume weight on the shared baseline (`person_signal_volume()`, `config.signals.volume`, engaging seven complete days after a person's newest mapping); the ingestion runner polling a source's people `poll_concurrency` at a time; and the other sources reported, not wired.
- **Phase 14**: the board measuring momentum again after the first 24-hour run — the drifting Gravity target (the seed plus a bounded offset moved over weeks by the person's own Signals evidence, per-person floor, behind `ENGINE_TARGET_DRIFT_ENABLED`, off), the score stored at four decimals so Gravity's pull inside 1.72 points of the target is no longer rounded away every tick, `HIGH_IMPACT_THRESHOLD` and `Y_RANGE_FLOOR` retuned to the Engine's half-point unit of notable, the 1.250 identified as arithmetic rather than a clamp, and from the queue: `forbes` and `newsdata` off the exact hour and the two trigger functions no longer executable by the user roles.
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

- **Phase 8**: RSS signal quality: the tiered publisher allowlist as configuration (`publisher_domains`: known domains at their tier, unknown ones at the floor, blocked ones dropped and logged), per-item tier resolution from the publisher domain Google News names in `<source url>`, `signals.tier` read by the Engine over the source's tier, story-level deduplication at ingestion (Dice ≥ 0.5 over content words, 48-hour lookback, highest-tier survivor, in-place upgrade of an unread stored copy) applied to signals and to `news_volume_24h` alike, the drop and collapse counters on polls, runs and `source_health`, and the Feed placeholder that no longer restates the source.

- **Phase 10**: two more subjects with deliberately different data shapes — Kai Cenat on Twitch (Helix app token; follower growth plus retrospective broadcast-window aggregates, with the spiky live reading kept as an event rather than forced into a baseline) and Patrick Mahomes on API-Sports NFL (game results as events, one per-game metric sampled once per game, season cumulative totals refused as degenerate) — both with curated RSS, nineteen sports and streaming publisher domains seeded, and poll intervals set off the multiple of sixty that was silently halving the others.

- **Phase 9**: the ingestion cron (hourly, `INGEST_CRON_ENABLED`, flag checked before authentication, overlap-guarded on an in-flight run, no model call on the path) alongside the untouched manual endpoint and the separately gated Engine cron; the Spotify artist read hardened with a plural-endpoint fallback behind the Phase 8+ named error; and `/admin`, its own route tree behind `users.is_admin`, 404 for everyone else, showing LLM cost and the unpriced counter, ingestion health with per-metric baseline progress, both cron states, the read-only risk levers and the behaviour funnel — with no raw metric level anywhere on it.

- **Phase 8+**: connector corrections: comment digests (one signal per video per poll, the distribution and the sample size, comments as evidence only), `comment_volume` as a metric on the shared baseline, Spotify's silent path turned into a named error, the dedup threshold lowered to 0.4 with the local-TV misses pinned as tests, 17 observed domains promoted and two corporate-PR domains held at the floor by decision, and derived-metric inputs declared.

Deliberately not built yet: the profile screen, search results, the Forecast force, and the recommendation algorithm (For You). Shorting stays switched off; the risk levers stay inert (the cooldown's rise to 60 s is a policy floor, not a calibration); and both schedules are wired behind flags — the Engine's heartbeat behind `ENGINE_CRON_ENABLED` and the fifteen-minute ingestion behind `INGEST_CRON_ENABLED`, each of which ships unset.
