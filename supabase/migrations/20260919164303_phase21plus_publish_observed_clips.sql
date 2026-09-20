-- =============================================================================
-- Momentum Terminal — Phase 21+: clips_per_stream_hour opts in too.
--
-- The previous migration set publish_observed on six metrics and landed five.
-- It looked for clips_per_stream_hour under config.live.metrics, on the
-- assumption that Phase 16's session metrics were declared inside the live
-- block. They are not: the twitch row declares all five of its metrics —
-- follower_count, stream_days_7d, stream_hours_7d, session_peak_viewers and
-- clips_per_stream_hour — under config.metrics, and config.live carries only
-- the live-mode switches. The guarded WHERE made the miss silent rather than
-- an error, which is what a guard is for.
--
-- clips_per_stream_hour is a count of public artifacts off a public stream,
-- the same category as hours streamed, so it opts in on the same reasoning.
-- session_peak_viewers stays out: an audience size is not a count of items.
-- =============================================================================

update public.data_sources
   set config = jsonb_set(config, '{metrics,clips_per_stream_hour,publish_observed}', 'true'::jsonb)
 where name = 'twitch' and config->'metrics' ? 'clips_per_stream_hour';
