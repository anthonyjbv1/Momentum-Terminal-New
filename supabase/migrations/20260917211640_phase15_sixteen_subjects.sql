-- =============================================================================
-- Momentum Terminal — Phase 15: the remaining twelve subjects on the two news
-- doors, and the per-person signal-volume baseline.
--
-- Twelve of the sixteen tracked people had no source at all, so their silence
-- measured the platform and not them. Each now reads the publisher catalogue
-- (publisher_rss: the same 71 feeds fetched once a run, filtered against
-- more names) and a Google News search (rss), with topics that select the
-- right feeds and disambiguation terms where the name is shared. Nothing
-- here is a connector; it is configuration on person_data_sources.
--
-- VOLUME. Sixteen subjects span two orders of magnitude of coverage, and the
-- Signals force grew with volume. The Engine now weights each person's event
-- signals against THEIR OWN trailing daily volume (lib/engine/signal-volume
-- .ts), read through person_signal_volume() below. The series counts complete
-- days since the person's newest active mapping was created, so a mapping
-- change restarts the clock: the days before it are not a quiet person but an
-- untracked one. person_data_sources gains created_at for that; existing rows
-- take the migration's time, which starts every subject's baseline together,
-- under the same configuration, on the same day.
--
-- THROUGHPUT. The runner polls a source's people `poll_concurrency` at a time
-- (code default 1). Sixteen Google News fetches at the measured two seconds
-- each would fill the scheduled run's 35-second budget on their own; four at
-- a time is four rounds of about three seconds.
-- =============================================================================

-- When a mapping was created: the start of the person's current volume regime.
alter table public.person_data_sources
  add column if not exists created_at timestamptz not null default now();

comment on column public.person_data_sources.created_at is
  'When the mapping was created. The newest active mapping of a person starts their signal-volume baseline (person_signal_volume): a mapping change is a new volume regime.';

-- The subjects: the publisher catalogue ----------------------------------------
-- external_identifier is the primary match term (whole words, case-folded);
-- match_terms adds the bare surnames headlines actually use where they are
-- safe, and only there; topics select the feeds; disambiguation refuses the
-- other entities the name is shared with. Where a name is unique as a phrase
-- no terms are invented, and a bare surname that is a common word (Page), a
-- company (Dell), another newsmaker (Ellison, for David; Lamar, for Jackson)
-- or a common surname (Huang) is deliberately not a match term.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, v.identifier, true, v.config::jsonb
  from (values
    ('elon-musk', 'Elon Musk',
     '{"match_terms": ["Musk"], "topics": ["business", "tech", "general"],
       "disambiguation": {"require_any": [],
         "exclude_terms": ["kimbal musk", "maye musk", "errol musk", "justine musk", "tosca musk",
                           "musk ox", "muskox", "musk deer", "musk melon", "musk perfume", "musk fragrance", "white musk"]}}'),
    ('jeff-bezos', 'Jeff Bezos',
     '{"match_terms": ["Bezos"], "topics": ["business", "tech", "general"],
       "disambiguation": {"require_any": [], "exclude_terms": ["sanchez bezos", "sánchez bezos"]}}'),
    ('mark-zuckerberg', 'Mark Zuckerberg',
     '{"match_terms": ["Zuckerberg", "Zuck"], "topics": ["business", "tech", "general"],
       "disambiguation": {"require_any": [],
         "exclude_terms": ["randi zuckerberg", "indiana lawyer", "indiana attorney", "indianapolis attorney", "indianapolis lawyer",
                           "bankruptcy attorney", "bankruptcy lawyer", "mark s. zuckerberg"]}}'),
    ('warren-buffett', 'Warren Buffett',
     '{"match_terms": ["Buffett"], "topics": ["business", "tech", "general"],
       "disambiguation": {"require_any": [],
         "exclude_terms": ["jimmy buffett", "margaritaville", "howard buffett", "howard g. buffett", "peter buffett", "susie buffett", "susan buffett"]}}'),
    ('jensen-huang', 'Jensen Huang',
     '{"match_terms": [], "topics": ["business", "tech", "general"]}'),
    ('larry-ellison', 'Larry Ellison',
     '{"match_terms": [], "topics": ["business", "tech", "general"]}'),
    ('larry-page', 'Larry Page',
     '{"match_terms": [], "topics": ["business", "tech", "general"]}'),
    ('sergey-brin', 'Sergey Brin',
     '{"match_terms": [], "topics": ["business", "tech", "general"]}'),
    ('michael-dell', 'Michael Dell',
     '{"match_terms": [], "topics": ["business", "tech", "general"]}'),
    ('kendrick-lamar', 'Kendrick Lamar',
     '{"match_terms": ["Kendrick"], "topics": ["music", "entertainment", "general"],
       "disambiguation": {"require_any": [],
         "exclude_terms": ["kendrick perkins", "anna kendrick", "kendrick bourne", "kendrick nunn", "kendrick sampson", "lamar jackson", "lamar odom"]}}'),
    ('adin-ross', 'Adin Ross',
     '{"match_terms": [], "topics": ["creator", "streaming", "gaming", "entertainment", "general"]}'),
    -- A name shared with a visual-effects artist, a defendant and a hundred
    -- LinkedIn profiles, and a subject with no coverage yet: an item must name
    -- the context or it is refused. Over-filtering is the safe error here.
    ('anthony-baptiste', 'Anthony Baptiste',
     '{"match_terms": [], "topics": ["business", "tech", "general"],
       "disambiguation": {"require_any": ["momentum terminal", "baptiste facility"], "exclude_terms": []}}')
  ) as v(slug, identifier, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'publisher_rss'
 where not exists (select 1 from public.person_data_sources x where x.person_id = p.id and x.data_source_id = d.id);

-- The subjects: Google News ----------------------------------------------------
-- The same disambiguation block, pushed into the query as negative terms and
-- applied again post-fetch; null config where the name is unique as a phrase.
insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
select p.id, d.id, v.url, true, v.config::jsonb
  from (values
    ('elon-musk',        'https://news.google.com/rss/search?q=%22Elon+Musk%22&hl=en-US&gl=US&ceid=US%3Aen',
     '{"disambiguation": {"require_any": [], "exclude_terms": ["kimbal musk", "maye musk", "errol musk", "justine musk", "tosca musk", "musk ox", "muskox", "musk deer", "musk melon", "musk perfume", "musk fragrance", "white musk"]}}'),
    ('jeff-bezos',       'https://news.google.com/rss/search?q=%22Jeff+Bezos%22&hl=en-US&gl=US&ceid=US%3Aen',
     '{"disambiguation": {"require_any": [], "exclude_terms": ["sanchez bezos", "sánchez bezos"]}}'),
    ('mark-zuckerberg',  'https://news.google.com/rss/search?q=%22Mark+Zuckerberg%22&hl=en-US&gl=US&ceid=US%3Aen',
     '{"disambiguation": {"require_any": [], "exclude_terms": ["randi zuckerberg", "indiana lawyer", "indiana attorney", "indianapolis attorney", "indianapolis lawyer", "bankruptcy attorney", "bankruptcy lawyer", "mark s. zuckerberg"]}}'),
    ('warren-buffett',   'https://news.google.com/rss/search?q=%22Warren+Buffett%22&hl=en-US&gl=US&ceid=US%3Aen',
     '{"disambiguation": {"require_any": [], "exclude_terms": ["jimmy buffett", "margaritaville", "howard buffett", "howard g. buffett", "peter buffett", "susie buffett", "susan buffett"]}}'),
    ('jensen-huang',     'https://news.google.com/rss/search?q=%22Jensen+Huang%22&hl=en-US&gl=US&ceid=US%3Aen', null),
    ('larry-ellison',    'https://news.google.com/rss/search?q=%22Larry+Ellison%22&hl=en-US&gl=US&ceid=US%3Aen', null),
    ('larry-page',       'https://news.google.com/rss/search?q=%22Larry+Page%22&hl=en-US&gl=US&ceid=US%3Aen', null),
    ('sergey-brin',      'https://news.google.com/rss/search?q=%22Sergey+Brin%22&hl=en-US&gl=US&ceid=US%3Aen', null),
    ('michael-dell',     'https://news.google.com/rss/search?q=%22Michael+Dell%22&hl=en-US&gl=US&ceid=US%3Aen', null),
    ('kendrick-lamar',   'https://news.google.com/rss/search?q=%22Kendrick+Lamar%22&hl=en-US&gl=US&ceid=US%3Aen',
     '{"disambiguation": {"require_any": [], "exclude_terms": ["kendrick perkins", "anna kendrick", "kendrick bourne", "kendrick nunn", "kendrick sampson", "lamar jackson", "lamar odom"]}}'),
    ('adin-ross',        'https://news.google.com/rss/search?q=%22Adin+Ross%22&hl=en-US&gl=US&ceid=US%3Aen', null),
    ('anthony-baptiste', 'https://news.google.com/rss/search?q=%22Anthony+Baptiste%22&hl=en-US&gl=US&ceid=US%3Aen',
     '{"disambiguation": {"require_any": ["momentum terminal", "baptiste facility"], "exclude_terms": []}}')
  ) as v(slug, url, config)
  join public.people p on p.slug = v.slug
  join public.data_sources d on d.name = 'rss'
 where not exists (select 1 from public.person_data_sources x where x.person_id = p.id and x.data_source_id = d.id);

-- Throughput: the two news doors poll four people at a time --------------------
update public.data_sources
   set config = coalesce(config, '{}'::jsonb) || jsonb_build_object('poll_concurrency', 4)
 where name in ('rss', 'publisher_rss');

-- The volume baseline ------------------------------------------------------------
-- Per active person: when their newest active mapping was created, their
-- event signals in the trailing 24 hours, and their event signals on each
-- complete UTC day since that mapping (oldest first, at most p_days). Metric
-- and baseline signals are not volume: they carry their own baselines.
create index if not exists signals_person_occurred_idx on public.signals (person_id, occurred_at desc);

create or replace function public.person_signal_volume(p_days integer default 14)
returns table (person_id uuid, tracked_since timestamptz, current_24h bigint, daily bigint[])
language sql
stable
security definer
set search_path = ''
as $$
  with tracked as (
    select m.person_id, max(m.created_at) as tracked_since
      from public.person_data_sources m
      join public.people p on p.id = m.person_id and p.is_active
     where m.is_active
     group by m.person_id
  ),
  bounds as (
    select t.person_id, t.tracked_since,
           greatest((t.tracked_since at time zone 'utc')::date + 1, (now() at time zone 'utc')::date - greatest(p_days, 1)) as first_day,
           (now() at time zone 'utc')::date - 1 as last_day
      from tracked t
  ),
  counts as (
    select s.person_id, (s.occurred_at at time zone 'utc')::date as day, count(*) as n
      from public.signals s
     where s.occurred_at >= now() - (greatest(p_days, 1) + 2) * interval '1 day'
       and coalesce(s.raw_payload ->> 'kind', '') not in ('metric', 'baseline')
     group by s.person_id, (s.occurred_at at time zone 'utc')::date
  )
  select b.person_id,
         b.tracked_since,
         (select count(*) from public.signals s
           where s.person_id = b.person_id
             and s.occurred_at >= now() - interval '24 hours'
             and coalesce(s.raw_payload ->> 'kind', '') not in ('metric', 'baseline')) as current_24h,
         coalesce(
           (select array_agg(coalesce(c.n, 0) order by d.day)
              from generate_series(b.first_day::timestamp, b.last_day::timestamp, interval '1 day') as d(day)
              left join counts c on c.person_id = b.person_id and c.day = d.day::date
             where b.first_day <= b.last_day),
           '{}'::bigint[]) as daily
    from bounds b;
$$;

comment on function public.person_signal_volume(integer) is
  'Per active person: the start of their current volume regime (newest active mapping), event signals in the trailing 24 h, and event signals per complete UTC day since then (oldest first, at most p_days). Feeds the Engine''s per-person volume weight. Service role only.';

revoke execute on function public.person_signal_volume(integer) from public, anon, authenticated;
grant  execute on function public.person_signal_volume(integer) to service_role;
