-- =============================================================================
-- Momentum Terminal — Phase 14: the drifting Gravity target, and two small
-- configuration items from the queue.
--
-- THE DRIFTING TARGET. After the first 24-hour Engine run every score sat
-- within two points of its seeded revert_target and the board was a
-- ranking of seeds. Gravity's target is now the seed PLUS an offset the
-- Engine moves over weeks from sustained signal evidence (config.targetDrift:
-- half-life 336 h, bound ±8 points, full coverage at 0.2 points of Signals
-- impact an hour), behind ENGINE_TARGET_DRIFT_ENABLED, which ships off.
--
-- The state lives on the people row, written by the tick:
--   target_attention   trailing gross Signals impact per hour (null: never measured)
--   target_direction   trailing signed Signals impact per hour (null: never measured)
--   target_offset      the points added to revert_target; 0 while the drift is off
-- Gravity's target is revert_target + target_offset, and every read of the
-- target (Home, the profile, the console) adds the two. revert_target itself
-- is untouched: it stays the seed, the centre of the band.
--
-- With the switch off the tick writes null, null, 0: nothing accumulates in
-- the dark, and turning the switch on later starts every target at its seed.
-- =============================================================================
alter table public.people
  add column if not exists target_attention numeric,
  add column if not exists target_direction numeric,
  add column if not exists target_offset    numeric not null default 0;

comment on column public.people.revert_target    is 'The SEED of the Gravity target (0–100): the centre of the drifting target''s band. Gravity pulls toward revert_target + target_offset.';
comment on column public.people.target_attention is 'Drifting target (Phase 14): trailing gross Signals impact per hour, half-life config.targetDrift.halfLifeHours. Null until the drift has measured the person.';
comment on column public.people.target_direction is 'Drifting target (Phase 14): trailing signed Signals impact per hour, same half-life. Null until the drift has measured the person.';
comment on column public.people.target_offset    is 'Drifting target (Phase 14): the points the Engine adds to revert_target, within ±config.targetDrift.bound. 0 while ENGINE_TARGET_DRIFT_ENABLED is off.';

-- The Engine tick writes the drift state beside the score. Body as in
-- 20260912153309 plus the three columns; a payload without them (an older
-- Engine) writes null, null, 0, which is the dormant state.
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

  -- Portfolio value snapshots at this tick's quotes (Phase 6f): one row per
  -- user holding a position, marked at the Sell / Buy quotes just written.
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
    'portfolio_snapshots', v_snapshots
  );
end;
$$;

comment on function public.apply_engine_tick(jsonb) is
  'Atomically persists one Engine tick (people scores, spread and the drifting target''s state, score_history, score_events, processed signals, engine_ticks) and records every position-holding user''s portfolio value at the new quotes. Service role only.';

-- Two idle sources still on the exact hour ----------------------------------
-- forbes and newsdata are inactive, but an interval that is a multiple of
-- the fifteen-minute cron period loses the "minutes since last poll <
-- interval" race on every fire and would poll at half its stated rate the
-- moment either is switched on. 55, like every other source that polls
-- about hourly.
update public.data_sources
   set poll_interval_minutes = 55
 where name in ('forbes', 'newsdata')
   and poll_interval_minutes = 60;

-- Two SECURITY DEFINER trigger functions executable by anon ------------------
-- Flagged by the security advisor in Phase 9. A trigger function is invoked
-- by its trigger, never as an RPC, and neither has a meaningful effect when
-- called directly (both return null outside a trigger context), but
-- "probably cannot be called" is weaker than "cannot be called". Triggers
-- do not check EXECUTE at fire time, so both keep firing; place_order()
-- runs as its definer regardless.
revoke execute on function public.positions_enforce_direction()      from public, anon, authenticated;
revoke execute on function public.trade_orders_snapshot_portfolio()  from public, anon, authenticated;
