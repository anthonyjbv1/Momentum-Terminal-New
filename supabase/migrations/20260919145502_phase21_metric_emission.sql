-- =============================================================================
-- Momentum Terminal — Phase 21: a metric describes a state, and the event is
-- the state CHANGING.
--
-- Two schema consequences of the emission rule. Neither changes any force's
-- weight or behaviour; both change what reaches the pipeline at all.
--
-- 1. A NEW OUTCOME, 'unchanged'.
--
-- A metric reading outside the deadband that repeats the reading already on
-- the record is the same fact told again, not a second fact. From Phase 21 the
-- runner suppresses it and records it as 'unchanged': the reading is on the
-- ledger with its level, its baseline statistics and its sigma exactly as
-- before, and it produced no signal. The outcome is also what the NEXT reading
-- compares itself against — a run of identical readings collapses to its
-- first, because every repeat after the first is itself 'on the record' — so
-- the column is load-bearing, not only descriptive.
--
-- 'inside_band' still means normal. 'unchanged' means unusual and already
-- said. Telling them apart is the whole point of a second value.
--
-- 2. comment_volume BECOMES OBSERVE-ONLY.
--
-- The metric is the total comment count across the three most recent uploads
-- of a channel. That is a sum over a CHANGING BASKET: when a new video
-- replaces the oldest of the three, the total steps by the difference between
-- them, and nothing about the audience changed. MrBeast's stepped from 179,354
-- to 88,049 on 2026-09-18 for exactly that reason, and the metric is declared
-- delta 'level' against a 336-hour baseline, so every poll since has been
-- judged against the mean of a basket that no longer exists. It emitted on
-- 78.2% of its observations — 79 of 101, the highest rate of any metric on the
-- board — every one of them a negative reading of a person whose comment
-- volume had not fallen.
--
-- This is NOT thin data and it is not a threshold problem: 104 samples against
-- a declared minimum of 24, and neither of Phase 21's other two changes helps.
-- The level moves every poll, so emit-on-change never fires (79 of 79 survive
-- it); the 2.0σ deadband only delays the emission while the old basket ages
-- out of the window (sigma has been walking back from −2.79 toward the band at
-- about 0.05 an hour, and the next upload restarts it).
--
-- The fix is a CONNECTOR change to a basket-stable definition — comments per
-- video, or a fixed cohort of videos followed over time — which is a new
-- metric with its own baseline to fill, and out of this phase's scope. Until
-- then the figure is recorded and scores nothing: config.observe_only is read
-- by the runner before any observation is taken, so the reading becomes a raw
-- snapshot and reaches no observation, signal, force, memory or score history.
-- The declaration comes out of config.metrics with it, because the declaration
-- that exists is the one that misdescribes the metric; the honest state of the
-- row is "recorded, not yet defined".
--
-- Turning it back on is this row and no deploy: drop the key from
-- observe_only and declare the NEW definition under metrics.
-- =============================================================================

alter table public.raw_metric_observations
  drop constraint raw_metric_observations_outcome_check;

alter table public.raw_metric_observations
  add constraint raw_metric_observations_outcome_check
  check (outcome in ('no_config', 'first_contact', 'insufficient_baseline', 'inside_band', 'unchanged', 'emitted'));

comment on column public.raw_metric_observations.outcome is
  'What became of the reading. no_config: the metric is not declared. first_contact: nothing to compare against yet. insufficient_baseline: fewer samples than the metric asks for. inside_band: within the deadband, so normal. unchanged (Phase 21): outside the band but identical to the reading already on the record, so suppressed as a repeat — and itself on the record, which is what collapses a run to its first. emitted: a signal was created.';

update public.data_sources
   set config = (config - 'metrics') || jsonb_build_object('metrics', '{}'::jsonb, 'observe_only', '["comment_volume"]'::jsonb)
 where name = 'youtube_comments';
