-- =============================================================================
-- Momentum Terminal — Phase 22 follow-up: @DrakeOfficial, and the Adin Ross
-- corroboration recorded where the next reader will look.
--
-- DRAKE. The previous migration refused @Drake — it resolves to a
-- 491-subscriber namesake — and left his main channel unmapped rather than
-- inferring it from a chart sighting. The missing handle is @DrakeOfficial:
-- the channel is titled "Drake", carries the OVO owl, is verified at 33.1M
-- subscribers and links to ovosound.com and drakerelated.com. That is almost
-- certainly UCByOQJjav0CUDwxCk-jVNRQ, the channel that posted "DRAKE - CLASSIC"
-- at #1 on the 21:15 poll.
--
-- "Almost certainly" is not the bar. So the handle is SEEDED rather than the id
-- pinned, the connector resolves it through channels.list?forHandle= on the
-- next poll, and the id is pinned only if that resolution returns
-- UCByOQJjav0CUDwxCk-jVNRQ — verification through a handle, not inference from
-- a chart sighting. If it returns anything else it is refused and reported,
-- exactly as @Drake was.
--
-- THE ARMING WINDOW, stated rather than glossed. A handle is trusted the moment
-- it resolves, so between this migration and the pin @DrakeOfficial is live on
-- the channel route. For a false signal to result, the channel it resolves to
-- would have to be somebody else's AND have a video in the US top fifty during
-- that one poll cycle. The handle is independently evidenced from the live
-- channel page, so the conjunction is remote — but it is a real window and the
-- note on the next poll is what closes it.
--
-- ADIN ROSS — CORROBORATION, NOT A DEFECT. UCey-eDTR5J6xU6pZ2f4guoA is pinned
-- to adin-ross and the channel is titled "Adin Live", not "Adin Ross". That
-- mismatch reads as a bug to anyone meeting the row cold, so the evidence is
-- recorded here: the channel is verified at 4.62M subscribers, holds the handle
-- @AdinRoss, and lists kick.com/adinross among its links. The handle and the
-- Kick link are two independent confirmations of ownership; the channel is
-- simply named differently from the person, which creators routinely do. The
-- pin stands and is NOT a mistake to be "corrected" by a later reader.
-- =============================================================================

update public.person_data_sources m
   set config = m.config || jsonb_build_object('handles', jsonb_build_array('@DrakeOfficial'))
  from public.people p, public.data_sources d
 where m.person_id = p.id
   and m.data_source_id = d.id
   and d.name = 'youtube_trending'
   and p.slug = 'drake';
