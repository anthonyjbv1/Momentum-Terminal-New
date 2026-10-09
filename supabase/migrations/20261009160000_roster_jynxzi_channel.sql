-- =============================================================================
-- ROSTER EXPANSION, STEP FOUR (2026-10-09): Jynxzi's channel, as ruled.
--
-- The handle @Jynxzi resolved live (channels.list forHandle, 02:30 UTC) to
-- UCjiXtODGCCulmhwypZAWSag ("Jynxzi", 7.0M subscribers, 2,298 videos), not
-- the id the 10-02 prep listed as unverified. The operator ruled for the
-- live answer. Channel statistics with commentary OFF, the channel pinned on
-- the trending row, the Twitch mapping's resolve block dropped.
--
-- Re-runnable after the Phase 22 seed, which rewrites every trending row.
-- =============================================================================

insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, 'UCjiXtODGCCulmhwypZAWSag', true, '{"commentary": false}'::jsonb
  from public.people p, public.data_sources d
 where p.slug = 'jynxzi' and d.name = 'youtube'
on conflict (person_id, data_source_id) do update
   set external_identifier = excluded.external_identifier, is_active = true, config = excluded.config;

update public.person_data_sources m
   set config = (m.config - 'channel_id' - 'handles') || jsonb_build_object('channel_ids', '["UCjiXtODGCCulmhwypZAWSag"]'::jsonb)
  from public.people p, public.data_sources d
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'youtube_trending' and p.slug = 'jynxzi';

update public.person_data_sources m
   set config = m.config - 'resolve'
  from public.people p, public.data_sources d
 where m.person_id = p.id and m.data_source_id = d.id and d.name = 'twitch' and p.slug = 'jynxzi';
