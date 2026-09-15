-- =============================================================================
-- Momentum Terminal — Phase 10: Twitch and API-Sports, and two new subjects.
--
-- Two tracked people with deliberately different data shapes, registered now
-- because a baseline's clock starts at registration and not at first interest:
-- most metrics here need one to four weeks of span before they can say
-- anything, so the cost of waiting is measured in weeks.
--
--   Kai Cenat       creator, Twitch + curated RSS
--   Patrick Mahomes athlete, API-Sports (NFL) + curated RSS
--
-- Both people already exist among the sixteen seeded rows, and both source
-- rows already exist as inactive registry entries, so this migration
-- CONFIGURES and MAPS; it inserts no person and no data source.
--
-- POLL INTERVAL. Both rows carry an interval BELOW sixty minutes, and that is
-- deliberate. The runner skips a source when `minutes since last poll <
-- poll_interval_minutes`; with the hourly ingestion cron firing on the hour,
-- an interval of exactly 60 means the check sees 59 minutes and skips, so the
-- source polls every SECOND hour and its baseline fills at half the intended
-- rate. The three sources registered before this phase are all on 60 and are
-- all skipping alternate runs — see the Phase 10 report; they are left alone
-- here because changing them is not this migration's job, but the new rows are
-- not going to inherit the same defect.
-- =============================================================================

-- Twitch ----------------------------------------------------------------------
--
-- THE SAMPLING PROBLEM. A live stream either is or is not running when we poll,
-- and hourly polling samples that unevenly: a six-hour broadcast is caught six
-- times, a ninety-minute one once or not at all. An instantaneous concurrent-
-- viewer reading therefore has a distribution driven by the online/offline
-- mixture rather than by the audience, and its sigma would describe the cron
-- schedule. So no instantaneous value is declared as a metric. What is declared
-- is either cumulative and monotone (follower_count) or a retrospective window
-- aggregate over completed broadcasts (stream_hours_7d, stream_days_7d), both
-- of which answer the same whatever minute they are asked. The spiky fact —
-- live right now, to this many people — is an EVENT instead, one signal per
-- broadcast keyed on the stream id.
update public.data_sources
   set is_active = true,
       poll_interval_minutes = 55,
       config = jsonb_build_object(
         'archive_window_hours', 168,
         'metrics', jsonb_build_object(
           -- Cumulative and monotone: the polling moment cannot change it.
           'follower_count', jsonb_build_object(
             'label', 'Twitch follower growth',
             'delta', 'relative_rate',
             'polarity', 1,
             'baseline_window_hours', 168,
             'min_samples', 24,
             'sd_floor', 0.00001,
             'scale', 1.0
           ),
           -- Trailing-week broadcast hours. A level, like news_volume_24h: the
           -- window is the measurement, so consecutive polls agree.
           'stream_hours_7d', jsonb_build_object(
             'label', 'Twitch streaming hours',
             'delta', 'level',
             'polarity', 1,
             'baseline_window_hours', 720,
             'min_samples', 48,
             'sd_floor', 1.0,
             'scale', 0.7
           ),
           -- Days streamed in the trailing week: cadence rather than volume. An
           -- integer 0..7, so the sd floor is half a day — without it a
           -- streamer at 7/7 for a month has a sigma of zero and any single
           -- rest day reads as a collapse.
           'stream_days_7d', jsonb_build_object(
             'label', 'Twitch streaming cadence',
             'delta', 'level',
             'polarity', 1,
             'baseline_window_hours', 720,
             'min_samples', 48,
             'sd_floor', 0.5,
             'scale', 0.6
           )
         )
       )
 where name = 'twitch';

-- API-Sports (NFL) ------------------------------------------------------------
--
-- METRIC VERSUS EVENT. A season is scheduled, periodic and outcome-bearing,
-- which is a shape nothing else here has. Game results are EVENTS: discrete,
-- dated, and already in language the sentiment path reads. Only one METRIC is
-- declared — per-game passing yards — and it is sampled once per game by the
-- connector, which returns a reading only when the figure moves, so `samples`
-- counts performances and not polls.
--
-- WHAT IS NOT DECLARED, AND WHY. Season cumulative totals (passing yards,
-- touchdowns, completions to date) are monotone step functions: flat for a
-- week, then a jump. Snapshotted against their own trailing series they give a
-- standard deviation pinned to the sd floor and a maximal signal on every
-- single game — an expensive way of saying "a game happened", which the event
-- says better. Season completion percentage fails the other way: a running
-- aggregate over hundreds of attempts barely leaves its own mean, so it would
-- never emit however the season went. Neither is registered.
--
-- WHAT CAN EMIT THIS SEASON. min_samples is 8, so game_passing_yards becomes
-- eligible at his eighth recorded game — roughly the season's halfway point,
-- early-to-mid November — and the 1680-hour window holds ten weeks, enough to
-- keep eight games in view. A metric needing the platform's usual 24 samples
-- would need twenty-four games, which is longer than a regular season; that is
-- the test every candidate metric here had to pass.
--
-- THE PATHS ARE CONFIGURATION. api-sports.io is unreachable from the network
-- this was written on, so the endpoint paths and statistic field names are
-- unverified. They live here rather than in the connector so that correcting
-- one is an update to this row, not a deploy.
update public.data_sources
   set is_active = true,
       -- Weekly events, a 100-request daily quota on the free plan: eight polls
       -- a day at two requests each is ample and leaves the quota alone.
       poll_interval_minutes = 175,
       config = jsonb_build_object(
         'host', 'v1.american-football.api-sports.io',
         'season', null,
         'team_id', null,
         'recent_games', 5,
         'paths', jsonb_build_object(
           'games', '/games?season={season}&team={team}',
           'player_statistics', '/players/statistics?id={player}&season={season}'
         ),
         'passing_yards_keys', jsonb_build_array('passing.yards', 'passing_yards', 'yards'),
         'metrics', jsonb_build_object(
           'game_passing_yards', jsonb_build_object(
             'label', 'passing yards per game',
             'delta', 'level',
             'polarity', 1,
             'baseline_window_hours', 1680,
             'min_samples', 8,
             -- Yards. Without a floor, a run of similar games would make an
             -- ordinary one read as an outlier.
             'sd_floor', 25.0,
             'scale', 0.8
           )
         )
       )
 where name = 'apisports';

-- The subjects ----------------------------------------------------------------
-- Both people are already seeded with the right categories (kai-cenat is a
-- creator, patrick-mahomes an athlete), so these are mappings only. Idempotent
-- on (person_id, data_source_id) so re-running cannot duplicate a mapping.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active)
select p.id, d.id, v.identifier, true
  from (values
    ('kai-cenat',       'twitch',    'kaicenat'),
    ('kai-cenat',       'rss',       'https://news.google.com/rss/search?q=%22Kai+Cenat%22&hl=en-US&gl=US&ceid=US%3Aen'),
    ('patrick-mahomes', 'apisports', '1197'),
    ('patrick-mahomes', 'rss',       'https://news.google.com/rss/search?q=%22Patrick+Mahomes%22&hl=en-US&gl=US&ceid=US%3Aen')
  ) as v(slug, source, identifier)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = v.source
on conflict (person_id, data_source_id)
  do update set external_identifier = excluded.external_identifier, is_active = true;

-- Publisher domains -----------------------------------------------------------
-- Sports coverage brings in outlets the first two subjects never surfaced, and
-- an unknown domain lands at the floor tier with heavily reduced weight — so a
-- week of legitimate Chiefs reporting would otherwise arrive as tier 5. Seeded
-- here are desks with editorial staff and a masthead, at the tier their
-- reporting warrants:
--   1  the national sports desks of record
--   2  established national sports and games press, and the subjects' home-city
--      papers, which do the closest reporting on them
--   3  team sites, blogs and aggregators with an editor but a looser standard
-- nfl.com sits at 2 rather than 1 despite being authoritative on fact: it is
-- the league's own outlet, and a league reporting on its own marquee player is
-- closer to the corporate-PR case Phase 8+ held at the floor than to the wires.
insert into public.publisher_domains (domain, status, tier, note)
values
  ('espn.com',          'allowed', 1, 'National sports desk of record; breaks and confirms most NFL news.'),
  ('theathletic.com',   'allowed', 1, 'Subscription sports desk with beat reporters per team; NYT-owned.'),
  ('si.com',            'allowed', 2, 'Sports Illustrated: national sports magazine with a reporting desk.'),
  ('cbssports.com',     'allowed', 2, 'National broadcaster sports desk.'),
  ('nbcsports.com',     'allowed', 2, 'National broadcaster sports desk; carries Pro Football Talk.'),
  ('nfl.com',           'allowed', 2, 'The league''s own outlet. Authoritative on fact, promotional on framing, so held below the independent desks.'),
  ('pff.com',           'allowed', 2, 'Pro Football Focus: charting and analytics desk, quantitative rather than narrative.'),
  ('kansascity.com',    'allowed', 2, 'The Kansas City Star: Mahomes'' home-city paper of record, closest beat coverage.'),
  ('theringer.com',     'allowed', 2, 'Sports and culture desk with staff writers.'),
  ('bleacherreport.com','allowed', 3, 'High-volume sports aggregator with an editorial desk; reach exceeds its reporting.'),
  ('sbnation.com',      'allowed', 3, 'Team-blog network with editors; enthusiast register.'),
  ('arrowheadpride.com','allowed', 3, 'Chiefs team blog (SB Nation): close to the subject, partisan by design.'),
  ('sports.yahoo.com',  'allowed', 3, 'Sports portal mixing wire syndication with some original reporting.'),
  ('yardbarker.com',    'allowed', 3, 'Sports aggregator with light original desk.'),
  ('kotaku.com',        'allowed', 2, 'Games and streaming-culture desk with staff reporters.'),
  ('pcgamer.com',       'allowed', 2, 'Games press with an editorial desk; covers streaming personalities.'),
  ('gamespot.com',      'allowed', 2, 'Games press with an editorial desk.'),
  ('dotesports.com',    'allowed', 3, 'Esports and streaming desk; fast, close to the creator beat.'),
  ('esports.gg',        'allowed', 3, 'Esports and streaming coverage; enthusiast register.')
on conflict (domain) do update
  set status = excluded.status, tier = excluded.tier, note = excluded.note, updated_at = now();
