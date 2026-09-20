-- =============================================================================
-- Momentum Terminal — Phase 22 follow-up: the resolutions, judged and pinned.
--
-- The previous migration seeded handles; the connector resolved them on the
-- 21:45 poll of 2026-09-20 and reported each through the note channel. This
-- pins the ones that are the person's own and drops every handle, which stops
-- the lookup. What each handle actually returned, and the judgement:
--
--   @MrBeast            UCX6OQ3DkcsbYNE6H8uQQuVA  "MrBeast"            516,000,000
--                       PIN. Identical to the id the board already held, so
--                       the value stored days ago is re-verified rather than
--                       assumed, which is what it was riding along to do.
--   @KaiCenat           UCoEmptob-eEGKk18c2VplJg  "Kai Cenat"            8,200,000
--                       PIN. THE ONE THIS FOLLOW-UP EXISTS FOR. His uploads
--                       carry a stream title and not his name, so the title
--                       route never saw them.
--   @KendrickLamar      UC3lBXcrKFnFAFkfVk5WuKcQ  "Kendrick Lamar"      20,300,000
--   @KendrickLamarVEVO  UCoYfzC2zMlc9M-Odgaf6OSg  "KendrickLamarVEVO"    6,830,000
--                       PIN BOTH. Personal and label, the set doing exactly
--                       the job it was widened for.
--   @DrakeVEVO          UCQznUf1SjfDqx65hX3zRDiA  "DrakeVEVO"            8,970,000
--                       PIN.
--   @adinross           UCey-eDTR5J6xU6pZ2f4guoA  "Adin Live"            4,620,000
--                       PIN, with the discrepancy stated rather than buried:
--                       the channel is titled "Adin Live", not "Adin Ross".
--                       The handle is exactly his name and 4.62M subscribers
--                       is his order of magnitude; a squatter does not hold
--                       both. Creators rename channels. Judged his.
--
--   @Drake              UCNTQH0uJzryQB4rRLGlv-Ww  "drake"                      491
--                       *** NOT PINNED. NOT HIM. ***
--                       491 subscribers. Somebody else holds the @Drake
--                       handle — a namesake or a squatter — and arming it
--                       would have credited Aubrey Graham with that person's
--                       uploads the first time one charted. This is the exact
--                       error the note channel exists to catch, caught on the
--                       first poll, and the handle is dropped here.
--
-- WHAT IS STILL OPEN, said plainly. Drake's MAIN channel is unmapped. The
-- 21:15 live fire caught "DRAKE - CLASSIC" at #1 from UCByOQJjav0CUDwxCk-jVNRQ,
-- titled "Drake" — a third channel, neither the 491-subscriber @Drake nor
-- DrakeVEVO — and that is where his music actually goes up. A channel title
-- seen on the chart is evidence of a name, NOT proof of ownership, and this
-- codebase pins ids it has verified rather than ids it has inferred. Closing
-- it needs the handle that resolves to that id; until then Drake keeps
-- DrakeVEVO plus the title route, which is what caught the #1 video.
-- =============================================================================

update public.person_data_sources m
   set config = (m.config - 'handles') || jsonb_build_object('channel_ids', v.channel_ids)
  from public.people p, public.data_sources d,
       (values
          ('mrbeast',        jsonb_build_array('UCX6OQ3DkcsbYNE6H8uQQuVA')),
          ('kai-cenat',      jsonb_build_array('UCoEmptob-eEGKk18c2VplJg')),
          ('kendrick-lamar', jsonb_build_array('UC3lBXcrKFnFAFkfVk5WuKcQ', 'UCoYfzC2zMlc9M-Odgaf6OSg')),
          ('adin-ross',      jsonb_build_array('UCey-eDTR5J6xU6pZ2f4guoA')),
          -- DrakeVEVO only. The @Drake handle is somebody else's; see above.
          ('drake',          jsonb_build_array('UCQznUf1SjfDqx65hX3zRDiA'))
       ) as v(slug, channel_ids)
 where m.person_id = p.id
   and m.data_source_id = d.id
   and d.name = 'youtube_trending'
   and p.slug = v.slug;
