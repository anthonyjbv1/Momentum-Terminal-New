-- =============================================================================
-- ROSTER EXPANSION (2026-10-09): thirteen subjects, every mapping at once.
--
-- Streamers (creator): Asmongold, Jynxzi, Caedrel. NFL (athlete): Jaxon
-- Smith-Njigba, Ja'Marr Chase, Jahmyr Gibbs, Bijan Robinson, Lamar Jackson,
-- Josh Allen. NBA (athlete): Stephen Curry, LeBron James, Victor Wembanyama,
-- Shai Gilgeous-Alexander. Not added: xQc (Kick) and IShowSpeed (no YouTube
-- live detection yet).
--
-- Every person starts at base 50.0 and current 50.0, public-figure tier,
-- tradeable, discoverable, with the revert target proposed in the 10-02
-- prep. THE TARGETS ARE PROVISIONAL pending the mid-October score-range
-- decision; the prep's table is the record of why each one.
--
-- Mappings, all created in this migration so every subject's volume
-- baseline starts on the same day:
--   rss              Google News search on the quoted name, with the name
--                    rules as tested in the prep (roster/rules)
--   publisher_rss    the publisher catalogue, same rules, topics per group
--   twitch           the three streamers by login (plus their YouTube handles
--                    to resolve); live mode is the source's setting and
--                    applies to them as it does to Kai Cenat
--   youtube_trending all thirteen by display name, the Phase 22 seed shape;
--                    channel ids pinned after live resolution
--   apisports        the six NFL players, INACTIVE until their player and
--                    team ids are resolved live (config.resolve); the
--                    per-position game statistics and headline line are
--                    the mapping's own (mergedApiSportsConfig)
--   youtube          added after the channel ids are resolved live (none here)
-- The NBA four get Google News and the catalogue only (the catalogue has no
-- basketball desk, so they read sports and general): no API-Sports mapping
-- until a basketball connector exists.
--
-- No weight, force, Gravity, drift, tune or market path changes. The one
-- data_sources change is three new per-game metric definitions on the
-- API-Sports row (receiving yards, receptions, rushing yards), needed for
-- the receivers and backs; the quarterback metrics are untouched.
-- =============================================================================

insert into public.people (slug, display_name, full_name, category, revert_target, is_discoverable)
values
  ('asmongold',               'Asmongold',               'Zack Hoyt',                     'creator', 56, true),
  ('jynxzi',                  'Jynxzi',                  'Nicholas Stewart',              'creator', 55, true),
  ('caedrel',                 'Caedrel',                 'Marc Robert Lamont',            'creator', 52, true),
  ('jaxon-smith-njigba',      'Jaxon Smith-Njigba',      'Jaxon Smith-Njigba',            'athlete', 58, true),
  ('jamarr-chase',            'Ja''Marr Chase',          'Ja''Marr Anthony Chase',        'athlete', 60, true),
  ('jahmyr-gibbs',            'Jahmyr Gibbs',            'Jahmyr Gibbs',                  'athlete', 58, true),
  ('bijan-robinson',          'Bijan Robinson',          'Bijan Robinson',                'athlete', 58, true),
  ('lamar-jackson',           'Lamar Jackson',           'Lamar Demeatrice Jackson Jr.',  'athlete', 62, true),
  ('josh-allen',              'Josh Allen',              'Joshua Patrick Allen',          'athlete', 63, true),
  ('stephen-curry',           'Stephen Curry',           'Wardell Stephen Curry II',      'athlete', 66, true),
  ('lebron-james',            'LeBron James',            'LeBron Raymone James',          'athlete', 68, true),
  ('victor-wembanyama',       'Victor Wembanyama',       'Victor Wembanyama',             'athlete', 64, true),
  ('shai-gilgeous-alexander', 'Shai Gilgeous-Alexander', 'Shai Gilgeous-Alexander',       'athlete', 65, true);

-- Google News (rss): the quoted name, the rules on the mapping ------------------
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, v.url, true, v.config::jsonb
  from (values
    ('asmongold',          'https://news.google.com/rss/search?q=%22Asmongold%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "aliases": ["Asmon", "zackrawrr", "Zack Hoyt"]}}'),
    ('jynxzi',             'https://news.google.com/rss/search?q=%22Jynxzi%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "aliases": ["Jynx"]}}'),
    ('caedrel',            'https://news.google.com/rss/search?q=%22Caedrel%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "aliases": ["Los Ratones'' Caedrel"]}}'),
    ('jaxon-smith-njigba', 'https://news.google.com/rss/search?q=%22Jaxon+Smith-Njigba%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": true, "aliases": ["JSN"]}}'),
    ('jamarr-chase',       'https://news.google.com/rss/search?q=%22Ja%27Marr+Chase%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "surname_context": ["bengals", "cincinnati", "burrow", "wide receiver", "wr"], "aliases": ["JaMarr Chase", "Jamarr Chase"], "exclude_unless_named": ["JPMorgan", "Chase Bank", "Chase Sapphire"]}}'),
    ('jahmyr-gibbs',       'https://news.google.com/rss/search?q=%22Jahmyr+Gibbs%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "surname_context": ["lions", "detroit", "running back", "rb"]}}'),
    ('bijan-robinson',     'https://news.google.com/rss/search?q=%22Bijan+Robinson%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "surname_context": ["falcons", "atlanta", "running back", "rb"]}}'),
    ('lamar-jackson',      'https://news.google.com/rss/search?q=%22Lamar+Jackson%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "surname_context": ["ravens", "baltimore", "quarterback", "qb"]}}'),
    ('josh-allen',         'https://news.google.com/rss/search?q=%22Josh+Allen%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "surname_context": ["bills", "buffalo", "quarterback", "qb", "mvp"], "aliases": ["Bills QB", "Bills quarterback"], "exclude_terms": ["hines-allen", "pass rusher"], "exclude_unless_named": ["Jaguars", "Jacksonville"]}}'),
    ('stephen-curry',      'https://news.google.com/rss/search?q=%22Stephen+Curry%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "surname_context": ["warriors", "golden state", "steph"], "aliases": ["Steph Curry", "Steph"], "exclude_unless_named": ["Seth Curry", "curry recipe", "chicken curry", "curry powder", "Dell Curry", "Sydel Curry", "Ayesha Curry"]}}'),
    ('lebron-james',       'https://news.google.com/rss/search?q=%22LeBron+James%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": false, "surname_context": ["76ers", "sixers", "lakers", "lebron"], "aliases": ["King James", "LeBron"], "exclude_terms": ["bronny", "lebron james jr", "lebron jr"]}}'),
    ('victor-wembanyama',  'https://news.google.com/rss/search?q=%22Victor+Wembanyama%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": true, "aliases": ["Wemby"]}}'),
    ('shai-gilgeous-alexander', 'https://news.google.com/rss/search?q=%22Shai+Gilgeous-Alexander%22&hl=en-US&gl=US&ceid=US%3Aen',
       '{"disambiguation": {"surname_alone": true, "aliases": ["SGA", "Shai"]}}')
  ) as v(slug, url, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'rss';

-- The publisher catalogue (publisher_rss): same rules, topics per group ---------
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, p.display_name, true, v.config::jsonb
  from (values
    ('asmongold',          '{"topics": ["creator", "streaming", "gaming", "entertainment", "general"], "match_terms": ["Asmon", "zackrawrr"], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "aliases": ["Asmon", "zackrawrr", "Zack Hoyt"]}}'),
    ('jynxzi',             '{"topics": ["creator", "streaming", "gaming", "entertainment", "general"], "match_terms": [], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "aliases": ["Jynx"]}}'),
    ('caedrel',            '{"topics": ["creator", "streaming", "gaming", "entertainment", "general"], "match_terms": [], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "aliases": ["Los Ratones'' Caedrel"]}}'),
    ('jaxon-smith-njigba', '{"topics": ["nfl", "sports", "general"], "match_terms": ["Smith-Njigba"], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": true, "aliases": ["JSN"]}}'),
    ('jamarr-chase',       '{"topics": ["nfl", "sports", "general"], "match_terms": ["JaMarr Chase", "Jamarr Chase"], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "surname_context": ["bengals", "cincinnati", "burrow", "wide receiver", "wr"], "aliases": ["JaMarr Chase", "Jamarr Chase"], "exclude_unless_named": ["JPMorgan", "Chase Bank", "Chase Sapphire"]}}'),
    ('jahmyr-gibbs',       '{"topics": ["nfl", "sports", "general"], "match_terms": [], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "surname_context": ["lions", "detroit", "running back", "rb"]}}'),
    ('bijan-robinson',     '{"topics": ["nfl", "sports", "general"], "match_terms": [], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "surname_context": ["falcons", "atlanta", "running back", "rb"]}}'),
    ('lamar-jackson',      '{"topics": ["nfl", "sports", "general"], "match_terms": [], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "surname_context": ["ravens", "baltimore", "quarterback", "qb"]}}'),
    ('josh-allen',         '{"topics": ["nfl", "sports", "general"], "match_terms": [], "disambiguation": {"require_any": [], "surname_alone": false, "surname_context": ["bills", "buffalo", "quarterback", "qb", "mvp"], "aliases": ["Bills QB", "Bills quarterback"], "exclude_terms": ["hines-allen", "pass rusher"], "exclude_unless_named": ["Jaguars", "Jacksonville"]}}'),
    ('stephen-curry',      '{"topics": ["sports", "general"], "match_terms": ["Steph Curry"], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": false, "surname_context": ["warriors", "golden state", "steph"], "aliases": ["Steph Curry", "Steph"], "exclude_unless_named": ["Seth Curry", "curry recipe", "chicken curry", "curry powder", "Dell Curry", "Sydel Curry", "Ayesha Curry"]}}'),
    ('lebron-james',       '{"topics": ["sports", "general"], "match_terms": ["LeBron"], "disambiguation": {"require_any": [], "surname_alone": false, "surname_context": ["76ers", "sixers", "lakers", "lebron"], "aliases": ["King James", "LeBron"], "exclude_terms": ["bronny", "lebron james jr", "lebron jr"]}}'),
    ('victor-wembanyama',  '{"topics": ["sports", "general"], "match_terms": ["Wembanyama", "Wemby"], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": true, "aliases": ["Wemby"]}}'),
    ('shai-gilgeous-alexander', '{"topics": ["sports", "general"], "match_terms": ["Gilgeous-Alexander"], "disambiguation": {"require_any": [], "exclude_terms": [], "surname_alone": true, "aliases": ["SGA", "Shai"]}}')
  ) as v(slug, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'publisher_rss';

-- Twitch: the three streamers by login. The broadcaster id and the YouTube
-- channel ids are resolved live from this one resolve block and written back
-- to config.identity (lib/ingest/identity.ts) ----
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, v.login, true, v.config::jsonb
  from (values
    ('asmongold', 'zackrawrr', '{"resolve": {"login": "zackrawrr", "handles": ["@AsmongoldTV", "@AsmongoldClips"]}}'),
    ('jynxzi',    'jynxzi',    '{"resolve": {"login": "jynxzi",    "handles": ["@Jynxzi"]}}'),
    ('caedrel',   'caedrel',   '{"resolve": {"login": "caedrel",   "handles": ["@Caedrel"]}}')
  ) as v(slug, login, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'twitch';

-- YouTube Trending: every one of the thirteen, in the Phase 22 seed shape -----
-- (display name as the identifier, no match terms, the disambiguation block
-- inherited from the publisher mapping). No handle on any row: a handle costs
-- a unit a poll, so the channel route is pinned (channel_ids) only after the
-- live resolution above has been compared with the prep listing.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, p.display_name, true,
       jsonb_build_object('match_terms', '[]'::jsonb, 'disambiguation', pub.config -> 'disambiguation')
  from public.people p
  join public.data_sources d on d.name = 'youtube_trending'
  join public.person_data_sources pub
    on pub.person_id = p.id
   and pub.data_source_id = (select id from public.data_sources where name = 'publisher_rss')
 where p.slug in ('asmongold', 'jynxzi', 'caedrel', 'jaxon-smith-njigba', 'jamarr-chase', 'jahmyr-gibbs',
                  'bijan-robinson', 'lamar-jackson', 'josh-allen', 'stephen-curry', 'lebron-james',
                  'victor-wembanyama', 'shai-gilgeous-alexander')
on conflict (person_id, data_source_id) do update
   set external_identifier = excluded.external_identifier,
       is_active = true,
       config = excluded.config;

-- API-Sports: the three new per-game metric definitions on the source row ------
update public.data_sources
   set config = jsonb_set(config, '{metrics}', (config->'metrics') || '{
     "game_receiving_yards": {"delta": "level", "label": "receiving yards per game", "scale": 0.8, "polarity": 1, "sd_floor": 20, "min_samples": 8, "baseline_window_hours": 1680},
     "game_receptions":      {"delta": "level", "label": "receptions per game",      "scale": 0.6, "polarity": 1, "sd_floor": 1.5, "min_samples": 8, "baseline_window_hours": 1680},
     "game_rushing_yards":   {"delta": "level", "label": "rushing yards per game",   "scale": 0.8, "polarity": 1, "sd_floor": 20, "min_samples": 8, "baseline_window_hours": 1680}
   }'::jsonb)
 where name = 'apisports';

-- API-Sports: the six NFL players, inactive until their ids are resolved live ----
-- external_identifier becomes the player id and is_active true once the
-- operator has compared identity.apisports with the prep listing.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, 'pending', false, v.config::jsonb
  from (values
    ('jaxon-smith-njigba', '{"resolve": {"player_search": "Smith-Njigba", "team_search": "Seattle"},
       "game_stats": {"game_receiving_yards": {"group": "Receiving", "name": "yards"}, "game_receptions": {"group": "Receiving", "name": "receptions"}},
       "headline_stats": {"receiving_yards": {"group": "Receiving", "name": "yards"}, "receptions": {"group": "Receiving", "name": "receptions"}}}'),
    ('jamarr-chase',       '{"resolve": {"player_search": "Chase", "team_search": "Cincinnati"},
       "game_stats": {"game_receiving_yards": {"group": "Receiving", "name": "yards"}, "game_receptions": {"group": "Receiving", "name": "receptions"}},
       "headline_stats": {"receiving_yards": {"group": "Receiving", "name": "yards"}, "receptions": {"group": "Receiving", "name": "receptions"}}}'),
    ('jahmyr-gibbs',       '{"resolve": {"player_search": "Gibbs", "team_search": "Detroit"},
       "game_stats": {"game_rushing_yards": {"group": "Rushing", "name": "yards"}, "game_receiving_yards": {"group": "Receiving", "name": "yards"}},
       "headline_stats": {"rushing_yards": {"group": "Rushing", "name": "yards"}, "receiving_yards": {"group": "Receiving", "name": "yards"}}}'),
    ('bijan-robinson',     '{"resolve": {"player_search": "Bijan", "team_search": "Atlanta"},
       "game_stats": {"game_rushing_yards": {"group": "Rushing", "name": "yards"}, "game_receiving_yards": {"group": "Receiving", "name": "yards"}},
       "headline_stats": {"rushing_yards": {"group": "Rushing", "name": "yards"}, "receiving_yards": {"group": "Receiving", "name": "yards"}}}'),
    ('lamar-jackson',      '{"resolve": {"player_search": "Lamar Jackson", "team_search": "Baltimore"},
       "game_stats": {"game_rating": {"group": "Passing", "name": "rating"}, "game_interceptions": {"group": "Passing", "name": "interceptions"}, "game_passing_yards": {"group": "Passing", "name": "yards"}, "game_rushing_yards": {"group": "Rushing", "name": "yards"}}}'),
    ('josh-allen',         '{"resolve": {"player_search": "Josh Allen", "team_search": "Buffalo"},
       "game_stats": {"game_rating": {"group": "Passing", "name": "rating"}, "game_interceptions": {"group": "Passing", "name": "interceptions"}, "game_passing_yards": {"group": "Passing", "name": "yards"}, "game_rushing_yards": {"group": "Rushing", "name": "yards"}}}')
  ) as v(slug, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'apisports';

-- The read-only probe the operator asked for (item 7): does a when:7d Google
-- News query serve Adin Ross recent items? The live query is untouched.
update public.person_data_sources pds
   set config = coalesce(pds.config, '{}'::jsonb) || '{"resolve": {"probe_url": "https://news.google.com/rss/search?q=%22Adin+Ross%22+when%3A7d&hl=en-US&gl=US&ceid=US%3Aen"}}'::jsonb
  from public.people p, public.data_sources d
 where pds.person_id = p.id and pds.data_source_id = d.id and p.slug = 'adin-ross' and d.name = 'rss';
