-- =============================================================================
-- ROSTER EXPANSION, STEP TWO (2026-10-09): the ids the platforms answered.
--
-- Resolved LIVE by lib/ingest/identity.ts at 02:00 UTC, through the official
-- APIs, and compared with the 10-02 prep listing before anything here went
-- active:
--   API-Sports (/teams then /players scoped to the team, season 2026)
--     Ja'Marr Chase    player 690    WR  Cincinnati Bengals  team 10
--     Jahmyr Gibbs     player 14098  RB  Detroit Lions       team 7
--     Bijan Robinson   player 24380  RB  Atlanta Falcons     team 8
--     Lamar Jackson    player 291    QB  Baltimore Ravens    team 5
--     Josh Allen       player 1414   QB  Buffalo Bills       team 20
--     (Jaxon Smith-Njigba: the Seahawks are team 23 but the player search
--      returned nobody; his mapping stays inactive, resolving under another
--      spelling.)
--   YouTube (channels.list forHandle)
--     Caedrel          @caedrel  -> UCOFiUtKui6-x4T-J7_DgCag ("Caedrel", 643K)
--     (Jynxzi's handle resolved to a channel other than the prep's unverified
--      guess; held for the operator. Asmongold's main channel is verified by
--      id in the next run; his clips channel matched the prep.)
--
-- The five API-Sports mappings go live with the player id as the identifier
-- and the team on the mapping (mergedApiSportsConfig); the resolve block is
-- dropped so the daily resolution stops, the identity block stays as the
-- record. Caedrel gets a youtube channel-statistics mapping with commentary
-- OFF (no search.list) and his channel pinned on the trending row, the
-- Phase 22 way: the handle is not kept, so the poll costs nothing.
--
-- Re-runnable after the Phase 22 seed, which rewrites every trending row.
-- =============================================================================

update public.person_data_sources m
   set external_identifier = v.player_id,
       is_active = true,
       config = (m.config - 'resolve') || jsonb_build_object('team_id', v.team_id)
  from public.people p, public.data_sources d,
       (values
          ('jamarr-chase',   '690',   10),
          ('jahmyr-gibbs',   '14098', 7),
          ('bijan-robinson', '24380', 8),
          ('lamar-jackson',  '291',   5),
          ('josh-allen',     '1414',  20)
       ) as v(slug, player_id, team_id)
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'apisports' and p.slug = v.slug;

insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, 'UCOFiUtKui6-x4T-J7_DgCag', true, '{"commentary": false}'::jsonb
  from public.people p, public.data_sources d
 where p.slug = 'caedrel' and d.name = 'youtube'
on conflict (person_id, data_source_id) do update
   set external_identifier = excluded.external_identifier, is_active = true, config = excluded.config;

update public.person_data_sources m
   set config = (m.config - 'channel_id' - 'handles') || jsonb_build_object('channel_ids', '["UCOFiUtKui6-x4T-J7_DgCag"]'::jsonb)
  from public.people p, public.data_sources d
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'youtube_trending' and p.slug = 'caedrel';
