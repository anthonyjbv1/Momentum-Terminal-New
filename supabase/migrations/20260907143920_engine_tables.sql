-- =============================================================================
-- Momentum Terminal — Phase 3 migration: Engine tables
--
-- * people.last_tick_at        when the Engine last updated the person (Gravity
--                              uses it for deltaHours)
-- * people.buy_price/sell_price generated columns: score +/- spread. Buy was
--                              "Allocate", Sell was "Redeem" on the old platform.
-- * engine_ticks               one row per Engine tick (monotonic tick_number,
--                              timing, counts, market mood, summary)
-- * score_events               per-force audit trail: one row per person per
--                              force per tick, zero-impact entries suppressed
-- * trade_events               live Buy/Sell tape the Trading Activity force
--                              reads (rolling 60s window vs 24h history). The
--                              trading flow of a later phase writes to it.
-- * apply_engine_tick(jsonb)   atomically persists a computed tick: people,
--                              score_history, score_events, signals, engine_ticks.
-- =============================================================================

-- people: tick bookkeeping + derived Buy / Sell prices ------------------------
alter table public.people
  add column last_tick_at timestamptz,
  add column buy_price    numeric generated always as (current_score + spread) stored,
  add column sell_price   numeric generated always as (current_score - spread) stored;

comment on column public.people.last_tick_at is 'When the Engine last updated this person. Null until the first tick.';
comment on column public.people.spread       is 'LMSR dynamic spread computed by the Engine each tick (base 0.50, max 1.50).';
comment on column public.people.buy_price    is 'Buy price = current_score + spread (generated). Buy was "Allocate" on the old platform.';
comment on column public.people.sell_price   is 'Sell price = current_score - spread (generated). Sell was "Redeem" on the old platform.';

-- engine_ticks ----------------------------------------------------------------
create table public.engine_ticks (
  id                uuid        primary key default gen_random_uuid(),
  tick_number       bigint      not null unique,
  started_at        timestamptz not null,
  finished_at       timestamptz not null,
  people_updated    integer     not null default 0,
  signals_processed integer     not null default 0,
  mood              numeric     not null default 0,
  summary           jsonb,
  created_at        timestamptz not null default now(),

  constraint engine_ticks_tick_number_positive check (tick_number > 0)
);

comment on table  public.engine_ticks is 'One row per Engine tick. tick_number is monotonic and shared by score_history / score_events rows of that tick.';
comment on column public.engine_ticks.mood is 'Market Mood this tick: platform-wide average Signals movement, before the per-person fraction is applied.';

-- score_events ----------------------------------------------------------------
create table public.score_events (
  id          uuid        primary key default gen_random_uuid(),
  tick_number bigint      not null references public.engine_ticks (tick_number) on delete cascade,
  person_id   uuid        not null references public.people (id) on delete cascade,
  force       text        not null,
  impact      numeric     not null,
  details     jsonb,
  created_at  timestamptz not null default now(),

  constraint score_events_force_check   check (force in ('gravity', 'signals', 'market_mood', 'conviction', 'trading_activity', 'inverse_pair')),
  constraint score_events_impact_nonzero check (impact <> 0)
);

-- tick_number is the leading column of the second index; person lookups use the first.
create index score_events_person_tick_idx on public.score_events (person_id, tick_number desc);
create index score_events_tick_number_idx on public.score_events (tick_number);

comment on table  public.score_events is 'Per-force audit trail of every score change. Zero-impact forces are never logged (enforced by check).';
comment on column public.score_events.force is 'gravity | signals | market_mood | conviction | trading_activity | inverse_pair';

-- trade_events ----------------------------------------------------------------
create table public.trade_events (
  id           uuid        primary key default gen_random_uuid(),
  person_id    uuid        not null references public.people (id) on delete cascade,
  user_id      uuid        references public.users (id) on delete set null,
  side         text        not null,
  amount_cents bigint      not null,
  created_at   timestamptz not null default now(),

  constraint trade_events_side_check      check (side in ('BUY', 'SELL')),
  constraint trade_events_amount_positive check (amount_cents > 0)
);

create index trade_events_person_created_idx on public.trade_events (person_id, created_at desc);
create index trade_events_user_id_idx        on public.trade_events (user_id);

comment on table public.trade_events is 'Live Buy/Sell tape in integer cents. Written by the trading flow (later phase), read by the Trading Activity force.';

-- RLS -------------------------------------------------------------------------
alter table public.engine_ticks enable row level security;
alter table public.score_events enable row level security;
alter table public.trade_events enable row level security;

create policy engine_ticks_select_authenticated
  on public.engine_ticks for select
  to authenticated
  using (true);

create policy score_events_select_authenticated
  on public.score_events for select
  to authenticated
  using (true);

create policy trade_events_select_own
  on public.trade_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.engine_ticks, public.score_events, public.trade_events from anon, authenticated;

-- -----------------------------------------------------------------------------
-- apply_engine_tick — atomic persistence of one computed tick.
--
-- Called only by the Engine (service role). Payload shape:
-- {
--   "expected_tick_number": 12,            -- optional concurrency guard
--   "started_at": "...", "finished_at": "...", "mood": 0.01, "summary": {...},
--   "people":  [{ "id": uuid, "score": 51.2, "spread": 0.5 }],
--   "signals": [{ "id": uuid, "impact_score": 1.2, "sentiment_label": "positive", "sentiment_confidence": 0.8 }],
--   "events":  [{ "person_id": uuid, "force": "gravity", "impact": 0.05, "details": {...} }]
-- }
-- Everything succeeds or nothing does, so a signal can never be applied to a
-- score without also being marked processed (which would double-count it).
-- -----------------------------------------------------------------------------
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

  update public.people p
     set current_score = x.score,
         spread        = x.spread,
         last_tick_at  = v_finished_at
    from jsonb_to_recordset(coalesce(p_tick -> 'people', '[]'::jsonb)) as x(id uuid, score numeric, spread numeric)
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

  update public.engine_ticks
     set people_updated = v_people_updated, signals_processed = v_signals_processed
   where tick_number = v_tick_number;

  return jsonb_build_object(
    'tick_number', v_tick_number,
    'people_updated', v_people_updated,
    'history_rows', v_history_rows,
    'score_events', v_events,
    'signals_processed', v_signals_processed
  );
end;
$$;

comment on function public.apply_engine_tick(jsonb) is
  'Atomically persists one Engine tick (people scores + spread, score_history, score_events, processed signals, engine_ticks). Service role only.';

revoke execute on function public.apply_engine_tick(jsonb) from public, anon, authenticated;
grant  execute on function public.apply_engine_tick(jsonb) to service_role;
