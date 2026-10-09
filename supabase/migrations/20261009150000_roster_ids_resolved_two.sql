-- =============================================================================
-- ROSTER EXPANSION, STEP THREE (2026-10-09): the last two verifications.
--
-- Resolved live at 02:30 UTC and compared with the 10-02 prep:
--   Jaxon Smith-Njigba  API-Sports player 14255 ("Jaxon SmithNjigba", WR,
--                       Seattle Seahawks, team 23); the first search carried
--                       the hyphen the API refuses, the second did not.
--   Asmongold           main channel UCQeRaTukNYft1_6AZPACnog verified BY ID
--                       ("Asmongold TV", @asmontv, 4.71M) and the clips
--                       channel UCMwJJL5FJFuTRT55ksbQ4GQ by handle
--                       (@asmongoldclips, 1.87M): both the ids the prep held.
--
-- His channel-statistics mapping is the main channel, commentary OFF; both
-- channels are pinned on the trending row. The streamers' Twitch mappings
-- drop their resolve blocks: the daily resolution has done its work and the
-- identity block stays as the record. Jynxzi's channel is NOT pinned: his
-- handle resolved to a channel other than the prep's unverified guess and
-- the operator rules on it.
--
-- Re-runnable after the Phase 22 seed, which rewrites every trending row.
-- =============================================================================

update public.person_data_sources m
   set external_identifier = '14255', is_active = true, config = (m.config - 'resolve') || '{"team_id": 23}'::jsonb
  from public.people p, public.data_sources d
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'apisports' and p.slug = 'jaxon-smith-njigba';

insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, 'UCQeRaTukNYft1_6AZPACnog', true, '{"commentary": false}'::jsonb
  from public.people p, public.data_sources d
 where p.slug = 'asmongold' and d.name = 'youtube'
on conflict (person_id, data_source_id) do update
   set external_identifier = excluded.external_identifier, is_active = true, config = excluded.config;

update public.person_data_sources m
   set config = (m.config - 'channel_id' - 'handles') || jsonb_build_object('channel_ids', '["UCQeRaTukNYft1_6AZPACnog", "UCMwJJL5FJFuTRT55ksbQ4GQ"]'::jsonb)
  from public.people p, public.data_sources d
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'youtube_trending' and p.slug = 'asmongold';

update public.person_data_sources m
   set config = m.config - 'resolve'
  from public.people p, public.data_sources d
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'twitch' and p.slug in ('asmongold', 'caedrel');

-- The receivers' receptions statistic: API-Sports names it "total receptions"
-- in the Receiving group (his statistics there: targets, total receptions,
-- yards, average, receiving touch downs, longest reception, two pt). Ja'Marr
-- Chase's first ten polls errored on "receptions"; corrected on the mapping,
-- as the poll's own reason advised.
update public.person_data_sources m
   set config = jsonb_set(jsonb_set(m.config, '{game_stats,game_receptions,name}', '"total receptions"'), '{headline_stats,receptions,name}', '"total receptions"')
  from public.people p, public.data_sources d
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'apisports' and p.slug in ('jamarr-chase', 'jaxon-smith-njigba');
