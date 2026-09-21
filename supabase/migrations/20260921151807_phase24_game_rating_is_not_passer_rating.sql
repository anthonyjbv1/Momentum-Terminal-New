-- =============================================================================
-- Momentum Terminal — Phase 24: "rating" is NOT the league's passer rating.
--
-- Phase 13+ registered game_passer_rating on the assumption that the host's
-- `rating` field was the NFL passer rating — "the league's own composite ...
-- bounded 0-158.3" — and set an sd floor of 12.0 for that range. The
-- assumption is wrong, and the API's own numbers settle it. Both games the
-- board has recorded:
--
--   Week 1  15/27, 184 yds, 2 TD, 1 INT   passer rating  86.0   host said 50.2
--   Week 2  32/47, 382 yds, 3 TD, 0 INT   passer rating 114.0   host said 78.6
--
-- The Week 2 line was read straight off the diagnostics note on the 15:00
-- poll of 2026-09-21: comp att="32/47", yards="382", average="8.1",
-- passing touch downs="3", interceptions="0", sacks="2-11", rating="78.6".
-- Computing the league formula on those inputs gives 114.0, not 78.6. It is
-- not the passer rating, and two games agree.
--
-- WHAT IT IS, HONESTLY. Not established. Both values sit inside 0-100, which
-- fits ESPN's Total QBR, and QBR was the standing hypothesis. It is NOT
-- adopted as the name, for two reasons. QBR is proprietary and derived from
-- play-by-play expected points, so it cannot be recomputed and checked, and
-- API-Sports is not ESPN. And the two readings sit 35.8 and 35.4 below the
-- passer rating of the same lines — a slope of essentially one with a
-- constant offset, which is what a transform of the SAME box-score inputs
-- looks like and is not what an independent play-by-play metric looks like.
-- Two points cannot establish a formula; they are enough to refuse a name
-- that claims one.
--
-- So the metric is renamed to what is actually known: `game_rating`, the
-- host's own rating figure, observed inside 0-100. The key matches the field
-- name in the response exactly and claims nothing beyond it.
--
-- THE SD FLOOR, RE-DERIVED. 12.0 was chosen as a floor for a 0-158.3 scale.
-- The proportional equivalent on 0-100 is 7.6; it is set to 8.0. A floor
-- exists so that a player who happens to be consistent over the sample
-- cannot manufacture a large sigma out of a small spread, and 8.0 on a
-- 0-100 scale is the same fraction of the range 12.0 was of the old one.
-- With two readings the observed spread is 14.2, comfortably above it.
--
-- THE COST OF DOING THIS NOW IS NOTHING, which is the whole reason to. The
-- metric needs eight games and has two, so it has never emitted a signal and
-- has never touched a score. The two stored readings are carried across to
-- the new key rather than orphaned, so no game is lost.
-- =============================================================================

update public.data_sources
   set config = jsonb_set(
         jsonb_set(
           config,
           '{game_stats}',
           (config -> 'game_stats') - 'game_passer_rating'
             || jsonb_build_object('game_rating', jsonb_build_object('group', 'Passing', 'name', 'rating'))
         ),
         '{metrics}',
         (config -> 'metrics') - 'game_passer_rating'
           || jsonb_build_object('game_rating', jsonb_build_object(
                'label', 'passing rating per game',
                'polarity', 1,
                'delta', 'level',
                'baseline_window_hours', 1680,
                'min_samples', 8,
                -- Re-derived for a 0-100 scale; see the header.
                'sd_floor', 8.0,
                'scale', 1.0
              ))
       )
 where name = 'apisports';

-- The two readings this metric has, carried across so the games survive the
-- rename. Both are 'insufficient_baseline': neither ever produced a signal.
update public.raw_metric_observations o
   set metric_key = 'game_rating'
  from public.data_sources d
 where d.id = o.data_source_id and d.name = 'apisports' and o.metric_key = 'game_passer_rating';

update public.raw_source_snapshots s
   set metric_key = 'game_rating'
  from public.data_sources d
 where d.id = s.data_source_id and d.name = 'apisports' and s.metric_key = 'game_passer_rating';

-- The diagnostic has answered its question; the note is noise on every poll
-- from here. The headline statistics it confirmed stay read.
update public.data_sources
   set config = config - 'diagnostics'
 where name = 'apisports';
