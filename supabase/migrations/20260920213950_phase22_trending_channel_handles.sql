-- =============================================================================
-- Momentum Terminal — Phase 22 follow-up: channel ids for the trending chart.
--
-- Phase 22 shipped with exactly one verified channel id (MrBeast's, copied
-- from the youtube mapping), so every other subject was caught by the TITLE
-- route alone. That is a real gap and it is worst exactly where the chart
-- matters most: Kai Cenat's own uploads conventionally carry a stream title
-- and not his name, so his own trending videos were invisible to us.
--
-- A channel id is not something anyone knows by heart, and the only way to
-- learn one WITHOUT scraping a web page is channels.list?forHandle= — one
-- quota unit. So the mapping now names HANDLES, the connector resolves them
-- where the API key lives, and reports each resolution through the poll's
-- note channel for an operator to judge and pin. Nothing here guesses an id:
-- every id this seeds is one the board already held.
--
-- TWO KEYS, AND WHY BOTH:
--   channel_ids  verified ids. Free, authoritative, matched as a SET.
--   handles      resolved each poll until pinned. A handle is TRUSTED once it
--                resolves, so only handles that are certainly the person's own
--                are seeded — a wrong handle would arm the channel route for
--                somebody else's uploads, which is the error this phase most
--                wants to avoid.
--
-- A SET OF CHANNELS, NOT ONE. A musician has both a personal channel and a
-- label-operated VEVO channel, and both trend. A single channel_id forced a
-- choice; the set does not. A VEVO channel is the artist's own distribution
-- for the artist's own music videos, so DrakeVEVO trending IS Drake trending,
-- and the credit runs the right way: DrakeVEVO carries "Drake ft. X", while
-- "X ft. Drake" lives on X's VEVO and is never credited here. The failure mode
-- of mapping VEVO is a MISS on a feature, not a false positive — and the title
-- route catches those when the title names him.
--
-- NO EXECUTIVE IS MAPPED, and that is the honest answer rather than an
-- omission. NVIDIA's channel is not Jensen Huang's, Meta's is not
-- Zuckerberg's, and mapping either would credit the person with the company's
-- upload schedule. Beyond the corporate channels there is nothing to map: what
-- exists for these nine is conference, interview and clip channels owned by
-- other people. And even where a personal channel exists, the channel route
-- would add almost nothing — an executive's video is conventionally titled
-- with their name ("Jensen Huang on the future of compute"), which the title
-- route already catches. The route earns its keep for creators whose titles do
-- not name them, which is the opposite case.
-- =============================================================================

-- MrBeast: the id the board already verified moves into the set, and the
-- handle rides along ONCE so the next poll re-resolves it rather than assuming
-- a value stored days ago still points where it did.
update public.person_data_sources m
   set config = m.config
                - 'channel_id'
                || jsonb_build_object(
                     'channel_ids', jsonb_build_array(m.config ->> 'channel_id'),
                     'handles', jsonb_build_array('@MrBeast')
                   )
  from public.people p, public.data_sources d
 where m.person_id = p.id
   and m.data_source_id = d.id
   and d.name = 'youtube_trending'
   and p.slug = 'mrbeast'
   and m.config ? 'channel_id';

-- The four subjects with a YouTube presence of their own, by handle.
--
--   kai-cenat       THE PRIORITY. The highest-frequency YouTube subject after
--                   MrBeast, and the one the title route misses outright.
--   drake           personal + VEVO.
--   kendrick-lamar  personal + VEVO.
--   adin-ross       personal.
--
-- Nobody else: Patrick Mahomes has no channel of his own (his highlights are
-- the NFL's and his team's), and the founder has none.
update public.person_data_sources m
   set config = m.config || jsonb_build_object('handles', v.handles)
  from public.people p, public.data_sources d,
       (values
          ('kai-cenat',      jsonb_build_array('@KaiCenat')),
          ('drake',          jsonb_build_array('@Drake', '@DrakeVEVO')),
          ('kendrick-lamar', jsonb_build_array('@KendrickLamar', '@KendrickLamarVEVO')),
          ('adin-ross',      jsonb_build_array('@adinross'))
       ) as v(slug, handles)
 where m.person_id = p.id
   and m.data_source_id = d.id
   and d.name = 'youtube_trending'
   and p.slug = v.slug;
