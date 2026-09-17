-- =============================================================================
-- Momentum Terminal — Phase 13: publisher-direct feeds, and a 15-minute pulse.
--
-- WHY. Google News surfaces a story one to three days after the outlet
-- published it, so by the time the search feed delivers it the freshness
-- curve has already discounted it: Mahomes' Week 1 win scored at a weight of
-- 0.245 because it was 48.8 hours old when read, where caught promptly it
-- would have carried about 0.92. A publisher's own feed carries the timestamp
-- the outlet wrote and no aggregator delay.
--
-- THE INVERSION. A section feed gives ALL of that section's coverage and the
-- platform filters for the subjects' names, rather than searching for a name
-- and taking what the aggregator ranked. More items in, better timestamps,
-- better provenance — and the tier is trivial, because the feed's domain IS
-- the publisher and resolves through publisher_domains like any other item.
-- What it costs: every feed is fetched every poll whether or not it mentions
-- anyone, and every item is name-matched against every subject watching that
-- feed's topics. The runner fetches the catalogue ONCE per run and shares it
-- across subjects; the connector caps concurrency, per-feed time and the whole
-- fetch's budget.
--
-- VALIDATED, NOT ASSUMED. Nothing in this session could reach a publisher
-- (every outlet is refused by the egress proxy it runs behind), so no feed
-- below is asserted to work. Each row is a CANDIDATE; the first poll after
-- deploy fetches it from production, where egress is open, and writes back
-- what it found: status, HTTP code, item count, how many items carry a real
-- publication date, how many carry a body, the newest date, and for a
-- discovery row the feed it found behind the page. An item with no date is
-- never ingested from this source. The report is read off this table.
--
-- Google News stays registered, at the faster interval, as the fallback for
-- coverage the catalogue misses; the two are one STORY FAMILY, deduplicated
-- against each other so one story is one signal whichever door it uses.
-- =============================================================================

-- The catalogue --------------------------------------------------------------
create table if not exists public.publisher_feeds (
  id                        uuid        primary key default gen_random_uuid(),
  -- The publisher. Its tier resolves through publisher_domains; it is also the
  -- fallback publisher of an item whose link names no host.
  domain                    text        not null,
  url                       text        not null unique,
  -- A label for the operator: "NFL", "Music", "Top stories", "Discovery".
  section                   text        not null,
  -- Which subjects read it: a person_data_sources row lists the topics it
  -- watches, and a feed is read when they intersect. Empty means everyone.
  topics                    text[]      not null default '{}',
  -- feed: fetch and read. discover: the URL is a PAGE; find the feed behind it
  -- (head <link rel="alternate" type="application/rss+xml">, feed-like anchors,
  -- then /feed/, /rss, /rss.xml, /feed.xml, /index.xml, /atom.xml), record it
  -- in discovered_url, ingest nothing.
  mode                      text        not null default 'feed' check (mode in ('feed', 'discover')),
  is_active                 boolean     not null default true,
  note                      text,
  -- Health, written by the runner after every fetch. Never edited by hand.
  last_fetched_at           timestamptz,
  -- ok | not_modified | empty | undated | not_feed | error | discovered | no_feed_found
  last_status               text,
  last_http_status          integer,
  last_error                text,
  last_item_count           integer,
  -- Items carrying a publication date: the only ones this source may ingest.
  last_dated_count          integer,
  -- Items carrying a description or body: a feed with none is headline-only.
  last_described_count      integer,
  -- Items that named a subject, summed over the run's people.
  last_matched_count        integer,
  last_newest_published_at  timestamptz,
  discovered_url            text,
  -- Conditional-request validators, so an unchanged feed answers 304.
  etag                      text,
  last_modified             text,
  consecutive_failures      integer     not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.publisher_feeds is
  'Phase 13. The publisher-direct feed catalogue: configuration (domain, url, section, topics, mode, is_active) and per-fetch health written back by the ingestion runner. Service role only.';

create index if not exists publisher_feeds_active_idx on public.publisher_feeds (is_active, last_fetched_at);

alter table public.publisher_feeds enable row level security;
revoke all on public.publisher_feeds from anon, authenticated;

-- The source ------------------------------------------------------------------
-- Tier 3 is the fallback for an item whose publisher cannot be resolved; every
-- catalogue domain is on the allowlist, so in practice each item carries its
-- publisher's own tier. Events only: no metric is declared here, because the
-- news-volume baseline already accumulating on the Google News source counts
-- distinct stories about the subject, and a second volume series over a
-- fixed publisher set would restart that clock for no new information.
insert into public.data_sources (name, display_name, tier, poll_interval_minutes, is_active, config)
select 'publisher_rss', 'Publisher feeds', 3, 10, true,
       jsonb_build_object(
         'max_items_per_feed', 50,
         'max_items_per_person', 60,
         -- A first fetch of a deep feed must not backfill a week of stale
         -- coverage; three days is the freshness curve's useful tail.
         'max_item_age_hours', 72,
         'concurrency', 8,
         'feed_timeout_ms', 8000,
         'fetch_budget_ms', 20000
       )
 where not exists (select 1 from public.data_sources where name = 'publisher_rss');

-- The subjects ----------------------------------------------------------------
-- external_identifier is the primary match term; config.match_terms adds
-- aliases; config.topics selects the feeds; config.disambiguation is the same
-- block the Google News row carries, applied post-fetch over headline and
-- outlet. Matching is whole-word and case-insensitive, so "Drake" never
-- matches "Drakeford" — but it does match "Drake London" and "Nick Drake",
-- which is what the exclusions are for.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, v.identifier, true, v.config::jsonb
  from (values
    ('patrick-mahomes', 'Patrick Mahomes',
     '{"match_terms": ["Mahomes"], "topics": ["nfl", "sports", "general"]}'),
    ('drake', 'Drake',
     '{"match_terms": [], "topics": ["music", "entertainment", "general"],
       "disambiguation": {"require_any": [],
         "exclude_terms": ["drake university", "drake bulldogs", "drake relays", "drake law", "drake maye", "drake bell",
                           "drake london", "nick drake", "francis drake", "tim drake", "drake batherson", "drake milligan",
                           "drake hogestyn", "drake hotel", "non-conference", "missouri valley", "ncaa tournament"]}}'),
    ('mrbeast', 'MrBeast',
     '{"match_terms": ["Mr. Beast", "Mr Beast", "Jimmy Donaldson"], "topics": ["creator", "tech", "business", "entertainment", "general"]}'),
    ('kai-cenat', 'Kai Cenat',
     '{"match_terms": [], "topics": ["creator", "streaming", "gaming", "entertainment", "music", "general"]}')
  ) as v(slug, identifier, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'publisher_rss'
 where not exists (select 1 from public.person_data_sources x where x.person_id = p.id and x.data_source_id = d.id);

-- The intervals ---------------------------------------------------------------
-- The ingestion cron now fires every fifteen minutes (vercel.json). The runner
-- skips a source when `minutes since last poll < poll_interval_minutes`, and
-- the previous poll lands seconds after its own fire, so an interval that is a
-- multiple of the schedule (15, 30, 45, 60) loses that race every time and the
-- source polls at half its claimed rate — the Phase 10+ defect, at a new
-- period. Ten minutes polls on every fire with five minutes of slack, as 55
-- did for the hourly schedule.
--
--   rss, publisher_rss  10   every fire: news is what the faster pulse is for
--   apisports           40   every third fire (45 min); a weekly sport needs no
--                            more, and a game's final is caught within the
--                            hour at a freshness of 0.98 rather than 0.92
--   youtube             55   unchanged: search.list costs 100 quota units a
--                            poll, and 96 polls a day would spend 9,600 of the
--                            10,000-unit daily quota on one channel
--   youtube_comments    55   unchanged: four times the polls is four times the
--                            comment signals, and each one is scored by the
--                            model — cost, for events that are not time-critical
--   twitch              55   unchanged: its metrics are weekly aggregates and
--                            follower growth, and its stream event is keyed on
--                            the broadcast; nothing there improves at 15 min
update public.data_sources set poll_interval_minutes = 10 where name in ('rss', 'publisher_rss') and poll_interval_minutes <> 10;
update public.data_sources set poll_interval_minutes = 40 where name = 'apisports' and poll_interval_minutes = 175;

-- The candidates --------------------------------------------------------------
-- Every domain below is already on publisher_domains at tier 1, 2 or 3. Topics:
-- general, entertainment, music, tech, creator, business, sports, nfl, gaming,
-- streaming. A "Discovery" row names a page, not a feed (see mode above).
insert into public.publisher_feeds (domain, url, section, topics, mode, note) values
  -- General news
  ('bbc.com',            'https://feeds.bbci.co.uk/news/rss.xml',                              'News',                 '{general}',                'feed',     null),
  ('theguardian.com',    'https://www.theguardian.com/us-news/rss',                            'US news',              '{general}',                'feed',     null),
  ('washingtonpost.com', 'https://feeds.washingtonpost.com/rss/national',                      'National',             '{general}',                'feed',     null),
  ('cnbc.com',           'https://www.cnbc.com/id/100003114/device/rss/rss.html',              'Top news',             '{general,business}',       'feed',     null),
  ('usatoday.com',       'https://rssfeeds.usatoday.com/usatoday-NewsTopStories',              'Top stories',          '{general}',                'feed',     null),
  ('nytimes.com',        'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',          'Home page',            '{general}',                'feed',     null),
  ('cbc.ca',             'https://www.cbc.ca/webfeed/rss/rss-canada-toronto',                  'Toronto',              '{general}',                'feed',     'Drake''s home city.'),
  ('slate.com',          'https://slate.com/feeds/all.rss',                                    'All',                  '{general,entertainment}',  'feed',     null),
  ('apnews.com',         'https://apnews.com/',                                                'Discovery',            '{general}',                'discover', 'AP retired its public RSS years ago; discovery records whether anything is declared today.'),
  ('reuters.com',        'https://www.reuters.com/',                                           'Discovery',            '{general,business}',       'discover', 'Reuters stopped publishing RSS in June 2020; measured here rather than assumed.'),
  ('bloomberg.com',      'https://www.bloomberg.com/',                                         'Discovery',            '{general,business}',       'discover', 'No public RSS is known.'),
  ('thestar.com',        'https://www.thestar.com/',                                           'Discovery',            '{general,entertainment}',  'discover', 'Toronto Star.'),
  -- Entertainment
  ('hollywoodreporter.com', 'https://www.hollywoodreporter.com/feed/',                         'All',                  '{entertainment}',          'feed',     null),
  ('variety.com',        'https://variety.com/feed/',                                          'All',                  '{entertainment}',          'feed',     null),
  ('rollingstone.com',   'https://www.rollingstone.com/feed/',                                 'All',                  '{entertainment}',          'feed',     null),
  ('bbc.com',            'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',       'Entertainment & Arts', '{entertainment}',          'feed',     null),
  ('theguardian.com',    'https://www.theguardian.com/culture/rss',                            'Culture',              '{entertainment}',          'feed',     null),
  ('washingtonpost.com', 'https://feeds.washingtonpost.com/rss/entertainment',                 'Entertainment',        '{entertainment}',          'feed',     null),
  ('cbc.ca',             'https://www.cbc.ca/webfeed/rss/rss-arts',                            'Arts',                 '{entertainment,music}',    'feed',     null),
  ('avclub.com',         'https://www.avclub.com/rss',                                         'All',                  '{entertainment}',          'feed',     null),
  ('justjared.com',      'https://www.justjared.com/feed/',                                    'All',                  '{entertainment}',          'feed',     null),
  ('people.com',         'https://people.com/',                                                'Discovery',            '{entertainment}',          'discover', null),
  ('vice.com',           'https://www.vice.com/en/',                                           'Discovery',            '{entertainment,creator}',  'discover', null),
  ('theringer.com',      'https://www.theringer.com/',                                         'Discovery',            '{sports,entertainment,music}', 'discover', null),
  -- Music
  ('billboard.com',      'https://www.billboard.com/feed/',                                    'All',                  '{music}',                  'feed',     null),
  ('pitchfork.com',      'https://pitchfork.com/feed/feed-news/rss',                           'News',                 '{music}',                  'feed',     null),
  ('stereogum.com',      'https://www.stereogum.com/feed/',                                    'All',                  '{music}',                  'feed',     null),
  ('hiphopdx.com',       'https://hiphopdx.com/rss/news.xml',                                  'News',                 '{music}',                  'feed',     null),
  ('xxlmag.com',         'https://www.xxlmag.com/feed/',                                       'All',                  '{music}',                  'feed',     null),
  ('nme.com',            'https://www.nme.com/news/music/feed',                                'Music news',           '{music}',                  'feed',     null),
  ('rollingstone.com',   'https://www.rollingstone.com/music/feed/',                           'Music',                '{music}',                  'feed',     null),
  ('rap-up.com',         'https://www.rap-up.com/feed/',                                       'All',                  '{music}',                  'feed',     null),
  ('thesource.com',      'https://thesource.com/feed/',                                        'All',                  '{music}',                  'feed',     null),
  ('theguardian.com',    'https://www.theguardian.com/music/rss',                              'Music',                '{music}',                  'feed',     null),
  ('nytimes.com',        'https://rss.nytimes.com/services/xml/rss/nyt/Music.xml',             'Music',                '{music}',                  'feed',     null),
  ('variety.com',        'https://variety.com/v/music/feed/',                                  'Music',                '{music}',                  'feed',     null),
  ('hollywoodreporter.com', 'https://www.hollywoodreporter.com/c/music/feed/',                 'Music',                '{music}',                  'feed',     null),
  ('complex.com',        'https://www.complex.com/music',                                      'Discovery',            '{music,entertainment}',    'discover', 'Complex serves its feeds from assets.complex.com; discovery reads the declaration.'),
  ('thefader.com',       'https://www.thefader.com/',                                          'Discovery',            '{music}',                  'discover', null),
  ('theneedledrop.com',  'https://www.theneedledrop.com/',                                     'Discovery',            '{music}',                  'discover', null),
  ('hotnewhiphop.com',   'https://www.hotnewhiphop.com/',                                      'Discovery',            '{music}',                  'discover', null),
  ('revolt.tv',          'https://www.revolt.tv/',                                             'Discovery',            '{music}',                  'discover', null),
  -- Technology, the creator economy, business
  ('theverge.com',       'https://www.theverge.com/rss/index.xml',                             'All',                  '{tech,creator}',           'feed',     null),
  ('techcrunch.com',     'https://techcrunch.com/feed/',                                       'All',                  '{tech}',                   'feed',     null),
  ('cnbc.com',           'https://www.cnbc.com/id/19854910/device/rss/rss.html',               'Technology',           '{tech,business}',          'feed',     null),
  ('wsj.com',            'https://feeds.a.dj.com/rss/RSSWSJD.xml',                             'Technology',           '{tech,business}',          'feed',     'Headline feed behind a paywall; the dates are what matter here.'),
  ('nytimes.com',        'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',        'Technology',           '{tech}',                   'feed',     null),
  ('theguardian.com',    'https://www.theguardian.com/technology/rss',                         'Technology',           '{tech}',                   'feed',     null),
  ('tubefilter.com',     'https://www.tubefilter.com/feed/',                                   'All',                  '{creator}',                'feed',     null),
  ('digiday.com',        'https://digiday.com/feed/',                                          'All',                  '{creator,business}',       'feed',     null),
  ('adweek.com',         'https://www.adweek.com/feed/',                                       'All',                  '{creator,business}',       'feed',     null),
  ('marketingdive.com',  'https://www.marketingdive.com/feeds/news/',                          'News',                 '{business}',               'feed',     null),
  ('businessinsider.com', 'https://feeds.businessinsider.com/custom/all',                      'All',                  '{business,tech}',          'feed',     null),
  ('businessinsider.com', 'https://www.businessinsider.com/',                                  'Discovery',            '{business,tech}',          'discover', null),
  ('forbes.com',         'https://www.forbes.com/business/feed/',                              'Business',             '{business}',               'feed',     null),
  ('forbes.com',         'https://www.forbes.com/innovation/feed/',                            'Innovation',           '{tech}',                   'feed',     null),
  ('dexerto.com',        'https://www.dexerto.com/feed/',                                      'All',                  '{creator,streaming}',      'feed',     null),
  ('variety.com',        'https://variety.com/v/digital/feed/',                                'Digital',              '{creator,tech}',           'feed',     null),
  ('morningbrew.com',    'https://www.morningbrew.com/',                                       'Discovery',            '{business,creator}',       'discover', null),
  ('campaignlive.com',   'https://www.campaignlive.com/',                                      'Discovery',            '{business}',               'discover', null),
  -- Sports and the NFL
  ('espn.com',           'https://www.espn.com/espn/rss/nfl/news',                             'NFL',                  '{nfl}',                    'feed',     null),
  ('espn.com',           'https://www.espn.com/espn/rss/news',                                 'Top',                  '{sports}',                 'feed',     null),
  ('cbssports.com',      'https://www.cbssports.com/rss/headlines/nfl/',                       'NFL',                  '{nfl}',                    'feed',     null),
  ('cbssports.com',      'https://www.cbssports.com/rss/headlines/',                           'Headlines',            '{sports}',                 'feed',     null),
  ('nbcsports.com',      'https://www.nbcsports.com/nfl.atom',                                 'NFL',                  '{nfl}',                    'feed',     null),
  ('nbcsports.com',      'https://profootballtalk.nbcsports.com/feed/',                        'Pro Football Talk',    '{nfl}',                    'feed',     'Legacy address; may redirect.'),
  ('nbcsports.com',      'https://www.nbcsports.com/nfl/profootballtalk',                      'Discovery',            '{nfl}',                    'discover', 'Pro Football Talk.'),
  ('nfl.com',            'https://www.nfl.com/news/',                                          'Discovery',            '{nfl}',                    'discover', null),
  ('theguardian.com',    'https://www.theguardian.com/sport/nfl/rss',                          'NFL',                  '{nfl}',                    'feed',     null),
  ('nytimes.com',        'https://rss.nytimes.com/services/xml/rss/nyt/ProFootball.xml',       'Pro football',         '{nfl}',                    'feed',     null),
  ('washingtonpost.com', 'https://feeds.washingtonpost.com/rss/sports',                        'Sports',               '{sports}',                 'feed',     null),
  ('usatoday.com',       'https://rssfeeds.usatoday.com/UsatodaycomNfl-TopStories',            'NFL',                  '{nfl}',                    'feed',     null),
  ('si.com',             'https://www.si.com/feed',                                            'All',                  '{sports}',                 'feed',     null),
  ('si.com',             'https://www.si.com/nfl',                                             'Discovery',            '{nfl}',                    'discover', null),
  ('pff.com',            'https://www.pff.com/pff-rss',                                        'Discovery',            '{nfl}',                    'discover', 'PFF lists its feeds on this page.'),
  ('theathletic.com',    'https://www.nytimes.com/athletic/nfl/',                              'Discovery',            '{nfl}',                    'discover', 'The Athletic now lives under nytimes.com/athletic; items resolve to nytimes.com, tier 1.'),
  ('kansascity.com',     'https://www.kansascity.com/sports/nfl/kansas-city-chiefs/?widgetName=rssfeed&widgetContentId=6199&getXmlFeed=true', 'Chiefs', '{nfl}', 'feed', 'McClatchy feed address.'),
  ('kansascity.com',     'https://www.kansascity.com/sports/nfl/kansas-city-chiefs/',          'Discovery',            '{nfl}',                    'discover', null),
  ('arrowheadpride.com', 'https://www.arrowheadpride.com/rss/index.xml',                       'Chiefs',               '{nfl}',                    'feed',     null),
  ('bleacherreport.com', 'https://bleacherreport.com/articles/feed?tag_id=16',                 'NFL',                  '{nfl}',                    'feed',     null),
  ('sports.yahoo.com',   'https://sports.yahoo.com/nfl/rss.xml',                               'NFL',                  '{nfl}',                    'feed',     null),
  ('sports.yahoo.com',   'https://sports.yahoo.com/nfl/',                                      'Discovery',            '{nfl}',                    'discover', null),
  ('foxsports.com',      'https://www.foxsports.com/nfl',                                      'Discovery',            '{nfl}',                    'discover', null),
  ('fox4kc.com',         'https://fox4kc.com/feed/',                                           'All',                  '{nfl}',                    'feed',     'Kansas City local news; the name match does the selecting.'),
  ('kctv5.com',          'https://www.kctv5.com/sports/',                                      'Discovery',            '{nfl}',                    'discover', null),
  ('bbc.com',            'https://feeds.bbci.co.uk/sport/american-football/rss.xml',           'American football',    '{nfl}',                    'feed',     null),
  -- Gaming and streaming
  ('kotaku.com',         'https://kotaku.com/rss',                                             'All',                  '{gaming,streaming}',       'feed',     null),
  ('polygon.com',        'https://www.polygon.com/rss/index.xml',                              'All',                  '{gaming}',                 'feed',     'Volume fell after the 2025 sale; kept to measure.'),
  ('pcgamer.com',        'https://www.pcgamer.com/rss/',                                       'All',                  '{gaming}',                 'feed',     null),
  ('ign.com',            'https://feeds.feedburner.com/ign/all',                               'All',                  '{gaming}',                 'feed',     null),
  ('ign.com',            'https://www.ign.com/',                                               'Discovery',            '{gaming}',                 'discover', null),
  ('gamespot.com',       'https://www.gamespot.com/feeds/news/',                               'News',                 '{gaming}',                 'feed',     null),
  ('dotesports.com',     'https://dotesports.com/feed',                                        'All',                  '{streaming,gaming}',       'feed',     null),
  ('esports.gg',         'https://esports.gg/feed/',                                           'All',                  '{streaming}',              'feed',     null)
on conflict (url) do nothing;
