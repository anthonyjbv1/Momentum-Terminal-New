-- =============================================================================
-- Momentum Terminal — Phase 13 curation: what the first production fetch found.
--
-- The catalogue seeded by 20260917142813 was a list of CANDIDATES: nothing in
-- the session that wrote it could reach a publisher, so no feed was asserted
-- to work. The first poll after deploy (2026-09-17 14:45 UTC) fetched all 94
-- rows from production and wrote back what it found. This migration applies
-- those findings to the rows, so a rebuilt database inherits the curation and
-- not the guesswork. Every status named below was measured by the runner.
--
--   63 of 69 feed rows answered with a feed of dated items (every item dated,
--      every item carrying a body: none of them is headline-only).
--   13 of 25 discovery pages declared or linked a feed with dated items;
--      9 of those are promoted here, 4 duplicated a feed already in the
--      catalogue and are switched off.
--   Refused outright, by HTTP status, on the homepage: AP (403), Bloomberg
--      (403), Reuters (401), People (402), IGN's homepage (403; its feedburner
--      feed works). Nothing found behind: Campaign, KCTV5, NFL.com, REVOLT,
--      The Ringer.
--   Feed addresses that answered with an HTML page (rap-up.com/feed,
--      both rssfeeds.usatoday.com addresses) or a 404 (Bleacher Report's tag
--      feed) become discovery rows on the outlet's pages. HipHopDX's
--      rss/news.xml answers but its newest item is from April; discovery on
--      the homepage instead.
--   Stale feeds switched off: NYT Pro Football (newest July; the desk moved to
--      The Athletic, whose NFL feed is promoted), WSJ Technology (newest
--      January). Tubefilter's feed answers 403 to an automated fetch.
--   Left to the connector's own backoff: the Kansas City Star feed (timed
--      out) and the Toronto Star page (429), both plausibly transient.
-- =============================================================================

-- Promotions: discovery found a feed with dated items behind these pages.
update public.publisher_feeds set url = 'https://www.complex.com/index.xml', mode = 'feed', section = 'All', topics = '{music,entertainment}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17 behind complex.com/music: 50 dated items.' where url = 'https://www.complex.com/music';
update public.publisher_feeds set url = 'https://api.foxsports.com/v2/content/optimized-rss?partnerKey=MB0Wehpmuj2lUhuRhQaafhBjAJqaPU244mlTDK1i&size=30&tags=fs%2Fnfl', mode = 'feed', section = 'NFL', topics = '{nfl}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17 in the head of foxsports.com/nfl: 18 dated items.' where url = 'https://www.foxsports.com/nfl';
update public.publisher_feeds set url = 'https://www.hotnewhiphop.com/feed', mode = 'feed', section = 'All', topics = '{music}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17: 10 dated items.' where url = 'https://www.hotnewhiphop.com/';
update public.publisher_feeds set url = 'https://www.morningbrew.com/feed/', mode = 'feed', section = 'All', topics = '{business,creator}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17: 40 dated items.' where url = 'https://www.morningbrew.com/';
update public.publisher_feeds set url = 'https://www.pff.com/feed', mode = 'feed', section = 'All', topics = '{nfl}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17 on the PFF feeds page: 25 dated items.' where url = 'https://www.pff.com/pff-rss';
update public.publisher_feeds set url = 'https://www.nytimes.com/athletic/rss/nfl/', mode = 'feed', section = 'NFL', topics = '{nfl}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17 in the head of nytimes.com/athletic/nfl: 100 dated items. Items resolve to nytimes.com, tier 1.' where url = 'https://www.nytimes.com/athletic/nfl/';
update public.publisher_feeds set url = 'https://feeds.feedburner.com/TheFaderMagazine/', mode = 'feed', section = 'All', topics = '{music}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17 in the head of thefader.com (declared over http; fetched over https): 20 dated items.' where url = 'https://www.thefader.com/';
update public.publisher_feeds set url = 'https://theneedledrop.com/rss/', mode = 'feed', section = 'All', topics = '{music}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17: 15 dated items.' where url = 'https://www.theneedledrop.com/';
update public.publisher_feeds set url = 'https://www.vice.com/en/feed/', mode = 'feed', section = 'All', topics = '{entertainment,creator}', last_status = null, discovered_url = null, consecutive_failures = 0,
       note = 'Discovered 2026-09-17: 10 dated items.' where url = 'https://www.vice.com/en/';

-- Discovery rows whose find is a feed the catalogue already reads.
update public.publisher_feeds set is_active = false, note = 'Discovery 2026-09-17 found feeds.businessinsider.com/custom/all, which is already a row.' where url = 'https://www.businessinsider.com/';
update public.publisher_feeds set is_active = false, note = 'Discovery 2026-09-17 found profootballtalk.atom (4 items); the legacy Pro Football Talk feed row carries 30 and is kept instead.' where url = 'https://www.nbcsports.com/nfl/profootballtalk';
update public.publisher_feeds set is_active = false, note = 'Discovery 2026-09-17 found si.com/feed/, which is already a row.' where url = 'https://www.si.com/nfl';
update public.publisher_feeds set is_active = false, note = 'Discovery 2026-09-17 found sports.yahoo.com/rss/ (all sports); the NFL feed row is kept instead.' where url = 'https://sports.yahoo.com/nfl/';
update public.publisher_feeds set is_active = false, note = 'Homepage refuses automated fetch (403, 2026-09-17); the feedburner feed row works and is kept.' where url = 'https://www.ign.com/';

-- Outlets that refuse automated fetch outright: no feed can be obtained this way.
update public.publisher_feeds set is_active = false, note = 'AP retired its public RSS; the homepage answers 403 to an automated fetch (2026-09-17).' where url = 'https://apnews.com/';
update public.publisher_feeds set is_active = false, note = 'No public RSS; the homepage answers 403 to an automated fetch (2026-09-17).' where url = 'https://www.bloomberg.com/';
update public.publisher_feeds set is_active = false, note = 'Reuters stopped publishing RSS in June 2020; the homepage answers 401 to an automated fetch (2026-09-17).' where url = 'https://www.reuters.com/';
update public.publisher_feeds set is_active = false, note = 'The homepage answers 402 to an automated fetch (2026-09-17); no feed reachable.' where url = 'https://people.com/';

-- Pages that declare no feed in the head, link none, and answer nothing at the conventional paths.
update public.publisher_feeds set is_active = false, note = 'No feed found 2026-09-17: nothing declared in the head, no feed-like anchor, nothing at the conventional paths.'
 where url in ('https://www.campaignlive.com/', 'https://www.kctv5.com/sports/', 'https://www.nfl.com/news/', 'https://www.revolt.tv/', 'https://www.theringer.com/');

-- Feed addresses that answered with an HTML page or a 404: search the site for the feed instead.
update public.publisher_feeds set url = 'https://bleacherreport.com/nfl', mode = 'discover', section = 'Discovery', last_status = null, consecutive_failures = 0, etag = null, last_modified = null,
       note = 'articles/feed?tag_id=16 answered 404 on 2026-09-17; discovery on the NFL section instead.' where url = 'https://bleacherreport.com/articles/feed?tag_id=16';
update public.publisher_feeds set url = 'https://www.rap-up.com/', mode = 'discover', section = 'Discovery', last_status = null, consecutive_failures = 0, etag = null, last_modified = null,
       note = '/feed/ answered with an HTML page on 2026-09-17; discovery on the homepage instead.' where url = 'https://www.rap-up.com/feed/';
update public.publisher_feeds set url = 'https://www.usatoday.com/', mode = 'discover', section = 'Discovery', last_status = null, consecutive_failures = 0, etag = null, last_modified = null,
       note = 'rssfeeds.usatoday.com answered with an HTML page on 2026-09-17; discovery on the homepage instead.' where url = 'https://rssfeeds.usatoday.com/usatoday-NewsTopStories';
update public.publisher_feeds set url = 'https://www.usatoday.com/sports/nfl/', mode = 'discover', section = 'Discovery', last_status = null, consecutive_failures = 0, etag = null, last_modified = null,
       note = 'rssfeeds.usatoday.com answered with an HTML page on 2026-09-17; discovery on the NFL section instead.' where url = 'https://rssfeeds.usatoday.com/UsatodaycomNfl-TopStories';
update public.publisher_feeds set url = 'https://hiphopdx.com/', mode = 'discover', section = 'Discovery', last_status = null, consecutive_failures = 0, etag = null, last_modified = null,
       note = 'rss/news.xml still answers but its newest item is from April 2026; discovery on the homepage for the live feed.' where url = 'https://hiphopdx.com/rss/news.xml';

-- Feeds that answer but have gone stale: nothing inside the age window will ever come from them.
update public.publisher_feeds set is_active = false, note = 'Answers, but the newest item is from July 2026: the sports desk moved to The Athletic, whose NFL feed replaces this row (2026-09-17).' where url = 'https://rss.nytimes.com/services/xml/rss/nyt/ProFootball.xml';
update public.publisher_feeds set is_active = false, note = 'Answers, but the newest item is from January 2026; the feed appears retired (2026-09-17).' where url = 'https://feeds.a.dj.com/rss/RSSWSJD.xml';

-- A feed that refuses automated fetch.
update public.publisher_feeds set is_active = false, note = 'The feed answers 403 to an automated fetch (2026-09-17).' where url = 'https://www.tubefilter.com/feed/';
