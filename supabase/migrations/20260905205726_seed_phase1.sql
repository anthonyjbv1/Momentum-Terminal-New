-- =============================================================================
-- Momentum Terminal — Phase 1 migration 4/4: seed data
--
-- * 16 tracked people. base_score and current_score start at 50.0; each person
--   has an individual revert_target.
-- * One inverse pair: Drake <-> Kendrick Lamar, dampening 0.40.
-- * The data-source registry, all inactive until later phases switch them on.
--
-- Every insert is idempotent (on conflict do nothing) so re-running is safe.
-- =============================================================================

-- people ----------------------------------------------------------------------
insert into public.people (slug, display_name, full_name, bio, category, current_score, base_score, revert_target)
values
  ('elon-musk',        'Elon Musk',        'Elon Reeve Musk',          'CEO of Tesla and SpaceX.',                                   'executive', 50.0, 50.0, 55),
  ('mrbeast',          'MrBeast',          'James Stephen Donaldson',  'YouTube creator and founder of Feastables.',                 'creator',   50.0, 50.0, 68),
  ('kai-cenat',        'Kai Cenat',        'Kai Carlo Cenat III',      'Twitch streamer and content creator.',                       'creator',   50.0, 50.0, 60),
  ('drake',            'Drake',            'Aubrey Drake Graham',      'Rapper, singer and founder of OVO Sound.',                   'musician',  50.0, 50.0, 65),
  ('adin-ross',        'Adin Ross',        'Adin David Ross',          'Live streamer and content creator.',                         'creator',   50.0, 50.0, 52),
  ('patrick-mahomes',  'Patrick Mahomes',  'Patrick Lavon Mahomes II', 'Quarterback for the Kansas City Chiefs.',                    'athlete',   50.0, 50.0, 61),
  ('kendrick-lamar',   'Kendrick Lamar',   'Kendrick Lamar Duckworth', 'Rapper, songwriter and co-founder of pgLang.',               'musician',  50.0, 50.0, 63),
  ('jensen-huang',     'Jensen Huang',     'Jen-Hsun Huang',           'Co-founder and CEO of NVIDIA.',                              'executive', 50.0, 50.0, 63),
  ('mark-zuckerberg',  'Mark Zuckerberg',  'Mark Elliot Zuckerberg',   'Co-founder and CEO of Meta Platforms.',                      'executive', 50.0, 50.0, 55),
  ('warren-buffett',   'Warren Buffett',   'Warren Edward Buffett',    'Chairman of Berkshire Hathaway.',                            'executive', 50.0, 50.0, 62),
  ('larry-ellison',    'Larry Ellison',    'Lawrence Joseph Ellison',  'Co-founder and chairman of Oracle.',                         'executive', 50.0, 50.0, 57),
  ('jeff-bezos',       'Jeff Bezos',       'Jeffrey Preston Bezos',    'Founder of Amazon and Blue Origin.',                         'executive', 50.0, 50.0, 56),
  ('larry-page',       'Larry Page',       'Lawrence Edward Page',     'Co-founder of Google.',                                      'executive', 50.0, 50.0, 55),
  ('sergey-brin',      'Sergey Brin',      'Sergey Mikhailovich Brin', 'Co-founder of Google.',                                      'executive', 50.0, 50.0, 54),
  ('michael-dell',     'Michael Dell',     'Michael Saul Dell',        'Founder, chairman and CEO of Dell Technologies.',            'executive', 50.0, 50.0, 53),
  ('anthony-baptiste', 'Anthony Baptiste', 'Anthony Baptiste',         'Founder of Momentum Terminal.',                              'founder',   50.0, 50.0, 60)
on conflict (slug) do nothing;

-- inverse pairs ---------------------------------------------------------------
insert into public.inverse_pairs (person_a_id, person_b_id, dampening)
select a.id, b.id, 0.40
  from public.people a
  join public.people b on true
 where a.slug = 'drake'
   and b.slug = 'kendrick-lamar'
on conflict do nothing;

-- data sources (all inactive until activated in later phases) -----------------
insert into public.data_sources (name, display_name, tier, poll_interval_minutes, is_active)
values
  ('youtube',   'YouTube',     2, 60,    false),
  ('twitch',    'Twitch',      2, 15,    false),
  ('spotify',   'Spotify',     2, 60,    false),
  ('forbes',    'Forbes',      1, 60,    false),
  ('finnhub',   'Finnhub',     1, 5,     false),
  ('newsdata',  'NewsData.io', 3, 60,    false),
  ('billboard', 'Billboard',   2, 10080, false),
  ('apisports', 'API-Sports',  2, 360,   false)
on conflict (name) do nothing;
