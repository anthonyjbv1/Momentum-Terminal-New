-- =============================================================================
-- Momentum Terminal — Phase 22: YouTube Trending as a signal.
--
-- The trending chart is the closest thing to a real-time attention signal
-- available legitimately: it refreshes about every half hour, it is national
-- and non-personalised (the same for every observer, so an appearance is
-- reproducible), and YouTube's own ranking already weighs a video's
-- performance RELATIVE TO ITS CHANNEL'S NORM. An appearance is not raw
-- popularity; it is a momentum reading YouTube computed across all of
-- YouTube. Read through the official Data API only — videos.list with
-- chart=mostPopular, one quota unit a call — never by scraping the chart page.
--
-- EVENT, NOT METRIC, for a regulatory reason. The platform's posture is that
-- the score is a transparent, rules-based function of public inputs. A
-- trending RANK is the output of an undisclosed algorithm nobody here can
-- audit; baselining it would make part of the methodology "because YouTube
-- said so". An APPEARANCE is a dated, verifiable occurrence — the video was on
-- the chart, anyone can check — so this row declares NO metrics. There is
-- nothing under config.metrics to baseline and nothing for observe_only to
-- hold back: the connector has no fetchMetrics at all.
--
-- ONE ROW FOR THE CHART, ONE FETCH FOR EVERYONE. The chart is shared, so the
-- connector fetches it once per run (a module cache keyed on the run's clock,
-- as the publisher feed catalogue and the API-Sports games list are) and every
-- mapped person is matched against the same list. Sixteen mappings, one
-- request.
--
-- POLL INTERVAL 25. Not a multiple of 15 (the rule every active source obeys
-- since Phase 13: an exact multiple loses the `< interval` race on every fire
-- and silently polls half as often), and not 55 either, which lands on the
-- top of the hour beside youtube, youtube_comments and twitch. On the
-- fifteen-minute cron 25 comes due every second fire — an effective cadence
-- of 30 minutes, which is what the chart refreshes at; polling faster buys
-- nothing. Two units an hour; forty-eight a day against ten thousand.
--
-- TIER 2, the same as the youtube row: this is YouTube's own first-party
-- chart, not a report about it.
--
-- THE MAPPINGS. Every active person, keyed by display name (the term a title
-- must carry, as the publisher feed mappings are keyed), with the per-subject
-- half of the configuration built from what the board already knows:
--
--   channel_id       the person's own YouTube channel, for the CHANNEL route
--                    (a video on their channel is theirs, unambiguously). Taken
--                    from the existing youtube mapping where one exists — today
--                    that is MrBeast alone — and absent otherwise. A channel id
--                    is added by verifying it through the official
--                    channels.list (forHandle=@handle, one unit) and updating
--                    this row; nothing is guessed here.
--   match_terms      EMPTY, on purpose. The publisher mappings admit bare
--                    surnames ("Musk", "Bezos", "Kendrick") because a
--                    business-section feed supplies the context; the trending
--                    chart is unscoped — gaming beside cooking beside news — so
--                    a title must name the person in full. An alias is a row
--                    update if an operator ever wants one.
--   disambiguation   the Phase 12+ block, INHERITED from the person's
--                    publisher_rss mapping (the richest of the two news doors),
--                    not rewritten: the same exclusions, judged by the same
--                    code. Drake's list gains the one wrong Drake the chart is
--                    likelier to carry than a news feed is — the sitcom.
--
-- A person the chart never carries is unaffected: no match, no signal, no
-- score impact, and the poll row says ok with nothing produced.
-- =============================================================================

insert into public.data_sources (name, display_name, tier, poll_interval_minutes, is_active, config)
values (
  'youtube_trending',
  'YouTube Trending',
  2,
  25,
  true,
  jsonb_build_object(
    -- One national, non-personalised chart.
    'region', 'US',
    -- The top of the chart, in one call. Up to 200 (four calls) if ever wanted.
    'max_results', 50
  )
)
on conflict (name) do update
   set display_name = excluded.display_name,
       tier = excluded.tier,
       poll_interval_minutes = excluded.poll_interval_minutes,
       is_active = excluded.is_active,
       config = excluded.config;

-- Every active person reads the chart ----------------------------------------
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id,
       d.id,
       p.display_name,
       true,
       jsonb_strip_nulls(
         jsonb_build_object(
           'channel_id', yt.external_identifier,
           'match_terms', '[]'::jsonb,
           'disambiguation', coalesce(
             pub.config -> 'disambiguation',
             jsonb_build_object('exclude_terms', '[]'::jsonb, 'require_any', '[]'::jsonb)
           )
         )
       )
  from public.people p
 cross join public.data_sources d
  left join public.person_data_sources yt
         on yt.person_id = p.id
        and yt.is_active
        and yt.data_source_id = (select id from public.data_sources where name = 'youtube')
  left join public.person_data_sources pub
         on pub.person_id = p.id
        and pub.is_active
        and pub.data_source_id = (select id from public.data_sources where name = 'publisher_rss')
 where d.name = 'youtube_trending'
   and p.is_active
on conflict (person_id, data_source_id) do update
   set external_identifier = excluded.external_identifier,
       is_active = true,
       config = excluded.config;

-- Drake: the sitcom. "Drake & Josh" reunions, clips and retrospectives trend
-- on YouTube in a way they never reach a music-section news feed, and the
-- title names neither the university nor the quarterback the inherited list
-- already refuses. Appended to the inherited exclusions, so the row above can
-- be re-run and this still holds.
update public.person_data_sources m
   set config = jsonb_set(
         m.config,
         '{disambiguation,exclude_terms}',
         coalesce(m.config -> 'disambiguation' -> 'exclude_terms', '[]'::jsonb) || '["drake & josh", "drake and josh"]'::jsonb
       )
  from public.people p, public.data_sources d
 where m.person_id = p.id
   and m.data_source_id = d.id
   and d.name = 'youtube_trending'
   and p.slug = 'drake';
