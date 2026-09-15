-- =============================================================================
-- The same interval defect, on a dormant row.
--
-- The previous migration moved the three sources that were actively losing the
-- race off the multiple of sixty. Extending the test to EVERY active source
-- then turned up a fourth: `spotify`, still at 60.
--
-- It is inactive in production, so it was not costing anything — but it is
-- ACTIVE in the migrations, which means a database rebuilt from this directory
-- gets a spotify row polling every second hour, and whenever spotify is turned
-- back on in production it would start doing the same silently. A known trap
-- left armed on a row somebody will eventually flip is worse than the two
-- minutes it costs to disarm it now.
--
-- (Worth recording separately: production has spotify.is_active = false while
-- these migrations leave it true. That drift predates this phase and is not
-- corrected here — it is reported, not changed.)
-- =============================================================================

update public.data_sources
   set poll_interval_minutes = 55
 where name = 'spotify'
   and poll_interval_minutes % 60 = 0;
