-- =============================================================================
-- Momentum Terminal — the poll interval that halved three baselines.
--
-- THE DEFECT. The ingestion runner skips a source when
--
--     minutes since last poll < poll_interval_minutes
--
-- and the hourly Vercel cron fires on the hour. The previous run's poll lands a
-- few seconds AFTER its own fire, so an hour later the check measures 59-point-
-- something minutes, not 60. A source whose interval is exactly 60 therefore
-- loses that race every single time: it polls, skips the next hour, polls,
-- skips. rss, youtube and youtube_comments were all registered at 60 and have
-- been sampling every SECOND hour since the ingestion cron went on — thirteen
-- readings across a 37.4-hour span, one every ~2.9h, against baselines
-- configured on the assumption of hourly samples.
--
-- Nothing surfaced it. Every poll that ran returned ok, every skipped run
-- recorded its reason honestly, and the admin console read it as ordinary
-- accumulation, because a sample count rising half as fast as expected looks
-- exactly like a sample count rising.
--
-- THE FIX. 55 minutes: off the multiple of 60, so the comparison is 59 > 55 and
-- every hourly fire polls, with five minutes of slack for cron jitter. The same
-- value the Phase 10 twitch row already carries. apisports stays at 175, which
-- is deliberate — off the multiple, and every third hour is right for a weekly
-- sport on a 100-request daily quota.
--
-- This is configuration, so it is a migration and not a one-off edit: a rebuilt
-- database must not silently inherit the old behaviour. A test
-- (lib/ingest/privacy.db.test.ts) now holds all five active sources off the
-- multiple so this cannot regress.
--
-- No metric declaration, weight, cost control or cron flag is touched here.
-- =============================================================================

update public.data_sources
   set poll_interval_minutes = 55
 where name in ('rss', 'youtube', 'youtube_comments')
   and poll_interval_minutes % 60 = 0;
