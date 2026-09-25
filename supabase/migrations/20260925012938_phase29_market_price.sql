-- Phase 29 — THE MARKET PRICE: two numbers, and the framework around them.
--
-- Until now the price you traded at WAS the score: Buy = score + spread,
-- Sell = score − spread, and two of the five forces that moved the score
-- (Conviction, Trading Activity) read participant activity. That is one number
-- doing two jobs, and the jobs pull against each other: an index has to be
-- indifferent to who is betting on it, and a price has to answer to demand.
--
-- From here there are TWO numbers, and the schema keeps them apart:
--
--   THE MOMENTUM SCORE   the index. Gravity, Signals, Market Mood, inverse
--                        pairs. Written by the Engine tick and by nothing
--                        else. Nothing in this file writes current_score, and
--                        nothing derived from an order ever reaches it — the
--                        Engine's two participant-derived forces contribute
--                        zero to the score from this phase (lib/engine/tick.ts).
--
--   THE MARKET PRICE     score + PREMIUM. The premium is the crowd's net
--                        position against the platform, expressed in points,
--                        and it moves with trading along a published cost
--                        curve and decays toward zero every tick. It lives on
--                        the people row beside the score, and the Buy / Sell
--                        quotes every reader already uses are regenerated on
--                        top of it, so a position is marked to the market
--                        price without any reader changing.
--
-- THE PLATFORM IS THE SOLE COUNTERPARTY. There is no order book, no matching
-- and no peer. Every fill is against the platform's dealer, whose state per
-- person is one signed integer:
--
--   market_inventory_units   I   net units the crowd has bought from the
--                                dealer, in thousandths of a share (Phase 27
--                                units), after decay. Positive: the crowd is
--                                net long; negative: net short (shorting is
--                                still gated off; the arithmetic is symmetric).
--   premium_cents            P   trunc(I × 100 / D): the premium in cents per
--                                share, D being the tier's DEPTH in units per
--                                point. Derived, stored beside I so the
--                                generated price columns can read it.
--
-- THE COST CURVE. The marginal price at inventory x is S + 100·x/D cents per
-- share, S being the side's base price (score ± half-spread, in whole cents,
-- premium excluded). An order of u units walks the curve, so
--
--   buy cost        = ceil ( u·S_buy /1000 + u·(2I + u) / (20·D) )
--   sell proceeds   = floor( u·S_sell/1000 + u·(2I − u) / (20·D) )
--
-- where the second term is the exact integral of the premium along the walk:
-- the crowd's existing premium (2Iu) plus this order's own IMPACT (u²), over
-- 20·D. Both are RATIONAL numbers with no finite decimal expansion for a
-- general depth, so every function below evaluates them as one integer
-- fraction (numerator over 20000·D) and rounds ONCE, in integer arithmetic,
-- in the platform's favour — Phase 27's rule, unchanged: a buy rounds up, a
-- sell rounds down, at most a cent, never toward the user. No float is
-- involved anywhere, and the CHECK constraints below recompute the same
-- fraction from the integer inputs stored on every row, so they are EXACT
-- identities, not bounds.
--
-- WHY THE PREMIUM IS KEPT OUT OF S. If the rounded premium entered the side
-- price, a buy-then-sell at unchanged state would leak a cent at the
-- rounding seam. Keeping the premium as the exact rational term makes a
-- round trip cost exactly the spread plus the impact, and nothing else.
--
-- DECAY. Every tick, for every person with I ≠ 0:
--   I ← I − sign(I) · ceil(|I| / K),   K = round(half_life_ticks / ln 2)
-- Integer, symmetric, and it reaches EXACTLY zero: once |I| < K the step is
-- one unit a tick. Every step writes a premium_history row, as does every
-- trade, so the market price at any instant is reproducible from
-- score_history, trade_orders and the published parameters — and the
-- reproducibility test recomputes a day of it to the cent.
--
-- DEPLOY INVARIANCE. Every person starts at I = 0, P = 0, so the regenerated
-- Buy / Sell columns hold the values they held a moment before, and every
-- portfolio value is identical to the cent across this migration. The report
-- shows the reconciliation.
--
-- WHAT THIS FILE DOES NOT TOUCH: the score, its history, the forces' weights,
-- the spread, Phase 27's rounding functions, the founder's landing page.
--
-- (The text Supabase recorded carries the provisional 20260925000000 name on
-- the line above; apply_migration assigns the version, so the file could only
-- be named after it once it had run. Nothing executable differs.)

-- ---------------------------------------------------------------------------
-- 0. The locks, up front, with a finite timeout (as Phase 27)
-- ---------------------------------------------------------------------------
-- The Engine ticks every 30 s and reads and writes people; apply_engine_tick()
-- marks every portfolio through the generated price columns this file
-- rebuilds. Everything commits or nothing does, and a lock this cannot take in
-- five seconds aborts here with the schema exactly as it was.
set local lock_timeout = '5s';
lock table public.people, public.positions, public.position_closes, public.trade_orders, public.platform_settings, public.users
  in access exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. Tier parameters — settings, not code
-- ---------------------------------------------------------------------------
-- Two tiers. A PUBLIC FIGURE has a deep, forgiving market; a PRIVATE
-- INDIVIDUAL has a shallow one with tighter caps, a longer minimum hold, a
-- second (total-price) breaker, an alert on every halt and no shorting without
-- an explicit per-person override. Every number here is a lever: change it
-- with the service role and the next order reads it. The depth will be
-- recalibrated to real beta volume.
create table public.market_tier_settings (
  tier                          text        primary key,
  -- Units of inventory per point of premium. 300,000 units = 300 shares move
  -- the price one point. NULL IS THE OFF SWITCH: a flat market for the tier —
  -- no premium, no inventory, Phase 27 pricing exactly — with no deploy.
  depth_units                   bigint,
  -- Ticks for the premium to halve with no trading. 480 ticks = 4 hours at 30 s.
  decay_half_life_ticks         integer     not null,
  -- |premium| may not exceed this, either direction, in cents per share.
  premium_cap_cents             bigint      not null,
  -- A lot may not be closed before this many seconds (extends close_cooldown_seconds).
  min_hold_seconds              integer     not null,
  -- The largest single order, as a fraction of depth_units.
  max_order_share_of_depth      numeric     not null,
  -- The platform's net holdings on the person (HIGH − LOW open units) may not exceed this.
  aggregate_exposure_cap_units  bigint      not null,
  -- CIRCUIT BREAKER on the premium: this many cents of premium move inside the window halts trading for halt_seconds.
  breaker_premium_cents         bigint      not null,
  breaker_window_seconds        integer     not null,
  breaker_halt_seconds          integer     not null,
  -- The looser TOTAL-PRICE breaker (score + premium), private individuals only. Null: off.
  breaker_price_cents           bigint,
  -- May this tier be shorted at all when platform_settings.shorting_enabled is on? A per-person override on people can still say otherwise.
  shorting_allowed              boolean     not null,
  -- Does a halt raise an admin alert?
  alert_on_halt                 boolean     not null,
  updated_at                    timestamptz not null default now(),

  constraint market_tier_settings_tier_check      check (tier in ('public_figure', 'private_individual')),
  constraint market_tier_settings_depth_positive  check (depth_units is null or depth_units > 0),
  constraint market_tier_settings_half_life_pos   check (decay_half_life_ticks > 0),
  constraint market_tier_settings_cap_positive    check (premium_cap_cents > 0),
  constraint market_tier_settings_hold_nonneg     check (min_hold_seconds >= 0),
  constraint market_tier_settings_order_share     check (max_order_share_of_depth > 0 and max_order_share_of_depth <= 1),
  constraint market_tier_settings_exposure_pos    check (aggregate_exposure_cap_units > 0),
  constraint market_tier_settings_breaker_pos     check (breaker_premium_cents > 0 and breaker_window_seconds > 0 and breaker_halt_seconds > 0),
  constraint market_tier_settings_price_breaker   check (breaker_price_cents is null or breaker_price_cents > 0)
);

comment on table public.market_tier_settings is
  'Phase 29: the market price''s parameters per subject tier. Depth (units per point of premium; NULL turns the premium off for the tier: a flat market at Phase 27 prices), decay half-life (ticks), premium cap, minimum hold, largest order as a share of depth, the platform''s aggregate exposure cap, the premium breaker (X cents in Y seconds halts Z seconds), the total-price breaker (private individuals only), whether the tier may ever be shorted, and whether a halt alerts. Service-role writes only; every value is read at order time.';

-- THE DEFAULTS, conservative, and consistent with each other: the premium cap
-- is what binds first (an economic limit on the price), and the aggregate
-- exposure cap sits ABOVE the inventory the cap allows (2,400 / 300 shares)
-- as a backstop on the platform's book. The exposure cap counts HOLDINGS
-- while decay erases INVENTORY, so a popular person's holdings can reach it
-- at zero premium; it must become per-person scalable or loss-based before a
-- real user base arrives (recorded in the design notes).
insert into public.market_tier_settings
  (tier, depth_units, decay_half_life_ticks, premium_cap_cents, min_hold_seconds, max_order_share_of_depth, aggregate_exposure_cap_units,
   breaker_premium_cents, breaker_window_seconds, breaker_halt_seconds, breaker_price_cents, shorting_allowed, alert_on_halt)
values
  ('public_figure',       300000, 480, 800,   600, 0.20, 3000000, 300, 600, 1800, null, true,  false),
  ('private_individual',  100000, 240, 300, 86400, 0.10,  400000, 150, 600, 3600,  500, false, true);

alter table public.market_tier_settings enable row level security;
create policy market_tier_settings_select_authenticated on public.market_tier_settings for select to authenticated using (true);
grant select on public.market_tier_settings to authenticated;
grant all    on public.market_tier_settings to service_role;
revoke insert, update, delete on public.market_tier_settings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The person's market state, tier and trading mode
-- ---------------------------------------------------------------------------
alter table public.people
  add column tier                           text        not null default 'public_figure',
  add column trading_mode                   text        not null default 'tradeable',
  add column market_inventory_units         bigint      not null default 0,
  add column premium_cents                  bigint      not null default 0,
  add column depth_units_override           bigint,
  add column decay_half_life_ticks_override integer,
  add column premium_cap_cents_override     bigint,
  add column shorting_override              boolean,
  add column halted_until                   timestamptz,
  add column halt_reason                    text;

alter table public.people
  add constraint people_tier_check          check (tier in ('public_figure', 'private_individual')),
  add constraint people_trading_mode_check  check (trading_mode in ('tradeable', 'display_only', 'paused')),
  add constraint people_depth_override_pos  check (depth_units_override is null or depth_units_override > 0),
  add constraint people_half_life_override  check (decay_half_life_ticks_override is null or decay_half_life_ticks_override > 0),
  add constraint people_cap_override_pos    check (premium_cap_cents_override is null or premium_cap_cents_override > 0);

-- THE PRICES, REGENERATED. Buy / Sell were score ± spread; they are now
-- score + premium ± spread, and market_price is score + premium. premium_cents
-- × 0.01 is an exact two-decimal numeric, so with premium 0 these columns hold
-- exactly the values they held before (the deploy-invariance test says so).
alter table public.people
  drop column buy_price,
  drop column sell_price,
  add column buy_price    numeric generated always as (current_score + premium_cents * 0.01 + spread) stored,
  add column sell_price   numeric generated always as (current_score + premium_cents * 0.01 - spread) stored,
  add column market_price numeric generated always as (current_score + premium_cents * 0.01) stored;

comment on column public.people.tier                   is 'Phase 29: public_figure | private_individual. Selects the row of market_tier_settings the market price runs on.';
comment on column public.people.trading_mode           is 'Phase 29: tradeable | display_only (score shown, new positions refused, closes allowed) | paused (every order refused).';
comment on column public.people.market_inventory_units is 'Phase 29: THE DEALER''S STATE. Net units the crowd has bought from the platform (thousandths of a share), after decay. Positive: crowd net long. The one canonical input to the premium.';
comment on column public.people.premium_cents          is 'Phase 29: trunc(market_inventory_units × 100 / depth_units): the premium in cents per share. Derived from the inventory and stored so the generated price columns can read it. Starts at 0 for everyone.';
comment on column public.people.depth_units_override   is 'Phase 29: per-person depth (units per point), overriding the tier''s. Null: the tier''s.';
comment on column public.people.decay_half_life_ticks_override is 'Phase 29: per-person decay half-life in ticks, overriding the tier''s. Null: the tier''s.';
comment on column public.people.premium_cap_cents_override     is 'Phase 29: per-person premium cap in cents, overriding the tier''s. Null: the tier''s.';
comment on column public.people.shorting_override      is 'Phase 29: per-person shorting permission overriding the tier''s shorting_allowed. Null: the tier decides. Always ANDed with platform_settings.shorting_enabled.';
comment on column public.people.halted_until           is 'Phase 29: while in the future, every order on the person is refused (circuit breaker or an admin halt).';
comment on column public.people.halt_reason            is 'Phase 29: why halted_until was set, in plain language, shown on the profile and the trade sheet.';
comment on column public.people.buy_price              is 'Buy quote = current_score + premium + spread (generated). The market price''s Buy side.';
comment on column public.people.sell_price             is 'Sell quote = current_score + premium − spread (generated). The market price''s Sell side; a HIGH position is marked here.';
comment on column public.people.market_price           is 'Phase 29: current_score + premium (generated). The number the profile shows beside the Momentum Score.';

-- THE FOUNDER is a private individual and display-only: his score is shown,
-- nobody can open a position on him, and anyone who already holds one can
-- close it. The other fifteen are public figures (the column default).
update public.people
   set tier = 'private_individual', trading_mode = 'display_only'
 where slug = 'anthony-baptiste';

create index people_halted_until_idx on public.people (halted_until) where halted_until is not null;

-- ---------------------------------------------------------------------------
-- 3. premium_history and the house ledger
-- ---------------------------------------------------------------------------
-- One row per CHANGE of a person's inventory: every trade, every decay step,
-- every reset. With score_history this is what makes the market price at any
-- instant reproducible. Retention: appended to the existing retention item;
-- no prune in this phase.
create table public.premium_history (
  id                      bigint      generated always as identity primary key,
  person_id               uuid        not null references public.people (id) on delete cascade,
  recorded_at             timestamptz not null,
  tick_number             bigint,
  order_id                uuid,
  cause                   text        not null,
  inventory_before_units  bigint      not null,
  inventory_after_units   bigint      not null,
  premium_before_cents    bigint      not null,
  premium_after_cents     bigint      not null,
  -- Null only on a reset row: the tier's depth was switched off and the
  -- inventory was returned to zero.
  depth_units             bigint,
  -- The score at that instant, so market price = score + premium_after from this row alone.
  score                   numeric     not null,

  constraint premium_history_cause_check   check (cause in ('trade', 'decay', 'reset')),
  constraint premium_history_depth_pos     check (depth_units is null or depth_units > 0),
  constraint premium_history_premium_is_derived check (
    (cause = 'reset' and inventory_after_units = 0 and premium_after_cents = 0)
    or (depth_units is not null
        and premium_after_cents = (inventory_after_units * 100) / depth_units
        and premium_before_cents = (inventory_before_units * 100) / depth_units)
  )
);

create index premium_history_person_recorded_idx on public.premium_history (person_id, recorded_at desc, id desc);
create index premium_history_order_idx           on public.premium_history (order_id) where order_id is not null;

comment on table public.premium_history is
  'Phase 29: every change of a person''s dealer inventory and premium — trade, decay step or reset — with the depth in force and the score at that instant. With score_history and trade_orders this reproduces every market price ever quoted. Appended to the retention item; no prune this phase.';

alter table public.premium_history enable row level security;
create policy premium_history_select_authenticated on public.premium_history for select to authenticated using (true);
grant select on public.premium_history to authenticated;
grant all    on public.premium_history to service_role;
revoke insert, update, delete on public.premium_history from anon, authenticated;

-- THE HOUSE BOOK. The platform is the counterparty, so every cent a user
-- realises is a cent the platform gave up, and vice versa. At each close the
-- user's P&L is decomposed into three integer categories that sum EXACTLY to
-- minus the P&L:
--   score_move          the index moved between entry and exit
--   premium_change      the premium moved between entry and exit
--   spread_and_impact   the two half-spreads, the two impact terms, and the
--                       rounding cents (the residual, so the identity is exact)
-- and at each decay step a fourth, decay_mark, records how the decay moved
-- the mark of everything held on the person. Positive means the house gained.
create table public.house_ledger (
  id            bigint      generated always as identity primary key,
  recorded_at   timestamptz not null,
  person_id     uuid        not null references public.people (id) on delete restrict,
  user_id       uuid        references public.users (id) on delete set null,
  order_id      uuid,
  close_id      uuid,
  tick_number   bigint,
  category      text        not null,
  amount_cents  bigint      not null,
  details       jsonb       not null default '{}'::jsonb,

  constraint house_ledger_category_check check (category in ('score_move', 'premium_change', 'spread_and_impact', 'decay_mark'))
);

create index house_ledger_person_recorded_idx on public.house_ledger (person_id, recorded_at desc, id desc);
create index house_ledger_close_idx           on public.house_ledger (close_id) where close_id is not null;
create index house_ledger_order_idx           on public.house_ledger (order_id) where order_id is not null;

comment on table public.house_ledger is
  'Phase 29: the platform''s side of every realised close (score_move + premium_change + spread_and_impact = −pnl_cents, exactly) and of every decay step (decay_mark: the change in the marked value of everything held on the person). Integer cents; positive is a house gain. Service role only.';

alter table public.house_ledger enable row level security;
grant all on public.house_ledger to service_role;
revoke all on public.house_ledger from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Accounts: freeze, the identity hook, excluded parties
-- ---------------------------------------------------------------------------
alter table public.users
  add column frozen_at             timestamptz,
  add column frozen_reason         text,
  -- THE IDENTITY HOOK. One field, one enforcement point, no vendor: when a
  -- verification provider is chosen it writes a stable key here, the unique
  -- index below is what makes one person one account, and
  -- platform_settings.require_verified_identity is the switch that makes
  -- place_order() insist on it.
  add column verified_identity_key text,
  add column identity_verified_at  timestamptz,
  -- Referral hook for the referral-spike detector. Nothing sets it yet.
  add column referred_by           uuid references public.users (id) on delete set null;

create unique index users_verified_identity_key_uidx on public.users (verified_identity_key) where verified_identity_key is not null;
create index users_referred_by_idx on public.users (referred_by) where referred_by is not null;

comment on column public.users.frozen_at             is 'Phase 29: while set, every order from the account is refused. Set and cleared through the admin RPCs, which audit-log it.';
comment on column public.users.verified_identity_key is 'Phase 29 identity hook: a stable key from an identity verification, unique across accounts (one person, one account). Null until a provider is wired. Never a document number.';
comment on column public.users.referred_by           is 'Phase 29: who referred this account, for the referral-spike detector. Nothing sets it yet.';

-- EXCLUDED PARTIES: accounts that may not trade a market (or any market): the
-- subject, their staff, the platform's own people. Enforced in place_order().
create table public.excluded_parties (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.users (id) on delete cascade,
  -- Null: excluded from every market.
  person_id    uuid        references public.people (id) on delete cascade,
  reason       text        not null,
  added_by     uuid        references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid        references public.users (id) on delete set null,
  removal_note text
);

create index excluded_parties_user_idx on public.excluded_parties (user_id) where removed_at is null;

comment on table public.excluded_parties is
  'Phase 29: accounts that may not trade one market (person_id) or any (null). Read by place_order() on every order. Added and removed through the admin RPCs, which audit-log it.';

alter table public.excluded_parties enable row level security;
grant all on public.excluded_parties to service_role;
revoke all on public.excluded_parties from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Surveillance: events, alerts, the immutable audit log
-- ---------------------------------------------------------------------------
create table public.alerts (
  id              uuid        primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  type            text        not null,
  severity        text        not null,
  person_id       uuid        references public.people (id) on delete set null,
  user_ids        uuid[]      not null default '{}',
  evidence        jsonb       not null default '{}'::jsonb,
  status          text        not null default 'open',
  resolved_at     timestamptz,
  resolved_by     uuid        references public.users (id) on delete set null,
  resolution_note text,

  constraint alerts_severity_check check (severity in ('low', 'medium', 'high', 'critical')),
  constraint alerts_status_check   check (status in ('open', 'reviewing', 'resolved', 'dismissed'))
);

create index alerts_open_idx    on public.alerts (created_at desc) where status in ('open', 'reviewing');
create index alerts_person_idx  on public.alerts (person_id, created_at desc);

comment on table public.alerts is
  'Phase 29: the admin review queue. One row per detector finding or breaker halt worth a human look: type, severity, the person, the accounts, the evidence (salted hashes and counts, never raw addresses), and its status. Service role only; acted on through the admin RPCs.';

create table public.surveillance_events (
  id          bigint      generated always as identity primary key,
  recorded_at timestamptz not null default now(),
  detector    text        not null,
  severity    text        not null,
  person_id   uuid        references public.people (id) on delete cascade,
  user_ids    uuid[]      not null default '{}',
  evidence    jsonb       not null default '{}'::jsonb,
  alert_id    uuid        references public.alerts (id) on delete set null,

  constraint surveillance_events_severity_check check (severity in ('info', 'low', 'medium', 'high'))
);

create index surveillance_events_recorded_idx on public.surveillance_events (recorded_at desc, id desc);
create index surveillance_events_person_idx   on public.surveillance_events (person_id, recorded_at desc);

comment on table public.surveillance_events is
  'Phase 29: the surveillance stream — every detector reading, whether or not it reached the alert threshold, plus every halt. Evidence carries counts and salted fingerprint hashes only. Service role only.';

-- THE AUDIT LOG IS APPEND-ONLY. Rows can be inserted and read; an update or a
-- delete is refused by a trigger whatever role attempts it, the service role
-- included. There is no override.
create table public.admin_audit_log (
  id               bigint      generated always as identity primary key,
  performed_at     timestamptz not null default now(),
  actor_id         uuid        not null references public.users (id) on delete restrict,
  action           text        not null,
  alert_id         uuid        references public.alerts (id) on delete set null,
  target_user_id   uuid        references public.users (id) on delete set null,
  target_person_id uuid        references public.people (id) on delete set null,
  note             text,
  details          jsonb       not null default '{}'::jsonb,

  constraint admin_audit_log_action_check check (action in (
    'freeze_account', 'unfreeze_account', 'halt_person', 'lift_halt', 'set_trading_mode',
    'add_excluded_party', 'remove_excluded_party', 'resolve_alert', 'reopen_alert'
  ))
);

create index admin_audit_log_performed_idx on public.admin_audit_log (performed_at desc, id desc);

create or replace function public.admin_audit_log_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'admin_audit_log is append-only: rows are never updated or deleted' using errcode = '0A000';
end;
$$;

create trigger admin_audit_log_immutable
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_is_immutable();

comment on table public.admin_audit_log is
  'Phase 29: every admin action on the review queue (freeze, halt, trading mode, excluded party, resolution), by whom, when, on what, with a note. APPEND-ONLY: a trigger refuses update and delete for every role.';

alter table public.alerts              enable row level security;
alter table public.surveillance_events enable row level security;
alter table public.admin_audit_log     enable row level security;
grant all on public.alerts, public.surveillance_events, public.admin_audit_log to service_role;
revoke all on public.alerts, public.surveillance_events, public.admin_audit_log from anon, authenticated;
revoke execute on function public.admin_audit_log_is_immutable() from public, anon, authenticated;

-- Thresholds, beside the other levers.
alter table public.platform_settings
  add column surveillance_window_seconds      integer not null default 600,
  add column clustered_buying_min_accounts    integer not null default 4,
  add column new_account_age_hours            integer not null default 24,
  add column new_account_burst_min_accounts   integer not null default 3,
  add column shared_infra_min_accounts        integer not null default 2,
  add column wash_window_seconds              integer not null default 3600,
  add column wash_min_round_trips             integer not null default 3,
  add column referral_spike_min_accounts      integer not null default 5,
  add column fingerprint_retention_days       integer not null default 30,
  add column require_verified_identity        boolean not null default false;

alter table public.platform_settings
  add constraint platform_settings_surveillance_positive check (
    surveillance_window_seconds > 0 and clustered_buying_min_accounts > 1 and new_account_age_hours > 0
    and new_account_burst_min_accounts > 1 and shared_infra_min_accounts > 1 and wash_window_seconds > 0
    and wash_min_round_trips > 0 and referral_spike_min_accounts > 1 and fingerprint_retention_days > 0
  );

comment on column public.platform_settings.surveillance_window_seconds    is 'Phase 29: the trailing window the clustered-buying, new-account-burst, shared-infrastructure and referral-spike detectors read.';
comment on column public.platform_settings.clustered_buying_min_accounts  is 'Phase 29: distinct accounts buying one person inside the window at or above which an alert is raised.';
comment on column public.platform_settings.new_account_age_hours          is 'Phase 29: an account younger than this counts as new for the new-account-burst detector.';
comment on column public.platform_settings.new_account_burst_min_accounts is 'Phase 29: new accounts trading one person inside the window at or above which an alert is raised.';
comment on column public.platform_settings.shared_infra_min_accounts      is 'Phase 29: distinct accounts sharing one salted fingerprint hash inside the window at or above which an alert is raised.';
comment on column public.platform_settings.wash_window_seconds            is 'Phase 29: the window the wash / round-trip detector reads for one account on one person.';
comment on column public.platform_settings.wash_min_round_trips           is 'Phase 29: buy-and-sell round trips by one account on one person inside the window at or above which an alert is raised.';
comment on column public.platform_settings.referral_spike_min_accounts    is 'Phase 29: accounts sharing one referrer created inside the window at or above which an alert is raised.';
comment on column public.platform_settings.fingerprint_retention_days     is 'Phase 29: how long trade_orders.fingerprint_hash is kept (documented retention; the prune is a later item).';
comment on column public.platform_settings.require_verified_identity      is 'Phase 29 identity hook: when true, place_order() refuses accounts without identity_verified_at.';

-- ---------------------------------------------------------------------------
-- 6. The arithmetic, in integers
-- ---------------------------------------------------------------------------

-- The premium from the inventory: trunc toward zero, which is what bigint
-- division does.
create or replace function public.market_premium_cents(p_inventory_units bigint, p_depth_units bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$ select (coalesce(p_inventory_units, 0) * 100) / p_depth_units $$;

-- K = round(half_life / ln 2): the divisor of the per-tick decay step.
-- ln over numeric, rounded once to an integer; deterministic.
create or replace function public.market_decay_divisor(p_half_life_ticks integer)
returns bigint
language sql
immutable
set search_path = ''
as $$ select greatest(1, round(p_half_life_ticks::numeric / ln(2::numeric)))::bigint $$;

-- One decay step: I − sign(I)·ceil(|I|/K). Symmetric; reaches exactly 0.
create or replace function public.market_decay_step(p_inventory_units bigint, p_divisor bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
           when coalesce(p_inventory_units, 0) = 0 then 0::bigint
           when p_inventory_units > 0 then p_inventory_units - (p_inventory_units + p_divisor - 1) / p_divisor
           else p_inventory_units + (-p_inventory_units + p_divisor - 1) / p_divisor
         end;
$$;

-- THE WALK. The exact value of u units along the curve from inventory I at
-- base price S with depth D, as one integer fraction, rounded once:
--   up   (a buy walks the price up):    [20·D·u·S + 1000·u·(2I + u)] / (20000·D)
--   down (a sell walks it down):        [20·D·u·S + 1000·u·(2I − u)] / (20000·D)
-- A null depth is the flat market of every pre-Phase-29 row: u·S/1000, which
-- is exactly Phase 27's units_cost_cents / units_proceeds_cents.
create or replace function public.market_walk_cents(
  p_units           bigint,
  p_base_cents      bigint,
  p_inventory_units bigint,
  p_depth_units     bigint,
  p_direction       text,
  p_rounding        text
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_u   numeric := coalesce(p_units, 0);
  v_num numeric;
  v_den numeric;
  v_q   numeric;
  v_r   numeric;
begin
  if v_u <= 0 then
    return 0;
  end if;
  if p_direction not in ('up', 'down') or p_rounding not in ('ceil', 'floor') then
    raise exception 'market_walk_cents: direction must be up|down and rounding ceil|floor' using errcode = '22023';
  end if;
  if p_depth_units is null then
    v_num := v_u * coalesce(p_base_cents, 0);
    v_den := 1000;
  else
    v_num := 20 * p_depth_units::numeric * v_u * coalesce(p_base_cents, 0)
           + 1000 * v_u * (2 * coalesce(p_inventory_units, 0)::numeric + case when p_direction = 'up' then v_u else -v_u end);
    v_den := 20000 * p_depth_units::numeric;
  end if;
  v_q := div(v_num, v_den);          -- integer quotient, truncated toward zero
  v_r := v_num - v_q * v_den;
  if v_r = 0 then
    return v_q::bigint;
  end if;
  if p_rounding = 'floor' then
    return (case when v_num > 0 then v_q else v_q - 1 end)::bigint;
  end if;
  return (case when v_num > 0 then v_q + 1 else v_q end)::bigint;
end;
$$;

-- The marginal price at an inventory: S + 100·I/D, rounded in the platform's
-- favour for the side asked (the "worst fill" of an order is this at the
-- inventory the order ends on).
create or replace function public.market_marginal_cents(p_base_cents bigint, p_inventory_units bigint, p_depth_units bigint, p_rounding text)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_num numeric;
  v_den numeric;
  v_q   numeric;
  v_r   numeric;
begin
  if p_depth_units is null then
    return p_base_cents;
  end if;
  v_num := p_base_cents::numeric * p_depth_units + 100 * coalesce(p_inventory_units, 0)::numeric;
  v_den := p_depth_units::numeric;
  v_q := div(v_num, v_den);
  v_r := v_num - v_q * v_den;
  if v_r = 0 then
    return v_q::bigint;
  end if;
  if p_rounding = 'floor' then
    return (case when v_num > 0 then v_q else v_q - 1 end)::bigint;
  end if;
  return (case when v_num > 0 then v_q + 1 else v_q end)::bigint;
end;
$$;

-- An order's gross, from its stored components: the closing segment first
-- (from the inventory before), then the opening segment (from where the
-- closing segment left the inventory), each rounded in the side's favour.
-- With shorting off one segment is always the whole order and the other is
-- empty; the two-segment form is what keeps a lot's own CHECK exact when both
-- exist. A null depth is a flat pre-Phase-29 row: the whole order at once.
create or replace function public.market_order_gross_cents(
  p_side                  text,
  p_units                 bigint,
  p_closed_units          bigint,
  p_opened_units          bigint,
  p_base_cents            bigint,
  p_inventory_before_units bigint,
  p_depth_units           bigint
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_depth_units is null then
      public.market_walk_cents(p_units, p_base_cents, 0, null, case when p_side = 'BUY' then 'up' else 'down' end, case when p_side = 'BUY' then 'ceil' else 'floor' end)
    when p_side = 'BUY' then
      public.market_walk_cents(p_closed_units, p_base_cents, p_inventory_before_units, p_depth_units, 'up', 'ceil')
      + public.market_walk_cents(p_opened_units, p_base_cents, p_inventory_before_units + coalesce(p_closed_units, 0), p_depth_units, 'up', 'ceil')
    else
      public.market_walk_cents(p_closed_units, p_base_cents, p_inventory_before_units, p_depth_units, 'down', 'floor')
      + public.market_walk_cents(p_opened_units, p_base_cents, p_inventory_before_units - coalesce(p_closed_units, 0), p_depth_units, 'down', 'floor')
  end;
$$;

-- What a lot cost to open: a HIGH lot walks up and rounds up; a LOW lot
-- (shorting, gated off) walks down and its collateral also rounds up.
create or replace function public.market_lot_amount_cents(
  p_direction       text,
  p_units           bigint,
  p_base_cents      bigint,
  p_inventory_units bigint,
  p_depth_units     bigint
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select public.market_walk_cents(p_units, p_base_cents, p_inventory_units, p_depth_units, case when p_direction = 'HIGH' then 'up' else 'down' end, 'ceil');
$$;

-- The AVERAGE fill per share of a walk, for reading and for the tolerance
-- band: the exact rational average, S + 100·(2I ± u)/(2·D), rounded to the
-- NEAREST cent (half away from zero). Exact, not derived from the rounded
-- gross: for a tiny order the gross's one cent of rounding would misstate the
-- average by whole dollars. In a flat market it is S exactly.
create or replace function public.market_average_cents(
  p_units           bigint,
  p_base_cents      bigint,
  p_inventory_units bigint,
  p_depth_units     bigint,
  p_direction       text
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
           when p_depth_units is null or coalesce(p_units, 0) <= 0 then coalesce(p_base_cents, 0)
           else round((2 * p_depth_units::numeric * p_base_cents
                       + 100 * (2 * coalesce(p_inventory_units, 0)::numeric + case when p_direction = 'up' then p_units else -p_units end))
                      / (2 * p_depth_units::numeric))::bigint
         end;
$$;

-- The impact term on its own, u² / (20·D), to nine decimals, for the record
-- and the review screen. The exact identity is the CHECK, not this figure.
create or replace function public.market_impact_cents(p_units bigint, p_depth_units bigint)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_depth_units is null or coalesce(p_units, 0) <= 0 then 0::numeric
              else round(p_units::numeric * p_units / (20 * p_depth_units), 9) end;
$$;

-- The largest inventory the cap allows: premium(I) = trunc(I·100/D) ≤ cap
-- ⇔ I ≤ ceil((cap + 1)·D / 100) − 1.
create or replace function public.market_cap_inventory_units(p_cap_cents bigint, p_depth_units bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$ select ceil((p_cap_cents + 1)::numeric * p_depth_units / 100)::bigint - 1 $$;

grant execute on function public.market_premium_cents(bigint, bigint)                                  to authenticated, service_role;
grant execute on function public.market_decay_divisor(integer)                                          to authenticated, service_role;
grant execute on function public.market_decay_step(bigint, bigint)                                      to authenticated, service_role;
grant execute on function public.market_walk_cents(bigint, bigint, bigint, bigint, text, text)          to authenticated, service_role;
grant execute on function public.market_marginal_cents(bigint, bigint, bigint, text)                    to authenticated, service_role;
grant execute on function public.market_order_gross_cents(text, bigint, bigint, bigint, bigint, bigint, bigint) to authenticated, service_role;
grant execute on function public.market_lot_amount_cents(text, bigint, bigint, bigint, bigint)          to authenticated, service_role;
grant execute on function public.market_average_cents(bigint, bigint, bigint, bigint, text)             to authenticated, service_role;
grant execute on function public.market_impact_cents(bigint, bigint)                                    to authenticated, service_role;
grant execute on function public.market_cap_inventory_units(bigint, bigint)                             to authenticated, service_role;

-- The parameters a person's market runs on: the tier's row with the person's
-- overrides applied, and the person's tier in the tier column.
create or replace function public.market_params_for(p_person_id uuid)
returns public.market_tier_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_params public.market_tier_settings%rowtype;
  v_person record;
begin
  select p.tier, p.depth_units_override, p.decay_half_life_ticks_override, p.premium_cap_cents_override, p.shorting_override
    into v_person
    from public.people p
   where p.id = p_person_id;
  if not found then
    raise exception 'market_params_for: unknown person %', p_person_id using errcode = 'P0002';
  end if;
  select t.* into v_params from public.market_tier_settings t where t.tier = v_person.tier;
  if not found then
    raise exception 'market_params_for: no market_tier_settings row for tier %', v_person.tier using errcode = 'P0002';
  end if;
  v_params.depth_units           := coalesce(v_person.depth_units_override, v_params.depth_units);
  v_params.decay_half_life_ticks := coalesce(v_person.decay_half_life_ticks_override, v_params.decay_half_life_ticks);
  v_params.premium_cap_cents     := coalesce(v_person.premium_cap_cents_override, v_params.premium_cap_cents);
  v_params.shorting_allowed      := coalesce(v_person.shorting_override, v_params.shorting_allowed);
  return v_params;
end;
$$;

revoke execute on function public.market_params_for(uuid) from public, anon;
grant  execute on function public.market_params_for(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Orders, lots and closes carry the curve's inputs; the CHECKs stay exact
-- ---------------------------------------------------------------------------

-- trade_orders --------------------------------------------------------------
alter table public.trade_orders drop constraint if exists trade_orders_gross_is_notional;

alter table public.trade_orders
  add column base_price_cents        bigint,
  add column inventory_before_units  bigint  not null default 0,
  add column inventory_after_units   bigint  not null default 0,
  add column premium_before_cents    bigint  not null default 0,
  add column premium_after_cents     bigint  not null default 0,
  add column depth_units             bigint,
  add column impact_cents            numeric not null default 0,
  add column worst_fill_cents        bigint,
  add column cost_cents              bigint  not null default 0,
  add column proceeds_cents          bigint  not null default 0,
  add column fingerprint_hash        text;

-- BACKFILL. Every existing order filled flat at fill_price_cents with no
-- premium: its base price is its fill price, its depth is null (the flat
-- market), the inventory identity holds trivially at 0, and its cost and
-- proceeds are what Phase 27 computed for them.
update public.trade_orders o
   set base_price_cents = o.fill_price_cents,
       worst_fill_cents = o.fill_price_cents,
       cost_cents       = public.units_cost_cents(o.opened_units, o.fill_price_cents),
       proceeds_cents   = coalesce((select sum(c.proceeds_cents) from public.position_closes c where c.order_id = o.id), 0);

alter table public.trade_orders alter column base_price_cents set not null;
alter table public.trade_orders alter column worst_fill_cents set not null;

alter table public.trade_orders
  add constraint trade_orders_base_positive check (base_price_cents > 0),
  add constraint trade_orders_depth_positive check (depth_units is null or depth_units > 0),
  -- THE EXACT IDENTITY: gross = the closing segment + the opening segment,
  -- each ceil'd (buy) or floor'd (sell) from the integer inputs on the row.
  add constraint trade_orders_gross_is_curve check (
    gross_cents = public.market_order_gross_cents(side, units, closed_units, opened_units, base_price_cents, inventory_before_units, depth_units)
  ),
  -- The opening segment on its own is what the lot was charged.
  add constraint trade_orders_cost_is_opening_segment check (
    cost_cents = case
      when depth_units is null then public.units_cost_cents(opened_units, base_price_cents)
      when side = 'BUY' then public.market_walk_cents(opened_units, base_price_cents, inventory_before_units + closed_units, depth_units, 'up', 'ceil')
      else public.market_walk_cents(opened_units, base_price_cents, inventory_before_units - closed_units, depth_units, 'down', 'ceil')
    end
  ),
  -- The inventory moved by exactly the order's units, in the order's
  -- direction; a flat order (null depth) records no inventory at all.
  add constraint trade_orders_inventory_walk check (
    (depth_units is null and inventory_before_units = 0 and inventory_after_units = 0)
    or (depth_units is not null and inventory_after_units = inventory_before_units + case when side = 'BUY' then units else -units end)
  ),
  -- The premiums are the derived function of the inventories (flat rows: 0).
  add constraint trade_orders_premium_is_derived check (
    (depth_units is null and premium_before_cents = 0 and premium_after_cents = 0)
    or (depth_units is not null
        and premium_before_cents = (inventory_before_units * 100) / depth_units
        and premium_after_cents  = (inventory_after_units  * 100) / depth_units)
  );

comment on column public.trade_orders.fill_price_cents       is 'Phase 29: the AVERAGE fill per share — the walk''s exact average S + 100·(2I ± u)/(2D), rounded to the nearest cent. For reading and the tolerance band; the exact money is gross_cents through the curve CHECK.';
comment on column public.trade_orders.base_price_cents       is 'Phase 29: S, the side''s base price at the moment of the order — points_to_cents(score ± spread), premium excluded. One of the curve''s integer inputs.';
comment on column public.trade_orders.inventory_before_units is 'Phase 29: the dealer''s inventory the order started from. One of the curve''s integer inputs.';
comment on column public.trade_orders.inventory_after_units  is 'Phase 29: inventory_before ± units.';
comment on column public.trade_orders.premium_before_cents   is 'Phase 29: trunc(inventory_before × 100 / depth): the premium quoted before the order.';
comment on column public.trade_orders.premium_after_cents    is 'Phase 29: the premium quoted after it.';
comment on column public.trade_orders.depth_units            is 'Phase 29: the depth in force. NULL marks an order filled flat: pre-Phase-29, or while the tier''s depth was switched off.';
comment on column public.trade_orders.impact_cents           is 'Phase 29: the order''s own impact term u² / (20·D), to nine decimals, for the record. The exact identity is trade_orders_gross_is_curve.';
comment on column public.trade_orders.worst_fill_cents       is 'Phase 29: the marginal price at the inventory the order ended on, rounded against the user: the last unit''s price, shown on review.';
comment on column public.trade_orders.cost_cents             is 'Phase 29: what the opening segment was charged (the lot''s amount_cents). 0 for a pure close.';
comment on column public.trade_orders.proceeds_cents         is 'Phase 29: what the closes returned to the wallet. 0 for a pure open.';
comment on column public.trade_orders.fingerprint_hash       is 'Phase 29: a salted hash of the requesting client''s network fingerprint, computed by the API route, for the shared-infrastructure detector. Never the address itself. Retention: platform_settings.fingerprint_retention_days.';

create index trade_orders_fingerprint_idx on public.trade_orders (fingerprint_hash, created_at desc) where fingerprint_hash is not null;

-- positions -----------------------------------------------------------------
alter table public.positions drop constraint if exists positions_amount_is_cost;

-- RENAME. entry_score never held a score: it held the entry PRICE in points.
-- The one writer is place_order() and the one reader was a test, so the
-- rename is cheap; the Phase 27 rollback file names the old column and is
-- guarded against running on a Phase 29 schema for that reason.
alter table public.positions rename column entry_score to entry_price_points;

alter table public.positions
  add column entry_base_cents      bigint,
  add column entry_inventory_units bigint not null default 0,
  add column entry_depth_units     bigint,
  add column entry_premium_cents   bigint not null default 0,
  add column entry_index_cents     bigint;

-- BACKFILL. Flat lots: the base is the fill price; the index at entry is the
-- score the Engine had recorded when the lot opened (exact, from
-- score_history), with the fill price as the fallback for a lot that predates
-- any tick.
update public.positions l
   set entry_base_cents  = l.entry_price_cents,
       entry_index_cents = coalesce(
         (select public.points_to_cents(sh.score) from public.score_history sh
           where sh.person_id = l.person_id and sh.recorded_at <= l.opened_at
           order by sh.recorded_at desc, sh.tick_number desc limit 1),
         l.entry_price_cents);

alter table public.positions alter column entry_base_cents set not null;
alter table public.positions alter column entry_index_cents set not null;

alter table public.positions
  add constraint positions_entry_base_positive check (entry_base_cents > 0),
  add constraint positions_entry_depth_positive check (entry_depth_units is null or entry_depth_units > 0),
  -- THE EXACT IDENTITY: the lot's amount is its own segment of the walk.
  add constraint positions_amount_is_curve check (
    amount_cents = public.market_lot_amount_cents(direction, units, entry_base_cents, entry_inventory_units, entry_depth_units)
  ),
  add constraint positions_entry_premium_is_derived check (
    (entry_depth_units is null and entry_premium_cents = 0)
    or (entry_depth_units is not null and entry_premium_cents = (entry_inventory_units * 100) / entry_depth_units)
  );

comment on column public.positions.entry_price_points    is 'Phase 29 (was entry_score): the lot''s AVERAGE entry price in points — entry_price_cents / 100. Never a score. For display.';
comment on column public.positions.entry_price_cents     is 'Phase 29: the lot''s average entry price per share — its segment''s exact average, rounded to the nearest cent. For display; the exact money is amount_cents through positions_amount_is_curve.';
comment on column public.positions.entry_base_cents      is 'Phase 29: S at entry — points_to_cents(score ± spread), premium excluded. One of the lot''s curve inputs.';
comment on column public.positions.entry_inventory_units is 'Phase 29: the dealer''s inventory at the start of the lot''s segment of the walk.';
comment on column public.positions.entry_depth_units     is 'Phase 29: the depth in force at entry. NULL marks a pre-Phase-29 lot, filled flat.';
comment on column public.positions.entry_premium_cents   is 'Phase 29: the premium quoted when the lot opened, for the house ledger''s premium_change.';
comment on column public.positions.entry_index_cents     is 'Phase 29: points_to_cents(current_score) when the lot opened — the INDEX, no spread, no premium — for the house ledger''s score_move.';
comment on column public.positions.amount_cents          is 'Phase 29: the lot''s cost — its own segment of the cost curve, rounded up. Exactly checked.';

-- position_closes -----------------------------------------------------------
alter table public.position_closes
  add column exit_base_cents      bigint,
  add column exit_inventory_units bigint not null default 0,
  add column exit_premium_cents   bigint not null default 0,
  add column exit_index_cents     bigint;

update public.position_closes c
   set exit_base_cents  = c.exit_price_cents,
       exit_index_cents = coalesce(
         (select public.points_to_cents(sh.score) from public.score_history sh
           where sh.person_id = c.person_id and sh.recorded_at <= c.closed_at
           order by sh.recorded_at desc, sh.tick_number desc limit 1),
         c.exit_price_cents);

alter table public.position_closes alter column exit_base_cents set not null;
alter table public.position_closes alter column exit_index_cents set not null;

comment on column public.position_closes.exit_price_cents     is 'Phase 29: the order''s average exit price per share, for display. proceeds_cents is an allocation of the order''s closing segment (floor per partial lot, exact remainder for the last), so pnl = proceeds − cost stays definitional.';
comment on column public.position_closes.exit_base_cents      is 'Phase 29: S at exit, premium excluded.';
comment on column public.position_closes.exit_inventory_units is 'Phase 29: the dealer''s inventory when the closing order started.';
comment on column public.position_closes.exit_premium_cents   is 'Phase 29: the premium quoted when the closing order started.';
comment on column public.position_closes.exit_index_cents     is 'Phase 29: points_to_cents(current_score) at exit — the index — for the house ledger''s score_move.';

-- ---------------------------------------------------------------------------
-- 8. Recording a change, decaying, halting, breaking
-- ---------------------------------------------------------------------------

create or replace function public.record_premium_change(
  p_person_id  uuid,
  p_at         timestamptz,
  p_cause      text,
  p_before     bigint,
  p_after      bigint,
  p_depth      bigint,
  p_score      numeric,
  p_tick       bigint default null,
  p_order_id   uuid   default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.premium_history
    (person_id, recorded_at, tick_number, order_id, cause, inventory_before_units, inventory_after_units, premium_before_cents, premium_after_cents, depth_units, score)
  values
    (p_person_id, p_at, p_tick, p_order_id, p_cause, p_before, p_after,
     public.market_premium_cents(p_before, p_depth), public.market_premium_cents(p_after, p_depth), p_depth, p_score)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.record_premium_change(uuid, timestamptz, text, bigint, bigint, bigint, numeric, bigint, uuid) from public, anon, authenticated;
grant  execute on function public.record_premium_change(uuid, timestamptz, text, bigint, bigint, bigint, numeric, bigint, uuid) to service_role;

-- A HALT: the person is closed to every order until p_at + p_seconds. Always
-- an event on the surveillance stream; an alert when the tier says so (or
-- when p_force_alert, which an admin halt sets).
create or replace function public.halt_person(
  p_person_id   uuid,
  p_seconds     integer,
  p_reason      text,
  p_at          timestamptz,
  p_source      text,
  p_evidence    jsonb default '{}'::jsonb,
  p_force_alert boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_params   public.market_tier_settings%rowtype;
  v_alert_id uuid;
begin
  v_params := public.market_params_for(p_person_id);
  update public.people
     set halted_until = p_at + make_interval(secs => p_seconds),
         halt_reason  = left(p_reason, 200)
   where id = p_person_id;
  if v_params.alert_on_halt or p_force_alert then
    insert into public.alerts (type, severity, person_id, evidence, created_at, updated_at)
    values (p_source, case when v_params.tier = 'private_individual' then 'high' else 'medium' end, p_person_id,
            p_evidence || jsonb_build_object('reason', p_reason, 'halt_seconds', p_seconds, 'tier', v_params.tier), p_at, p_at)
    returning id into v_alert_id;
  end if;
  insert into public.surveillance_events (recorded_at, detector, severity, person_id, evidence, alert_id)
  values (p_at, p_source, 'high', p_person_id, p_evidence || jsonb_build_object('reason', p_reason, 'halt_seconds', p_seconds), v_alert_id);
  return v_alert_id;
end;
$$;

revoke execute on function public.halt_person(uuid, integer, text, timestamptz, text, jsonb, boolean) from public, anon, authenticated;
grant  execute on function public.halt_person(uuid, integer, text, timestamptz, text, jsonb, boolean) to service_role;

-- The premium as it stood at an instant: the latest change at or before it,
-- else what the first change after it started from, else the current value.
create or replace function public.premium_cents_at(p_person_id uuid, p_at timestamptz)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select ph.premium_after_cents from public.premium_history ph
      where ph.person_id = p_person_id and ph.recorded_at <= p_at
      order by ph.recorded_at desc, ph.id desc limit 1),
    (select ph.premium_before_cents from public.premium_history ph
      where ph.person_id = p_person_id and ph.recorded_at > p_at
      order by ph.recorded_at asc, ph.id asc limit 1),
    (select p.premium_cents from public.people p where p.id = p_person_id),
    0);
$$;

-- The index (score in cents) as it stood at an instant, from score_history:
-- the latest tick at or before it, else the first tick after it (a person
-- younger than the window), else the current score.
create or replace function public.index_cents_at(p_person_id uuid, p_at timestamptz)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select public.points_to_cents(sh.score) from public.score_history sh
      where sh.person_id = p_person_id and sh.recorded_at <= p_at
      order by sh.recorded_at desc, sh.tick_number desc limit 1),
    (select public.points_to_cents(sh.score) from public.score_history sh
      where sh.person_id = p_person_id and sh.recorded_at > p_at
      order by sh.recorded_at asc, sh.tick_number asc limit 1),
    (select public.points_to_cents(p.current_score) from public.people p where p.id = p_person_id));
$$;

revoke execute on function public.premium_cents_at(uuid, timestamptz) from public, anon;
revoke execute on function public.index_cents_at(uuid, timestamptz)   from public, anon;
grant  execute on function public.premium_cents_at(uuid, timestamptz) to authenticated, service_role;
grant  execute on function public.index_cents_at(uuid, timestamptz)   to authenticated, service_role;

-- DECAY, once per tick, after the scores are written and before the
-- portfolios are marked. Returns how many people moved.
create or replace function public.apply_market_decay(p_at timestamptz, p_tick_number bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count          integer := 0;
  v_p              record;
  v_params         public.market_tier_settings%rowtype;
  v_k              bigint;
  v_after          bigint;
  v_premium_after  bigint;
  v_high_units     bigint;
  v_low_units      bigint;
  v_sell_base      bigint;
  v_buy_base       bigint;
  v_mark_change    bigint;
begin
  for v_p in
    select p.id, p.current_score, p.spread, p.market_inventory_units, p.premium_cents
      from public.people p
     where p.market_inventory_units <> 0
     order by p.slug
       for update
  loop
    v_params := public.market_params_for(v_p.id);

    -- THE OFF SWITCH: a tier whose depth is null runs a flat market. Any
    -- inventory left from before the switch is returned to zero in one step,
    -- recorded as a reset, and the premium with it.
    if v_params.depth_units is null then
      update public.people set market_inventory_units = 0, premium_cents = 0 where id = v_p.id;
      insert into public.premium_history
        (person_id, recorded_at, tick_number, cause, inventory_before_units, inventory_after_units, premium_before_cents, premium_after_cents, depth_units, score)
      values
        (v_p.id, p_at, p_tick_number, 'reset', v_p.market_inventory_units, 0, v_p.premium_cents, 0, null, v_p.current_score);
      v_count := v_count + 1;
      continue;
    end if;

    v_k := public.market_decay_divisor(v_params.decay_half_life_ticks);
    v_after := public.market_decay_step(v_p.market_inventory_units, v_k);
    v_premium_after := public.market_premium_cents(v_after, v_params.depth_units);

    update public.people
       set market_inventory_units = v_after,
           premium_cents          = v_premium_after
     where id = v_p.id;

    perform public.record_premium_change(v_p.id, p_at, 'decay', v_p.market_inventory_units, v_after, v_params.depth_units, v_p.current_score, p_tick_number, null);

    -- The house book: how the step moved the mark of everything held.
    if v_premium_after <> v_p.premium_cents then
      select coalesce(sum(case when l.direction = 'HIGH' then l.open_units else 0 end), 0),
             coalesce(sum(case when l.direction = 'LOW'  then l.open_units else 0 end), 0)
        into v_high_units, v_low_units
        from public.positions l
       where l.person_id = v_p.id and l.is_open;
      if v_high_units <> 0 or v_low_units <> 0 then
        v_sell_base := public.points_to_cents(v_p.current_score - v_p.spread);
        v_buy_base  := public.points_to_cents(v_p.current_score + v_p.spread);
        -- HIGH holders are marked at the Sell side: their value moved by the
        -- difference; the house moved the other way. LOW holders are marked
        -- at the Buy side and gain when it falls.
        v_mark_change :=
            (public.units_proceeds_cents(v_high_units, v_sell_base + v_premium_after) - public.units_proceeds_cents(v_high_units, v_sell_base + v_p.premium_cents))
          - (public.units_proceeds_cents(v_low_units,  v_buy_base  + v_premium_after) - public.units_proceeds_cents(v_low_units,  v_buy_base  + v_p.premium_cents));
        insert into public.house_ledger (recorded_at, person_id, tick_number, category, amount_cents, details)
        values (p_at, v_p.id, p_tick_number, 'decay_mark', -v_mark_change,
                jsonb_build_object('high_units', v_high_units, 'low_units', v_low_units, 'sell_base_cents', v_sell_base, 'buy_base_cents', v_buy_base,
                                   'premium_before_cents', v_p.premium_cents, 'premium_after_cents', v_premium_after,
                                   'inventory_before_units', v_p.market_inventory_units, 'inventory_after_units', v_after, 'divisor', v_k));
      end if;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.apply_market_decay(timestamptz, bigint) from public, anon, authenticated;
grant  execute on function public.apply_market_decay(timestamptz, bigint) to service_role;

-- THE TOTAL-PRICE BREAKER, evaluated every tick for the tiers that have one
-- (private individuals): if score + premium has moved more than the tier's
-- limit inside its window, trading halts and an alert is raised. The premium
-- breaker needs no tick pass: decay only moves the premium toward zero, and
-- every trade is checked in place_order() before it fills.
create or replace function public.evaluate_price_breakers(p_at timestamptz, p_tick_number bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count  integer := 0;
  v_p      record;
  v_params public.market_tier_settings%rowtype;
  v_now    bigint;
  v_then   bigint;
  v_ref_at timestamptz;
begin
  for v_p in
    select p.id, p.current_score, p.premium_cents
      from public.people p
      join public.market_tier_settings t on t.tier = p.tier
     where p.is_active
       and t.breaker_price_cents is not null
       and (p.halted_until is null or p.halted_until <= p_at)
  loop
    v_params := public.market_params_for(v_p.id);
    v_ref_at := p_at - make_interval(secs => v_params.breaker_window_seconds);
    v_now  := public.points_to_cents(v_p.current_score) + v_p.premium_cents;
    v_then := public.index_cents_at(v_p.id, v_ref_at) + public.premium_cents_at(v_p.id, v_ref_at);
    if abs(v_now - v_then) > v_params.breaker_price_cents then
      perform public.halt_person(
        v_p.id, v_params.breaker_halt_seconds,
        format('The market price moved %s points in %s minutes.', to_char(abs(v_now - v_then) / 100.0, 'FM990.00'), v_params.breaker_window_seconds / 60),
        p_at, 'price_breaker',
        jsonb_build_object('price_now_cents', v_now, 'price_then_cents', v_then, 'window_seconds', v_params.breaker_window_seconds,
                           'limit_cents', v_params.breaker_price_cents, 'tick_number', p_tick_number));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.evaluate_price_breakers(timestamptz, bigint) from public, anon, authenticated;
grant  execute on function public.evaluate_price_breakers(timestamptz, bigint) to service_role;

-- The Engine tick, with the two market steps between the scores and the
-- portfolio marks. Body as in 20260917202622 plus those two calls.
create or replace function public.apply_engine_tick(p_tick jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tick_number       bigint;
  v_expected          bigint := nullif(p_tick ->> 'expected_tick_number', '')::bigint;
  v_started_at        timestamptz := (p_tick ->> 'started_at')::timestamptz;
  v_finished_at       timestamptz := (p_tick ->> 'finished_at')::timestamptz;
  v_people_updated    integer := 0;
  v_history_rows      integer := 0;
  v_events            integer := 0;
  v_signals_processed integer := 0;
  v_snapshots         integer := 0;
  v_decays            integer := 0;
  v_halts             integer := 0;
begin
  if v_started_at is null or v_finished_at is null then
    raise exception 'apply_engine_tick: started_at and finished_at are required' using errcode = '22023';
  end if;

  -- One tick at a time.
  perform pg_advisory_xact_lock(hashtext('momentum_engine_tick'));

  v_tick_number := coalesce((select max(tick_number) from public.engine_ticks), 0) + 1;
  if v_expected is not null and v_expected <> v_tick_number then
    raise exception 'apply_engine_tick: stale tick (computed for tick %, next tick is %)', v_expected, v_tick_number
      using errcode = '40001';
  end if;

  insert into public.engine_ticks (tick_number, started_at, finished_at, mood, summary)
  values (v_tick_number, v_started_at, v_finished_at, coalesce((p_tick ->> 'mood')::numeric, 0), p_tick -> 'summary');

  -- THE SCORE. Written here and nowhere else. The premium is not in this
  -- statement and never will be.
  update public.people p
     set current_score    = x.score,
         spread           = x.spread,
         target_attention = x.target_attention,
         target_direction = x.target_direction,
         target_offset    = coalesce(x.target_offset, 0),
         last_tick_at     = v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb))
           as x(id uuid, score numeric, spread numeric, target_attention numeric, target_direction numeric, target_offset numeric)
   where p.id = x.id;
  get diagnostics v_people_updated = row_count;

  insert into public.score_history (person_id, score, tick_number, recorded_at)
  select x.id, x.score, v_tick_number, v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb)) as x(id uuid, score numeric);
  get diagnostics v_history_rows = row_count;

  insert into public.score_events (tick_number, person_id, force, impact, details, created_at)
  select v_tick_number, e.person_id, e.force, e.impact, e.details, v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'events', '[]'::jsonb)) as e(person_id uuid, force text, impact numeric, details jsonb)
   where e.impact <> 0;
  get diagnostics v_events = row_count;

  update public.signals s
     set processed            = true,
         processed_at         = v_finished_at,
         impact_score         = x.impact_score,
         sentiment_label      = x.sentiment_label,
         sentiment_confidence = x.sentiment_confidence
    from jsonb_to_recordset(coalesce(p_tick -> 'signals', '[]'::jsonb)) as x(id uuid, impact_score numeric, sentiment_label text, sentiment_confidence numeric)
   where s.id = x.id
     and s.processed = false;
  get diagnostics v_signals_processed = row_count;

  -- THE MARKET (Phase 29): the premium decays a step, then the total-price
  -- breakers are read, then the portfolios are marked at the quotes as they
  -- now stand.
  v_decays := public.apply_market_decay(v_finished_at, v_tick_number);
  v_halts  := public.evaluate_price_breakers(v_finished_at, v_tick_number);

  v_snapshots := public.snapshot_portfolios(v_finished_at, v_tick_number);

  update public.engine_ticks
     set people_updated = v_people_updated, signals_processed = v_signals_processed
   where tick_number = v_tick_number;

  return jsonb_build_object(
    'tick_number', v_tick_number,
    'people_updated', v_people_updated,
    'history_rows', v_history_rows,
    'score_events', v_events,
    'signals_processed', v_signals_processed,
    'premium_decays', v_decays,
    'breaker_halts', v_halts,
    'portfolio_snapshots', v_snapshots
  );
end;
$$;

comment on function public.apply_engine_tick(jsonb) is
  'Atomically persists one Engine tick (people scores, spread and the drifting target''s state, score_history, score_events, processed signals, engine_ticks), decays every non-zero premium one step (Phase 29), reads the total-price breakers, and records every position-holding user''s portfolio value at the new quotes. Service role only. Nothing derived from an order is written to the score here.';

-- ---------------------------------------------------------------------------
-- 9. The read side: the quote, the summaries, the history, the market series
-- ---------------------------------------------------------------------------

create or replace function public.trade_quote(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'person_id',        p.id,
           'score',            p.current_score,
           'spread',           p.spread,
           'buy_cents',        public.points_to_cents(p.buy_price),
           'sell_cents',       public.points_to_cents(p.sell_price),
           'base_buy_cents',   public.points_to_cents(p.current_score + p.spread),
           'base_sell_cents',  public.points_to_cents(p.current_score - p.spread),
           'premium_cents',    p.premium_cents,
           'market_price',     p.market_price,
           'inventory_units',  p.market_inventory_units,
           'depth_units',      m.depth_units,
           'premium_cap_cents', m.premium_cap_cents,
           'tier',             p.tier,
           'trading_mode',     p.trading_mode,
           'halted_until',     case when p.halted_until > now() then p.halted_until end,
           'halt_reason',      case when p.halted_until > now() then p.halt_reason end,
           'tolerance_cents',  (select s.price_tolerance_cents from public.platform_settings s where s.id),
           'units_per_share',  public.units_per_share(),
           'as_of',            now()
         )
    from public.people p
   cross join lateral public.market_params_for(p.id) m
   where p.id = p_person_id
     and p.is_active;
$$;

comment on function public.trade_quote(uuid) is
  'Phase 29: the current Buy and Sell quotes (market price ± half-spread) in integer cents, the base prices without the premium, the premium, the dealer inventory and depth the cost curve runs on, the tier, the trading mode and any halt. Null for an unknown or inactive person.';

create or replace function public.position_summary_for(p_user_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_direction   text;
  v_units       bigint := 0;
  v_cost        bigint := 0;
  v_lots        integer := 0;
  v_oldest      timestamptz;
  v_newest      timestamptz;
  v_mark        bigint;
  v_value       bigint;
  v_unrealized  bigint;
  v_realized    bigint;
  v_buy_cents   bigint;
  v_sell_cents  bigint;
  v_premium     bigint;
  v_market      numeric;
begin
  select public.points_to_cents(p.buy_price), public.points_to_cents(p.sell_price), p.premium_cents, p.market_price
    into v_buy_cents, v_sell_cents, v_premium, v_market
    from public.people p
   where p.id = p_person_id;

  select l.direction, sum(l.open_units), sum(l.open_cost_cents), count(*), min(l.opened_at), max(l.opened_at)
    into v_direction, v_units, v_cost, v_lots, v_oldest, v_newest
    from public.positions l
   where l.user_id = p_user_id
     and l.person_id = p_person_id
     and l.is_open
   group by l.direction
   order by sum(l.open_units) desc
   limit 1;

  select coalesce(sum(c.pnl_cents), 0)
    into v_realized
    from public.position_closes c
   where c.user_id = p_user_id
     and c.person_id = p_person_id;

  if v_direction is null then
    return jsonb_build_object(
      'person_id', p_person_id, 'direction', null, 'open_units', 0, 'cost_cents', 0, 'avg_entry_cents', null,
      'lots', 0, 'oldest_opened_at', null, 'newest_opened_at', null,
      'mark_price_cents', v_sell_cents, 'value_cents', 0, 'unrealized_pnl_cents', 0, 'realized_pnl_cents', v_realized,
      'premium_cents', v_premium, 'market_price', v_market,
      'units_per_share', public.units_per_share()
    );
  end if;

  -- A HIGH position closes at the Sell side of the market price, a LOW one at the Buy side.
  v_mark := case when v_direction = 'HIGH' then v_sell_cents else v_buy_cents end;
  v_value := public.units_proceeds_cents(v_units, v_mark);
  v_unrealized := case when v_direction = 'HIGH' then v_value - v_cost else v_cost - v_value end;

  return jsonb_build_object(
    'person_id', p_person_id,
    'direction', v_direction,
    'open_units', v_units,
    'cost_cents', v_cost,
    'avg_entry_cents', round(v_cost::numeric * public.units_per_share() / v_units)::bigint,
    'lots', v_lots,
    'oldest_opened_at', v_oldest,
    'newest_opened_at', v_newest,
    'mark_price_cents', v_mark,
    'value_cents', v_value,
    'unrealized_pnl_cents', v_unrealized,
    'realized_pnl_cents', v_realized,
    'premium_cents', v_premium,
    'market_price', v_market,
    'units_per_share', public.units_per_share()
  );
end;
$function$;

create or replace function public.portfolio_summary_for(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_now             timestamptz := now();
  v_cash            bigint;
  v_positions       jsonb;
  v_position_count  integer := 0;
  v_positions_value bigint := 0;
  v_open_cost       bigint := 0;
  v_unrealized      bigint := 0;
  v_realized        bigint := 0;
  v_credit          bigint := 0;
  v_orders          bigint := 0;
  v_closes          bigint := 0;
  v_people_traded   bigint := 0;
  v_first_order     timestamptz;
  v_last_order      timestamptz;
  v_history_points  bigint := 0;
  v_total           bigint;
begin
  select u.wallet_balance_cents into v_cash from public.users u where u.id = p_user_id;
  if v_cash is null then
    return null;
  end if;

  with lots as (
    select l.person_id,
           l.direction,
           sum(l.open_units)::bigint      as open_units,
           sum(l.open_cost_cents)::bigint as cost_cents,
           count(*)::integer              as lots,
           min(l.opened_at)               as oldest_opened_at,
           max(l.opened_at)               as newest_opened_at
      from public.positions l
     where l.user_id = p_user_id
       and l.is_open
     group by l.person_id, l.direction
  ),
  marked as (
    select lo.*,
           p.slug, p.display_name, p.category, p.avatar_url, p.is_active, p.current_score, p.spread, p.premium_cents, p.market_price,
           p.trading_mode, case when p.halted_until > v_now then p.halted_until end as halted_until,
           public.points_to_cents(p.buy_price)  as buy_cents,
           public.points_to_cents(p.sell_price) as sell_cents,
           case when lo.direction = 'HIGH' then public.points_to_cents(p.sell_price)
                                          else public.points_to_cents(p.buy_price) end as mark_cents,
           (select coalesce(sum(c.pnl_cents), 0)::bigint
              from public.position_closes c
             where c.user_id = p_user_id and c.person_id = lo.person_id) as realized_cents
      from lots lo
      join public.people p on p.id = lo.person_id
  ),
  valued as (
    select m.*,
           public.units_proceeds_cents(m.open_units, m.mark_cents) as value_cents,
           (case when m.direction = 'HIGH' then public.units_proceeds_cents(m.open_units, m.mark_cents) - m.cost_cents
                                          else m.cost_cents - public.units_proceeds_cents(m.open_units, m.mark_cents) end)::bigint as unrealized_cents
      from marked m
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id',            v.person_id,
           'slug',                 v.slug,
           'display_name',         v.display_name,
           'category',             v.category,
           'avatar_url',           v.avatar_url,
           'is_active',            v.is_active,
           'direction',            v.direction,
           'open_units',           v.open_units,
           'cost_cents',           v.cost_cents,
           'avg_entry_cents',      round(v.cost_cents::numeric * public.units_per_share() / v.open_units)::bigint,
           'lots',                 v.lots,
           'oldest_opened_at',     v.oldest_opened_at,
           'newest_opened_at',     v.newest_opened_at,
           'score',                v.current_score,
           'spread',               v.spread,
           'premium_cents',        v.premium_cents,
           'market_price',         v.market_price,
           'trading_mode',         v.trading_mode,
           'halted_until',         v.halted_until,
           'buy_cents',            v.buy_cents,
           'sell_cents',           v.sell_cents,
           'mark_side',            case when v.direction = 'HIGH' then 'SELL' else 'BUY' end,
           'mark_price_cents',     v.mark_cents,
           'value_cents',          v.value_cents,
           'unrealized_pnl_cents', v.unrealized_cents,
           'unrealized_pct',       case when v.cost_cents > 0 then round(v.unrealized_cents::numeric * 100 / v.cost_cents, 2) end,
           'realized_pnl_cents',   v.realized_cents
         ) order by v.value_cents desc, v.display_name, v.person_id), '[]'::jsonb),
         count(*)::integer,
         coalesce(sum(v.value_cents), 0)::bigint,
         coalesce(sum(v.cost_cents), 0)::bigint,
         coalesce(sum(v.unrealized_cents), 0)::bigint
    into v_positions, v_position_count, v_positions_value, v_open_cost, v_unrealized
    from valued v;

  select coalesce(sum(c.pnl_cents), 0)::bigint, count(*)::bigint
    into v_realized, v_closes
    from public.position_closes c
   where c.user_id = p_user_id;

  select coalesce(sum(case when t.type = 'DEPOSIT' then t.amount_cents when t.type = 'WITHDRAWAL' then -t.amount_cents else 0 end), 0)::bigint
    into v_credit
    from public.transactions t
   where t.user_id = p_user_id;

  select count(*)::bigint, count(distinct o.person_id)::bigint, min(o.created_at), max(o.created_at)
    into v_orders, v_people_traded, v_first_order, v_last_order
    from public.trade_orders o
   where o.user_id = p_user_id;

  select count(*)::bigint into v_history_points from public.portfolio_history h where h.user_id = p_user_id;

  v_total := v_cash + v_positions_value;

  return jsonb_build_object(
    'user_id',               p_user_id,
    'as_of',                 v_now,
    'cash_cents',            v_cash,
    'positions_value_cents', v_positions_value,
    'total_value_cents',     v_total,
    'open_cost_cents',       v_open_cost,
    'unrealized_pnl_cents',  v_unrealized,
    'realized_pnl_cents',    v_realized,
    'paper_credit_cents',    v_credit,
    'total_return_cents',    v_total - v_credit,
    'total_return_pct',      case when v_credit > 0 then round((v_total - v_credit)::numeric * 100 / v_credit, 2) end,
    'position_count',        v_position_count,
    'orders',                v_orders,
    'closes',                v_closes,
    'people_traded',         v_people_traded,
    'first_order_at',        v_first_order,
    'last_order_at',         v_last_order,
    'history_points',        v_history_points,
    'units_per_share',       public.units_per_share(),
    'positions',             v_positions
  );
end;
$function$;

-- The history reads the stored cost and proceeds rather than re-multiplying
-- a price: with a curve there is no one price to multiply by.
create or replace function public.trade_history_for(
  p_user_id   uuid,
  p_before    timestamptz default null,
  p_before_id uuid        default null,
  p_limit     integer     default 20
)
  returns table (
    id uuid, created_at timestamptz, side text, units bigint, fill_price_cents bigint, gross_cents bigint,
    opened_units bigint, closed_units bigint, cost_cents bigint, proceeds_cents bigint, realized_pnl_cents bigint,
    balance_after_cents bigint, surface text, person_id uuid, person_slug text, person_name text,
    person_category text, person_avatar text, units_per_share bigint
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select o.id,
         o.created_at,
         o.side,
         o.units,
         o.fill_price_cents,
         o.gross_cents,
         o.opened_units,
         o.closed_units,
         o.cost_cents,
         o.proceeds_cents,
         o.realized_pnl_cents,
         o.balance_after_cents,
         o.surface,
         p.id,
         p.slug,
         p.display_name,
         p.category,
         p.avatar_url,
         public.units_per_share()
    from public.trade_orders o
    join public.people p on p.id = o.person_id
   where o.user_id = p_user_id
     and (p_before is null or p_before_id is null or (o.created_at, o.id) < (p_before, p_before_id))
   order by o.created_at desc, o.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- THE MARKET LINE for the chart: the same buckets as person_score_series,
-- each carrying the market price (score + the premium as it stood at that
-- tick) beside the score. The premium is looked up once per bucket edge, so a
-- week is 168 lookups, not twenty thousand.
create or replace function public.person_market_series(
  p_person_id uuid,
  p_since     timestamptz default null,
  p_points    integer     default 120
)
returns table (
  bucket_at    timestamptz,
  score        numeric,
  open         numeric,
  market       numeric,
  market_open  numeric,
  samples      integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select least(greatest(coalesce(p_points, 120), 2), 1000) as points
  ),
  span as (
    select coalesce(p_since, (select min(sh.recorded_at)
                                from public.score_history sh
                               where sh.person_id = p_person_id)) as from_at,
           now() as to_at
  ),
  ranked as (
    select sh.score,
           sh.recorded_at,
           width_bucket(
             extract(epoch from sh.recorded_at),
             extract(epoch from s.from_at),
             extract(epoch from s.to_at) + 0.001,
             (select points from params)
           ) as bucket
      from public.score_history sh
      cross join span s
     where sh.person_id = p_person_id
       and s.from_at is not null
       and sh.recorded_at >= s.from_at
       and sh.recorded_at <= s.to_at
  ),
  buckets as (
    select max(r.recorded_at)                                        as bucket_at,
           min(r.recorded_at)                                        as opened_at,
           (array_agg(r.score order by r.recorded_at desc))[1]       as score,
           (array_agg(r.score order by r.recorded_at asc))[1]        as open,
           count(*)::int                                              as samples
      from ranked r
     group by r.bucket
  )
  select b.bucket_at,
         b.score,
         b.open,
         b.score + public.premium_cents_at(p_person_id, b.bucket_at) * 0.01 as market,
         b.open  + public.premium_cents_at(p_person_id, b.opened_at) * 0.01 as market_open,
         b.samples
    from buckets b
   order by b.bucket_at;
$$;

comment on function public.person_market_series(uuid, timestamptz, integer) is
  'Phase 29: person_score_series with the market price beside the score — each slice''s last score plus the premium as it stood at that tick (market) and its first score plus the premium then (market_open). Empty slices are omitted.';

revoke execute on function public.person_market_series(uuid, timestamptz, integer) from public, anon;
grant  execute on function public.person_market_series(uuid, timestamptz, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Surveillance: the detectors, run at the point of activity
-- ---------------------------------------------------------------------------
-- Called by place_order() after a fill, for the person and account that just
-- traded. Cheap, windowed queries; every reading is an event, and a reading
-- at or over its threshold raises an alert unless one of the same type on the
-- same person is already open inside the window (then the open one is
-- refreshed). Evidence is counts and salted hashes, never an address.

-- One reading: raise or refresh an alert when it fires, record the event
-- either way. Returns 1 when a NEW alert was raised, else 0.
create or replace function public.surveillance_emit(
  p_at        timestamptz,
  p_since     timestamptz,
  p_person_id uuid,
  p_order_id  uuid,
  p_type      text,
  p_severity  text,
  p_threshold integer,
  p_observed  integer,
  p_users     uuid[],
  p_evidence  jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert  uuid;
  v_fires  boolean := p_observed >= p_threshold;
  v_raised integer := 0;
begin
  if v_fires then
    select a.id into v_alert
      from public.alerts a
     where a.type = p_type
       and a.person_id is not distinct from p_person_id
       and a.status in ('open', 'reviewing')
       and a.updated_at >= p_since
     order by a.created_at desc
     limit 1;
    if v_alert is null then
      insert into public.alerts (type, severity, person_id, user_ids, evidence, created_at, updated_at)
      values (p_type, p_severity, p_person_id, coalesce(p_users, '{}'), p_evidence || jsonb_build_object('observed', p_observed, 'threshold', p_threshold), p_at, p_at)
      returning id into v_alert;
      v_raised := 1;
    else
      update public.alerts
         set updated_at = p_at,
             user_ids   = (select coalesce(array_agg(distinct u), '{}') from unnest(user_ids || coalesce(p_users, '{}')) as u),
             evidence   = evidence || p_evidence || jsonb_build_object('observed', p_observed, 'threshold', p_threshold, 'repeats', coalesce((evidence ->> 'repeats')::integer, 0) + 1)
       where id = v_alert;
    end if;
  end if;
  insert into public.surveillance_events (recorded_at, detector, severity, person_id, user_ids, evidence, alert_id)
  values (p_at, p_type, case when v_fires then p_severity else 'info' end, p_person_id, coalesce(p_users, '{}'),
          p_evidence || jsonb_build_object('observed', p_observed, 'threshold', p_threshold, 'order_id', p_order_id), v_alert);
  return v_raised;
end;
$$;

revoke execute on function public.surveillance_emit(timestamptz, timestamptz, uuid, uuid, text, text, integer, integer, uuid[], jsonb) from public, anon, authenticated;
grant  execute on function public.surveillance_emit(timestamptz, timestamptz, uuid, uuid, text, text, integer, integer, uuid[], jsonb) to service_role;

create or replace function public.run_surveillance(
  p_at               timestamptz,
  p_person_id        uuid,
  p_user_id          uuid,
  p_order_id         uuid,
  p_fingerprint_hash text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s        public.platform_settings%rowtype;
  v_raised   integer := 0;
  v_since    timestamptz;
  v_users    uuid[];
  v_count    integer;
  v_buys     integer;
  v_sells    integer;
  v_referrer uuid;
begin
  select * into v_s from public.platform_settings s where s.id;
  v_since := p_at - make_interval(secs => v_s.surveillance_window_seconds);

  -- 1. CLUSTERED BUYING: distinct accounts buying this person inside the window.
  select count(distinct o.user_id), array_agg(distinct o.user_id)
    into v_count, v_users
    from public.trade_orders o
   where o.person_id = p_person_id and o.side = 'BUY' and o.created_at >= v_since and o.created_at <= p_at;
  v_raised := v_raised + public.surveillance_emit(p_at, v_since, p_person_id, p_order_id, 'clustered_buying', 'medium',
                v_s.clustered_buying_min_accounts, coalesce(v_count, 0), v_users,
                jsonb_build_object('window_seconds', v_s.surveillance_window_seconds));

  -- 2. NEW-ACCOUNT BURST: accounts younger than the age limit trading this person inside the window.
  select count(distinct o.user_id), array_agg(distinct o.user_id)
    into v_count, v_users
    from public.trade_orders o
    join public.users u on u.id = o.user_id
   where o.person_id = p_person_id and o.created_at >= v_since and o.created_at <= p_at
     and u.created_at >= p_at - make_interval(hours => v_s.new_account_age_hours);
  v_raised := v_raised + public.surveillance_emit(p_at, v_since, p_person_id, p_order_id, 'new_account_burst', 'high',
                v_s.new_account_burst_min_accounts, coalesce(v_count, 0), v_users,
                jsonb_build_object('window_seconds', v_s.surveillance_window_seconds, 'account_age_hours', v_s.new_account_age_hours));

  -- 3. SHARED INFRASTRUCTURE: distinct accounts on this order's fingerprint inside the window, any market.
  if p_fingerprint_hash is not null then
    select count(distinct o.user_id), array_agg(distinct o.user_id)
      into v_count, v_users
      from public.trade_orders o
     where o.fingerprint_hash = p_fingerprint_hash and o.created_at >= v_since and o.created_at <= p_at;
    v_raised := v_raised + public.surveillance_emit(p_at, v_since, p_person_id, p_order_id, 'shared_infrastructure', 'high',
                  v_s.shared_infra_min_accounts, coalesce(v_count, 0), v_users,
                  jsonb_build_object('window_seconds', v_s.surveillance_window_seconds, 'fingerprint_prefix', left(p_fingerprint_hash, 12)));
  end if;

  -- 4. WASH / ROUND TRIPS: this account's buys and sells on this person inside the wash window.
  select count(*) filter (where o.side = 'BUY'), count(*) filter (where o.side = 'SELL')
    into v_buys, v_sells
    from public.trade_orders o
   where o.person_id = p_person_id and o.user_id = p_user_id
     and o.created_at >= p_at - make_interval(secs => v_s.wash_window_seconds) and o.created_at <= p_at;
  v_raised := v_raised + public.surveillance_emit(p_at, v_since, p_person_id, p_order_id, 'wash_trading', 'medium',
                v_s.wash_min_round_trips, least(coalesce(v_buys, 0), coalesce(v_sells, 0)), array[p_user_id],
                jsonb_build_object('window_seconds', v_s.wash_window_seconds, 'buys', v_buys, 'sells', v_sells));

  -- 5. REFERRAL SPIKE: accounts sharing this account's referrer created inside the window.
  select u.referred_by into v_referrer from public.users u where u.id = p_user_id;
  if v_referrer is not null then
    select count(*), array_agg(u.id)
      into v_count, v_users
      from public.users u
     where u.referred_by = v_referrer and u.created_at >= v_since and u.created_at <= p_at;
    v_raised := v_raised + public.surveillance_emit(p_at, v_since, p_person_id, p_order_id, 'referral_spike', 'low',
                  v_s.referral_spike_min_accounts, coalesce(v_count, 0), v_users,
                  jsonb_build_object('window_seconds', v_s.surveillance_window_seconds, 'referrer', v_referrer));
  end if;

  return v_raised;
end;
$$;

revoke execute on function public.run_surveillance(timestamptz, uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.run_surveillance(timestamptz, uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 11. place_order, on the curve, behind every guard
-- ---------------------------------------------------------------------------

-- How long to wait, in words.
create or replace function public.wait_text(p_seconds numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when p_seconds >= 3600 then ceil(p_seconds / 3600)::integer || case when ceil(p_seconds / 3600) = 1 then ' hour' else ' hours' end
           when p_seconds >= 60   then ceil(p_seconds / 60)::integer   || case when ceil(p_seconds / 60) = 1 then ' minute' else ' minutes' end
           else greatest(ceil(p_seconds), 1)::integer || case when greatest(ceil(p_seconds), 1) = 1 then ' second' else ' seconds' end
         end;
$$;

grant execute on function public.wait_text(numeric) to authenticated, service_role;

drop function if exists public.place_order(uuid, text, bigint, bigint, text, bigint, text);

create function public.place_order(
  p_person_id          uuid,
  p_side               text,
  p_units              bigint  default null,
  p_quoted_price_cents bigint  default null,
  p_surface            text    default null,
  p_max_spend_cents    bigint  default null,
  p_quantity_scale     text    default null,
  p_fingerprint_hash   text    default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $function$
declare
  v_user_id          uuid := auth.uid();
  v_now              timestamptz := now();
  v_settings         public.platform_settings%rowtype;
  v_params           public.market_tier_settings%rowtype;
  v_account          record;
  v_wallet           bigint;
  v_person           record;
  v_base_buy         bigint;
  v_base_sell        bigint;
  v_base             bigint;
  v_index_cents      bigint;
  v_inventory        bigint;
  v_premium          bigint;
  v_depth            bigint;
  v_walk             text;
  v_rounding         text;
  v_quote            jsonb;
  v_scale            text;
  v_units            bigint;
  v_gross            bigint;
  v_avg              bigint;
  v_worst            bigint;
  v_close_direction  text;
  v_open_direction   text;
  v_closable_units   bigint;
  v_close_units      bigint;
  v_open_units       bigint;
  v_close_gross      bigint := 0;
  v_open_gross       bigint := 0;
  v_cost             bigint := 0;
  v_open_from        bigint := 0;
  v_inventory_after  bigint;
  v_premium_after    bigint;
  v_cap_units        bigint;
  v_max_units        bigint;
  v_shorting         boolean;
  v_hold_seconds     integer;
  v_cooldown_wait    numeric;
  v_daily_closed     bigint;
  v_same_side_units  bigint;
  v_total_side_units bigint;
  v_net_holdings     bigint;
  v_ref_at           timestamptz;
  v_ref_premium      bigint;
  v_ref_price        bigint;
  v_affordable       bigint;
  v_lo               bigint;
  v_hi               bigint;
  v_mid              bigint;
  v_order_id         uuid;
  v_lot              record;
  v_remaining        bigint;
  v_alloc_remaining  bigint;
  v_take             bigint;
  v_take_cost        bigint;
  v_take_gross       bigint;
  v_lot_proceeds     bigint;
  v_pnl              bigint;
  v_close_id         uuid;
  v_house_score      bigint;
  v_house_premium    bigint;
  v_total_proceeds   bigint := 0;
  v_total_pnl        bigint := 0;
  v_closed_units     bigint := 0;
  v_position_id      uuid;
  v_balance_after    bigint;
  v_fills            jsonb := '[]'::jsonb;
begin
  -- The actor is always the signed-in user, never a parameter.
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'p_side must be BUY or SELL' using errcode = '22023';
  end if;
  if (p_units is null) = (p_max_spend_cents is null) then
    raise exception 'exactly one of p_units or p_max_spend_cents must be given' using errcode = '22023';
  end if;
  if p_units is not null and p_units <= 0 then
    raise exception 'p_units must be a positive integer number of units' using errcode = '22023';
  end if;
  v_scale := lower(coalesce(nullif(trim(p_quantity_scale), ''), 'share'));
  if v_scale not in ('share', 'milli') then
    raise exception 'p_quantity_scale must be share or milli' using errcode = '22023';
  end if;
  if p_max_spend_cents is not null and p_max_spend_cents <= 0 then
    raise exception 'p_max_spend_cents must be a positive integer number of cents' using errcode = '22023';
  end if;
  if p_quoted_price_cents is not null and p_quoted_price_cents <= 0 then
    raise exception 'p_quoted_price_cents must be a positive integer number of cents' using errcode = '22023';
  end if;

  select * into v_settings from public.platform_settings s where s.id;

  -- Serialise this user's orders: the wallet row is the lock.
  select u.wallet_balance_cents, u.frozen_at, u.identity_verified_at
    into v_account
    from public.users u
   where u.id = v_user_id
     for update;
  if not found then
    raise exception 'No wallet for user %', v_user_id using errcode = 'P0002';
  end if;
  v_wallet := v_account.wallet_balance_cents;

  -- THE ACCOUNT GATES, before anything is priced.
  if v_account.frozen_at is not null then
    return public.trade_rejection('frozen', 'Your account is frozen while a review is open. Nothing can be placed until it is lifted.', null);
  end if;
  if v_settings.require_verified_identity and v_account.identity_verified_at is null then
    return public.trade_rejection('identity_required', 'Verify your identity before trading.', null);
  end if;
  if exists (select 1 from public.excluded_parties x
              where x.user_id = v_user_id and x.removed_at is null and (x.person_id is null or x.person_id = p_person_id)) then
    return public.trade_rejection('excluded', 'This account is not permitted to trade this market.', null);
  end if;

  -- Lock the person so neither a tick nor another order can move the market under this one.
  select p.id, p.display_name, p.is_active, p.current_score, p.spread, p.tier, p.trading_mode, p.halted_until, p.halt_reason,
         p.market_inventory_units, p.premium_cents
    into v_person
    from public.people p
   where p.id = p_person_id
     for update;
  if not found or not v_person.is_active then
    return public.trade_rejection('unknown_person', 'That person is not on the board.', null);
  end if;

  v_params    := public.market_params_for(p_person_id);
  v_depth     := v_params.depth_units;
  -- A null depth is the flat market: no inventory, no premium, no impact.
  v_inventory := case when v_depth is null then 0 else v_person.market_inventory_units end;
  v_premium   := case when v_depth is null then 0 else v_person.premium_cents end;
  v_base_buy  := public.points_to_cents(v_person.current_score + v_person.spread);
  v_base_sell := public.points_to_cents(v_person.current_score - v_person.spread);
  v_index_cents := public.points_to_cents(v_person.current_score);
  v_base      := case when p_side = 'BUY' then v_base_buy else v_base_sell end;
  v_walk      := case when p_side = 'BUY' then 'up' else 'down' end;
  v_rounding  := case when p_side = 'BUY' then 'ceil' else 'floor' end;
  v_quote     := public.trade_quote(p_person_id);

  -- THE MARKET GATES.
  if v_person.halted_until is not null and v_person.halted_until > v_now then
    return public.trade_rejection(
      'halted',
      format('Trading in %s is halted for %s. %s', v_person.display_name,
             public.wait_text(extract(epoch from (v_person.halted_until - v_now))), coalesce(v_person.halt_reason, '')),
      v_quote,
      jsonb_build_object('halted_until', v_person.halted_until, 'halt_reason', v_person.halt_reason)
    );
  end if;
  if v_person.trading_mode = 'paused' then
    return public.trade_rejection('paused', format('Trading in %s is paused.', v_person.display_name), v_quote);
  end if;
  -- The first unit's price must be a price: a degenerate market is refused, never filled.
  if public.market_marginal_cents(v_base, v_inventory, v_depth, v_rounding) <= 0 then
    return public.trade_rejection('no_quote', format('%s has no tradeable quote right now.', v_person.display_name), v_quote);
  end if;

  -- THE QUANTITY.
  if p_max_spend_cents is not null then
    -- DOLLARS MODE: the largest quantity whose walk stays within the amount.
    -- The walk is monotone in the quantity, so this is a binary search over
    -- integers; the charge that comes back is at most the amount, never more.
    if p_max_spend_cents < v_settings.min_order_cents then
      return public.trade_rejection(
        'below_minimum',
        format('The smallest order is $%s. Enter at least that much.', public.cents_to_dollars_text(v_settings.min_order_cents)),
        v_quote,
        jsonb_build_object('min_order_cents', v_settings.min_order_cents, 'requested_cents', p_max_spend_cents)
      );
    end if;
    v_lo := 0;
    v_hi := floor(p_max_spend_cents::numeric * public.units_per_share() / public.market_marginal_cents(v_base, v_inventory, v_depth, 'floor'))::bigint + 1;
    v_hi := greatest(v_hi, 1);
    -- A sell walks the price down, so the flat estimate can be too small; widen until it is too large.
    while public.market_walk_cents(v_hi, v_base, v_inventory, v_depth, v_walk, v_rounding) <= p_max_spend_cents and v_hi < 1000000000000 loop
      v_hi := v_hi * 2;
    end loop;
    while v_lo < v_hi - 1 loop
      v_mid := (v_lo + v_hi) / 2;
      if public.market_walk_cents(v_mid, v_base, v_inventory, v_depth, v_walk, v_rounding) <= p_max_spend_cents then
        v_lo := v_mid;
      else
        v_hi := v_mid;
      end if;
    end loop;
    v_units := v_lo;
    if v_units <= 0 then
      return public.trade_rejection(
        'below_minimum',
        format('$%s does not buy a tradeable quantity of %s at $%s per share.',
               public.cents_to_dollars_text(p_max_spend_cents), v_person.display_name,
               public.cents_to_dollars_text(public.market_marginal_cents(v_base, v_inventory, v_depth, v_rounding))),
        v_quote,
        jsonb_build_object('min_order_cents', v_settings.min_order_cents, 'requested_cents', p_max_spend_cents)
      );
    end if;
  else
    v_units := case when v_scale = 'milli' then p_units else p_units * public.units_per_share() end;
  end if;

  -- THE ORDER'S SIZE AGAINST THE MARKET'S DEPTH, both sides: a close moves
  -- the market as much as an open does.
  if v_depth is not null then
    v_max_units := floor(v_params.max_order_share_of_depth * v_depth)::bigint;
    if v_units > v_max_units then
      return public.trade_rejection(
        'order_too_large',
        format('The largest single order in %s is %s. Size it down or split it up.', v_person.display_name, public.shares_label(v_max_units)),
        v_quote,
        jsonb_build_object('max_units', v_max_units)
      );
    end if;
  end if;

  -- THE WHOLE ORDER'S WALK: its gross, its average and its worst fill.
  v_gross := public.market_walk_cents(v_units, v_base, v_inventory, v_depth, v_walk, v_rounding);
  v_avg   := public.market_average_cents(v_units, v_base, v_inventory, v_depth, v_walk);
  v_inventory_after := case when v_depth is null then 0 else v_inventory + case when p_side = 'BUY' then v_units else -v_units end end;
  v_worst := public.market_marginal_cents(v_base, v_inventory_after, v_depth, v_rounding);
  if v_worst <= 0 or v_gross <= 0 then
    return public.trade_rejection('no_quote', format('%s has no tradeable quote for that quantity right now.', v_person.display_name), v_quote);
  end if;

  -- THE TOLERANCE BAND, on the AVERAGE fill: never fill at a price the user
  -- has not just reviewed. In Dollars mode the quantity was resolved against
  -- the server's own curve; the average it produced is what is compared.
  if p_quoted_price_cents is not null and abs(v_avg - p_quoted_price_cents) > v_settings.price_tolerance_cents then
    return public.trade_rejection(
      'price_moved',
      format('The price moved. %s now fills at an average of $%s per share, not $%s.',
             case when p_side = 'BUY' then 'Buy' else 'Sell' end,
             public.cents_to_dollars_text(v_avg),
             public.cents_to_dollars_text(p_quoted_price_cents)),
      v_quote,
      jsonb_build_object('fill_price_cents', v_avg, 'quoted_price_cents', p_quoted_price_cents, 'units', v_units)
    );
  end if;

  if p_max_spend_cents is null and v_gross < v_settings.min_order_cents then
    return public.trade_rejection(
      'below_minimum',
      format('%s of %s is $%s. The smallest order is $%s.',
             public.shares_label(v_units), v_person.display_name,
             public.cents_to_dollars_text(v_gross), public.cents_to_dollars_text(v_settings.min_order_cents)),
      v_quote,
      jsonb_build_object('min_order_cents', v_settings.min_order_cents, 'order_cents', v_gross, 'units', v_units)
    );
  end if;

  -- THE PREMIUM CAP, both directions: the market price may not leave the
  -- band around the data, whatever is asked.
  v_cap_units := case when v_depth is null then null else public.market_cap_inventory_units(v_params.premium_cap_cents, v_depth) end;
  if v_depth is not null and p_side = 'BUY' and v_inventory_after > v_cap_units then
    v_max_units := greatest(v_cap_units - v_inventory, 0);
    return public.trade_rejection(
      'premium_cap',
      format('That would take the market price of %s more than %s points above the data, which is the limit. At most %s fits right now.',
             v_person.display_name, to_char(v_params.premium_cap_cents / 100.0, 'FM990.00'), public.shares_label(v_max_units)),
      v_quote,
      jsonb_build_object('max_units', v_max_units, 'premium_cap_cents', v_params.premium_cap_cents)
    );
  end if;
  if v_depth is not null and p_side = 'SELL' and v_inventory_after < -v_cap_units then
    v_max_units := greatest(v_inventory + v_cap_units, 0);
    return public.trade_rejection(
      'premium_cap',
      format('That would take the market price of %s more than %s points below the data, which is the limit. At most %s fits right now; the price returns toward the data every tick.',
             v_person.display_name, to_char(v_params.premium_cap_cents / 100.0, 'FM990.00'), public.shares_label(v_max_units)),
      v_quote,
      jsonb_build_object('max_units', v_max_units, 'premium_cap_cents', v_params.premium_cap_cents)
    );
  end if;
  v_premium_after := case when v_depth is null then 0 else public.market_premium_cents(v_inventory_after, v_depth) end;

  -- THE CIRCUIT BREAKER, before the fill: the premium move this order would
  -- complete, against the premium as it stood a window ago. Tripping it halts
  -- the person and refuses the order; the halt is recorded whatever happens
  -- to the order. Private individuals also have the total-price breaker.
  v_ref_at := v_now - make_interval(secs => v_params.breaker_window_seconds);
  v_ref_premium := public.premium_cents_at(p_person_id, v_ref_at);
  if abs(v_premium_after - v_ref_premium) > v_params.breaker_premium_cents then
    perform public.halt_person(
      p_person_id, v_params.breaker_halt_seconds,
      format('The premium moved %s points in %s minutes.', to_char(abs(v_premium_after - v_ref_premium) / 100.0, 'FM990.00'), v_params.breaker_window_seconds / 60),
      v_now, 'premium_breaker',
      jsonb_build_object('premium_after_cents', v_premium_after, 'premium_reference_cents', v_ref_premium,
                         'window_seconds', v_params.breaker_window_seconds, 'limit_cents', v_params.breaker_premium_cents,
                         'user_id', v_user_id, 'units', v_units, 'side', p_side));
    return public.trade_rejection(
      'halted',
      format('That order would move %s''s market price too far, too fast. Trading is halted for %s.', v_person.display_name, public.wait_text(v_params.breaker_halt_seconds)),
      v_quote,
      jsonb_build_object('halted_until', v_now + make_interval(secs => v_params.breaker_halt_seconds))
    );
  end if;
  if v_params.breaker_price_cents is not null then
    v_ref_price := public.index_cents_at(p_person_id, v_ref_at) + v_ref_premium;
    if abs(v_index_cents + v_premium_after - v_ref_price) > v_params.breaker_price_cents then
      perform public.halt_person(
        p_person_id, v_params.breaker_halt_seconds,
        format('The market price moved %s points in %s minutes.', to_char(abs(v_index_cents + v_premium_after - v_ref_price) / 100.0, 'FM990.00'), v_params.breaker_window_seconds / 60),
        v_now, 'price_breaker',
        jsonb_build_object('price_after_cents', v_index_cents + v_premium_after, 'price_reference_cents', v_ref_price,
                           'window_seconds', v_params.breaker_window_seconds, 'limit_cents', v_params.breaker_price_cents,
                           'user_id', v_user_id, 'units', v_units, 'side', p_side));
      return public.trade_rejection(
        'halted',
        format('That order would move %s''s market price too far, too fast. Trading is halted for %s.', v_person.display_name, public.wait_text(v_params.breaker_halt_seconds)),
        v_quote,
        jsonb_build_object('halted_until', v_now + make_interval(secs => v_params.breaker_halt_seconds))
      );
    end if;
  end if;

  -- Netting, in units: an order first closes the opposite side, then opens its own.
  v_close_direction := case when p_side = 'BUY' then 'LOW' else 'HIGH' end;
  v_open_direction  := case when p_side = 'BUY' then 'HIGH' else 'LOW' end;

  select coalesce(sum(l.open_units), 0) into v_closable_units
    from public.positions l
   where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction;

  v_close_units := least(v_units, v_closable_units);
  v_open_units  := v_units - v_close_units;

  -- THE GATE: a Sell may only open LOW when shorting is on for the platform
  -- AND allowed for this person (the tier's rule, or an explicit override).
  -- Read before the mode, so a Sell with nothing to close is told that.
  v_shorting := coalesce(v_settings.shorting_enabled, false) and v_params.shorting_allowed;
  if p_side = 'SELL' and v_open_units > 0 and not v_shorting then
    return public.trade_rejection(
      'exceeds_position',
      case when v_closable_units = 0
           then format('You hold no shares of %s. There is nothing to close.', v_person.display_name)
           else format('You hold %s of %s. A Sell can close at most that many.',
                       public.shares_label(v_closable_units), v_person.display_name) end,
      v_quote,
      jsonb_build_object('max_units', v_closable_units)
    );
  end if;

  -- DISPLAY-ONLY: the score is shown, nothing new is opened, what is held can be closed.
  if v_open_units > 0 and v_person.trading_mode = 'display_only' then
    return public.trade_rejection(
      'display_only',
      format('%s is display-only: the Momentum Score is shown, but new positions cannot be opened. Anything you already hold can still be closed.', v_person.display_name),
      v_quote,
      jsonb_build_object('max_units', v_closable_units)
    );
  end if;

  -- THE MINIMUM HOLD (risk lever 4, extended by the tier): the lots this close
  -- would touch, FIFO, must be older than the longer of the two.
  v_hold_seconds := greatest(coalesce(v_settings.close_cooldown_seconds, 0), v_params.min_hold_seconds);
  if v_close_units > 0 and v_hold_seconds > 0 then
    select max(extract(epoch from (t.opened_at + make_interval(secs => v_hold_seconds) - v_now)))
      into v_cooldown_wait
      from (
        select l.opened_at,
               coalesce(sum(l.open_units) over (order by l.opened_at, l.id rows between unbounded preceding and 1 preceding), 0) as units_before
          from public.positions l
         where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction
      ) t
     where t.units_before < v_close_units
       and t.opened_at > v_now - make_interval(secs => v_hold_seconds);
    if v_cooldown_wait is not null and v_cooldown_wait > 0 then
      return public.trade_rejection(
        'cooldown',
        format('Positions in %s must be held for %s. Wait %s more before closing this one.',
               v_person.display_name, public.wait_text(v_hold_seconds), public.wait_text(v_cooldown_wait)),
        v_quote,
        jsonb_build_object('wait_seconds', ceil(v_cooldown_wait)::integer, 'hold_seconds', v_hold_seconds)
      );
    end if;
  end if;

  -- The closing segment's money, on its own: the wallet is credited exactly
  -- this, allocated across the lots below.
  if v_close_units > 0 then
    v_close_gross := public.market_walk_cents(v_close_units, v_base, v_inventory, v_depth, v_walk, v_rounding);
  end if;

  -- RISK LEVER 3 — daily close value, at what the close would actually return.
  if v_close_units > 0 and p_side = 'SELL' then
    select coalesce(sum(c.proceeds_cents), 0) into v_daily_closed
      from public.position_closes c
     where c.user_id = v_user_id and c.closed_at > v_now - interval '24 hours';
    if v_daily_closed + v_close_gross > v_settings.max_daily_close_cents then
      return public.trade_rejection(
        'daily_limit',
        format('Daily close limit reached: $%s of $%s closed in the last 24 hours.',
               public.cents_to_dollars_text(v_daily_closed), public.cents_to_dollars_text(v_settings.max_daily_close_cents)),
        v_quote,
        jsonb_build_object('closed_today_cents', v_daily_closed, 'limit_cents', v_settings.max_daily_close_cents)
      );
    end if;
  end if;

  if v_open_units > 0 then
    select coalesce(sum(l.open_units), 0) into v_same_side_units
      from public.positions l
     where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_open_direction;

    -- RISK LEVER 1 — units per user per person.
    if v_same_side_units + v_open_units > v_settings.max_units_per_person then
      return public.trade_rejection(
        'max_units',
        format('That would take you past the limit of %s of one person.', public.shares_label(v_settings.max_units_per_person)),
        v_quote,
        jsonb_build_object('limit_units', v_settings.max_units_per_person, 'held_units', v_same_side_units)
      );
    end if;

    -- RISK LEVER 2 — share of open interest on the person.
    select coalesce(sum(l.open_units), 0) into v_total_side_units
      from public.positions l
     where l.person_id = p_person_id and l.is_open and l.direction = v_open_direction;
    if (v_same_side_units + v_open_units)::numeric / (v_total_side_units + v_open_units)::numeric > v_settings.max_open_interest_share then
      return public.trade_rejection(
        'open_interest',
        format('That would give you more than %s%% of all open shares of %s.',
               round(v_settings.max_open_interest_share * 100), v_person.display_name),
        v_quote,
        jsonb_build_object('limit_share', v_settings.max_open_interest_share)
      );
    end if;

    -- THE AGGREGATE EXPOSURE CAP: the platform's net book on the person
    -- (HIGH held minus LOW held, across every account) may not pass the tier's
    -- limit in either direction.
    select coalesce(sum(case when l.direction = 'HIGH' then l.open_units else -l.open_units end), 0) into v_net_holdings
      from public.positions l
     where l.person_id = p_person_id and l.is_open;
    if v_open_direction = 'HIGH' and v_net_holdings + v_open_units > v_params.aggregate_exposure_cap_units then
      v_max_units := greatest(v_params.aggregate_exposure_cap_units - v_net_holdings, 0);
      return public.trade_rejection(
        'exposure_cap',
        format('The platform''s exposure limit on %s has been reached. At most %s more can be opened right now.', v_person.display_name, public.shares_label(v_max_units)),
        v_quote,
        jsonb_build_object('max_units', v_max_units, 'cap_units', v_params.aggregate_exposure_cap_units, 'net_holdings_units', v_net_holdings)
      );
    end if;
    if v_open_direction = 'LOW' and -(v_net_holdings - v_open_units) > v_params.aggregate_exposure_cap_units then
      v_max_units := greatest(v_params.aggregate_exposure_cap_units + v_net_holdings, 0);
      return public.trade_rejection(
        'exposure_cap',
        format('The platform''s exposure limit on %s has been reached. At most %s more can be opened right now.', v_person.display_name, public.shares_label(v_max_units)),
        v_quote,
        jsonb_build_object('max_units', v_max_units, 'cap_units', v_params.aggregate_exposure_cap_units, 'net_holdings_units', v_net_holdings)
      );
    end if;

    -- THE BALANCE, against the opening segment: its own walk, from where the
    -- closing segment left the inventory, rounded up (a LOW open's collateral
    -- rounds up too).
    v_open_from := case when v_depth is null then 0 else v_inventory + case when p_side = 'BUY' then v_close_units else -v_close_units end end;
    v_cost := public.market_lot_amount_cents(v_open_direction, v_open_units, v_base, v_open_from, v_depth);
    -- The opening segment's share of the order's GROSS: a buy's is its cost;
    -- a sell's (a LOW open, gated off) is the segment rounded down, as every
    -- sell segment is, while the collateral it posts rounds up.
    v_open_gross := case when p_side = 'BUY' then v_cost else public.market_walk_cents(v_open_units, v_base, v_open_from, v_depth, 'down', 'floor') end;
    if v_cost > v_wallet then
      -- What the balance would cover, by the same search Dollars mode runs.
      v_lo := 0;
      v_hi := v_open_units;
      while v_lo < v_hi - 1 loop
        v_mid := (v_lo + v_hi) / 2;
        if public.market_lot_amount_cents(v_open_direction, v_mid, v_base, v_open_from, v_depth) <= v_wallet then
          v_lo := v_mid;
        else
          v_hi := v_mid;
        end if;
      end loop;
      v_affordable := v_lo + v_close_units;
      return public.trade_rejection(
        'insufficient_balance',
        format('%s of %s costs $%s. Your paper balance is $%s, enough for %s.',
               public.shares_label(v_open_units), v_person.display_name,
               public.cents_to_dollars_text(v_cost), public.cents_to_dollars_text(v_wallet),
               public.shares_label(v_affordable)),
        v_quote,
        jsonb_build_object('cost_cents', v_cost, 'balance_cents', v_wallet, 'max_units', v_affordable)
      );
    end if;
  end if;

  -- Every check has passed. From here everything is one transaction. --------
  insert into public.trade_orders (
    user_id, person_id, side, units, quoted_price_cents, fill_price_cents, gross_cents,
    opened_units, closed_units, requested_spend_cents, quantity_scale, surface, created_at,
    base_price_cents, inventory_before_units, inventory_after_units, premium_before_cents, premium_after_cents,
    depth_units, impact_cents, worst_fill_cents, cost_cents, proceeds_cents, fingerprint_hash
  )
  values (
    v_user_id, p_person_id, p_side, v_units, p_quoted_price_cents, v_avg, v_close_gross + v_open_gross,
    v_open_units, v_close_units, p_max_spend_cents, v_scale, left(p_surface, 40), v_now,
    v_base, v_inventory, v_inventory_after, v_premium, v_premium_after,
    v_depth, public.market_impact_cents(v_units, v_depth), v_worst, v_cost, 0, left(p_fingerprint_hash, 128)
  )
  returning id into v_order_id;

  -- Closes, FIFO, oldest lot first. THE BASIS SPLIT is Phase 27's; THE
  -- PROCEEDS SPLIT is its mirror: each partial lot takes floor(take / close
  -- units × the closing segment) and the last lot takes the exact remainder,
  -- so the lots' proceeds sum to the segment to the cent and P&L stays
  -- proceeds − basis by definition.
  v_remaining       := v_close_units;
  v_alloc_remaining := v_close_gross;
  for v_lot in
    select l.id, l.open_units, l.open_cost_cents, l.entry_price_cents, l.entry_premium_cents, l.entry_index_cents, l.direction
      from public.positions l
     where l.user_id = v_user_id and l.person_id = p_person_id and l.is_open and l.direction = v_close_direction
     order by l.opened_at, l.id
       for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_lot.open_units, v_remaining);
    v_take_cost := case when v_take = v_lot.open_units then v_lot.open_cost_cents
                        else floor(v_take::numeric * v_lot.open_cost_cents / v_lot.open_units)::bigint end;
    v_take_gross := case when v_take = v_remaining then v_alloc_remaining
                         else floor(v_take::numeric * v_close_gross / v_close_units)::bigint end;
    -- A HIGH lot returns its share of the walk. A LOW lot (shorting, gated
    -- off) returns twice its basis less its share of the buy-back, never
    -- below zero.
    v_lot_proceeds := case when v_lot.direction = 'HIGH' then v_take_gross
                           else greatest(2 * v_take_cost - v_take_gross, 0) end;
    v_pnl := v_lot_proceeds - v_take_cost;

    insert into public.position_closes (
      order_id, position_id, user_id, person_id, direction, units, entry_price_cents, exit_price_cents, cost_cents, proceeds_cents, pnl_cents, closed_at,
      exit_base_cents, exit_inventory_units, exit_premium_cents, exit_index_cents)
    values (
      v_order_id, v_lot.id, v_user_id, p_person_id, v_lot.direction, v_take, v_lot.entry_price_cents, v_avg, v_take_cost, v_lot_proceeds, v_pnl, v_now,
      v_base, v_inventory, v_premium, v_index_cents)
    returning id into v_close_id;

    update public.positions
       set open_units      = open_units - v_take,
           open_cost_cents = open_cost_cents - v_take_cost,
           is_open         = (open_units - v_take) > 0,
           closed_at       = case when open_units - v_take = 0 then v_now else closed_at end
     where id = v_lot.id;

    -- THE HOUSE BOOK for this close: the index's move and the premium's move,
    -- each rounded to the cent, and the residual (spreads, impacts, rounding)
    -- so the three sum exactly to −pnl.
    v_house_score   := -round(v_take::numeric * (v_index_cents - v_lot.entry_index_cents) * case when v_lot.direction = 'HIGH' then 1 else -1 end / 1000)::bigint;
    v_house_premium := -round(v_take::numeric * (v_premium - v_lot.entry_premium_cents) * case when v_lot.direction = 'HIGH' then 1 else -1 end / 1000)::bigint;
    insert into public.house_ledger (recorded_at, person_id, user_id, order_id, close_id, category, amount_cents, details)
    values
      (v_now, p_person_id, v_user_id, v_order_id, v_close_id, 'score_move', v_house_score,
       jsonb_build_object('units', v_take, 'entry_index_cents', v_lot.entry_index_cents, 'exit_index_cents', v_index_cents, 'direction', v_lot.direction)),
      (v_now, p_person_id, v_user_id, v_order_id, v_close_id, 'premium_change', v_house_premium,
       jsonb_build_object('units', v_take, 'entry_premium_cents', v_lot.entry_premium_cents, 'exit_premium_cents', v_premium, 'direction', v_lot.direction)),
      (v_now, p_person_id, v_user_id, v_order_id, v_close_id, 'spread_and_impact', -v_pnl - v_house_score - v_house_premium,
       jsonb_build_object('units', v_take, 'pnl_cents', v_pnl, 'cost_cents', v_take_cost, 'proceeds_cents', v_lot_proceeds));

    v_fills := v_fills || jsonb_build_object('position_id', v_lot.id, 'units', v_take, 'entry_price_cents', v_lot.entry_price_cents, 'pnl_cents', v_pnl, 'proceeds_cents', v_lot_proceeds);
    v_total_proceeds  := v_total_proceeds + v_lot_proceeds;
    v_total_pnl       := v_total_pnl + v_pnl;
    v_closed_units    := v_closed_units + v_take;
    v_remaining       := v_remaining - v_take;
    v_alloc_remaining := v_alloc_remaining - v_take_gross;
  end loop;

  if v_remaining <> 0 then
    -- Cannot happen under the wallet lock; if it ever does, nothing above survives.
    raise exception 'place_order: open lots changed while the order was running' using errcode = '40001';
  end if;

  -- Open, on its own segment of the curve. amount_cents is the rounded charge
  -- and open_cost_cents starts equal to it; the lot records every input its
  -- CHECK needs, and the premium and index at entry for the house book.
  if v_open_units > 0 then
    insert into public.positions (
      user_id, person_id, direction, amount_cents, open_cost_cents, entry_price_points, units, open_units, entry_price_cents, order_id, opened_at,
      entry_base_cents, entry_inventory_units, entry_depth_units, entry_premium_cents, entry_index_cents)
    values (
      v_user_id, p_person_id, v_open_direction, v_cost, v_cost,
      public.market_average_cents(v_open_units, v_base, v_open_from, v_depth, v_walk) * 0.01,
      v_open_units, v_open_units, public.market_average_cents(v_open_units, v_base, v_open_from, v_depth, v_walk), v_order_id, v_now,
      v_base, v_open_from, v_depth,
      case when v_depth is null then 0 else public.market_premium_cents(v_open_from, v_depth) end, v_index_cents)
    returning id into v_position_id;

    insert into public.transactions (user_id, type, amount_cents, person_id, order_id, created_at)
    values (v_user_id, 'ALLOCATION', v_cost, p_person_id, v_order_id, v_now);
  end if;

  if v_total_proceeds > 0 then
    insert into public.transactions (user_id, type, amount_cents, person_id, order_id, created_at)
    values (v_user_id, 'REDEMPTION', v_total_proceeds, p_person_id, v_order_id, v_now);
  end if;

  -- The balance: debit the cost, credit the proceeds. users_wallet_balance_nonneg is the backstop.
  update public.users
     set wallet_balance_cents = wallet_balance_cents - v_cost + v_total_proceeds,
         buying_power_cents   = wallet_balance_cents - v_cost + v_total_proceeds
   where id = v_user_id
   returning wallet_balance_cents into v_balance_after;

  -- THE DEALER MOVES: the inventory walks by the order's units, the premium
  -- follows, and the change is recorded. This is the only place a trade
  -- touches the people row, and current_score is not in it. A flat market
  -- (null depth) keeps no inventory and records nothing here.
  if v_depth is not null then
    update public.people
       set market_inventory_units = v_inventory_after,
           premium_cents          = v_premium_after
     where id = p_person_id;
    perform public.record_premium_change(p_person_id, v_now, 'trade', v_inventory, v_inventory_after, v_depth, v_person.current_score, null, v_order_id);
  end if;

  -- The tape (Phase 6): notional through the same rule as the charge. Since
  -- Phase 29 the Engine reads it for the market, never for the score.
  insert into public.trade_events (person_id, user_id, side, amount_cents, created_at)
  values (p_person_id, v_user_id, p_side, v_close_gross + v_open_gross, v_now);

  -- The detectors read the activity this order joined.
  perform public.run_surveillance(v_now, p_person_id, v_user_id, v_order_id, left(p_fingerprint_hash, 128));

  update public.trade_orders
     set proceeds_cents = v_total_proceeds, realized_pnl_cents = v_total_pnl, balance_after_cents = v_balance_after
   where id = v_order_id;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'id', v_order_id, 'person_id', p_person_id, 'side', p_side, 'units', v_units,
      'fill_price_cents', v_avg, 'gross_cents', v_close_gross + v_open_gross,
      'base_price_cents', v_base, 'worst_fill_cents', v_worst, 'impact_cents', public.market_impact_cents(v_units, v_depth),
      'premium_before_cents', v_premium, 'premium_after_cents', v_premium_after,
      'inventory_before_units', v_inventory, 'inventory_after_units', v_inventory_after, 'depth_units', v_depth,
      'units_per_share', public.units_per_share(),
      'requested_spend_cents', p_max_spend_cents, 'quantity_scale', v_scale,
      'opened_units', v_open_units, 'opened_direction', case when v_open_units > 0 then v_open_direction end,
      'position_id', v_position_id, 'cost_cents', v_cost,
      'closed_units', v_closed_units, 'proceeds_cents', v_total_proceeds, 'realized_pnl_cents', v_total_pnl,
      'fills', v_fills, 'created_at', v_now
    ),
    'balance_cents', v_balance_after,
    'position', public.position_summary_for(v_user_id, p_person_id),
    'quote', public.trade_quote(p_person_id)
  );
end;
$function$;

revoke execute on function public.place_order(uuid, text, bigint, bigint, text, bigint, text, text) from public, anon;
grant  execute on function public.place_order(uuid, text, bigint, bigint, text, bigint, text, text) to authenticated, service_role;

comment on function public.place_order(uuid, text, bigint, bigint, text, bigint, text, text) is
  'Phase 29: the one write path for a trade, priced on the market''s cost curve: a buy costs ceil(u·S/1000 + u·(2I+u)/(20·D)), a sell returns floor(u·S/1000 + u·(2I−u)/(20·D)), S the base side price, I the dealer inventory, D the tier''s depth. Behind, in order: frozen account, identity (when required), excluded party, halt, paused mode, order size vs depth, tolerance on the AVERAGE fill, minimum order, premium cap, the breakers, display-only mode, the shorting gate (platform AND tier), minimum hold, daily close limit, per-user and open-interest levers, the platform''s aggregate exposure cap, and the balance. Then one transaction: order, FIFO closes with basis and proceeds allocated to the cent, the lot, the ledger, the wallet, the dealer''s inventory and premium, premium_history, the house book, the tape, the detectors. Give p_units (Shares mode) or p_max_spend_cents (Dollars mode, a binary search over the curve), never both.';

-- ---------------------------------------------------------------------------
-- 12. The admin review queue: actions, each audit-logged
-- ---------------------------------------------------------------------------

create or replace function public.assert_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_admin boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  select u.is_admin into v_admin from public.users u where u.id = v_uid;
  if not coalesce(v_admin, false) then
    raise exception 'Not an admin' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function public.admin_freeze_account(p_user_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  update public.users set frozen_at = coalesce(frozen_at, now()), frozen_reason = left(p_reason, 500) where id = p_user_id;
  if not found then
    raise exception 'Unknown user %', p_user_id using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_user_id, note)
  values (v_actor, 'freeze_account', p_alert_id, p_user_id, left(p_reason, 500));
  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'frozen', true);
end;
$$;

create or replace function public.admin_unfreeze_account(p_user_id uuid, p_note text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
begin
  update public.users set frozen_at = null, frozen_reason = null where id = p_user_id;
  if not found then
    raise exception 'Unknown user %', p_user_id using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_user_id, note)
  values (v_actor, 'unfreeze_account', p_alert_id, p_user_id, left(p_note, 500));
  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'frozen', false);
end;
$$;

create or replace function public.admin_halt_person(p_person_id uuid, p_seconds integer, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_now   timestamptz := now();
begin
  if p_seconds is null or p_seconds <= 0 then
    raise exception 'p_seconds must be positive' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  perform public.halt_person(p_person_id, p_seconds, p_reason, v_now, 'admin_halt', jsonb_build_object('actor_id', v_actor), false);
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'halt_person', p_alert_id, p_person_id, left(p_reason, 500), jsonb_build_object('seconds', p_seconds, 'halted_until', v_now + make_interval(secs => p_seconds)));
  return jsonb_build_object('ok', true, 'person_id', p_person_id, 'halted_until', v_now + make_interval(secs => p_seconds));
end;
$$;

create or replace function public.admin_lift_halt(p_person_id uuid, p_note text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
begin
  update public.people set halted_until = null, halt_reason = null where id = p_person_id;
  if not found then
    raise exception 'Unknown person %', p_person_id using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note)
  values (v_actor, 'lift_halt', p_alert_id, p_person_id, left(p_note, 500));
  return jsonb_build_object('ok', true, 'person_id', p_person_id, 'halted_until', null);
end;
$$;

create or replace function public.admin_set_trading_mode(p_person_id uuid, p_mode text, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_before text;
begin
  if p_mode not in ('tradeable', 'display_only', 'paused') then
    raise exception 'p_mode must be tradeable, display_only or paused' using errcode = '22023';
  end if;
  select p.trading_mode into v_before from public.people p where p.id = p_person_id for update;
  if not found then
    raise exception 'Unknown person %', p_person_id using errcode = 'P0002';
  end if;
  update public.people set trading_mode = p_mode where id = p_person_id;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_person_id, note, details)
  values (v_actor, 'set_trading_mode', p_alert_id, p_person_id, left(p_reason, 500), jsonb_build_object('from', v_before, 'to', p_mode));
  return jsonb_build_object('ok', true, 'person_id', p_person_id, 'trading_mode', p_mode);
end;
$$;

create or replace function public.admin_add_excluded_party(p_user_id uuid, p_person_id uuid, p_reason text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_id    uuid;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  insert into public.excluded_parties (user_id, person_id, reason, added_by)
  values (p_user_id, p_person_id, left(p_reason, 500), v_actor)
  returning id into v_id;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_user_id, target_person_id, note, details)
  values (v_actor, 'add_excluded_party', p_alert_id, p_user_id, p_person_id, left(p_reason, 500), jsonb_build_object('excluded_party_id', v_id));
  return jsonb_build_object('ok', true, 'excluded_party_id', v_id);
end;
$$;

create or replace function public.admin_remove_excluded_party(p_excluded_party_id uuid, p_note text, p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
  v_row   record;
begin
  update public.excluded_parties
     set removed_at = now(), removed_by = v_actor, removal_note = left(p_note, 500)
   where id = p_excluded_party_id and removed_at is null
  returning user_id, person_id into v_row;
  if not found then
    raise exception 'No active excluded party %', p_excluded_party_id using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (actor_id, action, alert_id, target_user_id, target_person_id, note, details)
  values (v_actor, 'remove_excluded_party', p_alert_id, v_row.user_id, v_row.person_id, left(p_note, 500), jsonb_build_object('excluded_party_id', p_excluded_party_id));
  return jsonb_build_object('ok', true, 'excluded_party_id', p_excluded_party_id);
end;
$$;

create or replace function public.admin_resolve_alert(p_alert_id uuid, p_status text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.assert_admin();
begin
  if p_status not in ('reviewing', 'resolved', 'dismissed', 'open') then
    raise exception 'p_status must be open, reviewing, resolved or dismissed' using errcode = '22023';
  end if;
  if p_status in ('resolved', 'dismissed') and coalesce(trim(p_note), '') = '' then
    raise exception 'A note is required to resolve or dismiss' using errcode = '22023';
  end if;
  update public.alerts
     set status          = p_status,
         updated_at      = now(),
         resolved_at     = case when p_status in ('resolved', 'dismissed') then now() end,
         resolved_by     = case when p_status in ('resolved', 'dismissed') then v_actor end,
         resolution_note = case when p_status in ('resolved', 'dismissed') then left(p_note, 1000) else resolution_note end
   where id = p_alert_id;
  if not found then
    raise exception 'Unknown alert %', p_alert_id using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (actor_id, action, alert_id, note, details)
  values (v_actor, case when p_status = 'open' then 'reopen_alert' else 'resolve_alert' end, p_alert_id, left(p_note, 1000), jsonb_build_object('status', p_status));
  return jsonb_build_object('ok', true, 'alert_id', p_alert_id, 'status', p_status);
end;
$$;

revoke execute on function public.assert_admin()                                              from public, anon;
revoke execute on function public.admin_freeze_account(uuid, text, uuid)                       from public, anon;
revoke execute on function public.admin_unfreeze_account(uuid, text, uuid)                     from public, anon;
revoke execute on function public.admin_halt_person(uuid, integer, text, uuid)                 from public, anon;
revoke execute on function public.admin_lift_halt(uuid, text, uuid)                            from public, anon;
revoke execute on function public.admin_set_trading_mode(uuid, text, text, uuid)               from public, anon;
revoke execute on function public.admin_add_excluded_party(uuid, uuid, text, uuid)             from public, anon;
revoke execute on function public.admin_remove_excluded_party(uuid, text, uuid)                from public, anon;
revoke execute on function public.admin_resolve_alert(uuid, text, text)                        from public, anon;
grant  execute on function public.assert_admin()                                              to authenticated, service_role;
grant  execute on function public.admin_freeze_account(uuid, text, uuid)                       to authenticated, service_role;
grant  execute on function public.admin_unfreeze_account(uuid, text, uuid)                     to authenticated, service_role;
grant  execute on function public.admin_halt_person(uuid, integer, text, uuid)                 to authenticated, service_role;
grant  execute on function public.admin_lift_halt(uuid, text, uuid)                            to authenticated, service_role;
grant  execute on function public.admin_set_trading_mode(uuid, text, text, uuid)               to authenticated, service_role;
grant  execute on function public.admin_add_excluded_party(uuid, uuid, text, uuid)             to authenticated, service_role;
grant  execute on function public.admin_remove_excluded_party(uuid, text, uuid)                to authenticated, service_role;
grant  execute on function public.admin_resolve_alert(uuid, text, text)                        to authenticated, service_role;

comment on function public.assert_admin() is 'Phase 29: raises unless auth.uid() is an admin; returns the admin''s id. Every admin RPC calls it first.';
