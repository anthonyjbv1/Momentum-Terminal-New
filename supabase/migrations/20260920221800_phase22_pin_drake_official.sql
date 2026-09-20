-- =============================================================================
-- Momentum Terminal — Phase 22 follow-up: Drake's main channel, verified.
--
-- The 22:15 poll resolved the seeded handle:
--
--   @DrakeOfficial  ->  UCByOQJjav0CUDwxCk-jVNRQ  "Drake"  33,100,000 subscribers
--
-- That is the same id that posted "DRAKE - CLASSIC" at #1 on the 21:15 poll,
-- which is what closes this. The chart sighting alone was evidence of a NAME;
-- the handle resolution is evidence of OWNERSHIP, and the two agreeing is the
-- bar this phase set. Pinned alongside DrakeVEVO, personal channel first, the
-- same order as Kendrick's pair, and the handle is dropped so the lookup stops.
--
-- Drake now holds both channels that matter:
--   UCByOQJjav0CUDwxCk-jVNRQ  the active channel; new releases go up here
--   UCQznUf1SjfDqx65hX3zRDiA  DrakeVEVO, the label catalogue
-- This is the set doing exactly what it was widened for. Neither had to be
-- given up, and "DRAKE - CLASSIC" would now read as "Drake is trending at #1"
-- rather than "A video about Drake is trending at #1" — his own upload, said
-- as his.
--
-- THE @Drake REFUSAL STANDS AND STAYS DOCUMENTED. UCNTQH0uJzryQB4rRLGlv-Ww, a
-- 491-subscriber namesake, holds the exact-name handle. Nothing here pins it,
-- and the arming window opened by seeding @DrakeOfficial closed with this
-- migration having produced no signal from any unverified channel.
-- =============================================================================

update public.person_data_sources m
   set config = (m.config - 'handles')
                || jsonb_build_object('channel_ids', jsonb_build_array('UCByOQJjav0CUDwxCk-jVNRQ', 'UCQznUf1SjfDqx65hX3zRDiA'))
  from public.people p, public.data_sources d
 where m.person_id = p.id
   and m.data_source_id = d.id
   and d.name = 'youtube_trending'
   and p.slug = 'drake';
