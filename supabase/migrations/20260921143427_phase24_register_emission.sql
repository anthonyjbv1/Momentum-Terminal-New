-- =============================================================================
-- Momentum Terminal — Phase 24: a metric emits when its REGISTER changes.
--
-- WHAT THE FIRST LIVE GAME SHOWED. Sunday Night Football, 2026-09-21. Between
-- 00:00 and 14:01 UTC, Patrick Mahomes' two news metrics produced 39 metric
-- signals — "Coverage of Patrick Mahomes is running hot" roughly every
-- fifteen minutes — because a trailing-24h count genuinely ticks 56, 57, 58
-- through a big afternoon. Phase 21's emit-on-change compares the observed
-- QUANTITY, so it collapses a flat number and is defeated by a rising one:
-- the rule works on quiet days and fails on exactly the days that matter.
--
-- This is not a Feed problem. Each emission is a metric signal feeding the
-- Signals force, so it is the Phase 20 re-reporting finding — 71% of the
-- force being unchanged state — returning in a new shape on the busiest days.
-- Measured over that window: metric signals carried 9.30 of the 18.21 the
-- Signals force moved (51.1%); events carried 10.11.
--
-- THE RULE. A reader cannot tell 2.6σ from 2.7σ and should not be asked to.
-- What they can tell is coverage going from "running hot" to "56 stories
-- today — 2x their usual pace" and back, and that transition is the event. So
-- an observation now records the REGISTER it left on the record, and a
-- reading that lands in the same band is the same fact told again. Held with
-- hysteresis (0.25σ, from the board's own step sizes) so a sigma wobbling
-- across a boundary does not chatter. The rule lives in
-- lib/signals/register.ts; this migration is the ledger that makes it
-- stateful across polls.
--
-- MEASURED BEFORE SHIPPING, by replaying the rule over the stored ledger:
--   Mahomes, that window:  39 emissions -> 7; Signals force 18.21 -> 11.10
--   Board-wide, 7 days:  2,074 emissions -> 220, a cut of 89%
--
-- NOTHING STORED IS REWRITTEN. Rows written before this carry a null
-- register, which reads as "no band on the record": the first reading after
-- the deploy emits on its own register and the rule engages from there.
-- =============================================================================

alter table public.raw_metric_observations
  add column register text;

comment on column public.raw_metric_observations.register is
  'Phase 24: the register band (quiet | elevated | concrete | spiking) this observation left on the record, held with hysteresis. The NEXT reading of the same metric is judged against it: same band, same fact, no signal. Null when the observation left no band (no config, no baseline, or inside the deadband) and on every row written before Phase 24.';

alter table public.raw_metric_observations
  add constraint raw_metric_observations_register_check
  check (register is null or register in ('quiet', 'elevated', 'concrete', 'spiking'));

-- `same_register` joins `unchanged` as a reason a reading outside the deadband
-- produced no signal. Two distinct facts, both worth a ledger row: `unchanged`
-- is the connector returning the same number, `same_register` is a different
-- number that is called the same thing.
alter table public.raw_metric_observations
  drop constraint raw_metric_observations_outcome_check;

alter table public.raw_metric_observations
  add constraint raw_metric_observations_outcome_check
  check (outcome in ('no_config', 'first_contact', 'insufficient_baseline', 'inside_band', 'unchanged', 'same_register', 'emitted'));

comment on column public.raw_metric_observations.outcome is
  'What became of the reading: no_config | first_contact | insufficient_baseline | inside_band | unchanged (Phase 21: the same number as the record) | same_register (Phase 24: a different number in the same band as the record) | emitted.';
