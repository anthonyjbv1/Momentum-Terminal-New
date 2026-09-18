-- =============================================================================
-- Momentum Terminal — Phase 17: Finnhub for the executives, with NO price in
-- any score.
--
-- Nine of the sixteen are executives running on news alone. Finnhub gives them
-- a second door, and the whole design is shaped by one constraint that is
-- regulatory rather than modelling: the platform's positioning rests on its
-- indexes deriving no value from any registered financial instrument, which is
-- what defeats a security-based swap reading under Exchange Act 3(a)(68)(A).
-- A Momentum Score that moved because a company's stock moved would be exactly
-- that exposure, per person and direct.
--
-- So what SCORES here carries no price:
--   company_news_volume_24h  a COUNT of articles about the company, baselined
--                            against the person's own trailing fortnight. The
--                            same shape as news_volume_24h. A count is not a
--                            price, and the headlines are never stored (they
--                            are about the company, the two news doors already
--                            cover the person, and a stored "TSLA climbs 5%"
--                            would walk a price in through the scorer).
--   insider filings          EVENTS: one per Form 4 the TRACKED PERSON filed,
--                            matched by name against config.insider_names and
--                            limited to the decision codes P and S, carrying
--                            the direction and the share count and never the
--                            transaction price or any dollar value.
--
-- And the price it does read is OBSERVE-ONLY. `config.observe_only` is read by
-- the ingestion runner: a reading whose key is listed there is recorded as a
-- raw snapshot and goes no further — no observation, no signal, no force, no
-- memory, no score history. The series fills so the baseline is ready the day
-- counsel clears it, and there is no trail to unwind if it never is. Turning it
-- on is this row: drop 'daily_close' from observe_only and declare it under
-- metrics. No deploy.
--
-- POLL INTERVAL 35. Not a multiple of 15, and deliberately not 55 either: with
-- the fifteen-minute cron an interval of 55 comes due at exactly the top of
-- every hour, which is why youtube, youtube_comments, twitch, forbes and
-- newsdata all land together and why the 00:00 run spent 34.1 s of its 35 s
-- budget. 35 comes due every 45 minutes and so cycles through :45, :30, :15,
-- :00 — it shares the top of the hour one poll in four instead of every one.
-- =============================================================================

update public.data_sources
   set is_active = true,
       poll_interval_minutes = 35,
       config = jsonb_build_object(
         'host', 'https://finnhub.io/api/v1',
         'news_window_hours', 24,
         'insider_lookback_days', 45,
         -- P (open-market purchase) and S (open-market sale) are decisions an
         -- insider took. A (award), M (option exercise), F (shares withheld for
         -- tax) and G (gift) are compensation and estate mechanics: scoring an
         -- award as positive would mean the board paying the CEO moved the CEO.
         'insider_codes', jsonb_build_array('P', 'S'),
         'daily_close_hours', 20,
         -- Nine people at up to three calls each against a 60-a-minute free
         -- tier; four at a time keeps the source's share of the run near a
         -- second.
         'poll_concurrency', 4,
         -- THE PRICE LIVES HERE AND NOWHERE ELSE. Listed = recorded, displayed,
         -- never scored. Removing it from this array and adding a declaration
         -- under 'metrics' is the whole of turning it on.
         'observe_only', jsonb_build_array('daily_close'),
         'metrics', jsonb_build_object(
           -- A windowed count, like news_volume_24h: the window is the
           -- measurement, so consecutive polls agree and the sigma describes
           -- the coverage rather than the schedule. The sd floor is 2 rather
           -- than the person-level 0.5 because a company's day is measured in
           -- dozens of articles, not in ones. The scale is deliberately modest:
           -- this is attention on the COMPANY, a proxy for the person, and for
           -- Page and Brin it is the same series.
           'company_news_volume_24h', jsonb_build_object(
             'label', 'company news volume',
             'delta', 'level',
             'polarity', 1,
             'baseline_window_hours', 336,
             'min_samples', 24,
             'sd_floor', 2.0,
             'scale', 0.5
           )
         )
       )
 where name = 'finnhub';

-- The nine executives, each to the company they are identified with -----------
--
-- external_identifier is the ticker; config.insider_names is how a Form 4 is
-- recognised as THEIRS. Finnhub returns every insider at the company, and
-- "Tesla's CFO sold shares" is not a Musk event, so a person with no configured
-- name gets no filings at all and the poll says so through the note channel.
-- Names are surname-first as the SEC files them, and match when every word
-- appears, which accepts a middle initial and rejects a different Musk.
--
-- PAGE AND BRIN BOTH MAP TO GOOGL. Their insider filings differ (each is
-- matched by their own name) but the company-news count is the same series for
-- both, so that metric will move them together. It is left as one shared metric
-- at a modest scale rather than split or reweighted, because splitting it would
-- be inventing a difference that Alphabet's coverage does not have.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, v.symbol, true, jsonb_build_object('insider_names', v.insider_names)
  from (values
    ('elon-musk',       'TSLA',  jsonb_build_array('Musk Elon')),
    ('jeff-bezos',      'AMZN',  jsonb_build_array('Bezos Jeffrey')),
    ('mark-zuckerberg', 'META',  jsonb_build_array('Zuckerberg Mark')),
    ('warren-buffett',  'BRK.B', jsonb_build_array('Buffett Warren')),
    ('jensen-huang',    'NVDA',  jsonb_build_array('Huang Jen Hsun', 'Huang Jensen')),
    ('larry-ellison',   'ORCL',  jsonb_build_array('Ellison Lawrence')),
    ('larry-page',      'GOOGL', jsonb_build_array('Page Larry', 'Page Lawrence')),
    ('sergey-brin',     'GOOGL', jsonb_build_array('Brin Sergey')),
    ('michael-dell',    'DELL',  jsonb_build_array('Dell Michael'))
  ) as v(slug, symbol, insider_names)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'finnhub'
 where not exists (
   select 1 from public.person_data_sources m where m.person_id = p.id and m.data_source_id = d.id
 );

-- Watching a figure that counts for nothing -------------------------------------
--
-- Part of the point of observe-only is being able to SEE the data while it
-- counts for nothing, so the operator console needs the value. The Phase 7
-- privacy rule keeps raw metric levels off every user-facing surface, and admin
-- is one; the Phase 9 answer to that tension was a purpose-built view, and this
-- is the same answer with a narrower door.
--
-- The WHERE clause is the whole guarantee: a row is visible here only while its
-- source row lists its metric key in config.observe_only. So this view can
-- never show a level that scores — the moment a key is allowed to count, it
-- leaves observe_only and leaves this view in the same edit. And what it does
-- show for now is a public company's closing price: public market data, not
-- private data about a person, which is why this exception is the bounded one
-- worth making.
create view public.observe_only_snapshots with (security_invoker = true) as
select p.slug                as person_slug,
       d.name                as source,
       m.external_identifier as identifier,
       s.metric_key,
       s.value,
       s.recorded_at
  from public.raw_source_snapshots s
  join public.people p       on p.id = s.person_id
  join public.data_sources d on d.id = s.data_source_id
  left join public.person_data_sources m
         on m.person_id = s.person_id and m.data_source_id = s.data_source_id
 where jsonb_typeof(d.config -> 'observe_only') = 'array'
   and jsonb_exists(d.config -> 'observe_only', s.metric_key);

comment on view public.observe_only_snapshots is
  'Raw readings a source records and never scores (data_sources.config.observe_only, Phase 17): the value, when it was recorded, and whose it is. Bounded BY the observe_only list, so a level that contributes to a score is structurally unable to appear here. Service role only.';

revoke all on public.observe_only_snapshots from anon, authenticated;
