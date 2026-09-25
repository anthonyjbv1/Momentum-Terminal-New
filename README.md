# Momentum Terminal

A social data terminal where users take **HIGH** or **LOW** positions on individual people. Each person has a continuously updating Momentum Score driven by their observable real-world data. Users profit when a score moves in their predicted direction; the platform is the sole counterparty. The scoring system is called **the Engine**; its five forces are **Gravity**, **Signals**, **Market Mood**, **Conviction** and **Trading Activity**.

> **Status: Phase 29d complete, and the platform is RUNNING.** Both schedules are on: the Engine's heartbeat every 30 s (`ENGINE_CRON_ENABLED`) and ingestion every fifteen minutes (`INGEST_CRON_ENABLED`). As of 2026-09-22 that is **16,666 ticks**, **3,579 signals**, 197 Engine narratives and 266,656 recorded score points across the sixteen subjects, whose scores now sit between **52.1 and 68.6** rather than at the seeded 50.0. Eight sources are active — `rss` and `publisher_rss` (the two news doors), `youtube`, `youtube_comments`, `youtube_trending`, `twitch`, `finnhub` and `apisports` — every one of them registered as data on a row rather than as code. `ENGINE_TARGET_DRIFT_ENABLED` stays unset and shorting stays off. The whole app sits behind a signed-in session while the test is closed (`lib/auth-gate.ts`, one file, removable in one step; robots allowed the landing and privacy pages only, every other response `noindex`). Every metric a connector reads is snapshotted into a service-role-only raw table, differenced, normalised against the person's own trailing baseline and turned into a signal that carries **direction and magnitude only**, never a level; a trigger on `signals` refuses anything more. Trading is live, on paper: Buy opens a HIGH position at the server-read Buy quote, Sell closes it FIFO, every amount is integer cents, every order is one atomic RPC behind a tolerance band and the long-only gate, and `/portfolio` reconciles the lot to the cent. Home, the person profile, the Feed, Forecast and search are all live; `/design` is the living reference; `/admin` is the operator console, and the only surface where σ appears. **The first live NFL game ran through it on 2026-09-21** — Mahomes 60.9 → 66.0, the largest single-subject move recorded — and Phase 24 is what that game taught. Phases 25 to 27 are the trading surfaces themselves: one typeface per line, one format for every price you can trade at, the modal that finally covers the app it interrupts, and — since Phase 27 — fractional shares, with an order you can place in dollars and a quantity that goes to three decimals. **Since Phase 28 the platform has a front door**: a stranger at `/` sees the landing page — the founder's own Momentum Score, live on the 30-second heartbeat, with the reading behind it — and can leave an email on the waitlist; the app itself stays behind the session. **Since Phase 29 every person has two numbers** — the Momentum Score, which only the data moves, and the market price you trade at — and Phase 29b made the flat market a named mode and the whole phase reversible ([Reversing Phase 29](#reversing-phase-29)). The recommendation layer (For You) is the next phase.

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
| `20260917184229_phase13_athlete_metrics.sql` | The API-Sports row's `config.game_stats` (yards, rating and interceptions, each with its group and statistic name in the per-game response) and the `game_passer_rating` (+1) and `game_interceptions` (−1) declarations beside `game_passing_yards`, all at `min_samples` 8; merged onto the existing config. The rating declaration was renamed `game_rating` and re-floored in Phase 24, which disproved the passer-rating assumption |
| `20260917211640_phase15_sixteen_subjects.sql` | The twelve unmapped people on `publisher_rss` (topics, safe aliases, disambiguation) and `rss` (a quoted-name Google News search with the same block); `person_data_sources.created_at` (the start of a person's volume regime); `person_signal_volume()` (event signals per complete day since the newest mapping, plus the trailing day; service role only) with an index on `signals (person_id, occurred_at)`; `poll_concurrency` 4 on the two news doors |
| `20260917202622_phase14_target_drift.sql` | `people.target_attention` / `target_direction` / `target_offset` (the drifting target's state; `revert_target` documented as the seed) and `apply_engine_tick` writing them beside the score; `forbes` and `newsdata` from 60 to 55 minutes; execute on the two SECURITY DEFINER trigger functions (`positions_enforce_direction`, `trade_orders_snapshot_portfolio`) revoked from `anon` and `authenticated` |
| `20260918015822_phase17_finnhub_non_price.sql` | The `finnhub` row activated at a 35-minute interval (off the multiple of 15 AND off the top of the hour) with `config.observe_only`, `config.insider_codes` and one metric, `company_news_volume_24h`; the nine executives mapped to their companies with the name their Form 4 files under; `observe_only_snapshots`, the view that shows a figure only while its source declares it observe-only, service role only |
| `20260918161256_phase18plus_volume_counts_events_only.sql` | `person_signal_volume()` counts a signal only when its rate is set by the world rather than by our polling: comment digests and the legacy per-comment kind join metric, baseline and live-moment signals outside the count, so the denominator is exactly the set the volume weight multiplies (`UNCOUNTED_SIGNAL_KINDS`). Function body otherwise unchanged; `tracked_since` untouched |
| `20260918234503_phase19plus_mood_window.sql` | A partial index on `score_events (created_at desc) where force = 'signals'`: Market Mood reads the Signals force's own impacts over its trailing window once per tick, and the signals rows are a thousandth of that table. `engine_ticks.mood` re-documented — from Phase 19+ it holds the windowed reading, and rows before it hold the older instantaneous one |
| `20260918194213_phase19_forecast.sql` | `people.forecast_paused` (the per-person kill switch); `forecast_votes` (direction, reason tag, the score at vote time, `superseded_at` for the supersede-not-delete trail) with one active vote per user per person by partial unique index, RLS select-own for `authenticated` and no client writes; `forecast_rate_limit_per_hour()` = 20 and `forecast_min_votes()` = 5; `cast_forecast_vote()` (SECURITY DEFINER, actor `auth.uid()`, refusals as values) and `forecast_summary()` (aggregates only, the split withheld below the minimum) |
| `20260917235241_phase16_twitch_live_mode.sql` | `live_sessions` (one broadcast per source and stream id, with its running aggregates) and `live_samples` (the live ledger), both service role only; `ingest_runs.trigger` admits `live`; the `twitch` row's `config.live` block (on, two-minute samples, the thresholds) and its two session metrics (`session_peak_viewers`, `clips_per_stream_hour`, a month of sessions, five before either says anything); `person_signal_volume()` no longer counts live moments as volume |
| `20260919145502_phase21_metric_emission.sql` | `raw_metric_observations.outcome` admits `unchanged`, the Phase 21 emission rule's new outcome (outside the deadband, identical to the reading already on the record — suppressed, and itself on the record, which is what collapses a run to its first), with the column comment spelling out all six; the `youtube_comments` row's `comment_volume` moved out of `config.metrics` into `config.observe_only`, because the figure is a sum over a changing basket of uploads and cannot be calibrated until the connector defines it differently |
| `20260919150046_phase21_forces_window_index.sql` | `score_events_person_created_idx` on `(person_id, created_at desc)`, the read behind the forces panel's one-hour window; the existing tick-keyed person index stays for the latest-tick read on the same page |
| `20260919164206_phase21plus_publish_observed_gate.sql` | The metric-privacy allow-list gains `observed` and `baseline`, behind a per-metric `publish_observed` that DEFAULTS OFF, plus a rule that a signal carries both or neither; set on the six public counts (`news_volume_24h`, `company_news_volume_24h`, `viral_moment_rate`, `stream_hours_7d`, `stream_days_7d`) and NOT on `session_peak_viewers`, which is an audience size rather than a count of items. The headline digit refusal is unchanged |
| `20260919164303_phase21plus_publish_observed_clips.sql` | `clips_per_stream_hour` opts in too: the previous migration looked for it under `config.live.metrics`, and the twitch row declares all five of its metrics under `config.metrics`. The guarded WHERE made the miss silent rather than an error |
| `20260920000325_phase21plus_feed_entries_metric_payload.sql` | `feed_entries()` carries each METRIC signal's payload inside its `evidence` objects (null for events, whose payloads hold publisher-resolution detail). A `create or replace` rather than a drop: the key goes inside a column that is already `jsonb`, so the signature, the grants and the keyset pagination are untouched |
| `20260920222317_phase22_pin_drake_official.sql` | `@DrakeOfficial` resolved to `UCByOQJjav0CUDwxCk-jVNRQ` ("Drake", 33.1M) — the same channel the 21:15 chart sighting suggested, arrived at independently — so it is pinned beside DrakeVEVO and the handle dropped. The `@Drake` refusal stands; the namesake id is pinned nowhere |
| `20260920215816_phase22_drake_official_handle.sql` | `@DrakeOfficial` seeded as a handle rather than its id inferred from a chart sighting, plus the Adin Ross corroboration recorded (the channel is titled "Adin Live"; it holds `@AdinRoss` and lists kick.com/adinross, so the pin is not a defect to be "corrected") |
| `20260920214752_phase22_trending_pin_channel_ids.sql` | The resolutions, judged and pinned: MrBeast, Kai Cenat, Kendrick Lamar (personal + VEVO), Adin Ross and DrakeVEVO into `channel_ids`, every `handles` key dropped so the lookup stops. `@Drake` is **refused** — it resolves to a 491-subscriber namesake, and arming it would have credited Aubrey Graham with that person's uploads; his main channel stays unmapped rather than inferred from a channel title seen on the chart |
| `20260920213950_phase22_trending_channel_handles.sql` | Channel ids for the trending chart: MrBeast's verified id into `channel_ids` (a **set**, so a personal and a VEVO channel never have to be chosen between) with his handle riding along once so the next poll re-resolves it rather than assuming; and `handles` for `kai-cenat` (the priority — his titles do not name him), `drake`, `kendrick-lamar` and `adin-ross`, resolved by the connector through `channels.list?forHandle=` where the API key lives. No executive mapped: a corporate channel is the company's upload schedule, not the person's |
| `20260920192009_phase22_youtube_trending.sql` | The `youtube_trending` row (YouTube's own chart, tier 2, 25 minutes — off the multiple of fifteen and off the top of the hour, an effective half hour — and NO metrics, because a trending rank is never baselined) and a mapping for every active person keyed by display name: `channel_id` only where the board already held a verified one (MrBeast, copied from the `youtube` mapping), `match_terms` empty so a title must name the person in full, and the Phase 12+ disambiguation block inherited from the `publisher_rss` mapping, with Drake's list gaining the sitcom |
| `20260920232615_phase23_search.sql` | `people.is_discoverable` (the Phase 23 consent flag: boolean, not null, **default false**, the forecast_paused shape at the opposite polarity) set true for the sixteen by slug, one name at a time; `search_terms()` and `search_key()`, the two immutable normalisations that make a query forgiving of case, punctuation and Latin diacritics; three partial expression indexes on `people` — its first — scoped to `is_active and is_discoverable`, so the index is the discoverable set; and `search_people(text, integer)`, security invoker, which tests the flag inside the function so a person who has not opted in is unreachable through it for any caller and at any limit |
| `20260921143427_phase24_register_emission.sql` | `raw_metric_observations.register` (the band an observation left on the record, held with hysteresis) and `same_register` on the outcome CHECK. The rule it makes stateful: a metric emits when what a reading is CALLED changes, not when its number does. Replayed before shipping — Mahomes over the first live NFL game, 39 emissions to 7 and the Signals force 18.21 to 11.10; board-wide over seven days, 2,074 to 220 |
| `20260921151807_phase24_game_rating_is_not_passer_rating.sql` | The host's `rating` is NOT the league's passer rating: it rated a 15/27, 184-yard, 2-TD, 1-INT line 50.2 where the formula gives 86.0, and a 32/47, 382-yard, 3-TD, 0-INT line 78.6 where it gives 114.0 — read off the connector's own diagnostics note. Renamed `game_passer_rating` → `game_rating` (the field's name and nothing more; QBR fits the 0–100 range but cannot be recomputed and is not adopted), `sd_floor` re-derived 12.0 → 8.0 for that range, and the two stored readings carried across so no game is lost. It needs eight games and has two, so nothing has ever emitted |
| `20260922211703_phase27_fractional_units.sql` | **Units become THOUSANDTHS of a share.** Every stored quantity x1000 in one transaction, under an ACCESS EXCLUSIVE lock taken in the first statement with a finite `lock_timeout` (the server's own is 0), so the Engine's reader — which marks portfolios through `portfolio_value_cents()` every 30 s — can never see rescaled rows through a function that has not been rescaled with them. No money column is touched: per-user cash, basis, realized P&L, close proceeds, order gross and paper credit are byte-identical either side, from one query run twice. The rounding rule lives in `units_cost_cents()` (a buy rounds UP) and `units_proceeds_cents()` (a sell rounds DOWN) and every CHECK, read function and `place_order` branch calls them, so the platform never creates money and never takes more than a cent. `positions.open_cost_cents` carries the un-realised basis a partial close now needs; `platform_settings.min_order_cents` ships at $1.00 as risk lever 5; `trade_orders.quantity_scale` records which scale the CALLER declared, never inferred from the size of the number, so Phase 27a can see from data that no legacy client remains. The four payloads that carry a quantity now declare `units_per_share`, which is what let the interface ship a deploy BEFORE the data moved. Reversible: `supabase/rollback/20260922211703_phase27_fractional_units_down.sql`, run by a test, which refuses if anyone holds a fraction |
| `20260923212502_phase28_landing_waitlist.sql` | `citext` (in `extensions`); `waitlist` (email citext-unique with a shape check, `created_at`, `consent_at`, `source`, the five `utm_*` columns, `referrer`; RLS on, **no grant and no policy for any client**); `join_waitlist(p_email, p_source, p_utm, p_referrer)` SECURITY DEFINER, service role only, idempotent (`on conflict do nothing`, then the existing row), returning `{created, position, joined_at}` with the position a real row count; `behavioral_events.user_id` made nullable with `behavioral_events_actor_check` (a user or a session, never neither) for the anonymous landing events. |
| `20260925012938_phase29_market_price.sql` | **THE MARKET PRICE, and the anti-manipulation framework.** Under one `ACCESS EXCLUSIVE` lock with a 5 s `lock_timeout`: `market_tier_settings` (public_figure / private_individual: depth, decay half-life, premium cap, minimum hold, max order share of depth, aggregate exposure cap, the premium breaker, the private tier's total-price breaker, shorting allowed, alert on halt; a NULL depth was the tier's off switch until 29b named it); `people.tier`, `trading_mode`, `market_inventory_units`, `premium_cents`, `halted_until` / `halt_reason` and the four per-person overrides, with `buy_price` / `sell_price` regenerated to include the premium and `market_price` beside them (the founder set private + display-only, the fifteen public + tradeable); `premium_history` (every change of inventory and premium — trade, decay step, reset — with the depth in force and the score at that instant, so every market price ever quoted is reproducible) and `house_ledger` (the platform's side of every close, `score_move + premium_change + spread_and_impact = −pnl` exactly, and of every decay step); `users.frozen_at` / `frozen_reason`, the identity hook (`verified_identity_key` unique, `identity_verified_at`, `require_verified_identity` defaulting off) and `referred_by`; `excluded_parties`; `alerts`, `surveillance_events` and the **append-only** `admin_audit_log` (a trigger refuses update and delete for every role); the detectors' thresholds on `platform_settings`; the curve arithmetic as SQL functions (`market_walk_cents`, `market_average_cents`, `market_marginal_cents`, `market_premium_cents`, `market_decay_step`, `market_cap_inventory_units`, `market_params_for`) and the order/lot columns they explain (`base_price_cents`, inventory and premium before/after, `depth_units`, `impact_cents` numeric, `worst_fill_cents`, `cost_cents`, `proceeds_cents`, `fingerprint_hash`; `positions.entry_price_points` **renamed from `entry_score`** with `entry_base_cents` / `entry_inventory_units` / `entry_depth_units` / `entry_premium_cents` / `entry_index_cents`; `position_closes.exit_*`) under **EXACT** CHECKs (`trade_orders_gross_is_curve`, `trade_orders_cost_is_opening_segment`, `trade_orders_inventory_walk`, `trade_orders_premium_is_derived`, `positions_amount_is_curve`), legacy rows backfilled from `score_history`; `apply_market_decay` and `evaluate_price_breakers` inside `apply_engine_tick()` before the portfolio snapshot; `trade_quote` / `position_summary_for` / `portfolio_summary_for` / `trade_history_for` extended and `person_market_series()` added; `surveillance_emit` + `run_surveillance` (clustered buying, new-account burst, shared infrastructure, wash trading, referral spike); **`place_order()` on the cost curve** with an 8th argument `p_fingerprint_hash`; the eight audit-logged admin RPCs behind `assert_admin()`. Applied to production with deploy invariance verified: every quote, every generated column and the one live portfolio value byte-identical before and after. **Supersedes the Phase 27 rollback file**, which refuses to run on a Phase 29 schema; reversed (with 29b) by `supabase/rollback/20260925012938_phase29_market_price_down.sql` — see [Reversing Phase 29](#reversing-phase-29) |
| `20260925103634_phase29b_post_ship_fixes.sql` | **Flat is a named mode, never a NULL.** `market_tier_settings.pricing_mode` (`curve` \| `flat`, default `curve`) and `people.pricing_mode_override` (NULL: the tier's); `market_tier_settings.depth_units` NOT NULL (a NULL depth, had one existed, would have become `flat` with the shipped depth kept); `market_params_for()` resolves a NULL override to the tier's value always and returns a NULL depth exactly when the effective mode is `flat` (the one flat signal `place_order`, decay and the client already read); `trade_quote()` names the mode; `portfolio_summary_for()` carries each position's book (base prices, inventory, resolved depth, premium cap, mode) so the portfolio's close sheet walks the curve. Grants and comments kept. Production before and after: all fifteen tradeable people resolve to depth 300,000 from their tier, the founder to 100,000; nothing priced moved |
| `20260925162742_signals_dedupe_per_person.sql` | **Phase 29d, step 1 of 2.** Adds `signals_source_person_dedupe_key_unique` (data source, person, dedupe key) beside the source-only rule, so the old code kept its `ON CONFLICT` target until the new code shipped. Every existing row already satisfied it; nothing changed |
| `20260925162829_source_polls_detail.sql` | **Phase 29d.** `source_polls.detail` (jsonb, nullable): the connector's structured account of a poll by key — today `insider_filings`, every Finnhub Form 4 line fetched and what became of it. Share counts only, never a price |
| `20260925163533_signals_dedupe_drop_source_only.sql` | **Phase 29d, step 2 of 2**, applied once the code inserting against the per-person rule was live: drops `signals_source_dedupe_key_unique`. From here an item two people share is kept for each of them |

All of these are applied to the `Momentum Terminal` Supabase project and recorded under the same versions, so `npm run db:push` treats them as applied and only pushes new files. To add a migration: create `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, run `npm run db:push`, then `npm run db:types`.

### Tables

| Table                 | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `users`               | Profile + wallet for each `auth.users` row                                                    |
| `people`              | Each tracked individual: `current_score`, `revert_target` (the seed of the Gravity target) with the drifting target's `target_attention` / `target_direction` / `target_offset`, `spread`, `last_tick_at`; since Phase 29 the market's state — `tier`, `trading_mode`, `market_inventory_units`, `premium_cents`, `halted_until` / `halt_reason`, four per-person overrides — and the generated `buy_price` / `sell_price` / `market_price`, which include the premium |
| `market_tier_settings` | One row per tier (`public_figure`, `private_individual`): depth, decay half-life, premium cap, minimum hold, max order share of depth, aggregate exposure cap, the breakers, shorting allowed, alert on halt, and (Phase 29b) `pricing_mode`: `flat` is the named off switch — Phase 27 prices, no premium, no impact. Depth is never NULL. Readable signed in; changed by migration (Phase 29) |
| `premium_history`     | Every change of a person's inventory and premium — trade, decay step, reset — with the depth in force and the score at that instant. With `score_history` and `trade_orders` this reproduces every market price ever quoted. Service role only; on the retention item (Phase 29) |
| `house_ledger`        | The platform's side of every realised close (`score_move + premium_change + spread_and_impact = −pnl_cents`, exactly) and of every decay step (`decay_mark`). Integer cents; positive is a house gain. Service role only (Phase 29) |
| `excluded_parties`    | Accounts that may not trade one market (`person_id`) or any (null), read by `place_order()` on every order; added and removed through the audit-logged admin RPCs (Phase 29) |
| `alerts`, `surveillance_events` | The review queue (one row per detector finding or breaker halt worth a human look) and the stream under it (every detector reading, threshold reached or not). Evidence is counts, windows and salted hash prefixes, never an address. Service role only (Phase 29) |
| `admin_audit_log`     | **Append-only**: every operator action (freeze, halt, mode, exclusion, alert status) with actor, target and note. A trigger refuses update and delete for every role, the service role included (Phase 29) |
| `data_sources`        | Pluggable registry of external feeds (`is_active` switches a connector on)                    |
| `person_data_sources` | Which sources feed which person, with the external identifier                                 |
| `inverse_pairs`       | Unordered pairs whose scores move against each other (with `dampening`)                       |
| `positions`           | A user's lots: `direction`, `units`, `open_units`, `entry_price_cents` (the server's average fill), `entry_price_points` (the same in points; `entry_score` until Phase 29), `amount_cents` = cost, and since Phase 29 the book the lot was priced on (`entry_base_cents`, `entry_inventory_units`, `entry_depth_units`, `entry_premium_cents`, `entry_index_cents`) under an exact CHECK; FIFO closes reduce `open_units` |
| `trade_orders`        | Every accepted order: side, units, the AVERAGE price it filled at, how it split into units opened / closed, realized P&L, balance after; since Phase 29 the walk itself — base price, inventory and premium before and after, depth, `impact_cents`, `worst_fill_cents`, `cost_cents`, `proceeds_cents` — under exact CHECKs, and `fingerprint_hash` |
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
| `platform_settings`   | One row of platform-wide switches and tunables: `shorting_enabled` (default false), `price_tolerance_cents`, the five risk levers, and since Phase 29 the detectors' thresholds and `require_verified_identity` (default false). Service-role write only |

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
- `proxy.ts` refreshes expired sessions on every request (`resolveSession`), then applies **the auth gate** (`lib/auth-gate.ts`, Phase 7): while the test is closed, a signed-out request to any page is redirected to `/login?next=…`, a signed-out call to any API route gets `401` JSON (never a redirect), `/login`, `/signup`, `/auth/*` and static assets stay reachable, the shared-secret routes (`/api/ingest`, `/api/engine/*`, `/api/admin/*`) are left to their own check, `/robots.txt` is `Disallow: /`, and every response carries `X-Robots-Tag: noindex, nofollow, noarchive`. The gate is one file with one call site; a test asserts nothing else imports it, so reopening the app is deleting the file and restoring one line, after which the per-route rules in `lib/supabase-proxy.ts` (`/account`, `/portfolio`, `/profile` need a session; `/login`, `/signup` need none) keep working. **Since Phase 28** a signed-out `/` is **rewritten** to the landing page (`/welcome`, which redirects to `/` when asked for by name); `/privacy`, `/og`, `/api/public/featured` and `/api/waitlist` are named in the allowlist by exact path; `/robots.txt` allows exactly `/$`, `/privacy$` and `/og$` and disallows the rest; and the landing and privacy pages are the only responses without the `noindex` header. Signed in, `/` is the app's home exactly as before.
- Use `getCurrentUser()` / `requireUser()` from `lib/auth.ts` in server code for anything that depends on identity.

Set the Supabase Auth **Site URL** and **Redirect URLs** (Authentication → URL Configuration) to include your local and Vercel origins plus `/auth/callback`.

## Data ingestion

Connectors under `lib/connectors/` implement `DataConnector` and are registered by `data_sources.name`. A connector produces **events** (`fetchForPerson → RawSignal[]`: news items, comments, real text the sentiment scorer reads), **metrics** (`fetchMetrics → MetricReading[]`: raw levels the runner normalises before anything sees them), or both, and may report `available()` (credentials present or not). `youtube` (channel metrics and commentary volume), `youtube_comments` (one comment digest per video plus comment volume), `rss` (a person-scoped feed: articles and news volume), `publisher_rss` (the shared publisher catalogue), `spotify` (popularity and followers), `twitch` (broadcast aggregates plus [live mode](#live-mode-phase-16)), `apisports` (NFL games and per-game figures) and `finnhub` ([company news volume and Form 4 filings, and no price in any score](#finnhub-and-why-no-stock-price-touches-a-score-phase-17)) are implemented; `forbes`, `newsdata` and `billboard` are interface-compliant stubs.

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
| **Market Mood**      | mood = the board's Signals movement over a **trailing window** (`windowMinutes` 60), as a mean per person across the ticks in it that moved anyone; impact = `ratePerHour (1.41) · sensitivity (1.0, per-slug overridable) · Δh · mood excluding the person's own signals`, mood clamped to ±2 and impact to ±0.5 (the brakes). Per hour × the person's own elapsed time, exactly as Gravity applies its λ ([Phase 19+](#market-mood-is-a-tide-not-a-splash-phase-19)) | 0 |
| **Conviction**       | concentration = open capital on the person / `max_allocation_cents`; 0–60 % → 0, 60–85 % → +0.05…+0.15, > 85 % → −0.05…−0.15, capped at −0.30. **A MARKET force since Phase 29**: computed every tick, reported on the profile as a reading, added to nothing | 0 (no positions) |
| **Trading Activity** | flow score = net Buy−Sell flow in the last 60 s / `max_allocation_cents` (clamped ±1); **baseline** = the same score for every 60 s window over the trailing **24 h** (`baselineHours`); deviation = flow score − baseline mean; a deadband at **1.0 σ** (`thresholdStdDevs`) of the baseline sd, which is floored at **0.01** (`sdFloor`); outside the band adjustment = deviation · 0.25 (`weight`), inside it deviation · 0.25 · 0.25 (`inBandScale`) but never smaller in magnitude than **0.01** (`inBandMinImpact`, signed by the deviation, so normal trading reads alive rather than idle); × 0.4 when no signal confirms the move, capped ±0.30, skipped below 15 % concentration, and **0 with "insufficient baseline" until 30 windows** (`minPopulatedWindows`) in the trailing day have seen a trade. Baseline-relative so that long-only flow (which can only be ≥ 0) is not a permanent lift: steady inflow is the baseline, a burst above it lifts, a lull below it lowers. Unchanged when shorting is enabled. **A MARKET force since Phase 29**: computed, reported, added to nothing | 0 (no trades) |

`newScore = clamp(score + Σ SCORE forces, 35, 100)` — since Phase 29 the sum is Gravity + Signals + Market Mood (+ the inverse-pair pass); `SCORE_FORCES` and `MARKET_FORCES` in `lib/engine/types.ts` name the split and `lib/engine/market-readings.test.ts` proves an Engine under heavy trading and one under none write byte-identical score history. Stored at **four decimals** (Phase 14; two before). The precision is the stored score's only: every surface formats to one or two decimals and every quote is rounded to whole cents on both sides. Two decimals had a dead zone: at the 30-second cadence Gravity's pull in one tick is gap × 0.0029, under half a cent once a score is within 1.72 points of its target, and the rounding discarded it on every tick. The first 24-hour run showed it: every person without signals stuck 1.3 to 1.7 points short of their target (moved only when Market Mood tipped a tick over the rounding edge), and the board read as frozen. No force changed.

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
| `cast_forecast`   | required   | `{ direction: "rising" \| "falling", reason: "professional" \| "social" \| "financial" \| "cultural" \| "performance" \| "media" \| "other", changed?: boolean, surface?: string }` (server-side, on a forecast that was cast or changed; never on a repeat) |
| `view_landing`    | optional   | `{ surface: "landing", referrer_host?: string, utm_source?: string, utm_medium?: string, utm_campaign?: string }` (Phase 28; anonymous — `user_id` null, a one-off session id; written server-side when the landing page renders) |
| `join_waitlist`   | optional   | `{ source: "landing_hero" \| "landing_footer", disposition: "new" \| "existing" \| "dropped" \| "rate_limited" \| "invalid" \| "failed" }` (Phase 28; anonymous, server-side, after the route answers; never carries the address) |

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

The look is editorial monochrome: a jet-black ground, neutral grey cards with no borders, white type with a strong hierarchy, generous space. Green and red are the only saturated colours and appear only on Buy / Sell and directional score movement; navigation, focus, status and the timer are white or grey. Inter carries the interface; JetBrains Mono appears only on numbers, through the `num` utility, **with documented exceptions — Portfolio (Phase 25), the trade sheet and the profile score card's change line (Phase 26), and the forces panel's market readings and the forecast sentence (Phase 29c), which set their figures in Inter with `tabular-nums`**. Every chart keeps its mono axis and time labels. Both fonts are self-hosted through `next/font`.

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
| `search` | a query settles for 700 ms **with its results already back**, so the event carries the `result_count` the person actually saw (`{ query, result_count }`) |
| `view_person` | a search result is opened, by Enter on the highlighted row or by tap (`{ source: "search" }`) |

Logging is skipped entirely when nobody is signed in, since the log endpoint would reject those events anyway.

## Person profile (Phase 6c)

`/person/[slug]` — the page every Home card routes to. Desktop is two panels (identity, score and history, the five forces in the main column; signals in the right rail); mobile is one column in the same order with the signals last and Buy / Sell fixed above the tab bar.

An unknown slug is a real HTTP 404 inside the shell. The slug is resolved before anything streams (Home's `loading.tsx` therefore lives in its own `(home)` route group rather than above every page, since a `notFound()` thrown inside a Suspense boundary can only ever be a 200); the readings behind the sections then stream in behind a skeleton of the page's own shape.

### What it shows

- **Identity** — a labelled dossier grid: small grey uppercase label, large white value, hairline rules. NAME (the largest value after the score), CATEGORY, TRACKED SINCE (`people.created_at`), STATE and CONVICTION, with the avatar alongside (monogram when there is no image). REGION is not shown: `people` has no such column, and the page invents nothing. Every label describes market or score state; the only coloured value is STATE, and only because it reads direction.
- **Momentum score** — the score in large monospaced numerals; beneath it the change over the selected range in points and percent, coloured by direction; the gravity target (`revert_target`), spread, and the Buy / Sell quotes in small type.
- **Score history** — one thin white line, a recessive grid, a single score axis, three time marks, the gravity target as a faint dashed reference (or a note that it sits above / below the visible range), and a crosshair with the exact score and time on hover or touch. Ranges are 1H / 24H / 7D / ALL; a range with fewer than two slices of history is disabled, never drawn flat. A gap between ticks wider than three slices breaks the line, so a pause in the Engine reads as a pause. No history at all is an empty state that says so.
- **The five forces** — Gravity, Signals, Market Mood, Conviction, Trading Activity, each with what it measures and the points it added to the score **over the last hour** (`FORCES_WINDOW_MINUTES`, Phase 21: a tick's contribution is too small to render at two decimals), as a diverging bar from a centre line. A force that wrote no row in the window did nothing and reads 0.00; before the first tick every force is present and marked *Idle*. The caption and the header both name the span.
- **Signals** — the person's signals and Engine narratives merged newest first: source (data source name, or *The Engine*), age, headline, and the recorded score impact where there is one. Tapping an item opens its detail (exact time, sentiment and confidence, score before → after for a narrative). Read-only, with a real empty state.
- **Buy / Sell** — Buy is the light pill (near-white, black label), Sell the dark pill (near-black, white label), each showing the current quote. Monochrome: direction colour stays on the change figures. Tapping shows a one-line note that trading opens with Phase 6e and does nothing else.

### The STATE threshold

`STATE_RULE` in `lib/person/profile-model.ts`: over the **trailing 24 hours** of `score_history`, a person is **Heating** when at least **10 ticks** were recorded and the score rose by **≥ 1.0 point** from the first of those ticks to the last, **Cooling** when it fell by ≥ 1.0, and **Stable** otherwise — including when fewer than ten ticks exist, and when there is no history at all. The caption under the value says which case applies (the 24h change, or how many ticks exist against the ten needed). With the Engine dormant every person reads Stable, which is the honest reading.

### CONVICTION

Read from the Conviction force **on the latest tick** — a state reading, not something that accumulates over the panel's hour — using the concentration the Engine recorded (open capital on the person over their allocation cap): **Low** at or below 60 %, **Moderate** to 85 %, **High** above — the same bands as `DEFAULT_ENGINE_CONFIG.conviction`, pinned by a test. A ticked person with no Conviction row is Low (the force writes no row when it is zero); before the first tick the value is `—`.

### Data

`lib/person/profile.ts` reads on the server through the service-role client, for the same reason Home does (the page is public; anon has no policies). Per request: the `people` row by slug; `person_score_series()` once per range (time-bucketed in Postgres, so a week of two-ticks-a-minute history is 168 rows, not 20 000); the newest `score_history` row for the latest tick number; every `score_events` row of the last `FORCES_WINDOW_MINUTES` (force and impact only — what the forces panel sums); that latest tick's `score_events` for the working each force recorded, which is where CONVICTION's concentration comes from; and the newest `signals` and `narratives`. Everything is wrapped in React `cache()`, so the page, its metadata and the rail share one set of queries.

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
| `threshold_std_devs` | the deadband, default **2.0σ** (raised from 1.0 in Phase 21; see [Metric emission](#metric-emission-phase-21)) |
| `publish_observed` | whether the observed count may reach a reader. **Explicit, default false** (Phase 21+): set on small public counts, never on an audience level |

`config.derived` declares metrics computed from another metric's snapshot history with no connector of their own: `upload_rate` (`kind: rate`: the change in `video_count` over the trailing week, per day, once the history spans the window) and `viral_moment_rate` (`kind: spike_count`: how many `news_volume_24h` readings in the trailing week sat two sd above the week's own mean). A derived level is snapshotted and normalised like any other.

**One baseline.** `lib/engine/baseline.ts` (`baselineDeviation`) is the single implementation of mean, population sd, sd floor, minimum sample and deadband. Trading Activity consumes it for net order flow; every metric consumes it for its observations; a test fails if either grows its own mean and sd.

**The metric scorer.** `lib/engine/sentiment/metric.ts` sits beside the sentiment scorers behind the same `SentimentScorer` interface: `confidence = clamp(|σ| / 3 × scale, 0, 1)`, `direction = polarity × sign(σ)`, and the Signals force computes `baseImpact × tier × confidence × direction` exactly as for a headline, so metric and news signals flow into one force with the source tier as the relative weight (official APIs tier 2, viewer comments tier 4; an RSS item carries its own tier, resolved from its publisher, see [RSS signal quality](#rss-signal-quality-phase-8)). The Engine routes by what a signal *is* (payload `kind: "metric"`), never by where it came from; the LLM scorer's prefilter sends a metric signal to the metric scorer too, and the keyword scorer refuses to give one a direction.

**The privacy rule, schema-enforced.** A metric signal stores direction and normalised magnitude only: the headline reads "MrBeast's YouTube subscriber growth is running +1.4σ above their own trailing week", the payload is limited to an allow-list (`kind, metric, label, sigma, direction, polarity, samples, min_samples, window_hours, delta_kind, threshold_std_devs, scale, source`), and the `signals_enforce_metric_privacy` trigger refuses any other key, a missing polarity, a non-numeric sigma, or a headline carrying a run of four digits, a thousands grouping or a compact count. Raw levels live in `raw_source_snapshots` and `raw_metric_observations`: no grant, no policy, service role only; `lib/ingest/privacy.db.test.ts` asserts on real Postgres that no function or view the user roles can reach references them, and that no page, component or user-facing read in the app does either. The narrative layer only ever sees normalised values: the sentiment prompt's payload allow-list (`PAYLOAD_KEYS`) carries no level, previous level or delta, and a test feeds it a payload full of raw counts and asserts none reach the prompt; memory and narratives are built from headline, label and impact alone.

**Per-person signal volume.** Once several sources feed one person, the number of signals in a tick says more about the sources than the person, so the Signals force (a) keeps at most `maxPerSourcePerTick` (3) non-zero signals per source, the strongest, and (b) divides the sum of the kept signals by `count^volumeExponent` (0.5): four signals of one strength read twice one of them, not four times. Before either step, metric signals from one source that share an `occurred_at` are folded into one reading carrying the mean of their impacts (`oneReadingPerMetricMoment`, Phase 13+): the three per-game figures of one football game are one performance, and the fold keeps them from taking three cap slots and reading as √3 of one reading. The assumption is that a tick's signals about one person are partially redundant evidence of the same day and combine like noise, in quadrature. Where it is weak: it still grows with the number of sources, so adding sources to a person raises their ceiling; it cannot tell a genuinely busy day from four outlets covering one story; it dilutes a lone strong signal beside weak ones; and the source cap may drop a real second story on a three-story day. The honest fix is to normalise each person's signal volume against their own trailing volume, the same baseline the metrics use, once there is history to build it from.

**Observability.** Every run (`ingest_runs`), every poll (`source_polls`: source, person, ok / error / skipped with the reason, latency, what it produced) and every observation (`raw_metric_observations`: level, previous, delta, baseline mean and sd, sigma, samples, outcome, the signal it produced) is recorded and logged as a structured `[ingest]` line, so a score move can be walked back from `score_events.details.signals[].impact` to the signal to the observation to the poll. `source_health` (a view) gives last poll, last success, last error and its reason, the trailing-day poll count, error rate and latency per source; `llm_cost_per_tick` prices `llm_usage` by tick (the sentiment scorer now stamps the tick number on its usage rows) against `llm_model_prices`, and says how many calls had no price row. `GET /api/admin/health` returns all three.

**Running it dry.** The cron stays off. `POST /api/ingest?force=1` with `INGEST_SECRET` runs every active source once: the first run produces snapshots, first-contact observations and no metric signals; later runs produce `insufficient_baseline` observations until `min_samples` is reached, then `inside_band`, `unchanged`, or, on a real move to a level not already on the record, `emitted` with a σ signal. Nothing here advances a score; a signal waits for a tick.

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
- **Ingestion health** — per source: last success and its age, last poll, trailing-day polls, errors, error rate, latency, signals, blocked drops, collapsed duplicates, and the last error or skip reason; the recent runs; the recent poll errors with their messages. And the clock: **per-metric baseline progress**, samples against the minimum and span against the window, each as a number and a meter, with the state (`emitted` / `inside_band` / `unchanged` / `insufficient_baseline` / `first_contact` / `no_config`) spelled out, and a baseline counted READY on any of the first three.
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
| `game_rating` | +1 | the performance figure: the host's own `rating`, observed inside 0–100 (`sd_floor` 8, `scale` 1.0). **Not** the league's passer rating — Phase 13+ assumed it was and Phase 24 disproved it from the API's own numbers; what it IS has not been established, so the key claims only what the field is called |
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

The runner skips a source when `minutes since last poll < poll_interval_minutes`. The ingestion cron fires on its period and the previous run's poll lands a few seconds after it, so a period later the check sees a fraction **less** than the period: an interval that is an exact multiple of the period always loses that race and the source polls half as often as its interval claims. On the hourly schedule both Phase 10 rows sat off the multiple (55 for Twitch, 175 for API-Sports). Since Phase 13 the period is fifteen minutes and the rule is `poll_interval_minutes % 15 !== 0`, asserted for every active source: 10 (`rss`, `publisher_rss`) polls on every fire, 25 (`youtube_trending`, Phase 22) every second, 35 (`finnhub`) every third but cycling through the quarter-hours, 40 (`apisports`) every third, 55 (`youtube`, `youtube_comments`, `twitch`) every fourth — the hour.

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

## Finnhub, and why no stock price touches a score (Phase 17)

Nine of the sixteen are executives, and until this phase they ran on news alone. Finnhub gives each of them the public company they are identified with, and the whole design follows from one constraint that is **regulatory rather than modelling**: the platform's positioning rests on its indexes deriving no value from treasury prices, bank stock prices or any registered financial instrument, which is what defeats a security-based swap reading under Exchange Act 3(a)(68)(A). A Momentum Score that moved because TSLA moved would be that exposure, per person and direct. So nothing priced reaches a score, and the two things that do reach one carry no price:

| what | kind | why that kind |
|---|---|---|
| `company_news_volume_24h` | metric, `scale` 0.5 | a COUNT of articles about the company in the trailing day, baselined against the person's own trailing fortnight. The same shape as `news_volume_24h`: the window is the measurement, so consecutive polls agree. A count is not a price. The headlines are never stored — they are about the company, the two news doors already cover the person by name, and a stored "TSLA climbs 5%" would walk a price in through the sentiment scorer |
| insider filings | events | a Form 4 is discrete, dated, disclosed on a known day and carries a direction. As a metric it would fail the Phase 10 test: filings cluster (a 10b5-1 plan files for a week then nothing for a month), so a per-poll count's sigma would describe the filing calendar |

Two filters decide whether a filing is about the person at all. **Whose**: Finnhub returns every insider at the company, and "Tesla's CFO sold shares" is not a Musk event, so only names matching the mapping's `config.insider_names` become signals and a person with no configured name produces none (the poll says so through the note channel). **Which code**: `P` (open-market purchase) and `S` (open-market sale) are decisions; `A` (award), `M` (option exercise), `F` (tax withholding) and `G` (gift) are compensation and estate mechanics, and scoring an award as positive would mean the board paying the CEO moved the CEO. One signal per filing date and code, share counts summed across the filing's lines, **the transaction price never read**.

**Observe-only, and why not a flag.** The daily close is returned as a reading like any other and the ingestion runner records it as a raw snapshot and stops, because the source row lists it in `config.observe_only` — no observation row, no signal, no force, no memory, no score history. The series still fills, so the baseline is ready the day counsel clears it. A flag defaulting on would stop what comes next and leave what it already did: scores that moved on a stock price would stay moved in `score_history`, in the drifting target's state and in the person's memory profile. Observe-only leaves no trail to unwind.

It is **configuration in one place every source passes through**, not a property of this connector, so no connector can opt out of it, and the enable path is one row update with no deploy:

```sql
-- The whole of turning the close on, when counsel answers.
update public.data_sources
   set config = jsonb_set(jsonb_set(config, '{observe_only}', '[]'::jsonb),
                          '{metrics,daily_close}',
                          '{"label":"share price","delta":"relative_rate","polarity":1,
                            "baseline_window_hours":720,"min_samples":20,"sd_floor":0.005,"scale":1}'::jsonb)
 where name = 'finnhub';
```

Four things hold it shut, and three of them are tests. The connector exports `PRICE_DERIVED_METRICS`, and a database test asserts that list is **exactly** the row's `observe_only`, so a price metric added later without the row change fails the suite rather than reaching a score. A second asserts no price key is declared under `metrics`. A runner test drives forty polls with a tenfold move in an observe-only key and asserts it produced snapshots and no observation, no signal and nothing in the log but its key. And the operator console reads `observe_only_snapshots`, a view whose `WHERE` clause admits a row only while its source declares that key observe-only — so the edit that lets a figure count is the same edit that removes it from the view, and a level that scores is structurally unable to appear there. That view is the one place a raw level is deliberately readable, on the Phase 9 precedent that a purpose-built view is the boundary; what it exposes today is a public company's closing price, which is public market data rather than private data about a person.

**Page and Brin both map to GOOGL.** Their filings are told apart by name, so those differ. The company-news count is one series for both, so that metric moves them together, and it is left shared at a modest scale rather than split or reweighted: splitting it would be inventing a difference that Alphabet's coverage does not have. The news doors already separate them by name and are the dominant signal; if the correlation proves too strong in practice the fix is a per-person scale, which is not built because there is no evidence yet that it is needed. **Correction (Phase 29d):** until 29d the shared series reached Page only. The metric signal's key names the ticker, not the person, and signals were unique per source and key, so Brin's copy was refused silently on every poll (19 emitted readings in a week, 0 Finnhub signals ever). Signals are now unique per source, person and key.

**Quota and budget.** The free tier allows 60 calls a minute, and a poll of all nine costs 9 company-news calls plus 9 insider calls plus at most 9 quotes — 27 at the ceiling, 18 on the twenty-three polls a day that do not re-read the close, against 3,600 a minute of headroom. The interval is **35 minutes**: not a multiple of the cron's 15, and deliberately not 55 either, because 55 comes due at exactly the top of every hour on a fifteen-minute cron, which is why `youtube`, `youtube_comments`, `twitch`, `forbes` and `newsdata` all land together there and why the 00:00 run spent 34.1 s of its 35 s budget. 35 comes due every 45 minutes and cycles through :45, :30, :15, :00, sharing the top of the hour one poll in four, and `poll_concurrency` is 4.

**What else Finnhub has that is not a price**, reported and not wired: **insider sentiment** (MSPR, a company-wide monthly aggregate) is explicitly sold as a predictor of price changes over the next 30 to 90 days, which is the shape counsel would object to even though it is not itself a price, and it is not person-specific — recommended against. **Earnings surprises** (EPS actual against estimate) are the strongest remaining candidate: discrete, dated, directional, and a fundamental rather than an instrument price, but issuer financial data all the same, so it should be put to counsel before it is wired. **SEC filing counts** and **social-sentiment mention volume** are both attention-shaped and non-priced; mention volume is the better of the two and may need a paid tier. **Lobbying spend**, **government contracts** and **visa applications** are corporate-behaviour figures with a slow cadence, low value per unit of work. And `/stock/executive` is the one that would answer a question nothing else here can: whether the tracked person is still an officer of the company, which is how "Musk is no longer CEO" would be detected rather than inferred from a headline.

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

## Two queued changes, replayed and declined (Phase 18)

Both had been deferred for want of data. There is data now, and it says not to
ship either. Nothing in the Engine's behaviour changed in this phase; what
changed is that the two questions are answered in the code that raised them
(`lib/engine/baseline.ts`, `lib/ingest/comments.ts`) with their numbers attached.

### The robust baseline spread

`baselineDeviation` uses the population mean and sd of the trailing window, so
one extreme reading shifts both for the whole window and every ordinary move
after it reads as fewer sigmas. The two candidate fixes — winsorize the window
at ±3 sd, or swap mean/sd for median and 1.4826 × MAD — were replayed against
**3,130 readings across 14 metrics** (2026-09-14 to 2026-09-18) by
reconstructing each reading's own window from `raw_metric_observations`. The
reconstruction reproduced the stored classification on **3,130 of 3,130**.

| rule | readings that emit | reclassified |
|---|---|---|
| current (mean / sd) | 662 | — |
| winsorized at ±3 sd | 663 | 1 |
| median / 1.4826 × MAD | 604 | 176 (117 lost, 59 gained) |

Winsorizing is a no-op at this volume: its one difference is
`patrick-mahomes / news_volume_24h` at 2026-09-18 06:45, where the mean moves
37.5566 → 37.5496 and the sd 9.5671 → 9.5458, carrying |sigma| 0.9989 → 1.0004
across the deadband edge. MAD is actively worse: **773 of the windows have a
MAD of exactly 0**, because these are small-integer counts whose median
absolute deviation collapses once half the window shares a value, and a zero
MAD falls through to the constant `sd_floor` — the metric stops being
normalised against itself at all. Deferred, with a named revisit: the per-game
athlete metrics (`min_samples` 8 over 1,680 h) are the one family whose window
never fills, so around eight played games, in November.

The replay, to re-run it later (service role; `sd_floor` comes off each source's
`config.metrics`, the deadband is 1.0 σ for every metric, and each reading's
window is rebuilt from the observations inside its own `window_hours`):

```sql
with cfg as (
  select d.id as sid, m.key as mk, (m.value->>'sd_floor')::numeric as sd_floor
    from public.data_sources d, lateral jsonb_each(d.config->'metrics') m(key, value)
), obs as (
  select o.id, o.person_id, o.data_source_id, o.metric_key, o.recorded_at, o.observed,
         o.samples, o.min_samples, o.window_hours, o.outcome, c.sd_floor
    from public.raw_metric_observations o
    join cfg c on c.sid = o.data_source_id and c.mk = o.metric_key
   where o.observed is not null
), pairs as (          -- every reading's own trailing window, the reading included
  select a.id, b.observed as pt
    from obs a join obs b
      on b.person_id = a.person_id and b.data_source_id = a.data_source_id
     and b.metric_key = a.metric_key and b.recorded_at <= a.recorded_at
     and b.recorded_at >= a.recorded_at - (a.window_hours * interval '1 hour')
), s1 as (
  select p.id, avg(p.pt) as mean, coalesce(stddev_pop(p.pt), 0) as sd,
         percentile_cont(0.5) within group (order by p.pt) as med
    from pairs p group by p.id
), s2 as (
  select p.id,
         avg(least(greatest(p.pt, s1.mean - 3*s1.sd), s1.mean + 3*s1.sd)) as wmean,
         coalesce(stddev_pop(least(greatest(p.pt, s1.mean - 3*s1.sd), s1.mean + 3*s1.sd)), 0) as wsd,
         percentile_cont(0.5) within group (order by abs(p.pt - s1.med)) as mad
    from pairs p join s1 on s1.id = p.id group by p.id
), c as (
  select o.metric_key, o.outcome,
         (o.samples >= o.min_samples and abs(o.observed - s1.mean)  > greatest(s1.sd,  o.sd_floor))          as emit_now,
         (o.samples >= o.min_samples and abs(o.observed - s2.wmean) > greatest(s2.wsd, o.sd_floor))          as emit_wins,
         (o.samples >= o.min_samples and abs(o.observed - s1.med)   > greatest(1.4826*s2.mad, o.sd_floor))   as emit_mad,
         (o.samples >= o.min_samples and s2.mad = 0)                                                         as mad_zero
    from obs o join s1 on s1.id = o.id join s2 on s2.id = o.id
)
select metric_key, count(*) as observations,
       count(*) filter (where (outcome = 'emitted') = emit_now) as reconstruction_agrees,
       count(*) filter (where emit_now)  as emit_current,
       count(*) filter (where emit_wins) as emit_winsorized,
       count(*) filter (where emit_mad)  as emit_mad,
       count(*) filter (where mad_zero)  as zero_mad_windows
  from c group by 1 order by 2 desc;
```

**The separation holds, and it is narrower than it looks.** `baselineDeviation`
has four callers: the metric pipeline, the derived `spike_count` cutoff, the
per-person volume weight and the Trading Activity force. The volume weight
divides `referenceSignalsPerDay` by the reading's **mean**, so either robust
rule, applied inside the shared function, would silently re-level every
person's volume weight — and there are no complete days to replay that against
until 2026-09-25. The Signals freshness curve (24 h), memory expiry (30 days)
and the Gravity drift clock (336 h) do not read the file at all. All of that is
pinned by tests in `lib/engine/baseline.test.ts`; a future robust rule has to
arrive as a per-call-site option with today's behaviour as its default.

### The casual-register lexicon

Phase 8+ predicted the keyword lexicon would read news and not viewer comments.
It does: **87 of 87 digests in production read "are mixed" at 0.000 impact**,
and 851 of the 870 sampled comment slots (96 distinct comments, 3 videos, one
mapped person) score neutral. Comment volume is carrying that signal alone.

Extending the lexicon was replayed with a candidate casual list (goat, legend,
insane/crazy/wild, fire, respect, congrats, best/king/hero, love, praise emoji;
mid/trash/flop/fell-off/scam/💀). It lifts the corpus from 5 positive comments
to 53 and would turn **74 of the 87 digests positive**, average margin 0.385,
none negative. It fails on both registers at once. `scoreHeadline` is one
shared function, so of the 623 stored articles the 33 containing a candidate
term change direction 30 times — two of them **losing a correct negative**
("Officials Under Fire for Missing Travis Kelce Penalty", "Adin Ross Wants
'Investigation' Into Ray J vs. Supa Hot Fire Fight") and several inheriting a
wrong one ("Sergey Brin fights fire with fire", "MrBeast's 'God King' problem",
"Warren Buffett's dead-simple playbook", "The Time to Be Fearful When Others
Are Greedy"). Those readings are now pinned in
`lib/engine/sentiment/rules.test.ts`. And on the comment side, the largest class
it newly catches is praise for the **camera crew** — the example the digest was
built to exclude.

Letting the LLM grade the digest costs about **$0.55 a month** on Haiku 4.5 at
the current 14.5 digests a day (~$9 a month if all sixteen subjects were mapped
for comments; roughly five times that on Opus 5). Affordable, and it would read
the register correctly — but it does not fix what is wrong. YouTube's top
comments are ranked by likes, so the sample is positively selected by
construction, and a perfectly graded digest is a better-measured one-sided
reading: the Phase 10 rule about a sigma describing the sampling rather than
the subject, arriving by a different door.

**Neither ships.** Comment sentiment is not worth fixing while the sample is
like-ranked and the subject attribution is unsolved.

One consequence was flagged and left to Phase 18+, because it belongs to the
volume baseline rather than to the digest: `person_signal_volume()` counted
every event signal, digests included, so these zero-impact rows sat in the
denominator of the person's volume weight — over 2026-09-14..17 they were 80 of
MrBeast's 92 event signals.

## The volume denominator counts events, not artifacts (Phase 18+)

The volume weight measures how unusual today's flow of signals is for a person,
against their own trailing days, and multiplies every event signal's impact by
it. So the series has to count exactly the signals the weight multiplies: a
signal counted but not weighted dilutes everything else for free, and a signal
weighted but not counted is amplified by a denominator it never fed. One rule
now decides both sides, and `lib/engine/signal-volume.ts` holds it as
`UNCOUNTED_SIGNAL_KINDS` with a test that fails if the array and the RPC's SQL
ever disagree:

> **A signal counts when its rate is set by the world, not by our polling.**

Halve the poll interval and ask what changes. An article does not — a story is
published once and deduplicated across the two news doors. A stream summary
does not: one per broadcast. A game result: one per game. A Form 4: one per
filing. Those are **events**. They count, and they carry the weight, and it does
not matter that some are coverage of the person while others are the person's
own activity — both have a rate reality sets, and both are scored, so both
belong in the denominator that decides what a normal day is.

A comment digest does change: it is emitted once per video per poll whenever
the sampled top comments have churned, so its rate is our cadence and YouTube's
like ranking and nothing about the person. A live moment does too: it is the
live cron's sampling of a session, bounded by a cooldown that is itself a
sampling parameter. Those are **artifacts** — counted nowhere, weighted never.
It is the Phase 10 rule about a sigma describing the sampling rather than the
subject, applied to the volume series instead of to a metric. Metric signals
were already out (they carry their own per-metric baseline, so the weight would
normalise them twice) and baseline signals are zero-impact seeds.

Phase 16 had already settled the live moment on both sides; what it left
unwritten was the rule, so the comment digest went on being counted *and*
weighted. Both sides move in this phase, and the legacy per-comment kind
(`comment`, not emitted since Phase 8+) goes with them.

**The correction, per person**, as seven-day means to 2026-09-17. MrBeast is
the only subject it moves, because nobody else holds a signal of an excluded
kind:

| | before | after |
|---|---|---|
| daily series | `{1,6,4,16,38,27,12}` | `{1,0,0,1,6,3,1}` |
| mean per day | 14.86 | 1.71 |
| implied weight | 1.346 | 2.000 (at the ceiling) |

**What the correction exposed.** At `referenceSignalsPerDay` = 20 the weight now
saturates at `maxWeight` for fifteen of the sixteen: the real roster runs at 0.3
to 13.9 events a day, not the 3 to 100 the reference was chosen against in Phase
15. Only `patrick-mahomes` (1.443) sits below the ceiling. When the weight
engages it will therefore be very nearly a constant 2× on the Signals force
rather than a normalisation. Re-deriving the reference from the roster's own
volumes is its own decision and has not been made; the arithmetic is pinned in
`signal-volume.test.ts` so it cannot be quietly forgotten.

**Two waves, and they are not merely untidy.** `tracked_since` is untouched — the
regime clocks stay honest — so the weight engages **2026-09-25** for the seven
mapped in Phase 15 (adin-ross, anthony-baptiste, drake, kai-cenat,
kendrick-lamar, mrbeast, patrick-mahomes) and **2026-09-26** for the nine
remapped in Phase 17 (elon-musk, jeff-bezos, jensen-huang, larry-ellison,
larry-page, mark-zuckerberg, michael-dell, sergey-brin, warren-buffett).
Nothing displays the weight and nothing compares one person's weight to
another's — but two surfaces compare quantities the weight feeds, and both were
checked rather than assumed: `rankPeople` orders the board by score descending,
and `topMovers` orders the featured strip by absolute score *change*, which is
exactly what the weight multiplies. On 2026-09-25 six of the seven run at 2×
while the nine still run at 1×, so for one day the strip compares weighted
movement against unweighted. That is a real inconsistency, not a cosmetic one.
It is also strictly better than forcing a single date, which would change every
score's drift rate at the same instant instead of half of it; and backdating
`tracked_since` would buy tidiness with a lie about when each person started
being watched. The right answer is to know the date, not to move it.

## The volume reference, re-derived before it engaged (Phase 18++)

Phase 15 set `referenceSignalsPerDay` = 20 against an ASSUMED roster of 3–100
events a day. The real roster, measured once the denominator was correct, runs
0.5 to 30. At 20 the ceiling decided fourteen of sixteen weights, so when the
mechanism engaged on 2026-09-25 it would have been a near-constant 2× on the
Signals force — a global gain, not a normalisation, and the seeded-target
failure in a new costume.

### The derivation

The reference is now the **geometric mean of the roster's per-person daily
event rate**, measured over the complete days in which the whole roster was
ingesting, people with no volume at all excluded from the mean (log 0 is
undefined) and reported separately:

| window | geometric mean | median | arithmetic mean |
|---|---|---|---|
| last 2 complete days | 3.85 | 3.00 | 6.40 |
| last 3 complete days | 3.70 | 3.33 | 6.24 |
| last 4 complete days | 3.50 | 3.25 | 5.43 |

**Rounded to 4.** The geometric mean is the right centre because the weight is
multiplicative: setting log(reference) to the mean of log(rate) centres the
log-weights on zero, so as many subjects are scaled up as down and by
proportionate amounts. The arithmetic mean is dragged by one subject's game-day
spikes — Patrick Mahomes runs 30 a day across an NFL weekend and 1 on a Tuesday
— and would push the quiet majority below 1. The median agrees within 20 %,
which is itself evidence the choice is not knife-edge. The geometric mean is
also stable across the three windows (3.50–3.85) where the arithmetic mean is
not (5.43–6.40).

### The weight table

Three-complete-day rates to 2026-09-17, the same measurement the reference came
from:

| slug | typical / day | weight at 20 | **weight at 4** |
|---|---|---|---|
| patrick-mahomes | 30.33 | 0.659 | **0.132** |
| jensen-huang | 10.33 | 1.935 | **0.387** |
| elon-musk | 9.67 | 2.000 | **0.414** |
| drake | 9.33 | 2.000 | **0.429** |
| mark-zuckerberg | 8.33 | 2.000 | **0.480** |
| warren-buffett | 6.00 | 2.000 | **0.667** |
| kai-cenat | 4.67 | 2.000 | **0.857** |
| mrbeast | 3.33 | 2.000 | **1.200** |
| larry-ellison | 2.67 | 2.000 | **1.500** |
| jeff-bezos | 2.33 | 2.000 | **1.714** |
| sergey-brin | 2.00 | 2.000 | **2.000** (exactly at it) |
| larry-page | 1.67 | 2.000 | **2.000** (capped) |
| michael-dell | 1.67 | 2.000 | **2.000** (capped) |
| adin-ross | 0.67 | 2.000 | **2.000** (capped) |
| kendrick-lamar | 0.67 | 2.000 | **2.000** (capped) |
| anthony-baptiste | 0.00 | 2.000 | **2.000** (no volume) |

**Does it discriminate?** That is the test, and it is what the tests in
`signal-volume.test.ts` assert. A typical day's total impact — rate × weight,
which perfect normalisation would make equal for everyone — spanned **14.9×**
across the roster at 20 and spans **3.0×** at 4. The ceiling decides six weights
rather than fourteen, of which four are genuinely clamped. And it has not
flattened either: the weights still span more than 10×, so they are saying
something about each person rather than nothing.

### The bounds, examined with the reference

`maxWeight` 2 now binds below **2 events a day**, where a person's rate is
estimated from a handful of events and its relative error is large — so it is a
variance guard on the subjects we know least about, which is what a cap should
be. At 20 it had stopped being a guard and become the mechanism. `minWeight`
0.1 binds above **40 events a day** and nobody is close; a floor that never
fires is a floor doing its job, and it remains the guard against a runaway
connector reading as a person with no news. Both stay as they are.

### Fixed, not roster-relative

A roster-relative reference (the live geometric mean, recomputed each tick)
would never go stale — and would couple every person's weight to every other
person's. Ten new subjects at half an event a day would move today's live
geometric mean from **3.71 to 1.66**, so **every existing subject's weight would
fall by 55 % overnight**, for reasons that have nothing to do with them, and
their score history would stop being comparable across a roster change. (Ten at
one a day: −41 %. Three loud subjects at eight a day: +14 % on everyone.) That
is precisely what the per-person design exists to avoid. A fixed constant goes
stale instead — but *visibly*, and re-deriving it is a dated, deliberate act.

So the reference stays fixed, and the staleness is made observable rather than
latent. **`/admin` → Engine state → Signal volume** shows every person's typical
rate, weight and whether a bound is deciding it, plus four figures: how many
weights have engaged, the reference, the roster's live geometric mean, and how
many sit on a bound. **Re-derive when either symptom crosses:**

1. more than **a third** of the engaged people sit on a bound, or
2. the roster's live geometric mean leaves **[reference ÷ 2, reference × 2]**.

Sensitivity, so the trigger is not a mystery: the reference moves with the
*typical* subject, not the loudest. Adding N subjects at rate r to a roster of M
shifts log(reference) by (N / (M+N)) × (log r − log reference). On today's
fifteen measured subjects that is **−55 %** for ten newcomers at 0.5 a day,
**−41 %** at 1 a day, and **+14 %** for three at 8 a day. Roster changes move it
far more than source changes, and a roster change of a third is roughly the
point at which the second review trigger fires on its own.
`ENGINE_VOLUME_REFERENCE` re-sets it without a code change.

### The two-wave transient

The weight engages **2026-09-25** for the seven mapped in Phase 15 and
**2026-09-26** for the nine remapped in Phase 17. `Weight engaged` on the admin
panel counts it live. Nothing is suppressed for that day and nothing should be:
`topMovers` ranks by absolute score change, so for one day it compares weighted
movement against unweighted — but hiding the strip would remove the evidence
while the inconsistency happens, and annotating it would put an Engine
implementation detail on a subject-facing surface for one day. The board is
paper-traded and under an auth gate; the honest handling is to watch the
transient in the console, which is now possible, and leave the public surface
telling the truth about what the Engine actually did.

### Two loose items

**Finnhub is live.** The key was set; 36 ok polls in the three hours to 16:45
UTC, nine executives, 36 observations, no Form 4s in the window. **BRK.B is
Finnhub's spelling for Berkshire Hathaway** and it resolves: 7 readings of
company news volume between 8 and 23 items a day. Page and Brin both read GOOGL
and carry identical values, as designed.

**The epoch-dated article.** Google News emits `Thu, 01 Jan 1970 00:00:00 GMT`
for an entry with no publication date — a publisher's standing profile page —
and one such item ("Sergey Brin - Forbes", forbes.com) was stored on 2026-09-17
dated 1970-01-01. `rss.ts` now refuses any item whose date it cannot believe
(missing, before 2000, or more than ten minutes in the future), the same rule
`publisher_rss` has applied since Phase 13, and the poll carries a note saying
how many were refused rather than dropping them silently. The opposite hole was
worse and also closed: an undated item used to be stamped with the run's clock,
making the least trustworthy item the *freshest*. Of 651 stored articles exactly
**one** has the defect (that one) and **none** were stamped with the run — the
`?? now` path was latent rather than realised. The stored row is left in place;
it sits outside every freshness and volume window and removing production rows
is not something this phase was asked to do.

## Forecast: the crowd layer, capture and display (Phase 19)

The **Forecast** section sits on a person's profile directly below the five
forces, in their styling, and asks one question: is this person's momentum
**▲ Rising** or **▼ Falling** over the next month? It takes one answer with
one reason, shows the crowd's answer as aggregates only, and moves nothing.

### The one hard rule

Votes influence NOTHING in this phase. The Forecast force exists in
`DEFAULT_ENGINE_CONFIG.forecast` at weight **0.00** and nowhere else: no
force module, scorer, store or tick reads it. Following the Phase 17
discipline, that is asserted by tests rather than by a comment:

- `lib/engine/forecast.test.ts` pins the weight at exactly `0` (the object
  equals `{ weight: 0 }` and the literal `forecast: { weight: 0 }` is in the
  source), scans `lib/engine/` and fails if any file other than `config.ts`
  so much as names `forecast`, fails if the Engine's read or write path names
  `forecast_votes`, `cast_forecast_vote`, `forecast_summary` or
  `lib/forecast`, pins the store's tables and RPCs to the set they have always
  been, and runs the same tick twice on the memory store — once quiet, once
  with a crowd of votes decorating the store and one of the two people
  paused — and requires identical people, forces, mood, signals, score
  events, score history and processed signals, with no sixth force on
  anyone.
- `lib/forecast/forecast.db.test.ts` proves the same on real Postgres: three
  voters cast on every active person, `apply_engine_tick()` is applied, and
  every read the Engine makes (`people`, `person_signal_volume()`, `signals`,
  `engine_ticks`, `score_events`) is captured; the votes are deleted, the same
  tick applied again from the same starting point, and the two captures must
  be deep-equal. It also checks that no table the tick writes carries a
  column named for a forecast other than `people.forecast_paused`.

### Vocabulary

The section and the force are **Forecast**. A vote is **▲ Rising** or
**▼ Falling** — a call on trajectory, never bullish / bearish, never an
upvote / downvote, never a rating of the person. Every vote carries exactly
one reason tag: **Professional, Social, Financial, Cultural, Performance,
Media, Other**. The panel's footnote says so in the product's own words: *A
forecast is a call on where the momentum goes, not a rating of the person.
The crowd's calls are shown here and move no score.* `lib/forecast/model.ts`
holds the vocabulary once for SQL, server and client, and the db test pins
the SQL check constraints to the same seven tags.

### Schema

- `people.forecast_paused boolean not null default false` — the per-person
  kill switch. Admin-set by SQL like every other lever
  (`update public.people set forecast_paused = true where slug = '…'`); the
  console's Engine table shows it read-only as a `paused` / `open` column.
  When set, the profile does not render the section at all and
  `cast_forecast_vote()` refuses with `paused`.
- `forecast_votes` — `id`, `user_id` (→ `auth.users`, cascade), `person_id`
  (→ `people`, cascade), `direction` (`rising` | `falling`), `reason` (the
  seven tags, as a check constraint), `score_at_vote numeric(8,4)` (the
  person's `current_score` at the instant of the vote, read inside the RPC,
  never accepted from the client — the thing that makes accuracy computable
  later and cannot be backfilled), `created_at`, `superseded_at`.
- **One ACTIVE vote per user per person**, by a partial unique index on
  `(user_id, person_id) where superseded_at is null`. Voting again stamps
  `superseded_at` on the prior row and inserts a new one; nothing is deleted,
  so the trail of changes of mind is the accuracy record. Casting the
  identical direction and reason again is a no-op (`changed: false`) and
  writes no row.
- **Pseudonymous by construction.** RLS on `forecast_votes`: one policy,
  `select` for `authenticated` where `auth.uid() = user_id`; no client
  `insert`, `update` or `delete` grant at all; `anon` cannot read. The db test
  runs as a second signed-in user and sees none of the first user's rows, as
  `anon` and sees nothing, and fails to write directly under either role.
  Every other user meets a voter only as a count inside `forecast_summary()`.
- `cast_forecast_vote(p_person_id, p_direction, p_reason)` — SECURITY
  DEFINER with `auth.uid()` as the actor, never a parameter. Validates the
  vocabulary, refuses an unknown or inactive person, a paused person and the
  rate limit, then supersedes and inserts in one transaction. Every refusal
  is a returned value `{ ok: false, code, message }` (`invalid`,
  `unknown_person`, `paused`, `rate_limited`); only a missing session raises.
- `forecast_summary(p_person_id)` — aggregates only: `total`, `minVotes`,
  `revealed`, and `rising` / `falling` / `risingReasons` / `fallingReasons`
  (the top three tags per direction by count, then name) only once
  `total >= forecast_min_votes()`. Below the minimum the split is not merely
  hidden by the UI; it is not returned.
- `forecast_rate_limit_per_hour()` = **20** and `forecast_min_votes()` =
  **5**, as functions on the `starting_balance_cents()` pattern, so the SQL
  and the TypeScript constants (`FORECAST_RATE_LIMIT_PER_HOUR`,
  `FORECAST_MIN_VOTES`) are pinned to agree by a test.

### The two numbers

**Rate limit: 20 distinct people per trailing hour**, enforced in
`cast_forecast_vote()`. Sixteen subjects today: one person can forecast the
whole roster in a sitting, and a script cannot sweep it repeatedly. It counts
*people*, not votes — changing a vote on someone already voted on inside the
hour is free — and the window slides (the db test casts on 20 people, is
refused on the 21st, re-votes freely, and is admitted again once the earliest
casts are more than an hour old).

**Minimum count: 5 active votes** before the Rising / Falling split is shown.
Below it the panel shows the count alone — *3 forecasts so far. The Rising /
Falling split shows once 5 people have called it.* — because a lone vote
reading "100% Falling" is the wrong first impression, and because below five
a second voter could subtract their own vote from the aggregate and read the
first voter's.

### Display

- `components/person/forecast-panel.tsx`, rendered by the profile page right
  after `ForcesPanel`, under the same `SectionHeader` / `Card` as the forces.
  The header's meta is the count (*12 forecasts*).
- With five or more votes: the two percentages (`splitPercent()` rounds to
  whole numbers that sum to 100), a diverging bar, and the top reason tags
  per direction as badges with their counts. **Green and red mean the
  reported direction and nothing else**: the split, the bar, the reason
  badges and the line stating the viewer's own forecast.
- **Empty state** (no votes yet): *Make the first forecast.* — *Is
  {name}'s momentum rising or falling over the next month? Your call, with a
  reason, is the first reading the crowd has on them.*
- **The vote is two taps.** Two buttons, then the seven reasons as a row of
  outline chips; picking a reason submits. There is no modal. The **▲ Rising**
  button wears exactly the Buy styling and **▼ Falling** exactly the Sell
  styling — the shared `Button` `buy` / `sell` variants (and
  `buttonClassName()` for the signed-out links to `/login`), never green or
  red. After voting the panel shows *You forecast ▲ Rising · Professional*
  with a **Change** control that re-opens the two buttons beside **Keep
  mine**.
- Not shown, by instruction: any individual voter, any vote feed, any
  Data-vs-Crowd divergence.

### The write path

`POST /api/forecast/vote` with `{ personId, direction, reason, surface? }`.
Identity comes from the auth cookies, never the body (401 signed out); the
route validates the vocabulary and hands the rest to `cast_forecast_vote()`
as the viewer. Refusals come back as the RPC's `{ ok: false, code }` with
the matching status; a database failure is a 503 that records nothing. The
`cast_forecast` behavioural event is written after the response and only
when the vote changed. `lib/forecast/server.ts` reads the aggregate through
the service-role client and the viewer's own vote as the viewer, under the
select-own policy, which is the only way a vote row ever reaches a client.

### The mobile header

The paper balance pill is gone from the mobile header; it stays on the
desktop header unchanged and stays visible in Portfolio on both. Market Mood
is back in its original mobile position and styling. (`top-banner.tsx`: the
balance chip renders inside `hidden sm:contents`, and the pulse indicator is
unconditional again.)

### Not built, by instruction

Vote-influence weighting, accuracy scoring, coordinated-activity detection
and the abnormal-activity freeze, conviction levels on a vote, comments, any
freeze UI, any Engine contribution, any Feed presence. The score at vote
time is stored now so that accuracy can be computed later without a backfill.

## Market Mood is a tide, not a splash (Phase 19+)

Measured across the first 6,056 ticks: 215 had signals to read, 214 carried a
non-zero mood, and the largest reading ever was 0.2457. Those middle two
numbers matching is the whole story — the mood was the mean of **this tick's**
Signals impacts, signals arrive in fifteen-minute bursts, and the Engine ticks
twice a minute, so on **96.5% of ticks** there was nothing to read a tide from
and the mood correctly reported 0.00.

Gravity's behaviour between bursts is meaningful: it decays smoothly, and the
decay is real. Mood's was not. A tide that exists for one tick and is gone
thirty seconds later is a splash.

### The window

The mood is now the board's Signals movement over a **trailing 60 minutes**:

```
mood = Σ Signals impact in the window / (people × readings)
```

A **reading** is a tick inside the window that moved anyone. Dividing by every
tick would bury each burst under the 119 quiet ticks around it; dividing by
the readings keeps the burst's own magnitude and holds it for the window,
decaying as old readings age out. The value therefore stays on the scale the
clamps were set for — only its frequency changes. A person's own signals are
still excluded from their own mood, which matters *more* with a window, since
a burst now persists for an hour rather than a tick.

`windowMinutes` is a **tunable** (`ENGINE_MOOD_WINDOW_MINUTES`). 60 was chosen
from the replay below: 30 minutes leaves the mood absent on 16% of ticks, and
120 halves the visible changes to 1.5 an hour, reading as the mood of the
afternoon rather than of the hour.

### The replay, over the 48 hours to 2026-09-18 (5,760 ticks)

| | instantaneous (before) | windowed, 30 min | **windowed, 60 min** | windowed, 120 min |
| --- | --- | --- | --- | --- |
| Ticks with a non-zero mood | 204 (3.5%) | 4,845 (84.1%) | **5,750 (99.8%)** | 5,750 (99.8%) |
| Ticks showing something at 2 dp | 190 (3.3%) | 4,276 (74.2%) | **5,090 (88.4%)** | 5,266 (91.4%) |
| Times the header figure changes | 319 | 191 | **139 (2.9/hour)** | 71 (1.5/hour) |
| Range | −0.1400 … +0.1601 | −0.0436 … +0.0872 | **−0.0331 … +0.0773** | −0.0198 … +0.0561 |

The instantaneous reading changes *more often* (319) while saying less: most
of those changes are a flicker to a value and back to 0.00 within one tick.

### What it does to scores, and the rate that holds it still

Windowing puts the mood on ~28× more ticks, and the windowed value is itself
smaller than a burst reading, for a measured **21.27× rise in gross
contribution** had the per-tick `fraction` of 0.25 been left alone. That is a
real change in score movement, not a display change, so the weight was
re-derived in the same commit rather than left to run hot:

```
equivalent per-tick fraction = 0.25 / 21.27        = 0.01175
ratePerHour                  = 0.01175 × 120 ticks = 1.41
```

**The rate is derived, not chosen**, and `lib/engine/market-mood-window.test.ts`
fails if someone edits it without re-deriving it. Replayed per person over the
same 48 hours, with self-exclusion and four-decimal rounding included:

| | before | after | |
| --- | --- | --- | --- |
| Gross movement | 0.036184 points/hour | 0.036080 points/hour | **−0.3%** |
| Net drift | 0.026048 points/hour | 0.032216 points/hour | **+23.7%** |
| Resting displacement against Gravity | 0.074 points | 0.092 points | |

Gross is held flat by construction. **Net is not, and that is the honest
number**: a window cancels less within itself than separate one-tick splashes
do, so the same readings leave a little more signed drift behind. Both figures
sit far below the Engine's 0.5-point unit of notable, and the resting
displacement moves by under a fifth of a point, so the board does not
re-level; but the rate matches the board's measured *mix of signs*, not a
universal invariant. Re-derive it if the burst cadence changes materially.

### Per hour, like Gravity

The force is `ratePerHour × Δh`, in the person's own elapsed time, rather than
a fixed amount per tick. A per-tick force silently scales with the tick
interval: halving the cadence would have doubled Mood's pull on every score
with nothing in the diff to show it — the same class of bug as the poll
interval that was silently halving source polls (Phase 10) and the volume
reference that went stale against a changed roster (Phase 18++). The test runs
the same wall-clock hour at 30 and at 60 seconds a tick and requires the same
movement within 1%; a per-tick force would differ by 2×.

### Where the mood shows

The banner's Mood indicator has existed since Phase 6a but was never wired to
a reading — it passed `null` and always showed "—". Windowing is what makes
wiring it worth doing, so it now shows the latest tick's windowed mood and
whether the Engine is ticking (`lib/engine/board-pulse.ts`: one indexed row
per request, server-rendered, so it follows navigation rather than polling —
at 2.9 changes an hour that is honest enough). `/admin` labels its column
**Mood (60m)**. `engine_ticks.mood` now stores the windowed value; rows before
2026-09-18 hold the older instantaneous one, and the column's comment says so.

### The cost

Market Mood now writes a `score_events` row for nearly every person on nearly
every tick instead of 3.5% of them: roughly 46,000 more rows a day, about
20 MB, on a table already growing at 48,000 rows and 22 MB a day from Gravity.
Worth a retention window on `score_events` before it is a year old; not
changed here. **The retention item, as it stands (Phase 29 added to it):**
`score_events` as above; `premium_history`, which gains one row per person
per tick while that person's inventory is non-zero (decay) plus one per
order, and is what makes every quoted market price reproducible, so any
window must keep at least as much as the longest chart range; and
`trade_orders.fingerprint_hash`, to be nulled after
`platform_settings.fingerprint_retention_days` (30). None of the three is
pruned yet; no prune ships in this phase by decision.

## A displayed zero is never coloured (Phase 19+)

On a profile whose score sits above its Gravity target, the forces panel
showed Gravity as **0.00 in red**. Colour means direction in this design
system and zero has no direction. The cause was as diagnosed: the underlying
value is a small negative — the pull downward toward the target — that rounds
to 0.00 at two decimals while keeping its sign for colouring. Since Phase 14
stored scores at four decimals, it is the common case rather than a rare one.

`directionAtPrecision(value, precision, threshold)` in
`components/ui/direction-indicator.tsx` is now the rule: **a value that rounds
to zero at the precision it is shown at is neutral**, whatever its sign
underneath; above that the existing flat threshold still applies. It rounds
with the same `toFixed` the formatters use, so the text and its colour cannot
disagree. Rounding and precision are unchanged everywhere — this is a
colouring rule only.

Every surface that colours a number by sign was checked. Four carried the
defect, all of them the ones that passed a threshold of 0 (colour on any
non-zero sign) beside a figure shown to two decimals:

| Surface | Defect |
| --- | --- |
| The five forces (`readForces`, profile) | **The reported case**: Gravity at −0.0038 shown "0.00" in red |
| Signals list (profile) | A signal impact rounding to 0.00 took a colour |
| Feed entry evidence | The same, on each signal behind an entry |
| `FeedEntryModel.direction` | Same rule, latent: the field is carried but not yet rendered |

And one more found in the same class, in the text rather than the colour:
`formatChange()` signed by the raw value, so it printed **"+0.00"** for 0.004
— the header's own Mood figure among them. It now drops the sign when the
figure rounds to zero, exactly as `formatSigned()` already did.

Checked and left alone, with the reasoning: the shared `DirectionIndicator`
(score deltas, top movers, Notable Moves, the Feed's per-entry delta) shows
one decimal, where the flat threshold of 0.05 *is* half a unit, so a displayed
0.0 was already neutral; the period-change percent beside the hero score can
only display 0.00% for changes smaller than the points threshold colours; and
every money surface (portfolio, positions, trade sheet) works in integer
cents, where a non-zero value can never display as $0.00. Chart labels and
sparklines are monochrome.

## Metric emission, the deadband, and the forces panel (Phase 21)

Phase 20 measured the board and found metric signals outnumbering article
signals nine to one, carrying **92.5 % of all Signals-force impact** over 48
hours. Two causes, both in the emission rule rather than in the data. This
phase ships the fix for both, takes the one metric that is broken at the
source out of scoring, and makes the forces panel show a figure that can
render.

### A metric describes a state; the event is the state CHANGING

`news_volume_24h` reading four articles an hour, unchanged, for six hours was
six signals. Each was true and only the first was news. **82.5 % of emitted
metric signals repeated the identical value of the one before them**, carrying
77 % of metric impact.

`observeMetric()` now takes the metric's **previous observation** and emits
only when the observed quantity differs from it. The rule in full:

- **"Differs" is an identity check, not a small-change filter.** A reading that
  moves at all is a new reading and emits, whatever the size of the move —
  magnitude is the deadband's job. `UNCHANGED_RELATIVE_EPSILON` is **1e-12**,
  about a thousand times double precision's own round-off, so a quantity
  recomputed by a different route (a rate divided by a slightly different
  elapsed time, a float reassembled out of the ledger) reads as unchanged while
  a real move never does: a count would have to reach 10¹² before a change of
  one unit fell inside it.
- **A run collapses to its first, not to alternating.** A suppressed repeat is
  itself recorded, as the new outcome **`unchanged`**, and `outcomeReported()`
  treats `emitted` and `unchanged` alike as "on the record". Without that, a
  suppressed reading would leave nothing to compare against and the next one
  would emit: on / off / on forever.
- **Changing and changing back is news both times.** The comparison is against
  the record, not against a set of values ever seen. 4 → 4 → 7 → 4 emits three
  times and suppresses once: three states, three events.
- **A metric's FIRST emission is never suppressed.** `insufficient_baseline`,
  `inside_band`, `first_contact` and `no_config` do not report, so the reading
  that finally clears the baseline has nothing on the record to repeat, even
  when the level is the same one that was sitting inside the band yesterday.

The comparison reads one row per metric out of `raw_metric_observations`
(`store.lastObservations`, one query per person and source per poll, on the
index that already existed), so the state lives in the ledger rather than in
the runner's memory and survives a restart mid-poll.

Live mode is untouched: session metrics fire once when a stream closes, so two
consecutive sessions with the same peak viewers are two events, not a repeat,
and the live runner passes no previous observation.

### The deadband, 1.0σ → 2.0σ

At 1.0σ "unusual" meant **one reading in three**: for a normal statistic
|z| > 1 occurs 31.7 % of the time, and the board bore it out —
`news_volume_24h` emitted on 35.7 % of its observations and
`viral_moment_rate` on 29.4 %. That is a description of the middle of the
distribution. The threshold was the finding, not the data. At 2.0σ the tail is
4.6 % under normal theory, which is closer to what the word the headline uses
is worth.

It stays **tunable per metric** (`threshold_std_devs` on the source row);
2.0 is the default and every metric currently takes it. The constant carries
its derivation, and a test pins it so that changing it means re-deriving it.

**Replayed against the whole accumulated ledger**, per metric — what each rule
keeps, and what both together keep:

| Metric | Source | Judged | Emits today | Rate | 2.0σ alone | Change-only alone | Both |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `news_volume_24h` | rss | 2,914 | 1,041 | 35.7 % | 215 | 226 | **78** |
| `viral_moment_rate` | rss | 2,546 | 749 | 29.4 % | 199 | 71 | **50** |
| `comment_volume` | youtube_comments | 101 | 79 | 78.2 % | 18 | 79 | **18 → 0** |
| `company_news_volume_24h` | finnhub | 315 | 28 | 8.9 % | 2 | 19 | **2** |
| `recent_video_views` | youtube | 105 | 24 | 22.9 % | 7 | 24 | **7** |
| `view_count` | youtube | 105 | 8 | 7.6 % | 6 | 8 | **6** |
| `follower_count` | twitch | 92 | 1 | 1.1 % | 0 | 1 | **0** |
| `subscriber_count`, `commentary_volume_24h`, `stream_days_7d`, `stream_hours_7d` | youtube, twitch | 394 | 0 | 0 % | 0 | 0 | **0** |
| **Total** | | **6,572** | **1,930** | **29.4 %** | **447** | **428** | **161 → 143** |

Read it per metric, because the two rules bite differently. The RSS pair is
where the volume was, and the rules attack it from opposite sides: for
`news_volume_24h` the deadband and the repeat rule remove roughly the same
number independently and 92.5 % together; for `viral_moment_rate`, a
spike count that sits on the same integer for hours, the repeat rule alone
removes 90.5 %. The YouTube and Twitch metrics are already quiet and lose
almost nothing — `view_count`'s six survivors are six real moves. Nothing that
was silent becomes loud.

On the same 48 hours Phase 20 measured, the joint replay gives **153 signals
against 1,854**, matching that phase's projection exactly, and **135** once
`comment_volume` stops scoring.

**Measured after shipping**, on the SAME readings rather than a different
day's: the 194 observations of the first hour live (2026-09-19 15:15–16:22,
five ingestion runs) carry their own sigma, so what the old rule would have
done to them is arithmetic, not a different sample. **79** of the 194 clear
1.0σ and would have emitted. **17** clear 2.0σ. Emit-on-change removes 11 of
those 17 as repeats of the reading already on the record. **6 emitted** — a
92.4 % reduction against the replay's projected 92.6 %, on identical data.
Per metric: `news_volume_24h` 3 of 80, `viral_moment_rate` 1 of 80 (with 8
suppressed as repeats), `company_news_volume_24h` 2 of 18, every other metric
0. The six are five different people, and the one person with two
(Mark Zuckerberg, news volume −3.6σ then −4.7σ) moved between them.

The force-level share — 90.9 % metric against 9.1 % event over the 48 hours
before — is NOT yet measurable and is not quoted here: the post-ship hour holds
eight counted readings in total, and the event side of it saw two against a
48-hour average of 3.3 an hour. That figure needs its own 48-hour window, from
2026-09-19 15:15.

### `comment_volume` is not calibrated, and cannot be calibrated yet

It emitted on **78.2 %** of its observations, the highest rate on the board,
and every one was a negative reading of a person whose comment volume had not
fallen.

The metric totals the comment count of a channel's three newest uploads: a sum
over a **changing basket**. When a new video replaces the oldest of the three,
the total steps by the difference between them and nothing about the audience
has changed. MrBeast's stepped from 179,354 to 88,049 on 2026-09-18, and every
hourly poll since was judged as `level` against a 336-hour baseline whose mean
(157,887) describes a basket that no longer exists. Sigma has been walking back
from −2.79 toward the band at about 0.05 an hour as the old values age out, and
the next upload will restart it.

It is **not thin data**: 104 samples against a declared minimum of 24. And
neither of this phase's other changes fixes it — the level moves every poll, so
emit-on-change never fires (79 of 79 survive it), and 2.0σ only postpones the
emission. It is the only cumulative-style counter declared `level`;
`subscriber_count`, `view_count` and `recent_video_views` are all
`relative_rate`, which is why they are quiet.

The real fix is a **basket-stable definition in the connector** — comments per
video, each upload its own series, or a fixed cohort followed over time — which
is a new metric with a new baseline to fill, and out of this phase's scope.
Until it is written the key sits in the source row's `config.observe_only`
(the Phase 17 mechanism): the reading is recorded as a raw snapshot and reaches
no observation, signal, force, memory or score history. Its declaration comes
out of `config.metrics` with it, because the declaration that exists is the one
that misdescribes the metric. Turning it back on is one row update and no
deploy.

### The forces panel shows an hour, and says so

Gravity contributes about **0.005 points a tick** and Market Mood about
**0.0006**. The Engine ticks twice a minute. The panel showed the latest
tick's contribution at two decimals, so Market Mood read 0.00 forever and
Gravity flickered between 0.00 and the rounding grain: a number that cannot
render is not a reading.

The panel now sums each force's contributions over **`FORCES_WINDOW_MINUTES`
= 60** — the same span Market Mood itself is measured over since Phase 19+, so
the panel's Market Mood row and the banner's Mood indicator describe the same
hour. The same three forces on MrBeast at 2026-09-19 14:00 read **−0.60**,
**+0.53** and **−0.07**: the same arithmetic, summed rather than sampled.

**Display only.** No force's weight, cadence or behaviour changed; the sum is
exactly what the forces already moved the score by. Conviction and Trading
Activity write no rows, so they still read **0.00** — flat and uncoloured,
which is Phase 19+'s rule and still applies, since a window sum that rounds to
zero at two decimals is as directionless as a tick's was. The caption and the
section header are both built from the constant
(`forcesWindowLabel(FORCES_WINDOW_MINUTES)` → "hour"), so the number and the
words cannot come apart; the header still carries the age of the latest tick,
because whether the Engine is running is a separate fact from what it did.

The read is a second, narrow query (`force, impact` for the window) beside the
existing twelve-row latest-tick query, which stays because Conviction's
recorded `concentration` — a state reading, not something that accumulates —
is what the CONVICTION level is derived from.
`score_events_person_created_idx` is the index behind it: about 245 rows per
person per hour, against ten thousand rows per person that a tick-keyed index
would have had to walk.

### Not in this phase

**Feed suppression of metric signals.** Reported rather than done, since the
emission rule changes what the Feed receives in the first place. Before:
**1,273 metric signals in 24 hours, 1,227 of them reaching the Feed as signal
entries** (the rest linked to a narrative), across only 396 distinct
headlines — about **80 per person per day**. After, replayed: **135 in 48
hours, about 4.2 per person per day**. Eleven of the 135 (8.1 %) are still
consecutive near-identical entries for one person — the same metric, a
genuinely different level, and a sigma that rounds to the same figure at the
one decimal the headline prints — concentrated in Elon Musk (4) and Kendrick
Lamar (4). That residue is exactly what a Feed-level rule would catch, and it
is now a rounding artifact rather than a repeated fact.

## Signal language: no σ, and a voice per metric (Phase 21+)

Every metric said one sentence: *"Drake's viral-moment frequency is running
+2.8σ above their own trailing fortnight."* Three faults. σ is a derived
statistic a casual reader cannot check. "Their own trailing fortnight" is not a
phrase anyone says. And one template across sixteen metrics was most of why the
Feed read mechanical.

`lib/signals/metric-language.ts` is the replacement, and it is **display only**:
it is handed a reading that has already been judged and chooses words for it.
`metric-language.scoring.test.ts` asserts that publishing a count changes the
words and nothing the Engine reads — same sigma, same confidence, same anomaly
band, same dedupe key.

### σ is gone, and the counts underneath replace it

The raw counts are **more** transparent, not less: *"12 stories today against a
usual 4"* is checkable by anyone with the Feed in front of them, where +2.8σ is
checkable by nobody. So the expand shows the observed quantity, the person's own
pace, how they compare, and the window and sample size behind it. σ stays in the
operator console, where the statistic is the point.

That needed two keys the Phase 7 allow-list did not carry, so the boundary was
widened by exactly two and a **gate** was put in front of them.
`publish_observed` is per metric, **explicit, and false unless declared** — a
count of news stories and a subscriber total are different categories of fact,
and the second is what Phase 7 exists to keep out of a signal. Six metrics opt
in: `news_volume_24h`, `company_news_volume_24h`, `viral_moment_rate`,
`stream_hours_7d`, `stream_days_7d`, `clips_per_stream_hour`. Ten do not.

**`session_peak_viewers` is deliberately out**, though it is a Twitch session
metric and a `level`: peak concurrent viewers is an audience *size*, the same
category as a subscriber total measured instantaneously rather than
cumulatively. It keeps a register-only sentence and publishes no number. The
four audience metrics (`subscriber_count`, `view_count`, `recent_video_views`,
`follower_count`) cannot publish a total by any route — each is a
`relative_rate`, so its observed quantity is a growth rate — and the privacy
test pins both facts.

The **headline digit refusal is unchanged**. A metric headline still may not
carry a run of four digits, a thousands grouping or a compact count, and that is
solved in the phrasing rather than by relaxing the rule: the language layer says
"over a thousand clips" past 999, and "over 100x their usual pace" where the
multiple itself would run to four digits — 45,000 stories against a usual 4 is
"11250x", which is a raw level wearing an x.

### Register follows magnitude, deterministically

The voice is a function of the reading, never a random draw, so the same reading
always produces the same words and a reader learns that "spiking" means more
than "running hot" without being taught. Where a band holds several variants the
choice is an FNV-1a hash of the person, the day and the metric, so a refresh
cannot change the sentence under someone and a stored headline always matches a
later re-render of itself.

| Band | Register | Example |
| --- | --- | --- |
| **≥ 3.5σ** | momentum-native, because something is genuinely happening | *Attention on Drake is spiking* |
| **2.5–3.5σ** | concrete, because the number carries itself | *12 stories on Drake today — 3x their usual pace* |
| **2.0–2.5σ** | terminal, understated for a modest reading | *Coverage of Drake is running hot* |
| **below their own pace** | terminal throughout, and never a concrete count | *Quiet stretch for Jensen Huang* |

The boundaries are the ones proposed, kept because the board's own readings
divide evenly across them: of the 458 readings in the seven days to 2026-09-19
that clear the 2.0σ deadband, **34.5%** sit below pace, **27.5%** in 2.0–2.5,
**21.6%** in 2.5–3.5 and **16.4%** above 3.5. No band is starved and none
swallows the others, which is what a register scheme needs — a boundary that
fired twice a week would teach a reader nothing.

Bands read the **sign of the reading**, not the direction of its score impact.
They coincide for every metric today (all declare polarity +1) and must not be
conflated: a low reading is described as low whatever it does to the score. A
reading below pace is terminal at **every** magnitude, because a concrete low
count reads as an accusation — "four stories today against a usual twelve" says
something about the person that "quiet week" does not.

### Multiples above 2x, percentages below

2x and over becomes a multiple rounded to the nearest half ("3x", "2.5x"); under
2x becomes a percentage, because "1.3x their baseline" reads worse than "up
30%". A reading **below** pace never takes a decimal multiple — "0.3x their
baseline" is unreadable — and becomes a fraction where one lands near it ("a
third of their usual pace") or a percentage otherwise. "Pace" throughout, never
"average" or "baseline": a pace is a rate over time, which is what is being
measured, and the other two sound like a report card.

Two grammatical shapes are kept because one phrase cannot do both jobs:
`standalone` follows a dash, `running` follows a progressive verb — which is why
a multiple carries "at" in the second ("is running at 3x their usual pace") and
not the first.

### The comparison stays to the person, without guessing anyone's pronouns

"For him" was doing real work: it is what makes the comparison fair, since Drake
is measured against Drake and not against MrBeast. That survives — carried by
naming the person and by "their usual", and stated outright in the expand
("Measured against: Drake's own fortnight").

It is **not** carried by he/she. The people on this board are real, `people`
stores no pronouns, and a name does not tell you anybody's; guessing would
misgender someone in production in a way "their" never does. A test asserts no
sentence ever contains he, she, his or her. If pronouns are added to the roster
as data, the possessive is the one place that changes.

### Every metric says what it observed

`METRIC_VOICE` gives each of the seventeen registered metrics its own sentences,
per band, **written out in full**. The first attempt composed them from a noun
phrase and a verb phrase per metric and produced *"Drake's clips and moments
spreading just accelerated"* and *"Views on their newest uploads is elevated for
MrBeast"*. English does not survive that kind of assembly. A test asserts no two
metrics share a line, and that the three bands which do not depend on a number
can always speak from the person's name alone; the concrete band, which is built
around a number, borrows the elevated band's words when a metric publishes none.

### Nothing stored was rewritten

1,950 signals carry headlines written in σ, and 58 of the 88 narratives quote
one verbatim — the Engine's template is *X's momentum slipped on "…"*, so the σ
sits inside text nothing can re-derive.

Rather than rewrite production rows, **the payload became the source of truth for
display and the stored string a denormalised copy**. `feed_entries()` carries
each metric signal's payload inside its `evidence` objects, so the Feed
re-renders the sentence from the reading; the quoted headline inside a narrative
is an exact substring with its signal linked, so swapping it for the rendering is
a faithful substitution rather than a rewrite. Everything a historical payload
needs — metric, label, sigma, window — has been there since Phase 7. Only the
counts are new, so a historical entry shows the sentence and omits the
arithmetic rather than inventing it.

Ingestion also writes the new sentence into `signals.headline`, because that
string is what the Engine's narrative templates quote, what memory reads and
what the LLM sees. Fixing display alone would have left σ in every sentence the
Engine wrote from that day on.

## YouTube Trending as a signal (Phase 22)

YouTube's trending chart is the closest thing to a real-time attention signal
available legitimately. It refreshes about every half hour, it is national and
non-personalised (identical for every observer, which is what makes an
appearance reproducible), and YouTube's own ranking already weighs a video's
performance **relative to its channel's norm** — a creator who usually draws
ten thousand views drawing half a million is the strongest input to it. So an
appearance is not raw popularity; it is a momentum reading YouTube computed
across all of YouTube.

`lib/connectors/youtube-trending.ts` reads it through the **official Data API
only**: `videos.list` with `chart=mostPopular`, one quota unit a call, against
`search.list`'s hundred (which `commentary_volume_24h` already spends).
`charts.youtube.com` has no public API and is not scraped — that is the same
category as the follower scrapers the board cut.

### Event, not metric — and the reason is regulatory

The platform's posture is that the score is a transparent, rules-based
function of public inputs. A trending **rank** is the output of an
undisclosed algorithm nobody here can explain or audit; a sigma built on it
would make part of the methodology "because YouTube said so", and there is no
way to describe a baselined opaque rank to counsel that survives the question
"what does 2.3σ of trending position mean?". An **appearance** is a dated,
verifiable occurrence: the video was on the chart, anyone can check. So the
connector has no `fetchMetrics`, the source row declares no metrics, the rank
is never snapshotted, baselined or normalised, and it reaches a reader only
as the fact it is — "trending at #3" — the way a viewer count rides on a
Twitch broadcast.

**One signal per video per subject.** The chart is read every half hour and
a video sits on it for hours, so the dedupe key is the video and the subject
it is credited to (`youtube_trending:video:<id>:<slug>`), as Phase 16 keys a
broadcast on its stream id. The subject is in the key because, unlike a
broadcast, one video can be about two people on the board — a collaboration
— and the source-level unique constraint would otherwise credit whichever of
them polled first.

**A rank change is not a second event.** "Entered the top ten" would make the
rank an input to emission, which is exactly the exposure above; and it
re-reports the same fact, which the Engine would then score twice. The rank at
first sighting travels in the headline and the payload as an observation about
a moment. If a later phase wants peak rank and time on chart, the right shape is
a retrospective ledger like `live_sessions`, not a stream of events.

### Matching, and what is refused

Two routes, in this order, and nothing else:

| route | what admits | why it is safe |
|---|---|---|
| **channel** | `snippet.channelId` is in the mapping's `config.channel_ids` | a Drake University highlight reel cannot be on Drake's channel; no exclusion is consulted |
| **title** | the video's **title** names the subject as whole words (`matchesTerm`, the publisher feeds' matcher: "Drake's" matches, "DrakeVEVO" and "Drakeford" do not) and the mapping's disambiguation rules do not refuse it | the rules are the Phase 12+ block on the `person_data_sources` row — the same exclusions the two news doors apply, judged by the same code — read over the title, the channel's name and the first 600 characters of the description |

Refused, because a false positive here is a visible error on a consumer
surface where a miss is nothing:

- **a match in the description or tags alone.** Descriptions are keyword farms
  (`#drake #kendrick #mrbeast`) and list collaborators and inspirations; "inspired
  by MrBeast" is not a MrBeast appearance. The description is read for
  *exclusion* only — the same asymmetry `disambiguation.ts` states: substring
  matching is right for refusing and wrong for admitting.
- **a match on the channel's name alone.** "Drake Fan Page" trending is not
  Drake trending. (The channel's name *is* read for exclusion: "Drake University
  Athletics" refuses a title that says only "Drake vs Iowa State".)
- **bare surnames.** The publisher mappings admit "Musk", "Bezos", "Kendrick"
  because a business-section feed supplies the context; the trending chart is
  unscoped, gaming beside cooking beside news, so every seeded mapping carries
  `match_terms: []` and a title must name the person in full. An alias is a
  row update if one is ever wanted.
- **a guessed channel id.** An id is pinned only once it has been resolved
  through the official API and judged; see *Channel ids, by handle* below.

The chart is fetched **once per run** and shared by every subject (a module
cache keyed on the run's clock, as the publisher catalogue and the API-Sports
games list are): sixteen mappings, one request.

### Channel ids, by handle

Phase 22 shipped with exactly one verified channel id (MrBeast's, copied from
his `youtube` mapping), so everyone else was on the title route alone — worst
where the chart matters most, because **Kai Cenat's own uploads carry a stream
title and not his name** and so were invisible to us.

A channel id is not something anyone knows by heart, and the only way to learn
one without scraping a web page is `channels.list?forHandle=` — one quota unit.
The key for that call lives in production and nowhere else (Vercel holds it as
a *sensitive* variable, unreadable by design), so resolution belongs in the
connector rather than in a one-off script. Two keys on the mapping:

| key | what it is |
|---|---|
| `channel_ids` | verified ids. Free, authoritative, matched as a **set** |
| `handles` | resolved each poll, cached for the process, every outcome reported through the poll's `note` channel — a resolution with its id, channel title and subscriber count so an operator can *judge* it before pinning; a failure with its reason, so a stale handle is visible rather than silently dropping the subject to the title route |

Pinning the id **and dropping the handle** stops the lookup. Until then it is
one unit per handle per poll.

A **set** of channels, not one, is the answer to the VEVO question. A musician
has both a personal channel and a label-operated VEVO channel and both trend;
a single id forced a choice. DrakeVEVO trending *is* Drake trending — his own
music, his own distribution — and the credit runs the right way: DrakeVEVO
carries "Drake ft. X", while "X ft. Drake" lives on X's VEVO and is never
credited here. So mapping VEVO risks a **miss** on a feature, never a false
positive, and the title route catches those when the title names him.

The one sharp edge: a handle is **trusted the moment it resolves**, so a wrong
handle would arm the channel route for somebody else's uploads. The note exists
so a mistake shows on the next poll rather than after a false headline — and it
earned its keep on the first one.

**What the 21:45 poll of 2026-09-20 returned, and the judgement:**

| handle | resolved | channel | subscribers | |
|---|---|---|---|---|
| `@MrBeast` | `UCX6OQ3DkcsbYNE6H8uQQuVA` | MrBeast | 516,000,000 | **pinned** — identical to the id the board already held, so it is re-verified rather than assumed |
| `@KaiCenat` | `UCoEmptob-eEGKk18c2VplJg` | Kai Cenat | 8,200,000 | **pinned** — the one this exists for |
| `@KendrickLamar` | `UC3lBXcrKFnFAFkfVk5WuKcQ` | Kendrick Lamar | 20,300,000 | **pinned** |
| `@KendrickLamarVEVO` | `UCoYfzC2zMlc9M-Odgaf6OSg` | KendrickLamarVEVO | 6,830,000 | **pinned** |
| `@DrakeVEVO` | `UCQznUf1SjfDqx65hX3zRDiA` | DrakeVEVO | 8,970,000 | **pinned** |
| `@DrakeOfficial` | `UCByOQJjav0CUDwxCk-jVNRQ` | Drake | 33,100,000 | **pinned** — seeded after `@Drake` was refused; resolved to the same id the chart sighting suggested, which is what made it verification rather than inference |
| `@adinross` | `UCey-eDTR5J6xU6pZ2f4guoA` | **Adin Live** | 4,620,000 | **pinned** — see below |
| `@Drake` | `UCNTQH0uJzryQB4rRLGlv-Ww` | drake | **491** | **REFUSED.** Not him — a namesake or squatter holds the handle. Arming it would have credited Aubrey Graham with that person's uploads the first time one charted |

**Adin Ross is not a defect, though the row reads as one.** The channel is
titled "Adin Live" and not "Adin Ross". Ownership has two independent
confirmations: it holds the handle `@AdinRoss`, and it lists
`kick.com/adinross` among its links — verified, at 4.62M subscribers. Creators
routinely name a channel differently from themselves. **Do not "correct" this
pin.**

**Drake's main channel, closed.** `@Drake` being a 491-subscriber namesake left
his active channel unmapped: the live fire caught "DRAKE - CLASSIC" at #1 from
`UCByOQJjav0CUDwxCk-jVNRQ`, titled "Drake" — a third channel, neither the
namesake nor DrakeVEVO. That sighting was evidence of a *name*, not proof of
*ownership*, so the id was **not** pinned from it. The handle
`@DrakeOfficial` was seeded instead, and the 22:15 poll resolved it:

```
@DrakeOfficial  ->  UCByOQJjav0CUDwxCk-jVNRQ  "Drake"  33,100,000 subscribers
```

The same id, arrived at independently — so it is pinned, alongside DrakeVEVO.
Drake holds both channels that matter: the active one where releases go up, and
the label catalogue. Neither had to be given up, which is what the set was
widened for.

**No executive is mapped**, and that is the finding rather than an omission.
NVIDIA's channel is not Jensen Huang's and Meta's is not Zuckerberg's; mapping
either would credit the person with the company's upload schedule. Beyond the
corporate channels there is nothing to map — what exists for these nine is
conference, interview and clip channels owned by other people. And even where a
personal channel exists the channel route adds almost nothing, because an
executive's video is conventionally titled with their name and the title route
already catches it. The route earns its keep for creators whose titles do not
name them, which is the opposite case.

### Coverage is uneven, and that is the point

A person the chart never carries is unaffected: no match, no signal, no score
impact, no exclusion, and a poll row that says ok with nothing produced —
asserted at the runner in `runner.trending.test.ts`. Expected firing, as priors
to be replaced by the poll log: MrBeast most weeks (his own uploads by channel,
collaborations and reaction videos by title); Kai Cenat, Drake, Kendrick Lamar
and Patrick Mahomes in bursts around uploads, releases and games; Elon Musk a
few interview and news clips a month; Zuckerberg, Bezos and Jensen Huang around
keynotes; Warren Buffett a handful of times a year; Page, Brin, Ellison, Dell
and the founder essentially never.

### Language

An event has no σ bands, so its sentences are written directly, under the
Phase 21+ rules — no σ, the person named, "their" and never a guessed pronoun,
and the one number a public fact anyone can check on the chart:

> MrBeast is trending at #3 on YouTube: "I Survived 7 Days In Solitary Confinement".
>
> A video about Drake is trending at #12 on YouTube: "Drake - NOKIA (Official Music Video)", from DrakeVEVO.

A video on the subject's own channel is *their* trending; a video about them
says so and names its channel, so the two read differently at a glance. The
payload carries the channel and the video under `channelTitle` / `videoTitle`
/ `publishedAt` — the keys the sentiment prompt's allow-list already admits —
so the model sees which video without the list widening; the rank reaches it
only inside the sentence, never as a field.

### Cost and cadence

`poll_interval_minutes = 25`: off the multiple of fifteen, off the top of the
hour, and every second fire of the fifteen-minute cron — an effective half hour,
which is the chart's own refresh; polling faster buys nothing. One unit a poll
at the default depth of 50 (four at the full 200), so **48 units a day against
10,000**. On the Engine side a trending event is scored like any event: it joins
the person's chunk in the next tick's call (Haiku 4.5 at ≈ 1,630 input and 240
output tokens a call in the last seven days, ≈ $0.0028), adding roughly eighty
input and forty output tokens — about $0.0003 — or a whole call, $0.003, when
it is the person's only signal that tick. At the expected rate of five to
fifteen a week board-wide that is under five cents a week, either way.

One side effect stated rather than hidden: `person_signal_volume()` dates a
person's volume regime from their **newest** mapping, so sixteen new rows
restart every regime on the day they land. The volume weight needs seven
complete days and every person was at one or two, so it was already 1.0 for
everyone; the restart moves its engagement out by about three days and changes
no current score.

## Search, and who may be found (Phase 23)

Search is the first surface a beta invitee touches, and the first thing most
people type is their own name. That fact decided two things about this phase.

**The consent flag comes first, and it ships off.** `people.is_discoverable`
is a boolean, not null, default **false** — the same shape as
`forecast_paused` at the opposite polarity, which is the precedent for a
per-person switch of exactly this kind. Every privacy gate in this codebase
ships off and must be opted into (`publish_observed`, `forecast_paused`,
`shorting_enabled`, the drift flag), and being listed under your own name as
something with a score is a heavier thing to be opted into than any of them.
The sixteen current subjects are turned on **in the migration, by slug, one
name at a time** rather than by a `where is_active` sweep or a "public figure"
branch in application code: an explicit list is a record of a decision, and
the seventeenth person starts off until somebody writes their slug down the
same way.

**Enforcement is one predicate, and it is in the database.** The flag is
tested inside `search_people()` itself, so a person who has not opted in is
not reachable through the RPC at all: not by a different spelling, not by a
larger limit, not by a caller holding the service role. `lib/search/search.ts`
reads through the admin client — RLS bypassed — and still sees only the
discoverable, which is the property the tests assert directly.

**A connections tier extends this without reshaping it.** `is_discoverable`
stays the outer gate (off means unreachable, full stop); the tier arrives as a
second column that can only narrow within it, plus one more conjunct in the
same gate block:

```sql
alter table public.people add column discoverable_to text not null
  default 'everyone' check (discoverable_to in ('everyone', 'connections'));

-- inside search_people(), beside the flag:
and (p.discoverable_to = 'everyone'
     or exists (select 1 from public.connections c
                 where c.person_id = p.id and c.user_id = (select auth.uid())))
```

No existing row changes meaning, the partial indexes stay valid because their
predicate is the boolean, the returned columns are unchanged and no call site
moves. It is also why `search_people()` is **security invoker** rather than
definer: it runs as the caller, so `auth.uid()` is the connected user's —
exactly what a connections check needs and exactly what a definer function
would have thrown away.

**Forgiving of case and punctuation** means two immutable normalisations, both
indexable. `search_terms()` reduces a string to lowercase space-separated
words with the Latin diacritics folded (`'Jen-Hsun Huang'` → `jen hsun
huang`); `search_key()` drops the separators too (`jenhsunhuang`), so
"Kai Cenat", "kai-cenat", "KaiCenat" and "@kaicenat" all land on the same
string. The terms form is what lets "cenat" be recognised as the start of a
word rather than a fragment; the key form is what makes the handle and the
name the same query. Folding uses `translate()` over an explicit pair list
rather than `unaccent()`, which is an extension, is not immutable, and so
cannot appear in an index expression. One consequence worth stating: because
`search_key()` emits only `[a-z0-9]`, interpolating a needle into a `LIKE`
pattern is safe — no `%`, `_` or backslash survives normalisation.

Matches are ranked by the database, not the client: the name exactly, the name
starting with it, a word of the name, a word of the full name, anywhere in the
name, anywhere in the full name or slug — then score descending, then name,
then id, which is the board's own total order, so two identical calls return
identical lists. `change` comes back on the same row, derived over the
trailing hour the way `home_momentum()` derives it, so a result row and the
board cannot show different directions for the same person.

**What breaks first, and roughly when.** Sixteen rows today. The anchored half
of the match rides the three partial expression indexes — the first indexes
`people` has ever carried. The contains half ("beast" inside "mrbeast") cannot:
a b-tree answers `'needle%'` and nothing else, so those branches scan the
discoverable set. That is what gives first, and it gives by getting slow, not
by getting wrong. A few hundred people is nothing; it stays comfortable into
the low tens of thousands; somewhere past roughly 50k discoverable people the
fix is `pg_trgm` — a GIN index on the same `search_key()` expressions turns
the contains branch into an index scan without changing one match rule or one
returned column. It is deliberately not installed now: the local test harness
runs stock Postgres with no extensions, and sixteen rows do not need it. The
`change` join is bounded per matched person (25 people × 240 rows), so it
grows with tick density rather than with the roster.

**The words.** Two states, two different jobs, both in
`lib/search/search-model.ts` where a test can read them.

Before anything is typed:

> **Find a person.**
> Type a name or a handle. Everyone here carries a score that moves with what
> happens to them — open a result to see what moved it.

When a query finds nobody:

> **No one here by that name.**
> The list is short, and it grows one name at a time. If you were looking for
> yourself and came up empty, that is not an oversight — nobody is on this
> list by accident.

"0 results" is a log; the second state is the one that matters, because of who
is reading it and what they just typed. It answers the question actually being
asked — *why am I not here* — plainly, without treating the absence as a
malfunction and without pretending the roster is a consent register. Neither
state quotes a count, so nothing goes stale the day the seventeenth person is
added, and both follow the Phase 21+ rules: plain words, no jargon, no guessed
pronouns, no σ.

## What the first live game taught (Phase 24)

Sunday Night Football, 2026-09-21: Chiefs 33-30 over the Colts in overtime,
Mahomes 382 yards, 3 touchdowns, no interceptions. He moved 60.9 → 66.0, the
largest single-subject move the board has recorded. Much of the platform did
what it was built to do — in-game news reached the Feed inside fifteen minutes,
the scorer's confidence tracked substance (0.3 for a routine completion, 0.72
for the clutch overtime win), a 44-day-old article expired at zero cost and a
Spanish-language headline scored correctly. Four things did not.

### The metric flood returns on a busy day

Between 07:00 and 11:15 UTC, "Coverage of Patrick Mahomes is running hot" and
"People are sharing Patrick Mahomes' moments" emitted roughly every fifteen
minutes. Emit-on-change (Phase 21) did not stop it, because a trailing-24h
count genuinely ticks 56, 57, 58 through a big afternoon: the rule collapses a
flat number and is defeated by a rising one, so it works on quiet days and
fails on exactly the days that matter.

**Measured first.** Over 2026-09-21 00:00–14:01 UTC the Signals force moved
Mahomes **+18.21**, of which **9.30 (51.1%)** came from metric signals and
**10.11** from events. There were **39** metric emissions in those fourteen
hours. Of those, **28 (72%) restated a band that was already on the record** —
only eleven landed in a different register than the one before, and six of
those eleven were the same 2.5σ boundary being crossed back and forth.

**The rule: a metric emits when its REGISTER changes.** A reader cannot tell
2.6σ from 2.7σ and should not be asked to; what they can tell is coverage
going from "running hot" to "56 stories today — 2x their usual pace" and back,
and that transition is the event. So an observation records the band it left
on the record (`raw_metric_observations.register`) and a reading in the same
band is the same fact told again, logged as `same_register` rather than
dropped silently. The band is held with **0.25σ of hysteresis**, asymmetric:
an escalation is reported at the boundary itself, because the sentence is
chosen from the reading alone and a signal that emitted late would be worded
for a band it never announced; a de-escalation needs the margin, because "it
cooled a little" is not a second story. 0.25 comes from the board's own step
sizes — across 1,035 consecutive readings in the 1.5–4.0σ range over seven
days the median step is 0.034σ, the 75th percentile 0.104σ and the 90th
0.379σ, so the margin absorbs about five steps in six.

**Replayed against that window before shipping** (`lib/signals/register.test.ts`
runs the shipped `emissionDecision` over the ledger as it was written):

| | before | after |
| --- | --- | --- |
| news_volume_24h emissions | 21 | 3 |
| viral_moment_rate emissions | 18 | 4 |
| Signals force over the window | 18.21 | 11.10 |
| board-wide emissions, 7 days | 2,074 | 220 |

The three that survive for news volume are the first sighting, the moment it
turned concrete as the game story broke, and the moment it cooled back.

**What it costs, stated rather than buried.** A reading that intensifies
WITHIN a band no longer re-emits: a count that doubles from 2.6σ to 3.4σ says
nothing until it reaches "spiking". That is the intended trade and the same
principle Phase 21 shipped on — a metric describes a STATE and the event is
the state CHANGING — applied at the resolution a reader can actually read.
Option (d), collapsing in the Feed only, was refused for the reason the brief
named: it would leave the scoring half of the problem exactly where it was.

### A game result is dated when the game ENDED

The Week 2 result carried `occurred_at` 00:20 UTC — kickoff. The game ended
around 04:00, so the Engine scored it at freshness 0.886, as if it were 4.2
hours old the moment it arrived, and about 11% of its impact went to a
convention. The poll that actually stored it ran at **04:30:31**, about half
an hour after the final whistle.

API-Sports' American Football host publishes a kickoff (`game.date.timestamp`)
and a status (`FT`, `AOT`), and no final time. So the timestamp is the first
poll that observed the game finished — a real observation bounded by the
40-minute poll interval, thirty minutes late against four hours and ten
minutes early — with two guards and no estimate of how long a game takes:

- `config.game_end_keys` names where a reported final time lives, if the host
  ever publishes one. It takes precedence, and adding it is a row update.
- A first sighting more than `live_sighting_hours` (24) after kickoff means
  nothing was watching when it ended — a first-contact backfill — and the
  kickoff is used instead. The Week 1 result was first seen two days after
  kickoff, which is exactly this case.

The payload records `played_at`, `observed_final_at`, `ended_at` and
`ended_at_basis`, so a stored row can always be read back and judged. **Two
historic rows are affected and neither has been rewritten**: Week 1 (which
the new rule would date at kickoff anyway) and Week 2 (which it would date
04:30 instead of 00:20). Both are already processed; rewriting them would
change nothing the Engine will read again.

### The result says what the subject did

"Week 2: Kansas City Chiefs beat Indianapolis Colts 33-30." was true and said
nothing about the 382 yards. The metric path cannot fix that — a per-game
figure is judged against the player's own trailing games and knows nothing of
the score — so a mediocre line in a win and a great line in a loss can only be
reconciled where a model reads both together, which is the sentiment scorer
reading this headline. The result now reads:

> Week 2: Kansas City Chiefs beat Indianapolis Colts 33-30 in overtime; Patrick Mahomes threw for 382 yards and 3 touchdowns.

Only PLAIN-NUMERIC statistics are quoted (Phase 10): the value parser refuses
composites like "15/27" by construction, and a statistic that is not where
`config.headline_stats` says is OMITTED and noted rather than guessed at. The
result leads and the line follows, joined by a semicolon rather than by "as",
because "as THE Kansas City Chiefs beat THE Indianapolis Colts" is a grammar
guess about a team name this connector reads as data.

### The same ratio rendered two ways at 2x

Fifteen minutes apart, about the same metric: "...moments 100% above their
usual pace" at 09:45 and "...moments at 2x their usual pace" at 10:00. A ratio
a hair under 2 took the percentage branch on the RAW value and then ROUNDED to
100%, which is 2x said differently.

The rule now: **every boundary is decided on the figure as displayed, never on
the raw value behind it.** The multiple form owns everything that would print
as 2x or more, so the percentage form can never print 100%; the crossover is
exactly where "up 99%" ends. Auditing the rest of the module for the same
defect found two more and cleared the others:

- **100x.** 99.8x rounded to "100x" while 100.0 read "over 100x". Now decided
  on the rounded multiple, so nothing ever prints a bare "100x".
- **The below-pace fractions.** "a fifth" was keyed off the denominator within
  ±0.12, and a ratio of 0.195 fell just outside it and printed "down 80%" —
  the same fact as "a fifth". Each fraction now owns exactly the shortfall
  that would print as its own percentage, so nothing below pace ever prints
  "down 50%", "down 67%", "down 75%" or "down 80%".
- **"down 100%" for a non-zero reading.** A ratio of 0.004 rounded to a
  complete absence it is not; it now reads "next to nothing against their
  usual pace", distinct from the exact-zero "nothing at all".
- **Cleared:** the count's 999/1000 crossing already tested the rounded
  figure, and "barely above" / "level with" / "just below" print no figure at
  all, so no two of them can claim the same one.

A sweep over every ratio from 1.0 to 5.0 in thousandths asserts the result:
the displayed magnitude is monotone and no two phrasings ever describe it.

### "Rating" was never the passer rating

`game_passer_rating` was registered in Phase 13+ as "the league's own
composite ... bounded 0–158.3", with an sd floor of 12.0 chosen for that
range. It is not. The connector's diagnostics note on the 15:00 poll of
2026-09-21 returned the host's own words for the Week 2 game:

```
comp att="32/47", yards="382", average="8.1", passing touch downs="3",
interceptions="0", sacks="2-11", rating="78.6"
```

| | the line | league formula | host's `rating` |
| --- | --- | --- | --- |
| Week 1 | 15/27, 184 yds, 2 TD, 1 INT | 86.0 | 50.2 |
| Week 2 | 32/47, 382 yds, 3 TD, 0 INT | 114.0 | 78.6 |

Two games, decisive. **What it IS has not been established, and the name now
says so.** QBR was the standing hypothesis and both values sit inside its
0–100 range, but QBR is proprietary and derived from play-by-play expected
points, so it cannot be recomputed and checked, and API-Sports is not ESPN.
There is also a counter-indication worth recording: the two readings sit 35.8
and 35.4 below the passer rating of the same lines — a slope of essentially
one with a constant offset, which is what a transform of the same box-score
inputs looks like and is not what an independent play-by-play metric looks
like. Two points cannot establish a formula; they are enough to refuse a name
that claims one. So the key is `game_rating`: the field's name, and nothing
more.

The sd floor is re-derived for the observed range: 12.0 was the same fraction
of 0–158.3 that **8.0** is of 0–100. The two stored readings are carried
across to the new key so neither game is lost. The metric needs eight games
and has two, so it has never emitted a signal and has never touched a score —
which is exactly why this was worth doing today and would have been expensive
in November.

The same note settled two other things at no extra cost: the host publishes
**no final time** (`endedAtReported=none`), which is what sends the timestamp
to the first poll that saw the game finished; and the Week 2 status is
`"AOT"`, which is how the result headline knows to say "in overtime".

## Portfolio's typography, and why it is an exception (Phase 25)

`num` — JetBrains Mono, tabular — is the default for numerals everywhere on
the platform, and Portfolio is the one surface that does not take it. This is
the record of that decision, so it does not get quietly reverted as a
"missing `num`".

**Mono's only functional job is a figure that TICKS.** Its digits are
fixed-width, so a value that updates cannot jitter and a column cannot shuffle.
Inter's digits are fixed-width too under `tabular-nums` — measured in the
browser on the rendered page, the strings `$10,063.62`, `$11,111.11`,
`$18,888.88` and `$90,000.00` all render at **exactly 1112px** at the hero's
56px, at 260px in the stat grid at 24px, and the pill quote at 31px at 14px;
the same face with `font-variant-numeric: normal` swings from 98px to 139px
over the same four strings. So the jitter argument never required the
monospace face, only tabular figures.

**What mono actually did on Portfolio was spread onto words.** It had reached
units, dates and whole sentences, and in several places the typeface changed
mid-line — "+$63.62 (+0.64%) against your $10,000.00 of paper credit" switched
face three times; "Sold 1 share of Anthony Baptiste at $59.31" switched twice;
"3 shares · avg $51.65 · 2 lots" was a sentence set entirely in mono. That is
what made the page read like a log rather than like a statement.

The rule now, per surface:

| | face | why |
| --- | --- | --- |
| Portfolio figures | Inter + `tabular-nums` | one typeface per line; fixed-width digits without the log |
| Portfolio prose and dates | Inter, plain | nothing in them moves once an order has filled |
| Portfolio value chart | **untouched** | its own labels, its own conventions; out of scope by instruction |
| Everywhere else | `num` | Home, the profile, the Feed, the trade sheet, the header, `/admin` |

`Money` carries the choice as a `face` prop defaulting to `"mono"`, and
Portfolio passes `face="text"` at every call site, so the exception is visible
in the code rather than inherited from a wrapper a later reader would not
think to check.

**The Buy/Sell pill changed platform-wide, on purpose.** The quote inside it
was mono at `text-xs` beside an Inter label at the button's own size: two
typefaces and two sizes in a two-word control. It is now Inter at the label's
size and weight with `tabular-nums`, and it lives in ONE component
(`components/trade/trade-quote.tsx`) that the profile trade bar and Portfolio's
Sell buttons both read, because two copies of one control is how they drift
apart. Colour, shape, height, padding, gap and behaviour are untouched — the
pill is simply wider, because Inter's digits at the label's size are wider than
mono's at `text-xs`, and `Button` sizes to its content.

## One price, one format, everywhere you trade (Phase 26)

The pill said **Buy 56.7**. The sheet it opened charged **$56.64**. Both were
honest — one score point is one dollar, and a quote of 56.6449 points rounds to
56.7 at one decimal and to $56.64 at two — but nobody reads it that way. A tap
and a payment one screen apart, in two units at two precisions, reads as the
price moving while you decided, and that is the one thing a trading interface
may never look like.

The rule, flat, and now the only one:

| | unit | where |
| --- | --- | --- |
| A **score** | points, no currency, one decimal | the hero, the axis, the crosshair, the Gravity line, the change line |
| Anything you can **trade at** | dollars and cents, two decimals | the pill, the sheet's quote box, price per share, the recorded fill |

`pointsText()` — the one-decimal formatter that produced "56.7" — was **deleted**
rather than left unused. It was on the pills, under the sheet's quote boxes, in
the sheet's own confirmation sentence and on both position cards. A second
formatter still in reach is how the drift comes back.

Two places showed the mark in points beside the same figure in money: the
profile position card's "Value · at Sell 55.6" and Portfolio's row label, each
with "$55.64 per share" directly underneath. Neither was converted — the figure
was dropped from the label, because the price is already stated to the cent a
line below. Both now read "at the Sell quote".

**The four readings, to the cent** (`components/trade/one-price.db.test.ts`,
against a real Postgres with the migrations applied verbatim). A quote of
56.6449 points at a 0.5 spread, carried from the score panel to the ledger:

| reading | value |
| --- | --- |
| the Buy pill (`TradeQuote`, rendered) | `$57.14` |
| the sheet's quote box | `$57.14` |
| price per share, in the summary (`Money`, rendered) | `$57.14` |
| `orders.fill_price_cents`, written by `place_order()` | `$57.14` |

The same test scans the trading surfaces for a second way to format a price and
fails if one reappears.

## The score card, and two bugs at the sheet's edges (Phase 26)

**The change line is one statement.** It was three pieces that happened to sit
next to each other — arrow and points figure at one size and weight, the
percentage at another, the period smaller again — and because the arrow was an
inline icon inside the first piece it pushed that figure off the baseline the
percentage sat on. Three sizes, two baselines, one reading. Both figures are
now a single text run, `↗ +0.3 (+0.59%) · 1H`, so they share a baseline by
construction rather than by alignment; the arrow is centred on the line instead
of set in it; the period label stays neutral. Measured in the browser across
all twelve combinations (1H/24H/7D/ALL × rising/falling/flat): one text node,
figure and period label on the same baseline to the pixel, arrow centre equal
to text centre to the pixel, Inter 16px/500 with `tabular-nums` throughout. A
zero move renders `0.0 (0.00%)` with no sign and no colour, which is the
Phase 19+ rule.

**Both stat rows came off the card.** Buy and Sell repeated the trade bar that
is on screen at all times, in a second format. Spread showed the HALF-spread
(`0.5`) while the trade sheet showed the full one (`$1.00`) — the platform was
stating two different spreads, and the sheet, where a spread is actually
charged, is now the only place it is stated. Gravity moved into the chart,
where the target is a line on the same axis as the score instead of a number
the reader has to place: in range, a dashed line labelled `Gravity 55.0` at the
right edge, under the score line; out of range, the existing edge note. The
vertical domain is untouched — the 0.5-point floor and the domain arithmetic
are shared with the Portfolio value chart and were not part of this.

**Two bugs at the sheet's edges**, both reproduced at 375×667 before being
fixed:

- The title block was a sibling ABOVE the scroll area, with no background of
  its own and nothing between it and the content. Scrolled content was clipped
  hard at its bottom edge, so the surviving few pixels of a half-scrolled line
  landed under "Paper trading. Not real money." and the sheet read as though
  its content were showing through its own title. The title block is now sticky
  INSIDE the scroll area, carrying the sheet's own background; content passes
  under it and is covered.
- `--z-tabbar` was **40** and `--z-sheet` **35**: a row of navigation drawn on
  top of an `aria-modal` dialog, covering the bottom of the sheet and staying
  tappable while the dialog claimed to have trapped focus. The tab bar moved to
  **20**, under the overlay — a modal covers the app, and the banner stays the
  single documented exception because the countdown has to be honest
  everywhere. The sheet also stopped padding by a tab bar's height, which was
  only ever there to dodge the nav; it is now `env(safe-area-inset-bottom)`
  plus the body's own padding.

  Measured at 375×667, the primary action at rest, before and after:

  | | Buy sheet | Sell sheet |
  | --- | --- | --- |
  | before | 23px of the 52px button visible; a tap at its centre hits the tab bar | **0px visible**; a tap at its centre hits the tab bar |
  | after | **52px visible**; the tap hits the button | 41px visible; the tap hits the button |

### The pinned footer (Phase 26b)

Phase 26 bought the sheet height. It did not change its shape, so the primary
action still rode at the bottom of the scrolling content and whether you could
reach it stayed a function of how tall that content happened to be — the Sell
sheet was still 59px over on the smallest supported viewport, and every row a
later phase adds takes another bite out of the one control the sheet exists to
offer. So the sheet became three regions: the pinned title, a scrolling body,
and a **pinned footer** carrying the step's primary action. Every step hands
its bottom action row up — Review, Back/Confirm, Done, Close/Change order — and
the copy, variants and order are exactly what each step rendered before. What
stays in the body is what needs the body to make sense: the rejection's "Review
at $57.14" beside the quote it names, "Buy 3 shares instead" beside the limit
that produced it.

Pinned by flex, not by `position: sticky` — the panel is a column with a fixed
maximum height, so a `shrink-0` last child sits against the bottom edge and the
middle child takes what is left. No stacking context to reason about, and
"above the tab bar" is true by containment rather than by a second token. The
hairline on top is shown only while body remains underneath it, and is always
in the box (transparent when off) so toggling it cannot shift a pixel.

Measured at 375×667, the primary action at rest, every step and both sides:

| step | Buy | Sell |
| --- | --- | --- |
| compose | 52/52px, tap hits the button | 52/52px, tap hits the button |
| compose, scrolled to the end | 52/52px | 52/52px |
| compose + a 56px stand-in row above the stepper | 52/52px (body 516 → 580) | 52/52px (body 566 → 630) |
| confirm | 52/52px | 52/52px |
| filled | 52/52px | 52/52px |

The extra row costs the BODY its scroll and never the action, which is the
whole point: Phase 27's Shares/Dollars toggle can land above the stepper
without a spacing negotiation.

**The software keyboard.** `position: fixed` resolves against the layout
viewport, which iOS does not shrink when the keyboard appears — so a
bottom-anchored sheet, and its footer with it, ends up behind the keyboard.
The overlay now tracks `visualViewport` and lifts its own bottom edge by the
occluded height. Driven with a 260px inset on a 667px viewport, the panel and
the footer both come to rest at 407px, which is exactly the top of the
keyboard. Where the API is absent the inset stays 0 and nothing changes.

## The landing page and the waitlist (Phase 28)

The first page a stranger can see. One idea above the fold — a real Momentum Score, moving — and one ask: an email address. Everything below the fold exists to make the number make sense.

### What is on it

- **The hero.** The founder's own Momentum Score (`people.slug = 'anthony-baptiste'`, the one person the public side of the platform will ever describe, shown with consent and framed as exactly that), at display size, updating on the Engine's 30-second heartbeat with the same `CountdownTimer` on the same clock module the app's banner uses (`components/engine/engine-clock.ts`, wall-clock-aligned, so the landing page's countdown and a signed-in profile's agree to the second by construction). Three change chips (past hour, past 24 hours, past 7 days) computed by the profile's own `periodChange`, coloured by direction at the precision shown. One email field. The paper-trading statement in plain words.
- **How it works**, in three beats: signals from the world → the Engine computes a Momentum Score → you take a view, Rising or Falling, in shares, with paper credits.
- **Why it moved.** The day as a monochrome line, the five forces over the last hour with the points each added (the profile's `readForces` over `score_events`, in the founder's own terms), and the recent signals in plain language — or, today, the honest sentence that no signal about the founder has reached the Engine yet.
- **The closing ask**, the same field again, and a footer with the paper line, `/privacy` and Sign in.

### The public endpoint

`GET /api/public/featured` (`app/api/public/featured/route.ts`) is the one public read. It serves `FeaturedPayload` (`lib/landing/model.ts`: score, tick number, last tick time, the three changes, a day of history, the five force impacts, the newest six signals as source/headline/time/impact, and when it was generated) and **nothing else**: no id, no slug, no user, no trade, no position, and nothing about any other person. The slug is `FEATURED_SLUG`, a constant; **the handler reads no parameter** — path, query and headers are ignored — so there is no input through which a caller could name somebody else, and `/api/public/featured/anything` is not a public route at all (the gate answers 401 before any handler runs). `parseFeaturedPayload()` is an allowlist applied on both sides of the wire, and the route emits only `FEATURED_PAYLOAD_KEYS`. The read (`lib/landing/featured.ts`) is memoised per 30-second slot, so an instance reads the database once a tick however many visitors poll; an in-memory limiter allows 240 requests an address a minute; a failed read is a 503 with no body, never a stale value dressed as fresh.

### The kill switch

The client (`components/landing/use-featured.tsx`) polls on `useTickPolling`, the app's own schedule. A failed answer — 503, network error, unparseable body — changes nothing on screen except the label: the last payload stays and the hero says **Last known · as of &lt;time of that tick&gt;** in the reader's timezone. A tick older than three cadences is labelled the same way even when the feed answers. Nothing is ever estimated; when the endpoint answers again the label returns to **Live · next tick 0:NN**. A page that never received a number shows no number.

### The waitlist

`waitlist` (migration above) grants nothing to any client — no policy exists on purpose — and the only way in is `POST /api/waitlist` (`app/api/waitlist/route.ts`) → `join_waitlist()` through the service role. The route checks the honeypot first (a hidden field named `website`; anything in it is a bot, dropped behind a success that gives nothing away), then the per-IP limit in the database (`rate_limit_hit`, five in ten minutes, held across instances), then joins. A known address and a new one get the same answer, so the page cannot be used to test membership; the position shown on success is the row's real count, or nothing. No email is sent in this phase and the copy does not claim one will be, beyond the invite. **Cloudflare Turnstile was not added**: it needs a site key, a secret and a third-party script on a page that otherwise loads none, and the honeypot plus the database limit cover the phase; it is a one-component addition if the log shows it is needed. The logic is pure (`lib/landing/waitlist.ts`, tested for the four cases in `waitlist.test.ts`) and the SQL is tested on real Postgres (`waitlist.db.test.ts`: new, duplicate in any case, position, invalid, and that `anon` / `authenticated` hold no privilege on the table or the function).

### Privacy, events, admin, the address

`/privacy` says what is collected, why (the invite, nothing else), how long, and how to have a row deleted, by writing to `PRIVACY_CONTACT_EMAIL` in the copy file. **That address is a PLACEHOLDER** (`privacy@placeholder.example`, a reserved domain that can receive nothing) by the operator's decision on 2026-09-23, flagged in a box in `lib/landing/copy.ts` and held in step with `PRIVACY_CONTACT_IS_PLACEHOLDER` by the copy test; it must be swapped for a real address before the page is put in front of anyone. Page views and sign-ups are logged as `view_landing` and `join_waitlist` through the existing behavioural pipeline as **anonymous** rows (`user_id` null, a session id, never the address); no third-party tracker or analytics script loads. `/admin` gained a Waitlist panel (count, last 24 hours and 7 days, the latest twenty-five with form, campaign and referrer host). `NEXT_PUBLIC_SITE_URL` is the site's one address (`getSiteOrigin()` / `absoluteUrl()` in `lib/env.ts`): the canonical URL, the OG image, the metadata and every absolute link derive from it, and `lib/site-url.test.ts` fails the suite if a vercel.app hostname is ever written as a literal in app code.

### The copy rules

Every word a stranger reads is in `lib/landing/copy.ts`, one file, and `lib/landing/copy.test.ts` holds all of it — and the string literals and text nodes of every landing component and public page — to the rules: only the founder is named; the beta is paper trading with paper credits, said plainly; never invest, bet, gamble, wager, earn, profit, returns, income, "get paid", worth or value; no promise of real-money trading; no manufactured urgency; Momentum Score, the Engine, Feed, shares; never "Oracle", no Black Mirror, no "Nosedive"; the founder never a pronoun. `copy.db.test.ts` reads the roster from the seeded database and checks that no other tracked person's slug, name or surname appears anywhere public. Three headlines were written and one chosen; all three are in the copy file.

### Verification harness

`lib/auth-gate.test.ts` covers the rewrite, the redirect of `/welcome`, the public API routes by exact path, the robots file and the two indexable pages, and audits the landing tree's source for any `/api/` path that is not a public one. `lib/landing/model.test.ts` proves the payload allowlist. Screenshots at 375px and desktop, the live tick against the countdown, the kill switch, LCP and reduced motion are checked with a temporary fixture page and Playwright before each deploy and reported; the fixture is deleted afterwards.

## The market price, and the anti-manipulation framework (Phase 29)

Every person has **two numbers**. The **Momentum Score** is the data's number: Gravity + Signals + Market Mood, and nothing anyone does on the platform. The **market price** is the number you trade at: the score plus a **premium** that trading moves and that decays back toward zero every tick. Buy and Sell quotes sit either side of the market price by the spread. The public explainer is `/how-the-price-works` (reachable signed out, indexable, linked from every profile's market line); it prints the formula and the tier parameters as they stand in the database when it is served.

### Option A: the score is independent of trading

Conviction and Trading Activity read participant activity, and nothing derived from participant activity may feed the index. Both are still computed every tick and reported (`PersonSummary.market`), and neither is in the score's sum nor in `score_events`. `SCORE_FORCES = [gravity, signals, market_mood, inverse_pair]`, `MARKET_FORCES = [conviction, trading_activity]` (`lib/engine/types.ts`). Before the change, their actual contribution over the trailing 7 days was measured: **zero `score_events` rows for either force across 20,159 ticks; max 0, mean 0 per tick** — removing them cannot affect the ~09-28 weight-wave analysis. On the profile the two rows now show what they read (the share of the allocation cap committed; the net flow over the hour) with a MARKET tag, computed from the same rows the Engine reads (`positions.amount_cents`, `trade_events`), and the Dossier's CONVICTION comes from that concentration rather than from an audit row that is no longer written.

### The arithmetic

Quantities are thousandths of a share, prices whole cents, every step integer. With `S` the side's base price (score ± half-spread, premium excluded), `I` the dealer's inventory in units (positive after net buying) and `D` the tier's depth in units per point:

| | |
| --- | --- |
| a buy of `u` costs | `ceil( u·S/1000 + u·(2I + u) / (20·D) )` cents (`market_walk_cents`, up, ceil) |
| a sell of `u` brings | `floor( u·S/1000 + u·(2I − u) / (20·D) )` cents (down, floor) |
| the average fill | `round( S + 100·(2I ± u) / (2·D) )`, the exact rational rounded once (`market_average_cents`) — what the order records as `fill_price_cents`, what the sheet sends and what the **tolerance band is checked against** |
| the worst fill | the marginal price at the inventory after: `S + 100·I'/D`, rounded the side's way (`market_marginal_cents`) |
| the premium | `trunc( I × 100 / D )` cents a share; `market_price = current_score + premium_cents × 0.01`; `buy_price` / `sell_price` are `market_price ± spread` |
| decay, each tick | `I ← I − sign(I)·ceil(|I| / K)`, `K = round(half_life_ticks / ln 2)` (692 for the public tier, 346 private), so the inventory reaches **exactly zero** in finite ticks and never oscillates |
| the cap | inventory may not pass `ceil((cap + 1)·D / 100) − 1` in either direction |

The walk is evaluated as **one integer fraction over `20000·D`** and rounded once; the impact term `u²/(20·D)` has no finite decimal expansion for a general depth, so `trade_orders.impact_cents` is stored as `numeric` to nine decimals **for the record** and the CHECKs assert the exact integer identity instead (`gross = market_order_gross_cents(...)`, i.e. `ceil(linear + impact)` for a buy and `floor` for a sell, evaluated in integers; `positions.amount_cents` the same through `market_lot_amount_cents`). A round trip against an unchanged book costs exactly the spread plus at most two cents of rounding: the impact paid in is recovered on the way out, so a pumper's loss is the spread plus whatever decay took during the minimum hold. `lib/trading/market.ts` mirrors every function in BigInt and `lib/trading/market.db.test.ts` holds the two against each other over 3,000 random cases and the SQL against itself over 1,500 random order splits (path independence).

**The off switch is a named mode (Phase 29b).** `pricing_mode = 'flat'` on a tier, or `people.pricing_mode_override = 'flat'` for one person, is a flat market — Phase 27 pricing exactly, premium 0, no impact, no `premium_history` rows — with no deploy; the next tick returns any standing inventory to zero with one `reset` row per person. `'curve'` on a person keeps them on the curve while their tier is flat. A NULL `depth_units_override` always means the tier's depth, and the stored depth is NOT NULL, so a flat market can no longer be the accident of a missing number (Phase 29 had used a NULL depth for it, while a NULL override already meant "the tier's" — one NULL, two meanings). `market_params_for()` returns a NULL depth exactly when the effective mode is `flat`. The legacy suites run on the named flat mode and pass unchanged; `lib/trading/pricing-mode.db.test.ts` holds every tradeable person to a non-null depth from their tier, both overrides both ways, the NOT NULL and CHECK refusals, and the reset.

### Parameters, as shipped (`market_tier_settings`; the operator recalibrates depth to real beta volume)

| | public_figure | private_individual |
| --- | --- | --- |
| depth | 300,000 units (300 shares of net buying move the price one point) | 100,000 |
| decay half-life | 480 ticks (4 h) | 240 ticks (2 h) |
| premium cap | 8.00 points | 3.00 points |
| minimum hold | 600 s (the longer of this and `close_cooldown_seconds`) | 86,400 s |
| max single order | 0.20 of depth (60 shares) | 0.10 of depth (10 shares) |
| aggregate exposure cap | 3,000,000 units (3,000 shares net) | 400,000 |
| premium breaker | 3.00 points in 600 s → halt 1,800 s | 1.50 points in 600 s → halt 3,600 s |
| total-price breaker | none | 5.00 points in 600 s → halt 3,600 s |
| shorting allowed | yes (still behind `platform_settings.shorting_enabled`, off) | no |
| alert on halt | no | yes |

The founder is `private_individual`, `display_only`; the other fifteen are `public_figure`, `tradeable`. The premium cap and the exposure cap are set so the premium cap is reachable: 2,402,999 units of inventory hit the public cap, under the 3,000,000-unit exposure cap (the memo's 2,000 / 200 shares would have bound first and made the stated caps unreachable). **The exposure cap counts HOLDINGS while decay erases INVENTORY**: a popular person whose holders simply keep holding reaches the cap and stays there, at zero premium, until someone sells. It is a share-count cap kept for this phase and recorded in the design notes as something that must become per-person scalable or loss-based before a real user base arrives.

### Guards, breakers, modes

`place_order()` checks, in order: frozen account → identity (when `require_verified_identity`) → excluded party → halt → paused → no quote → the Dollars-mode binary search over the curve → `order_too_large` (share of depth) → walk, average and worst fill → **tolerance on the average** → below minimum → `premium_cap` both directions (the message names what still fits) → the **premium breaker** (the premium move this order would complete against the premium a window ago; tripping it halts the person and refuses the order, and the halt is recorded whatever happens to the order) → the private tier's **total-price breaker** → netting → the shorting gate (platform AND tier AND override) → `display_only` (the score is shown, nothing new opens, what is held can be closed) → the minimum hold → the daily close limit → levers 1 and 2 → `exposure_cap` → the balance. The Engine's tick runs `apply_market_decay` and `evaluate_price_breakers` before it snapshots portfolios, so a breaker can trip on a tick as well as on an order. A halt from a breaker on a tier with `alert_on_halt` raises an alert.

**The sheet** previews on the same curve (`previewMarketOrder` / `previewMarketSpend` in `lib/trading/model.ts`, through `lib/trading/market.ts`): each quote is **the price before your order** (Phase 29b: it had been called the first share's price, which it is not — the quote's premium is truncated to the cent, the curve's first thousandth of a share is not, so "Buy at $73.40" sat beside "first share $73.41"), the review names the **average** and the **last share's** price, the order sends the average as `quotedPriceCents`, and the fill reports both from the server. Halted, paused and display-only each have their own compose state and rejection title; `order_too_large`, `premium_cap`, `exposure_cap`, `insufficient_balance` and `exceeds_position` offer the largest order that fits. The portfolio's Sell sheet gets the person's whole book from `portfolio_summary_for()` (Phase 29b) and walks the curve exactly as the profile's does: the same `toTradeBook` parser, the average sent as the quoted price. Every sentence in the sheet that states a price is built in `lib/trading/sheet-copy.ts` from the figures it sits beside, and `lib/trading/sheet-copy.test.ts` reads each figure back out of the text and holds it to its neighbours over thousands of random books. The chart draws the market price as a second, thinner line on the score's axis with a legend and a two-value crosshair (one point is one dollar, so the gap between the lines is the premium); `person_market_series()` looks the premium up once per bucket edge and the live route places it under new ticks from `premium_history` by the same rule (`marketAtTicks`). The position card marks a HIGH position at the Sell side of the market price and says where the market price sits.

### Surveillance and the review queue

`run_surveillance` runs inside `place_order()` after every fill, over `platform_settings.surveillance_window_seconds` (600): **clustered buying** (≥ 4 distinct accounts buying one person), **new-account burst** (≥ 3 accounts under 24 h old), **shared infrastructure** (≥ 2 accounts from one salted fingerprint hash), **wash trading** (≥ 3 round trips by one account in 3,600 s) and **referral spike** (≥ 5 accounts sharing a referrer). Every reading is a `surveillance_events` row; a reading at or over its threshold raises an `alerts` row unless one of the same type on the same person is already open inside the window (then it is refreshed). Evidence is counts, windows and a 12-character hash prefix, never an address. The **fingerprint** is `sha256(FINGERPRINT_SALT | first hop of x-forwarded-for | user agent)`, computed in the order route from the request's own headers (never from the body) and passed as `place_order()`'s eighth argument; without the salt the column stays null and that one detector is silent. `/admin` gained **The market**: the open queue with freeze / exclude / halt / lift / resolve / dismiss on each alert, the market's state per person with mode and halt controls, frozen accounts, excluded parties, the tier settings, the detector thresholds, the house book by category and the audit log — every action a plain HTML form to one Server Action (`app/admin/actions.ts`) calling the admin RPC as the signed-in operator, each of which writes `admin_audit_log`, which refuses update and delete for every role. The levers stay read-only and changed by migration; `min_order_cents` and `require_verified_identity` joined the levers table.

### Verification

`lib/trading/market.db.test.ts` (27 tests on real Postgres): deploy invariance; the curve on the deploy book (a ten-share buy costs $505.17 at an average of $50.52, last share $50.54, premium 3¢); a round trip of −$10.01; exact-CHECK rejection of a wrong gross; path independence over 1,500 random splits; the SQL↔TS mirror over 3,000 cases; decay to exactly zero, symmetric; `decay_mark` rows; Dollars mode on a curved book; tolerance on the average; every guard at its boundary (`order_too_large` at 60 shares, `premium_cap` at 2,402,999 units, `exposure_cap`, the premium breaker at 900,000 units with the halt, the private alert and total-price breaker, the 600 s hold message); every mode (display-only founder, paused, frozen, excluded, identity required, identity uniqueness, the shorting override); the house book summing to −P&L per close; a replay of `premium_history` and `person_market_series` reproducing every price; the **pump simulation** (a single account loses more than $720 on a $2,000 round trip through the premium; a ten-account ring gets 15 fills and is then halted with `clustered_buying`, `new_account_burst` and `shared_infrastructure` raised and no fingerprint leaked); the admin RPC flow, the immutable audit log and the grants. `lib/engine/market-readings.test.ts` proves the score is byte-identical under heavy trading and none. `lib/trading/model.market.test.ts` holds the previews and parsers against the mirror. The Phase 27 rollback file refuses on a Phase 29 schema (`lib/trading/rollback.db.test.ts`); Phase 29's own down file came with 29b ([Reversing Phase 29](#reversing-phase-29)).

### Design notes (recorded, not built)

- **Leaderboards rank accuracy or risk-adjusted performance, never raw P&L.** Raw P&L on a market with a premium rewards whoever moves the price and exits first; the ranking must not be an incentive to do that.
- **Head-to-head challenges cannot target private individuals.** A private individual is display-only or, at most, tradeable under the tighter tier; a challenge that puts two people's attention on one private person's market is exactly the pressure the tier exists to prevent.
- **The aggregate exposure cap counts holdings while decay erases inventory**, so a person whose holders keep holding sits at the cap permanently at zero premium. The share-count cap must become per-person scalable (a fraction of the person's depth or of their open interest) or loss-based (a limit on the platform's marked exposure in cents) before a real user base arrives.
- **The premium's decay does not know who is holding.** It brings the market price back to the score while positions stay open, so a crowd that bought high and exits after the premium has drifted back pushes the price below the data for a while. The explainer says so in plain words; the house book records the platform's side of it.
- **Retention**: `premium_history` and `fingerprint_hash` are on the retention item with `score_events`; no prune ships in this phase.

### Phase 29b: post-ship fixes

- **Depth resolution.** Confirmed on production before and after: all fifteen tradeable people resolve to a non-null depth (300,000) from their tier, no override set; the founder to 100,000. Flat is now the named `pricing_mode` (above), never a NULL.
- **The portfolio's close sheet walks the curve.** It had previewed flat at the quote and sent the quote, so a close big enough to move the price more than the 10¢ tolerance was refused as `price_moved` from the portfolio while the same close went through from the profile. `pricing-mode.db.test.ts` sells 60 shares (a 20¢ move) and 150 shares (the flat quote 25¢ from the average: refused; the curve's average: filled) and checks the preview's average, last share and gross against the server's fill to the cent.
- **The landing's "why it moved"** shows the three forces that move the score (Gravity, Signals, Market Mood) and no longer Conviction or Trading Activity: `SCORE_FORCE_KEYS` in `lib/person/profile-model.ts`; the public payload's parser drops a market force even if one is sent; the copy says three forces.
- **The sheet on a phone.** Typing in the Shares or Dollars field glitched the sheet and could close it. The root cause was in `components/ui/sheet.tsx`: its open/close effect depended on `onClose`, and the trade sheet's close handler changes identity with the quantity typed, so **every keystroke tore the sheet down and set it up again** — focus went back to the Buy pill behind it and then to the panel, and the scroll lock came off and on. On a desktop that swallowed every digit after the first (reproduced: typing "125" left the field empty); on iOS the blur dismissed the keyboard and the focus jump scrolled the page. The effect now reads the latest `onClose` through a ref and runs once per open. Around it, for iOS specifically: the body is pinned (`position: fixed` at the scroll offset, restored on close) because iOS ignores `overflow: hidden` for its scroll-into-view; the overlay follows the **visual** viewport at both edges, so when the keyboard pans the view the sheet's title stays on screen; the backdrop closes only on a press that began on it, never within 500 ms of the viewport changing size, and if a field had the keyboard when the press began (read at the press, since a tap can move focus before the click) the first tap outside only puts the keyboard away; programmatic focus never scrolls. Verified in a 375 px Chromium with a scripted `visualViewport` (keyboard 291 px, pan 150 px): the panel sits exactly in the visible band, "12" types as "12", a ghost click and a settling-viewport tap leave the sheet open; and with real touch and mouse input the first backdrop tap puts the keyboard away and the second closes the sheet. Not verified on a physical iPhone from here: the sandbox has Chromium only.
- **The dev overlay's "1 Issue"** in the Phase 29 screenshots was a hydration mismatch, and there were two. The profile shots' was the verification fixture's own: it built timestamps from `Date.now()` in a client module, so server and browser disagreed. The sheet shot's was real: `Sheet` rendered its portal only where `document` existed, so a sheet open on the first render was nothing on the server and a dialog on the client; it now mounts through `useSyncExternalStore`. Auditing for the same class found a third that would have hit real readers: the halted notice formatted "halted until 7:22 AM" in the server's time zone (UTC) and again in the reader's — it is `LocalClock` now, and every time-dependent phrase on the trade bar reads the page's `useNow` clock. Console clean, overlay at 0, on the profile, the sheet (compose and confirm), halted and display-only, in a New York time zone.
- **Display-only is score only**: no market price line, no premium footnote, no market line on the chart, no market price in the sheet; closing a held position works as before.
- **The trade bar** is opaque and exactly `--spacing-tradebar` (96 px) tall; the profile reserves that below its last line (`pb-tradebar`) on top of the tab bar and the home indicator — measured: the last line ends at the bar's top edge, 0 px apart. The status line is one line: while the market is not open it says only its state ("Halted · 29 min left", "Display-only · closing only").
- **Copy**: no duplicate "Shares" beside the toggle; "Closes up to X" only when X is not the holding already stated; "Last share" for the worst-fill row; the spread note is two lines at 375 px ("The $1.00 between Buy and Sell is the platform's spread. Each quote is the price before your order."), and the public explainer, which had made the same first-share claim, now says the same; the explainer says a halt pauses all trading, closing included.
- Found on the way: a Dollars-mode **Sell** for more than any sell could return made the preview's search double toward 10¹² units until a figure left the safe-integer range and the sheet threw while rendering. A sell's proceeds peak where its last unit prices at zero and fall after; the search now stops there (and at the largest order the sheet accepts). The server was never affected.

### Phase 29c: the market line, the forces panel, a depth demo

- **One line when they coincide.** While the market price is within 1¢ of the score at every point the chart draws (`marketInLine` in `lib/person/chart-math.ts`; the chart's time domain runs from the first point to the last, so those points are the visible window), the two are one line: the legend reads "Market price · in line with the data", with no swatch, and the chart draws the score alone — at the half-point floor a cent is still about five pixels, and a grey edge peeking out from under the score would read as the second line the legend says is not there. The crosshair still names both values. Two cents apart at any one point and the second line and its swatch come back.
- **The baseline.** What the code calls the revert target — where Gravity pulls — is the **baseline** everywhere a reader sees it: the chart's dashed line ("Baseline 55.0"), its out-of-range note ("Baseline 55.0 above this range"), the explainer, the landing copy and `/design`. Internal names (`revert_target`, `revertTarget`, the operator console's "Gravity target") are unchanged. The in-range label, set at the right edge where the line ends, now takes the side of the dashed line the line's end is not on, so a score finishing just above its baseline no longer runs through the words.
- **The five forces, in two groups.** "Moving the score" — Gravity ("Pull towards their baseline"), Signals, Market Mood ("The tide across the entire platform"), each with its points over the hour — and "Moving the market" — Trading Activity ("Buy and sell flow · moves the market price"), read as the hour's split and volume ("72% buying · $14 traded", or "No trades this hour"), and Conviction ("Capital committed · tightens the spread"), read as the share of the allocation cap held open. The market readings are phrases, so they are Inter with tabular figures in the neutral ink; the MARKET tag went, since the subheading says it.
- **Conviction tightens the spread; it does not set it and does not move the price.** Checked against `lib/engine/spread.ts` before the copy shipped: the spread is `clamp(0.50 + widening × (1 − tightening), 0.50, 1.50)`, and open capital enters twice — as the LMSR share that decides how thin the market is (more capital, less widening) and as concentration, half the weight of the tightening (signal depth and confidence are the other half). More capital never widens a person's spread, but it never sets it alone — signal depth, confidence and everyone else's capital move it too — and the premium reads only inventory and depth. On production today every spread is between 0.5000 and 0.5029, so the effect is real but small.
- **Every claim on the panel is a test.** `components/person/forces-panel.test.ts` reads each line back against the code: the groups against the Engine's `SCORE_FORCES` / `MARKET_FORCES`; Gravity towards the revert target from both sides; a buy never lowering the premium and a sell never raising it (strictly, once the order is worth two cents of inventory — the premium truncates towards zero); the flat market's premium staying 0 and the row saying so ("the market price stays at the score", and the footnote with it); the spread non-increasing in open capital across a sweep, strictly tighter on a thin market, moved by depth and confidence at the same capital, and inside [0.50, 1.50]; the readings' wording and rounding (one sell among many buys is 99%, never 100%); and the rendered panel's order, face and colour.
- **The forecast sentence** sets "1 forecast" and the minimum ("once 5 people have called it") in Inter with tabular figures, by the Phase 26 rule; the split's standalone percentages stay mono.
- **A depth demo, temporary (MrBeast only).** Production data, not a migration: with his inventory confirmed at zero (a flat override for one tick wrote the `reset` row), `people.depth_units_override = 20000` — 20 shares per point — and every other parameter at the tier default. At that depth the largest single order is 4 shares (20% of depth) and the 3-point breaker trips once net buying from zero reaches 60.2 shares inside ten minutes (a premium of 3.01 against a limit of 3.00; decay adds a little if the buying is spread out). **To end it**: bring his inventory to zero the same way, then set the override back to NULL; `market_params_for()` then resolves his tier's 300,000. Never change a depth while inventory is non-zero — the premium is `trunc(I × 100 / D)`, so it would rescale at once. **Ended 2026-09-25 18:16 UTC**, exactly so: `pricing_mode_override = 'flat'` for one tick (a `reset` row took inventory 5,748 → 0 and the premium 28¢ → 0), then both overrides back to NULL. MrBeast is on the public-figure tier again (curve, 300 shares a point), and his profile's market-settings section is empty.

- **After 29c: the desktop trade dialog ends inside the window.** On desktop the Sheet's panel sat 5rem below the top of its overlay but was allowed the overlay's full height, so at its limit it hung 80 px past the bottom of the window — and its pinned footer, the Review and Confirm buttons, was the part cut off. The arithmetic had been wrong since Phase 6a; Phase 29's taller sheet is what made ordinary laptop windows reach it (measured before the fix: 1280×720 and 1366×768 with the Confirm button wholly below the window, 1440×900 with 19 px cut; phones unaffected, since there the panel is a bottom sheet). The top gap and the height limit now come from one token, `--spacing-dialog-gap` (`clamp(1.5rem, 10dvh, 5rem)`), through `top-dialog-gap` and `max-h-dialog` (the overlay less that gap above and below), so the panel ends inside the window at every size and the body scrolls instead. Measured after, from 1280×600 to 1920×1080, Buy and Sell, compose and confirm: nothing past the window, the Confirm button the topmost element at its centre and a real click reaching `POST /api/trade/order`; the phone's bottom sheet unchanged. `components/ui/sheet.test.ts` holds the rule. The search dialog uses the same primitive and gets the same fix.

### Phase 29d: the explainer made true, a person's own settings, and two signal fixes

**The explainer (`/how-the-price-works`).**
- **Market Mood is "the tide across everyone we track"**, on the explainer, the forces panel and the landing copy. "The entire platform" contradicted the same page's "all three read the world outside this platform"; the mood is built from the Signals movement of the people on the board, which is outside data.
- **Conviction, stated as the code does it.** More open capital on a person **tightens** that person's spread and never widens it (`lib/engine/spread.ts`: it raises the person's LMSR share, so the market is less thin, and it raises concentration, half the tightening weight). The explainer and the forces panel say exactly that; `lib/landing/explainer.test.ts` holds the two texts together and `forces-panel.test.ts` holds the direction to the code.
- **What a round trip costs.** "Exactly the spread and nothing more" was false: the buy rounds up and the sell rounds down, so once the two walks cancel the roundings are left. The page now says "the spread, plus at most a cent of rounding (the spread on a fraction of a share is counted up to the whole cent)", and the arithmetic section gives it exactly: `ceil(u·Δ/1000)` cents or one cent more. `lib/trading/round-trip.test.ts` pins the bound over 20,000 random books and orders, pins whole shares to the spread or the spread plus a cent, and shows why the fraction is counted up: against the unrounded spread a fractional order can sit nearly two cents over. The page also says the market is never quite unchanged in practice, because the minimum hold keeps you in while the premium you added drifts back.
- **Individual settings.** Under the limits table: "Individual people can carry their own settings; where they do, their profile says so." The profile now does (below).
- **Its own link preview**: openGraph and twitter set in full from `EXPLAINER_META` (`lib/landing/copy.ts`). Next merges metadata one key deep, so the page had inherited the landing page's preview.
- **"Show the arithmetic"**: the formulas sit in a native `<details>`, closed by default and in the server's HTML, so search engines index them and find-in-page opens them.

**A person's own market settings, on their profile.** `market_params_for()` resolves five per-person columns over the tier (`depth_units_override`, `decay_half_life_ticks_override`, `premium_cap_cents_override`, `pricing_mode_override`, `shorting_override`). The profile reads all five and, for every one that is set and differs from the tier's, prints one plain sentence under the score card against the tier's own figure (`lib/person/market-overrides.ts`, `components/person/market-overrides.tsx`). MrBeast's reads: "20 shares of net buying move MrBeast's market price one point, against 300 shares for other public figures, so the largest single order here is 4 shares (60 shares for other public figures)." Depth, half-life and cap are not mentioned on a flat market, where they do nothing. `market-overrides.test.ts` collects every `*_override` column from the migrations and fails if one has no sentence or is not read by the profile.

**Signals are unique per source, person and key** (migrations `…signals_dedupe_per_person` and `…signals_dedupe_drop_source_only`). The rule had been per source and key alone, and the store inserts with `ON CONFLICT DO NOTHING`, so an item that belongs to two people was stored for whichever came first and silently refused for the other. The audit found:
- **Finnhub company news, GOOGL** (Page and Brin). The one identifier mapped to two people in production today, and the reported bug.
- **Finnhub insider filings.** The key is `finnhub:insider:<symbol>:<date>:<code>`, so Page and Brin selling GOOGL on the same day would have collided.
- **News articles** (`rss:<link>`, `pub:<link>`). An article that turns up in two people's feeds was kept for one; the duplicate-story check is per person, so nothing else caught it.
- **Game results** (`apisports:game:<id>`). A game two tracked players both played in; one player is mapped today.
- **Streams, stream summaries, live moments and comment digests.** These are keyed by stream or video and would collide on a shared channel; there is none today.
- `youtube_trending` already carried the person in its key.

Changing the rule rather than every key string fixes all of these at once. It also re-stores nothing: an article, filing or game is re-read for days, and a new key format would have stored each again. Every existing row stays as it is, and there is no backfill, so Brin's past readings are not recreated. The change shipped in two steps so the deploy never met a missing `ON CONFLICT` target: the per-person rule was added beside the old one, the code moved to it, then the old rule was dropped. `lib/ingest/dedupe-per-person.db.test.ts` stores one key for Page and for Brin and still refuses a second copy for the same person. The in-memory store the ingestion tests run on follows the same rule.

**Every insider line, accounted for.** The Finnhub connector used to drop every Form 4 line that did not become a signal without counting it, so "no insider signal ever" could not be told apart from "no filing ever", "a name we do not match" or "only awards and exercises". `accountInsiderFilings()` now returns:
- the lines fetched for the company;
- the other insiders' lines, counted, with up to 20 of their names, so a spelling we fail to match shows up;
- each of the tracked person's own lines, kept or dropped with a reason: `code_not_scored`, `no_share_change`, `no_filing_date` or `net_zero`;
- the filings that became signals.

Connectors have a new `context.detail(key, value)`. The runner writes each entry onto the poll row (`source_polls.detail`, a new nullable jsonb column) and into the run log as `{"event":"detail",…}`, and never touches the poll's `reason`, so a healthy poll does not read as limping. Share counts only: the test asserts no price appears anywhere in the account. To read it:
```sql
select sp.started_at, p.slug, sp.detail->'insider_filings' as insider
  from public.source_polls sp join public.people p on p.id = sp.person_id
  join public.data_sources d on d.id = sp.data_source_id
 where d.name = 'finnhub' and sp.detail ? 'insider_filings'
 order by sp.started_at desc limit 20;
```

**Open item, not built.** Compare like days in the company-news baseline: weekday readings against weekdays, weekend against weekends. The weekly swing inflates the standard deviation, so a weekday reading needs roughly twice the average to cross 2σ. **Do this after the ~09-28 weight-wave analysis**, and prefer comparing like days to lowering the threshold, which would also let the weekend lull through as "quieter than usual".

The Phase 29 down file still takes the schema back through 29b exactly. The 29d migrations sit after it and are its own concern: `phase29-down.db.test.ts` now builds the database through 29b and no further.

### Phase 29e: the "price moved" loop, and the trade sheet on a wide screen

**The loop.** On MrBeast's demo depth (20 shares a point), a 4-share buy followed at once by another was refused "The price moved" every time, and "Change order" led back to the same refusal. The cause, confirmed before the fix:
- **The page kept the book from before the fill** (the main cause). A fill updated the balance and the position, but not the premium and inventory the sheet prices on, until the next poll, up to 30 seconds later. The live hook also dropped a poll whose only change was the inventory. At this depth one 4-share order moves the average 20¢, twice the 10¢ tolerance, so the next order was priced 20¢ short. Production's orders show it: each 4-share buy's average is 20¢ above the last.
- **The refusal's way out re-sent the stale price.** "Review at $X" went to the confirm step, which still priced on the unchanged book and sent the old average. It even showed the move backwards. "Change order" reopened compose on the same book.
- **Decay between review and confirm is not the cause.** One tick of decay moves a 4-share average by about a cent at most, even at the premium cap, and the confirm step already re-arms when a poll moves the book.
- **The re-quote button sat in the scrolling body,** under the pinned footer on a short window.

The fix:
- **Every answer from `place_order()` carries the book as the server read it** (after the order on a fill, before it on a refusal), and that book is applied at once. `ScorePanel` applies a fill's quote (`onFilled`) and a refusal's (the new `onQuote` prop). The sheet also prices on a refusal's book itself until the page's book moves past it, which is how the portfolio's sheet gets it too (it re-reads its summary as well).
- **The page reads the live book when the sheet opens,** and a poll that changes only the inventory now moves it. `lib/person/live-state.ts` has the merge.
- **A stale poll cannot undo an applied quote.** Polls and applied quotes share one sequence, so a poll sent before a quote was applied still brings its ticks but not its book.
- **A price_moved refusal has one action, in the pinned footer: "Buy at $70.41".** That is the server's own new average (`extra.fill_price_cents`), sent with the same order in one tap. Beside it is "Change order", which goes back to compose on the fresh book. The body says "The price moved" once, then "Buy now fills at an average of $70.41 a share, not $70.21. Nothing was placed." (`priceMovedBody` in `lib/trading/sheet-copy.ts`), with the summary of the order the tap will send.

The tests:
- `lib/trading/back-to-back.db.test.ts` runs on real Postgres at depth 20 through the page's own functions. It reproduces the loop, then shows five back-to-back buys and five back-to-back sells each filling at exactly the average previewed. It covers a refusal followed by a one-tap re-confirm (Shares and Dollars), decay between review and confirm (mid-book and at the cap, inside the tolerance), and a stale poll not putting the old inventory back.
- `lib/person/live-state.test.ts` holds the merge rules.
- `components/trade/price-moved.test.ts` holds the words and where the action lives.

**The sheet on a wide screen (≥1024px).** It had been a phone layout in a 512px dialog. At 1278×604 its body overflowed by 306–391px, measured on the committed code.
- **Two columns.** From `lg` up the order is on the left: the quotes in one short row, the market line, the spread note, Shares|Dollars beside the field, and the chips. The summary is on the right: average, last share, cost, balance after, position after. On the confirm step the two notes move under the summary too.
- **The footer spans both columns,** with the primary action under the summary.
- **The dialog is `Sheet size="wide"`.** It is at most 72rem wide, and never closer to the window's sides than the dialog gap.
- **The dialog gap got smaller** on short windows. `--spacing-dialog-gap` is now `clamp(1rem, 10dvh - 1.5rem, 5rem)`, 36px on a 604px-tall window where it was 60px.

Measured at 1278×604 (Buy and Sell, Dollars and 4 shares): compose, confirm, refused and filled all fit with no scrolling, and the spread note is on one line. The layout was also checked from 1024×768 to 1920×1080. The one exception is 1024×600, where the Sell steps scroll by 17px with the footer still pinned. Below `lg` nothing changed: the 375px screenshots of compose and confirm, Buy and Sell, are byte-identical before and after. `components/ui/sheet.test.ts` holds that the wide variant adds only `lg:` classes. It also holds that the width limit is not Tailwind's own `max-w-*` for a spacing token of the same name, the collision that first made the dialog run edge to edge at 1024.

### After 29e: ingestion overruns, and Buffett's insider symbol

**The overruns.** 17–50 publisher_rss person-polls a day hit the scheduled run's 35-second budget. Nothing was lost: every skipped person was polled again at the next fire, and the catch-up re-read the feeds' last 72 hours. But the same twelve people waited every time, the skip saved nothing, and one gap could delay items further:
- **The same twelve every time.** People were polled alphabetically, four at a time. All four waited on the one shared catalogue read (up to 15 s, plus a 6 s feed timeout), and when it returned the budget was spent, so everyone after the first four was skipped.
- **The skip saved nothing.** The expensive read had already been paid for; each skipped person needed only about a second of matching and writes.
- **A 304 gap.** The run saved the feeds' new caching markers (etag / last-modified) even though twelve people never read that content. So a feed unchanged at the next fire answered 304 and gave them nothing until it next changed: a delay, not a loss, unless the feed then stayed unchanged for the rest of the item's 72 hours.

Three changes:
- **A shared read is finished, inside a grace.** A connector that declares `sharedFetch` (the publisher catalogue) has all its people finished once it has started, instead of skipping those left when the budget runs out. They may start until the budget plus `sharedFetchGraceMs` (10 s); past that even they are skipped, so a slow database cannot carry the run into the 60-second kill. The catalogue itself now starts feeds only inside what is left of the run's budget (`context.remainingBudgetMs()`), so its last feed ends within one feed timeout of the budget. Feeds it does not reach are the longest-unfetched next time, as before.
- **Old markers after a miss.** A run in which anyone was skipped or failed keeps each feed's old caching markers, so the next fire downloads the feed whole and the people who missed it get it then. It costs one full download, and is logged as `feed_markers_kept`.
- **Longest wait first.** Inside every source, people are polled by their last successful poll (a six-hour window; anyone not served in it goes first), not alphabetically. Any deferral that remains falls on a different tail each time.

**The worst case.** A catalogue that starts with 0.1 s of budget left and has every feed hang to its timeout ends at 40.9 s. Sixteen people, four at a time, then take the run to 45 s at 1 s each, or 47 s at 3 s each (with eight deferred at the grace). Before, the worst case was about 56 s. `runner.feeds.test.ts` plays this through on a clock with four lanes; `cron.test.ts` holds the arithmetic.

**Buffett's insider filings.** Finnhub returns no insider lines at all for BRK.B, his company-news ticker. A Finnhub mapping can now name `config.insider_symbol`, the symbol Form 4s are read under; company news and the observe-only close stay on the ticker. A temporary probe (`config.insider_symbol_probe`) reads candidate symbols over a year and records only two counts per symbol on the poll row: lines returned, and lines naming the person. It is removed once read.

### Reversing Phase 29

Three ways back, in the order to reach for them.

**1. The named flat mode — the soft rollback, nothing lost, no deploy.** `update public.market_tier_settings set pricing_mode = 'flat';` (or `people.pricing_mode_override = 'flat'` for one person). Every order from then on fills at Phase 27 prices — score ± spread, no premium, no impact — and the next Engine tick returns every inventory to zero with a `reset` row. Everything else Phase 29 built (modes, halts, surveillance, the house book, the audit log) keeps working. Undo it with `'curve'`.

**2. The schema down file — `supabase/rollback/20260925012938_phase29_market_price_down.sql`.** Reverses Phase 29 and 29b together and takes the schema back to **exactly** what Phase 28 left; `lib/trading/phase29-down.db.test.ts` builds a database to Phase 28, another to 29b and back, and compares every column (type, nullability, default or generation expression, comment, grants), constraint, index, function (full definition, grants, comment), trigger, policy, table and view — no difference — then checks that every pre-existing row survives and the Phase 28 `place_order` trades on them, and that the Phase 27 down file applies again after it. The procedure:

1. Step 1 above, then wait one tick: every `premium_cents` and `market_inventory_units` must be 0 (the file refuses otherwise, naming the count).
2. **Vercel**: promote the Phase 28 deployment (commit `381fb7b`) to production. It runs on the Phase 29 schema as it stands — it calls `place_order` by name without the eighth argument, which defaults to null, and reads only columns that still exist — so orders keep filling (flat) throughout; there is no window of refused orders. (The other order, schema first, would leave the Phase 29 app calling functions that no longer exist until the promote.)
3. Take a `pg_dump` (there is no platform backup on the Free plan). Export what exists only in Phase 29's tables — `premium_history`, `house_ledger`, `alerts`, `surveillance_events`, `admin_audit_log`, `excluded_parties` — then run the file as one transaction (Supabase SQL editor, or `psql -v ON_ERROR_STOP=1 -f`), preceded by `set momentum.phase29_down_data_exported = 'yes';` if any of them has rows. It takes an `ACCESS EXCLUSIVE` lock with a 5 s `lock_timeout`; orders wait a few seconds, none fails.
4. If the file reports lots or orders filled along the curve that the Phase 27 CHECKs would reject (an order filled on the curve records an average, which is not in general gross ÷ units), either restore from a backup instead, or add `set momentum.phase29_down_curve_rows = 'not_valid';` — those two CHECKs come back `NOT VALID`, the rows are kept exactly as filled, every later row is checked. On production today: 0 of 7 lots and 0 of 11 orders would fail them, and every premium is 0.
5. The file deletes both versions (`20260925012938`, `20260925103634`) from `supabase_migrations.schema_migrations`, so `db push` sees the history the schema has. Move the two migration files out of `supabase/migrations/` in the repository at the same time, or the next push re-applies them.

**What the down file loses**: the six tables above and everything in them (on production today: 443 `premium_history` rows, 3 `house_ledger`, 6 `surveillance_events`, no alerts, no audit rows, no excluded parties); `market_tier_settings`; every per-person market setting — tier, trading mode (**the founder becomes tradeable again**, as before Phase 29), halts, the four overrides, the pricing mode; account freezes, the identity hook and referrals; the ten detector thresholds; and, on rows that stay, the curve's inputs — orders' base price, inventory and premium before/after, depth, impact, worst fill, the cost/proceeds split and the fingerprint hash, lots' `entry_*` and closes' `exit_*` inputs. `positions.entry_price_points` is renamed back to `entry_score`. Kept: every order, lot, close, transaction, balance, portfolio history point, score and signal. The market price's history can no longer be reproduced once `premium_history` is gone — export it first if it matters.

**3. A restore — the last resort, and not available today.** The project's organisation is on Supabase's **Free** plan, which has neither point-in-time recovery nor downloadable daily backups, so as things stand there is no restore to fall back on and option 2 is the real floor. On a paid plan a daily backup (Pro) or PITR (an add-on) could put the whole database back to before 2026-09-25 01:29 UTC, when Phase 29 was applied — losing **everything** written since (every order, signal, tick, score and waitlist entry, not just Phase 29's data) and still needing the Vercel promote in step 2. Until then the only full copy is one we take ourselves: `pg_dump` of the database before any schema rollback.

## Open items

- **A policy for operator resets, before real money.** An operator reset of a person's market (the flat-for-one-tick procedure that ended MrBeast's depth demo on 2026-09-25) takes the premium to zero at once, so every holder's position value changes by the premium times their shares, with no house-book entry at reset time. `apply_market_decay()` writes the `reset` row to `premium_history` and nothing to `house_ledger`. On paper this is a display change; with real money it is a transfer. Before real money there must be a written policy, for counsel, covering:
  - when a reset is allowed, and by whom;
  - how it is disclosed, to holders beforehand and on the profile afterwards;
  - who bears the cost: the house book or the holders, and how it is recorded.
- **Compare like days in the company-news baseline** (Phase 29d): weekdays against weekdays, weekends against weekends, after the ~09-28 weight-wave analysis. Prefer this to lowering the threshold.

## Scope so far

- **After 29e**: publisher_rss overruns no longer defer the same twelve people. A shared catalogue read is finished for everyone, inside a 10-second grace that keeps the run under the 60-second kill (worst case about 47 s, from 56 s). A run that missed anyone keeps the feeds' old caching markers, and people are polled longest-wait first. Finnhub insider filings can be read under their own symbol (`config.insider_symbol`), with a temporary probe to find Buffett's. Operator resets are recorded as an open item for a policy before real money.
- **Phase 29e**: back-to-back orders at MrBeast's demo depth no longer refuse themselves. Every fill and refusal hands the page the book the server read, the sheet reads the live book as it opens, and a "price moved" refusal offers one action in the pinned footer, "Buy at $X", the server's own average, in one tap. On a wide screen the trade sheet is two columns under one footer and fits a 1278×604 window with no scrolling. The phone layout is unchanged to the pixel.
- **Phase 29d**: the explainer made true — Market Mood "the tide across everyone we track", Conviction as the code does it (it tightens the spread), a round trip "the spread, plus at most a cent of rounding" with the bound pinned by a test, its own link preview and the arithmetic behind a toggle; a person's own market settings on their profile (MrBeast's depth now); signals unique per source, person and key, so Page and Brin both keep the GOOGL series and a shared article, filing or game reaches everyone it concerns; and every Finnhub insider line accounted for on the poll row.
- **Phase 29c**: the chart's legend says "in line with the data" while the market price sits within a cent of the score across the window; "baseline" for the revert target everywhere a reader sees it; the five forces in two groups, "Moving the score" and "Moving the market", with Trading Activity read as the hour's split and volume and Conviction described as what the code does with it — it tightens the spread — and every claim held to the code by a test; the forecast sentence in the sentence face; and a temporary depth demo on MrBeast (20 shares per point).
- **Phase 29b**: post-ship fixes — flat a named mode, never a NULL depth (confirmed on production: all fifteen tradeable people resolve to their tier's depth); the portfolio's close sheet walking the curve like the profile's; the landing's "why it moved" limited to the forces that move the score; every price sentence in the sheet held to its figures by a test; the sheet's keystroke bug (every keystroke re-ran its setup) and the iOS keyboard handling; three hydration mismatches; display-only as score only; an opaque trade bar with the page reserving its height; the copy tidy; and a down file that takes Phase 29 back to Phase 28 exactly, with the whole restore path in the README.
- **Phase 29**: the market price — a second number per person (the score plus a premium that trading moves and decay brings back), priced on an integer cost curve mirrored in SQL and TypeScript and held together by tests; Option A, with Conviction and Trading Activity computed and shown but adding nothing to the score (their prior contribution measured at exactly zero over seven days); exact CHECKs rather than bounds; per-tier depth, decay, caps, holds, breakers and shorting rules in a settings table with an off switch (a NULL depth then, the named flat mode since 29b); the founder private and display-only; every premium change on the record so every quoted price is reproducible; a house book; frozen accounts, excluded parties, the identity hook, five detectors, an alert queue and an append-only audit log; the profile's market line, the chart's second line, the sheet's average and worst fill and its halted / paused / display-only states; the public explainer; the admin review queue. Applied to production with deploy invariance verified.
- **Phase 1**: scaffold, schema, RLS, auth, seed data, typed clients.
- **Phase 2**: financial-write lockdown + RPC pattern, connector interface and registry, YouTube connector, stubs, `source_snapshots` (now `raw_source_snapshots`), ingestion runner and endpoint.
- **Phase 3**: swappable sentiment scoring (rules-based), the five forces, inverse pairs, LMSR spread with Buy/Sell prices, the atomic tick with history and per-force audit trail, the tick endpoint.
- **Phase 4**: provider-agnostic LLM abstraction with an Anthropic adapter and three stubs, model routing, per-entity memory with seeded baselines and cheap evolution, the `LLMScorer` with anomaly awareness and rules fallback, usage logging with a per-tick call cap, narratives for meaningful moves.
- **Engine cron**: the 30-second heartbeat via Vercel Cron (two ticks per one-minute invocation with a time budget), one shared `runFullTick()` path, gated by `ENGINE_CRON_ENABLED`, which ships as `false`.
- **Phase 11**: the tick that always commits — a start-gated deadline per tick, deferral (unattempted signals stay unprocessed) distinct from fallback (failed attempts score by rules), the load bounded in LLM shape with one chunk per person per tick, one attempt per call, a real per-tick call budget, the usage ledger written before each call, and the backlog visible tick by tick in the admin console.
- **Phase 12**: freshness — an age weight on the Signals force (half-life 24 h, zero past 7 days; expired signals processed at zero impact without a model call; metrics never aged; the model not shown a signal's date) and the effective per-request model timeout pinned end to end. The purge of the stale backlog was scoped and declined: freshness handles it.
- **Phase 12+**: newest-first selection with a least-recently-served rotation across people, and memory event expiry (30 days, dated folds written as history, today's date and event ages in the person block).
- **Phase 13**: publisher-direct feeds — the `publisher_feeds` catalogue read as one shared fetch per run, whole-word name matching scoped by topic, undated items refused, per-feed health and discovery written back onto the rows, the two news doors deduplicated as one story family with Google News kept as the fallback — and the ingestion cron at every fifteen minutes with every source interval off the multiple.
- **Phase 13+**: athlete metrics beyond passing yards — `config.game_stats` on the API-Sports row (every per-game figure read from one request per game, each with its own anchor), the rating figure (+1) and `game_interceptions` (−1) registered beside yards with touchdowns and every composite figure refused, and the Signals force folding one source's metric signals of one moment into one reading carrying their mean, so a game is its event and its stat line and never three copies of the line.
- **Phase 28**: the first public page — a signed-out `/` is the landing page (a rewrite inside the auth gate, so a stranger and a member use the same address), built around the founder's own Momentum Score moving on the Engine's 30-second cadence from a read-only public endpoint that names one slug in code and reads no parameter (memoised per tick slot, rate-limited, 503 rather than a stale body); three beats on how it works; the reading behind the number (the day as a line, the five forces over the last hour, the recent signals in plain language — or the honest statement that none has reached the Engine yet); the kill switch built into the client (a failed poll keeps the last number and relabels it "Last known · as of …", never an invented one); a waitlist (`waitlist`, citext-unique, no client access at all, `join_waitlist()` service-role only, honeypot then a per-IP limit held in the database, idempotent and non-enumerating, the position shown being the real row count); `/privacy`; an OG image in the house style; anonymous behavioural events; the waitlist on `/admin`; every word in one file (`lib/landing/copy.ts`) held to the copy rules by a test, with the other fifteen names checked against the seed; the site address from one variable, with a test that fails on a literal vercel.app hostname.
- **Phase 27**: fractional shares and dollar orders — a unit becomes a thousandth of a share, integer everywhere, so nothing in the ledger holds a fraction and the one place a fraction appears is resolved to a whole cent by a rule stated once (a buy rounds up, a sell rounds down, at most a cent, never in the user's favour), mirrored in SQL and TypeScript with a test comparing the two directly over the whole price range; an order can be named as a quantity or as an amount, with Buy opening in Dollars and Sell in Shares, and in Dollars mode no quantity is sent at all so the server resolves it against the quote it reads; "All" is always a quantity, because a dollar figure resolved back into a holding can only land within a unit of it and a Sell that leaves a thousandth behind has not closed the position; a $1.00 floor in money checked against what the user actually chose, so $0.99 is refused both ways and $1.00 exactly is not; a lot carrying `open_cost_cents` so a partial close takes its proportional basis and the last one takes the exact remainder, leaving a closed lot at exactly zero units and zero basis; and the migration shipped in four steps with no window — a scale-aware read path deployed first, the data moved under a lock, the fractional client second, the compatibility path removed once the data says no legacy caller remains.
- **Phase 26**: one price and one card — every tradeable price in dollars and cents through one formatter, with the points formatter deleted rather than left unused, and the pill, the sheet's quote box, its price per share and the recorded fill proved equal to the cent against a real Postgres; the profile score card's change line rebuilt as one statement (both figures a single text run on one baseline, the arrow centred on it, measured across all twelve range × direction combinations); the Buy/Sell and Spread stat rows removed — the spread had been stated twice, at two different values — and the Gravity target moved onto the chart as a labelled reference line with the vertical domain untouched; the trade sheet set in one typeface with its summary values right-aligned; and two layout bugs fixed at the sheet's edges, a title block that scrolled content ran into and a tab bar drawn on top of a modal, which had left the Sell sheet's Review button with none of it visible and a tap at its centre landing on the nav.
- **Phase 25**: Portfolio typography — the page set in one typeface, with `tabular-nums` carrying the fixed-width digits that mono was there for (measured: four different money strings render to the same pixel width at every size on the page); the mid-sentence face changes gone from the return line, the position sub-line and every trade-history row; and the Buy/Sell quote pill extracted into one shared component with its price matched to its label. The value chart, the header and every other page are untouched.
- **Phase 24**: what the first live NFL game taught — a metric now emits when its REGISTER changes rather than when its number does (39 emissions to 7 on the Mahomes window, 2,074 to 220 board-wide, replayed against the stored ledger before shipping), held with 0.25σ of asymmetric hysteresis from the board's own step sizes; a game result dated at the first poll that observed it FINISHED rather than at kickoff, with a config hook for a reported final time and a fallback to kickoff when nothing was watching; the subject's plain-numeric line in the result headline, omitted rather than guessed when a statistic is not where config says; every boundary in the language module decided on the DISPLAYED figure, which closed the 2x/100%, the 100x and the below-pace-fraction collisions in one rule; and `game_passer_rating` renamed `game_rating` and re-floored after the API's own numbers disproved the passer-rating assumption two games running.
- **Phase 23**: search — a per-person `is_discoverable` flag that ships **off** and is switched on for the sixteen by slug in the migration, enforced inside `search_people()` so a person who has not opted in is unreachable through it for any caller and at any limit; name, full name and slug matched partially and forgivingly of case, punctuation and Latin diacritics through two immutable normalisations; ranked and tie-broken in the database on the board's own total order, with the trailing-hour change on the same row so a result and the board cannot disagree; three partial expression indexes (the first `people` has ever had) covering the anchored half and an honest note on the contains half; and the placeholder replaced by two written states, one saying what search is for and one answering what somebody who searched their own name and found nothing is really asking.
- **Phase 22**: YouTube Trending as a signal — the official `videos.list?chart=mostPopular` read once per run and shared by all sixteen (one unit a poll, 48 a day), an APPEARANCE emitted as an event and never the rank as a metric, because a baselined opaque rank cannot be explained to counsel; deduplicated per video per subject as Phase 16 keys a broadcast; two matching routes only (the subject's own channel, or the title naming them in full through the inherited Phase 12+ exclusions) with description-only, channel-name-only, bare-surname and guessed-channel matches refused; no second event on a rank change; sentences under the Phase 21+ rules; 25-minute interval off the multiple of fifteen.
- **Phase 21+**: signal language — σ out of the consumer app entirely, replaced by the counts underneath it ("12 stories on Drake today — 3x their usual pace"), behind a per-metric `publish_observed` gate that is explicit and defaults off, set on six public counts and never on an audience level; register as a deterministic function of magnitude with the variant chosen by a hash of person and day, so a refresh never changes the sentence; multiples above 2x, percentages below, and never a decimal multiple for a reading below pace; a written-out voice per metric for all seventeen; the comparison to self kept by naming the person and "their usual" rather than by guessing pronouns the roster does not store; and the ~1,950 sigma headlines plus the 58 narratives quoting them re-rendered from the payload rather than rewritten in place.
- **Phase 21**: the emission rule — a metric describes a STATE and the event is the state CHANGING, so a reading identical to the one already on the record is recorded as `unchanged` and emits nothing (an identity check at one part in a trillion, a run collapsing to its first because a suppressed repeat is itself on the record, a change and a change back both news, and a first emission after the baseline fills never suppressed); the deadband raised 1.0σ → 2.0σ with its derivation written down, since 1.0σ made "unusual" mean one reading in three; replayed together over the accumulated ledger, 1,930 emissions become 161, and 143 once `comment_volume` — a sum over a CHANGING basket of uploads, emitting on 78.2% of its observations against a baseline describing a basket that no longer exists — becomes observe-only until the connector defines it stably; and the forces panel showing each force's contribution over the last hour rather than one tick of it, because Gravity's 0.005 points a tick and Market Mood's 0.0006 cannot render at two decimals, with no force's weight or behaviour touched.
- **Phase 19+**: Market Mood became a tide rather than a splash — the board's Signals movement read over a trailing 60 minutes (a mean across the ticks in it that moved anyone, so the scale is unchanged and only the frequency moves: non-zero on 99.8% of ticks against 3.5%, and the header figure changes 2.9 times an hour), applied as 1.41 points per hour × the person's own elapsed time exactly as Gravity applies its λ, with the rate DERIVED from the measured 21.27× rise in firing so the force's gross contribution is held where it was (−0.3%; net drift +23.7%, stated not hidden) and a cadence change can no longer re-level the board; the banner's Mood indicator wired to a real reading for the first time; and a displayed 0.00 never coloured again, on the five forces, the signals list, the Feed's evidence and the feed model, plus a "+0.00" that `formatChange` was printing.
- **Phase 19**: Forecast, the crowd layer, capture and display — the Forecast section below the five forces (▲ Rising / ▼ Falling with one of seven reason tags, the split and top reasons once five votes exist, the count alone below that, an invitation with none), `forecast_votes` with the score at vote time, one active vote per user per person with supersede-not-delete history, select-own RLS and no client writes, `cast_forecast_vote()` with a 20-distinct-people-an-hour rate limit and the per-person `forecast_paused` kill switch, `forecast_summary()` returning aggregates only, the Rising / Falling buttons in the Buy / Sell styling, the `cast_forecast` event, the paper balance removed from the mobile header — and the Forecast force at weight 0.00, read by nothing, pinned by two zero-influence tests.
- **Phase 18++**: the volume reference re-derived from measured data before it engages — `referenceSignalsPerDay` 20 → 4, the geometric mean of the roster's own daily rates (the typical-day impact spread falls 14.9× → 3.0×, the ceiling decides six weights rather than fourteen), the bounds examined and kept, fixed chosen over roster-relative with the coupling cost quantified, `ENGINE_VOLUME_REFERENCE` for a re-derivation without a code change, the staleness made visible on /admin (per-person weight, capped state, engaged count, the roster's live geometric mean and the two review triggers), and the Google News epoch-date hole closed in both directions.
- **Phase 18+**: the volume denominator counts events, not artifacts — one rule for both sides of the weight (a signal counts when its rate is set by the world, not by our polling), `UNCOUNTED_SIGNAL_KINDS` shared between `person_signal_volume()` and the Signals force with a test that fails if they diverge, comment digests and the legacy per-comment kind out of both (MrBeast's series 14.86 → 1.71 a day, the only subject moved), the four callers of the shared baseline documented at the function and pinned by an exhaustive-import test, and two findings reported not changed: the weight saturates at its ceiling for fifteen of sixteen at the present reference, and the two-wave engagement (2026-09-25 and 2026-09-26) is one day of weighted movement ranked against unweighted on the movers strip.
- **Phase 18**: two queued scorer-adjacent changes replayed against real data and both declined — the robust baseline spread (3,130 readings reconstructed and reclassified: winsorizing moves one, MAD moves 176 the wrong way on 773 zero-MAD windows; revisit at the per-game athlete metrics in November) and the casual-register lexicon (87 of 87 digests neutral; a casual extension would turn 74 of them positive and change 30 of the 33 news headlines it touches, two of them losing a correct negative). Nothing in the Engine's behaviour changed; the findings, the four callers of the shared baseline and the register boundary are now pinned by tests.
- **Phase 17**: Finnhub for the nine executives, and no stock price in any score — the company's news VOLUME as a count baselined per person and the tracked person's own Form 4 filings as events (matched by name, limited to the decision codes, carrying shares and never a price); the daily close recorded through `config.observe_only`, a runner-level rule that records a reading and gives it no observation, signal, force or history, so there is no trail to unwind and enabling it is one row update; `observe_only_snapshots` for watching it; and the rest of Finnhub's non-price surface reported, not wired.
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

Deliberately not built yet: the profile screen, the Forecast force's influence (the force exists at weight 0.00 and reads nothing; the crowd's votes are captured and displayed only), and the recommendation algorithm (For You). Shorting stays switched off; the risk levers stay inert (the cooldown's rise to 60 s is a policy floor, not a calibration); and both schedules are wired behind flags — the Engine's heartbeat behind `ENGINE_CRON_ENABLED` and the fifteen-minute ingestion behind `INGEST_CRON_ENABLED`, each of which ships unset.
