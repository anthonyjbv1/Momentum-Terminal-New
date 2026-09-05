-- =============================================================================
-- Momentum Terminal — Phase 1 migration 1/4: initial schema
--
-- Conventions
--   * Every monetary amount is stored as INTEGER CENTS in a bigint column.
--     Floating point is never used for money.
--   * Scores (current_score, base_score, revert_target, entry_score, ...) are
--     numeric on a 0–100 scale.
--   * Every table gets a uuid primary key defaulting to gen_random_uuid().
--   * Every foreign key is covered by an index (either a dedicated single-column
--     index or a composite index whose leading column is the foreign key).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users — application profile + wallet for every auth.users row.
-- Rows are created automatically by the on_auth_user_created trigger
-- (see the auth_triggers migration); clients never insert here directly.
-- -----------------------------------------------------------------------------
create table public.users (
  id                   uuid        primary key references auth.users (id) on delete cascade,
  email                text        not null unique,
  username             text        not null unique,
  display_name         text        not null,
  avatar_url           text,
  created_at           timestamptz not null default now(),
  wallet_balance_cents bigint      not null default 0,
  buying_power_cents   bigint      not null default 0,
  is_admin             boolean     not null default false,

  constraint users_username_format          check (username ~ '^[a-z0-9_]{3,30}$'),
  constraint users_wallet_balance_nonneg    check (wallet_balance_cents >= 0),
  constraint users_buying_power_nonneg      check (buying_power_cents >= 0)
);

comment on table  public.users is 'Application profile and wallet for each auth.users row. All balances are integer cents.';
comment on column public.users.wallet_balance_cents is 'Total wallet balance in integer cents.';
comment on column public.users.buying_power_cents   is 'Cents available to allocate to new positions.';

-- -----------------------------------------------------------------------------
-- people — each tracked individual. The core entity of the platform.
-- -----------------------------------------------------------------------------
create table public.people (
  id                   uuid        primary key default gen_random_uuid(),
  slug                 text        not null unique,
  display_name         text        not null,
  full_name            text,
  bio                  text,
  avatar_url           text,
  category             text        not null,
  current_score        numeric     not null default 50.0,
  base_score           numeric     not null default 50.0,
  revert_target        numeric     not null default 50.0,
  max_allocation_cents bigint      not null default 9000000,
  spread               numeric     not null default 0.5,
  partnership_status   text        not null default 'unverified',
  consent_tier         integer     not null default 0,
  is_active            boolean     not null default true,
  created_at           timestamptz not null default now(),

  constraint people_slug_format               check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint people_category_check            check (category in ('creator', 'musician', 'athlete', 'executive', 'founder')),
  constraint people_partnership_status_check  check (partnership_status in ('unverified', 'pending', 'partner')),
  constraint people_consent_tier_nonneg       check (consent_tier >= 0),
  constraint people_current_score_range       check (current_score between 0 and 100),
  constraint people_base_score_range          check (base_score between 0 and 100),
  constraint people_revert_target_range       check (revert_target between 0 and 100),
  constraint people_max_allocation_positive   check (max_allocation_cents > 0),
  constraint people_spread_nonneg             check (spread >= 0)
);

comment on table  public.people is 'Each tracked individual. Users take HIGH/LOW positions on a person''s Momentum Score.';
comment on column public.people.slug                 is 'URL-safe unique identifier, e.g. ''drake'', ''mrbeast''.';
comment on column public.people.category             is 'One of: creator, musician, athlete, executive, founder.';
comment on column public.people.current_score        is 'Live Momentum Score (0–100).';
comment on column public.people.base_score           is 'Baseline score the Engine starts from (0–100).';
comment on column public.people.revert_target        is 'Equilibrium score the Engine mean-reverts toward (0–100).';
comment on column public.people.max_allocation_cents is 'Maximum total open allocation allowed on this person, in cents.';
comment on column public.people.spread               is 'Bid/ask spread applied when opening positions.';
comment on column public.people.partnership_status   is 'One of: unverified, pending, partner.';
comment on column public.people.consent_tier         is 'Data consent tier granted by the person. 0 = public data only.';

-- -----------------------------------------------------------------------------
-- data_sources — pluggable registry of external data feeds.
-- Sources are added/activated by inserting rows, not by changing code.
-- -----------------------------------------------------------------------------
create table public.data_sources (
  id                    uuid        primary key default gen_random_uuid(),
  name                  text        not null unique,
  display_name          text        not null,
  tier                  integer     not null,
  poll_interval_minutes integer     not null,
  is_active             boolean     not null default false,
  config                jsonb,
  created_at            timestamptz not null default now(),

  constraint data_sources_tier_range             check (tier between 1 and 5),
  constraint data_sources_poll_interval_positive check (poll_interval_minutes > 0)
);

comment on table  public.data_sources is 'Registry of pluggable external data sources feeding the Engine.';
comment on column public.data_sources.name   is 'Machine name, e.g. ''youtube'', ''forbes'', ''spotify''.';
comment on column public.data_sources.tier   is 'Credibility tier, 1 (most credible) to 5.';
comment on column public.data_sources.config is 'Source-specific configuration (endpoints, params). Never store secrets here.';

-- -----------------------------------------------------------------------------
-- person_data_sources — which sources feed which person.
-- -----------------------------------------------------------------------------
create table public.person_data_sources (
  id                  uuid    primary key default gen_random_uuid(),
  person_id           uuid    not null references public.people (id) on delete cascade,
  data_source_id      uuid    not null references public.data_sources (id) on delete cascade,
  external_identifier text    not null,
  is_active           boolean not null default true,

  constraint person_data_sources_person_source_unique unique (person_id, data_source_id)
);

-- person_id is the leading column of the unique constraint above, so it is already indexed.
create index person_data_sources_data_source_id_idx on public.person_data_sources (data_source_id);

comment on table  public.person_data_sources is 'Maps a person to a data source plus the identifier used at that source.';
comment on column public.person_data_sources.external_identifier is 'Identifier at the source, e.g. a YouTube channel ID or Spotify artist ID.';

-- -----------------------------------------------------------------------------
-- inverse_pairs — people whose scores move against each other.
-- -----------------------------------------------------------------------------
create table public.inverse_pairs (
  id          uuid    primary key default gen_random_uuid(),
  person_a_id uuid    not null references public.people (id) on delete cascade,
  person_b_id uuid    not null references public.people (id) on delete cascade,
  dampening   numeric not null default 0.40,

  constraint inverse_pairs_pair_unique       unique (person_a_id, person_b_id),
  constraint inverse_pairs_distinct_people   check (person_a_id <> person_b_id),
  constraint inverse_pairs_dampening_range   check (dampening between 0 and 1)
);

-- person_a_id is the leading column of the unique constraint above, so it is already indexed.
create index inverse_pairs_person_b_id_idx on public.inverse_pairs (person_b_id);

-- A pair is unordered: (a, b) and (b, a) must not both exist.
create unique index inverse_pairs_unordered_unique_idx
  on public.inverse_pairs (least(person_a_id, person_b_id), greatest(person_a_id, person_b_id));

comment on table  public.inverse_pairs is 'Unordered pairs of people whose score movements are inversely linked.';
comment on column public.inverse_pairs.dampening is 'Fraction (0–1) of one person''s move that is applied inversely to the other.';

-- -----------------------------------------------------------------------------
-- positions — a user's HIGH or LOW position on a person.
-- -----------------------------------------------------------------------------
create table public.positions (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references public.users (id) on delete cascade,
  person_id        uuid        not null references public.people (id) on delete restrict,
  direction        text        not null,
  amount_cents     bigint      not null,
  shares           numeric     not null,
  cost_basis_cents bigint      not null,
  entry_score      numeric     not null,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  is_open          boolean     not null default true,

  constraint positions_direction_check        check (direction in ('HIGH', 'LOW')),
  constraint positions_amount_positive        check (amount_cents > 0),
  constraint positions_shares_positive        check (shares > 0),
  constraint positions_cost_basis_nonneg      check (cost_basis_cents >= 0),
  constraint positions_open_state_consistent  check ((is_open and closed_at is null) or (not is_open and closed_at is not null))
);

create index positions_user_id_idx   on public.positions (user_id);
create index positions_person_id_idx on public.positions (person_id);

comment on table  public.positions is 'A user''s open or closed HIGH/LOW position on a person. Amounts are integer cents.';
comment on column public.positions.direction is 'HIGH = profits when the score rises. LOW = profits when it falls.';

-- -----------------------------------------------------------------------------
-- transactions — wallet ledger.
-- -----------------------------------------------------------------------------
create table public.transactions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.users (id) on delete cascade,
  type         text        not null,
  amount_cents bigint      not null,
  person_id    uuid        references public.people (id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint transactions_type_check       check (type in ('DEPOSIT', 'ALLOCATION', 'REDEMPTION', 'WITHDRAWAL')),
  constraint transactions_amount_positive  check (amount_cents > 0)
);

create index transactions_user_id_idx   on public.transactions (user_id);
create index transactions_person_id_idx on public.transactions (person_id);

comment on table  public.transactions is 'Wallet ledger. amount_cents is always positive; type carries the direction.';

-- -----------------------------------------------------------------------------
-- signals — incoming data points, before and after Engine processing.
-- -----------------------------------------------------------------------------
create table public.signals (
  id                   uuid        primary key default gen_random_uuid(),
  person_id            uuid        not null references public.people (id) on delete cascade,
  data_source_id       uuid        not null references public.data_sources (id) on delete restrict,
  headline             text        not null,
  raw_payload          jsonb,
  sentiment_label      text,
  sentiment_confidence numeric,
  impact_score         numeric,
  processed            boolean     not null default false,
  created_at           timestamptz not null default now(),
  processed_at         timestamptz,

  constraint signals_sentiment_label_check      check (sentiment_label is null or sentiment_label in ('positive', 'negative', 'neutral')),
  constraint signals_sentiment_confidence_range check (sentiment_confidence is null or sentiment_confidence between 0 and 1)
);

-- person_id is the leading column of the composite index below, so it is already indexed.
create index signals_data_source_id_idx            on public.signals (data_source_id);
create index signals_person_processed_created_idx  on public.signals (person_id, processed, created_at);

comment on table  public.signals is 'Raw data points ingested from data sources; enriched in place by the Engine.';
comment on column public.signals.sentiment_label is 'One of: positive, negative, neutral (null until processed).';

-- -----------------------------------------------------------------------------
-- score_history — time series of each person's score.
-- -----------------------------------------------------------------------------
create table public.score_history (
  id          uuid        primary key default gen_random_uuid(),
  person_id   uuid        not null references public.people (id) on delete cascade,
  score       numeric     not null,
  tick_number bigint      not null,
  recorded_at timestamptz not null default now()
);

-- person_id is the leading column of this composite index, so it is already indexed.
create index score_history_person_recorded_idx on public.score_history (person_id, recorded_at);

comment on table public.score_history is 'Append-only history of Momentum Scores per Engine tick.';

-- -----------------------------------------------------------------------------
-- portfolio_history — time series of each user's total portfolio value.
-- -----------------------------------------------------------------------------
create table public.portfolio_history (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references public.users (id) on delete cascade,
  total_value_cents bigint      not null,
  recorded_at       timestamptz not null default now()
);

-- user_id is the leading column of this composite index, so it is already indexed.
create index portfolio_history_user_recorded_idx on public.portfolio_history (user_id, recorded_at);

comment on table public.portfolio_history is 'Append-only snapshots of total portfolio value in integer cents.';

-- -----------------------------------------------------------------------------
-- behavioral_events — foundation for the future recommendation algorithm.
-- -----------------------------------------------------------------------------
create table public.behavioral_events (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.users (id) on delete cascade,
  event_type text        not null,
  person_id  uuid        references public.people (id) on delete set null,
  metadata   jsonb,
  created_at timestamptz not null default now()
);

-- user_id is the leading column of the composite index below, so it is already indexed.
create index behavioral_events_person_id_idx    on public.behavioral_events (person_id);
create index behavioral_events_user_created_idx on public.behavioral_events (user_id, created_at);

comment on table  public.behavioral_events is 'User interaction events used by the future recommendation algorithm.';
comment on column public.behavioral_events.event_type is 'Known values: view_person, expand_signal, take_position, time_spent, follow. Intentionally unconstrained so new event types need no migration.';
