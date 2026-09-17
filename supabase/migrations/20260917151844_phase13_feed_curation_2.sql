-- =============================================================================
-- Momentum Terminal — Phase 13 curation, second round.
--
-- The rows the first curation re-pointed to discovery were fetched on the
-- 15:15 UTC fire. Bleacher Report declares its feed in the head of its NFL
-- section — 571 dated items across every sport; the name match selects and
-- the per-feed cap keeps the newest fifty — and is promoted. HipHopDX,
-- Rap-Up, the Toronto Star and both USA Today pages declared nothing in the
-- head, linked nothing feed-like and answered nothing at the conventional
-- paths, and are switched off with the finding in the note. The Kansas City
-- Star rows (feed and discovery) timed out on three consecutive fetches and
-- are left to the connector's backoff rather than switched off: the home
-- paper is worth one request every few hours.
-- =============================================================================

update public.publisher_feeds set url = 'https://feeds.bleacherreport.com/articles', mode = 'feed', section = 'All', topics = '{nfl,sports}', last_status = null, discovered_url = null, consecutive_failures = 0, etag = null, last_modified = null,
       note = 'Discovered 2026-09-17 in the head of bleacherreport.com/nfl: 571 dated items across every sport.' where url = 'https://bleacherreport.com/nfl';

update public.publisher_feeds set is_active = false, note = 'No feed found 2026-09-17 on the homepage either: nothing declared, no feed-like anchor, nothing at the conventional paths. rss/news.xml still answers but stopped updating in April 2026.' where url = 'https://hiphopdx.com/';
update public.publisher_feeds set is_active = false, note = 'No feed found 2026-09-17: /feed/ answers with an HTML page and the homepage declares nothing.' where url = 'https://www.rap-up.com/';
update public.publisher_feeds set is_active = false, note = 'No feed found 2026-09-17: the homepage answered 429 on the first fetch and declares nothing on the second.' where url = 'https://www.thestar.com/';
update public.publisher_feeds set is_active = false, note = 'No feed found 2026-09-17: rssfeeds.usatoday.com answers with an HTML page and the site declares nothing in the head or at the conventional paths.' where url in ('https://www.usatoday.com/', 'https://www.usatoday.com/sports/nfl/');
