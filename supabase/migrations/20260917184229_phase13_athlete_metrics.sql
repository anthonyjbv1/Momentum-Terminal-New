-- =============================================================================
-- Momentum Terminal — Phase 13+: athlete metrics beyond passing yards.
--
-- Two more per-game figures for Patrick Mahomes, read from the same per-game
-- statistics response the connector already fetches once per finished game:
--
--   game_passer_rating   polarity +1. The performance metric: the league's own
--                        composite of completion rate, yards per attempt,
--                        touchdown rate and interception rate, bounded
--                        0–158.3, so a bad line reads negative on its own.
--   game_interceptions   polarity −1. The one axis the rating formula dampens
--                        (its interception term saturates), discrete, and the
--                        failure a bad game announces itself with.
--
-- game_passing_yards stays as it was (volume, polarity +1). Passing
-- touchdowns are NOT registered: the rating already carries the touchdown
-- rate and the game-result event already carries the scoring, so a fourth
-- reading would be one more copy of the same performance. Composite values
-- ("15/27" completions/attempts, "2-12" sacks/yards lost) are never
-- registered: the connector's parser refuses anything that is not a plain
-- number, so a config entry pointing at one fails the poll out loud.
--
-- WHERE EACH LIVES. config.game_stats maps a metric key to the group and
-- statistic name in the per-game response (verified live on 2026-09-17: the
-- Passing group carries "yards", "rating" and "interceptions" as plain
-- numeric strings). The connector reads every key from ONE request per game,
-- each key keeping its own anchor, so the two new metrics backfill Week 1 on
-- the next poll and stay in step with yards from then on.
--
-- ONE GAME, ONE READING. Three figures of one game are one performance, not
-- three pieces of evidence. The Engine's Signals force folds metric signals
-- from one source that share an occurred_at into one reading carrying the
-- MEAN of their impacts, before the per-source cap, so a game contributes
-- its event and its stat line and never three correlated copies of the line
-- (lib/engine/forces/signals.ts, config.signals.oneReadingPerMetricMoment).
--
-- MIN_SAMPLES STAYS 8 FOR ALL THREE. The sample count is the number of games
-- and is the same for every per-game figure; what differs between them is
-- the noise, and that is the sd floor's job, not the minimum's. Eight games
-- is early-to-mid November whichever figure is asked.
--
-- SD FLOORS. Rating: 12 points — a starter's game-to-game rating varies by
-- 25 to 35 points, so the floor only guards a run of near-identical games.
-- Interceptions: 1.0 — an integer 0..4 whose mean sits near 0.7; without the
-- floor a month of clean games has a sigma near zero and one interception
-- reads as a catastrophe. Scales: rating 1.0 (the performance figure),
-- interceptions 0.7 (it announces; the rating measures), yards 0.8 unchanged.
--
-- Merged onto the row's existing config (host, paths, team id, lookups and
-- the yards declaration untouched), so re-running it changes nothing.
-- =============================================================================
update public.data_sources
   set config = config
     || jsonb_build_object(
          'game_stats', jsonb_build_object(
            'game_passing_yards', jsonb_build_object('group', 'Passing', 'name', 'yards'),
            'game_passer_rating', jsonb_build_object('group', 'Passing', 'name', 'rating'),
            'game_interceptions', jsonb_build_object('group', 'Passing', 'name', 'interceptions')
          ),
          'metrics', coalesce(config->'metrics', '{}'::jsonb)
            || jsonb_build_object(
                 'game_passer_rating', jsonb_build_object(
                   'label', 'passer rating per game',
                   'delta', 'level',
                   'polarity', 1,
                   'baseline_window_hours', 1680,
                   'min_samples', 8,
                   'sd_floor', 12.0,
                   'scale', 1.0
                 ),
                 'game_interceptions', jsonb_build_object(
                   'label', 'interceptions per game',
                   'delta', 'level',
                   'polarity', -1,
                   'baseline_window_hours', 1680,
                   'min_samples', 8,
                   'sd_floor', 1.0,
                   'scale', 0.7
                 )
               )
        )
 where name = 'apisports';
