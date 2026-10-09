-- =============================================================================
-- THE NBA CONNECTOR (2026-10-09): the apisports_nba source and the four
-- players' mappings, INACTIVE until the API-NBA plan is bought and the ids
-- resolve (config.resolve, the identity resolver: team first, then the
-- player scoped to the team). Modelled on the NFL row: tier 2, hourly, the
-- host, the paths and the per-game metric definitions as configuration.
--
-- No weight, force, Gravity, drift, tune or market path changes. The three
-- per-game metrics are level metrics against the player's own trailing
-- games (70 days, eight games before they emit), recorded at the game's
-- date; a game the player did not play is never a sample.
-- =============================================================================

insert into public.data_sources (name, display_name, tier, poll_interval_minutes, is_active, config)
values (
  'apisports_nba',
  'API-NBA',
  2,
  65,
  true,
  '{
    "host": "v2.nba.api-sports.io",
    "paths": {"games": "/games?season={season}&team={team}", "game_statistics": "/players/statistics?game={game}"},
    "season": null,
    "game_stats": {"game_points": "points", "game_rebounds": "totReb", "game_assists": "assists"},
    "minutes_field": "min",
    "min_minutes": 10,
    "comment_field": "comment",
    "player_id_keys": ["player.id"],
    "finished_statuses": ["Finished", "FT", "AOT", "Final"],
    "excluded_stages": ["Pre Season", "Preseason"],
    "regulation_periods": 4,
    "recent_games": 5,
    "metrics": {
      "game_points":   {"delta": "level", "label": "points per game",   "scale": 0.8, "polarity": 1, "sd_floor": 6,   "min_samples": 8, "baseline_window_hours": 1680},
      "game_rebounds": {"delta": "level", "label": "rebounds per game", "scale": 0.6, "polarity": 1, "sd_floor": 2.5, "min_samples": 8, "baseline_window_hours": 1680},
      "game_assists":  {"delta": "level", "label": "assists per game",  "scale": 0.6, "polarity": 1, "sd_floor": 2,   "min_samples": 8, "baseline_window_hours": 1680}
    }
  }'::jsonb
)
on conflict (name) do nothing;

-- The four, inactive, with the resolve blocks (team first, then the player
-- scoped to the team; alphanumeric search text). external_identifier
-- becomes the API-NBA player id and is_active true once the operator has
-- compared identity.apisports with the roster listing; team_id is set on the
-- mapping from identity.apisports.team_id at the same time.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, 'pending', false, v.config::jsonb
  from (values
    ('stephen-curry',           '{"resolve": {"player_search": "Curry", "team_search": "Golden State"}}'),
    ('lebron-james',            '{"resolve": {"player_search": "James", "team_search": "Lakers"}}'),
    ('victor-wembanyama',       '{"resolve": {"player_search": "Wembanyama", "team_search": "San Antonio"}}'),
    ('shai-gilgeous-alexander', '{"resolve": {"player_search": "Gilgeous Alexander", "team_search": "Oklahoma City"}}')
  ) as v(slug, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'apisports_nba'
on conflict (person_id, data_source_id) do nothing;
