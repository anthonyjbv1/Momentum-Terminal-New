-- =============================================================================
-- Momentum Terminal — Phase 8: RSS signal quality.
--
-- 1. publisher_domains: the tiered publisher allowlist, as CONFIGURATION.
--    A row is a normalised domain (lower case, no "www.", no trailing dot)
--    with a status: 'allowed' carries the credibility tier the publisher's
--    items resolve to; 'blocked' drops the item before scoring. A domain not
--    in the table is still accepted, at the floor tier (5, the weakest
--    multiplier), so an outlet nobody thought to list still contributes,
--    faintly. Matching walks up the domain: music.example.com resolves
--    through example.com unless a more specific row exists. Adding a domain is
--    inserting a row; no deploy. Service role only: never a user-facing read.
--
-- 2. signals.tier: the credibility tier resolved PER ITEM where the source
--    resolves one (RSS, from the publisher domain). Null = the data source's
--    own tier applies, which is what every other connector keeps doing. The
--    Engine reads coalesce(signals.tier, data_sources.tier).
--
-- 3. Observability: per poll and per run, how many items were dropped as
--    blocked and how many were collapsed as duplicates of a story already
--    seen, so both effects can be read from the health view.
-- =============================================================================

-- publisher_domains -----------------------------------------------------------
create table public.publisher_domains (
  domain     text        primary key,
  status     text        not null,
  tier       integer,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint publisher_domains_status_check     check (status in ('allowed', 'blocked')),
  constraint publisher_domains_tier_range       check (tier is null or tier between 1 and 5),
  constraint publisher_domains_tier_when_allowed check (status = 'blocked' or tier is not null),
  constraint publisher_domains_domain_normalised check (
    domain = lower(domain)
    and domain !~ '^www[0-9]*\.'
    and domain !~ '\.$'
    and domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'
  )
);

comment on table  public.publisher_domains        is 'The tiered publisher allowlist for per-item sources (RSS). allowed = items from this domain (and its subdomains) resolve to `tier`; blocked = dropped before scoring, logged. A domain absent from the table is accepted at the floor tier (5). Configuration: add a row, no deploy. Service role only.';
comment on column public.publisher_domains.domain is 'Normalised: lower case, no www., no trailing dot. Subdomains resolve through it unless a more specific row exists.';
comment on column public.publisher_domains.tier   is 'Credibility tier 1 (most credible) to 5, required when allowed; the Signals force multiplies impact by the tier''s multiplier.';

alter table public.publisher_domains enable row level security;
revoke all on public.publisher_domains from anon, authenticated;

-- The seed: small and defensible, for the two subjects on the board. Music and
-- entertainment press for Drake; creator-economy, tech and marketing press for
-- MrBeast; the wires and papers of record for both. Curated upward from what
-- the unknown-domain log keeps showing. on conflict do nothing: a curated
-- production row is never overwritten by a re-run of this file.
insert into public.publisher_domains (domain, status, tier, note) values
  -- Tier 1: wires, papers of record, the major trades.
  ('apnews.com',             'allowed', 1, 'Associated Press'),
  ('reuters.com',            'allowed', 1, 'Reuters'),
  ('bbc.com',                'allowed', 1, 'BBC'),
  ('bbc.co.uk',              'allowed', 1, 'BBC'),
  ('nytimes.com',            'allowed', 1, 'The New York Times'),
  ('washingtonpost.com',     'allowed', 1, 'The Washington Post'),
  ('theguardian.com',        'allowed', 1, 'The Guardian'),
  ('wsj.com',                'allowed', 1, 'The Wall Street Journal'),
  ('bloomberg.com',          'allowed', 1, 'Bloomberg'),
  ('cnbc.com',               'allowed', 1, 'CNBC'),
  ('cbc.ca',                 'allowed', 1, 'CBC (Canada''s public broadcaster; Drake''s home press)'),
  ('variety.com',            'allowed', 1, 'Variety'),
  ('hollywoodreporter.com',  'allowed', 1, 'The Hollywood Reporter'),
  ('billboard.com',          'allowed', 1, 'Billboard'),
  ('rollingstone.com',       'allowed', 1, 'Rolling Stone'),
  -- Tier 2: established music, entertainment, creator-economy, tech and marketing press.
  ('pitchfork.com',          'allowed', 2, 'Pitchfork'),
  ('complex.com',            'allowed', 2, 'Complex'),
  ('stereogum.com',          'allowed', 2, 'Stereogum'),
  ('nme.com',                'allowed', 2, 'NME'),
  ('thefader.com',           'allowed', 2, 'The FADER'),
  ('xxlmag.com',             'allowed', 2, 'XXL'),
  ('hiphopdx.com',           'allowed', 2, 'HipHopDX'),
  ('theneedledrop.com',      'allowed', 2, 'The Needle Drop (music critic)'),
  ('vice.com',               'allowed', 2, 'VICE'),
  ('people.com',             'allowed', 2, 'People'),
  ('usatoday.com',           'allowed', 2, 'USA Today'),
  ('thestar.com',            'allowed', 2, 'Toronto Star'),
  ('theverge.com',           'allowed', 2, 'The Verge'),
  ('techcrunch.com',         'allowed', 2, 'TechCrunch'),
  ('businessinsider.com',    'allowed', 2, 'Business Insider'),
  ('forbes.com',             'allowed', 2, 'Forbes'),
  ('tubefilter.com',         'allowed', 2, 'Tubefilter (creator economy)'),
  ('adweek.com',             'allowed', 2, 'Adweek'),
  ('digiday.com',            'allowed', 2, 'Digiday'),
  ('marketingdive.com',      'allowed', 2, 'Marketing Dive'),
  ('campaignlive.com',       'allowed', 2, 'Campaign'),
  ('slate.com',              'allowed', 2, 'Slate'),
  ('ign.com',                'allowed', 2, 'IGN'),
  ('polygon.com',            'allowed', 2, 'Polygon'),
  -- Tier 3: music and creator blogs with an editorial desk, celebrity press.
  ('hotnewhiphop.com',       'allowed', 3, 'HotNewHipHop'),
  ('thesource.com',          'allowed', 3, 'The Source'),
  ('rap-up.com',             'allowed', 3, 'Rap-Up'),
  ('dexerto.com',            'allowed', 3, 'Dexerto (creator news)'),
  ('9to5google.com',         'allowed', 3, '9to5Google'),
  ('avclub.com',             'allowed', 3, 'The A.V. Club'),
  ('justjared.com',          'allowed', 3, 'Just Jared (celebrity press)'),
  -- Blocked: observed in the first run serving scraped celebrity copy from a domain that is not a publisher.
  ('defensorianna.gob.ar',   'blocked', null, 'Argentine government ombudsman domain serving scraped Drake concert copy (first run, 2026-09-13); not a publisher')
on conflict (domain) do nothing;

-- signals.tier ------------------------------------------------------------------
alter table public.signals
  add column tier integer,
  add constraint signals_tier_range check (tier is null or tier between 1 and 5);

comment on column public.signals.tier is 'Credibility tier resolved per item (RSS: from the publisher domain via publisher_domains; unknown domains at the floor, 5). Null = the data source''s tier applies. The Engine reads coalesce(signals.tier, data_sources.tier).';

-- Drop and collapse counters ------------------------------------------------------
alter table public.source_polls
  add column blocked_dropped      integer not null default 0,
  add column duplicates_collapsed integer not null default 0;

alter table public.ingest_runs
  add column blocked_dropped      integer not null default 0,
  add column duplicates_collapsed integer not null default 0;

comment on column public.source_polls.blocked_dropped      is 'Items dropped before scoring because their publisher domain is blocked.';
comment on column public.source_polls.duplicates_collapsed is 'Items collapsed into a story already kept (this run or within the lookback window).';
comment on column public.ingest_runs.blocked_dropped       is 'Sum over the run''s polls of items dropped as blocked.';
comment on column public.ingest_runs.duplicates_collapsed  is 'Sum over the run''s polls of items collapsed as duplicates.';

create or replace view public.source_health with (security_invoker = true) as
select d.id            as data_source_id,
       d.name,
       d.display_name,
       d.tier,
       d.is_active,
       d.poll_interval_minutes,
       (select count(*) from public.person_data_sources pds where pds.data_source_id = d.id and pds.is_active) as people_mapped,
       last.last_poll_at,
       last.last_success_at,
       last.last_error_at,
       last.last_error,
       last.last_skip_reason,
       day.polls_24h,
       day.errors_24h,
       case when day.polls_24h > 0 then round(day.errors_24h::numeric / day.polls_24h, 4) else null end as error_rate_24h,
       day.avg_latency_ms_24h,
       day.signals_24h,
       day.blocked_24h,
       day.collapsed_24h
  from public.data_sources d
  cross join lateral (
    select (select max(p.finished_at) from public.source_polls p where p.data_source_id = d.id)                                              as last_poll_at,
           (select max(p.finished_at) from public.source_polls p where p.data_source_id = d.id and p.status = 'ok' and p.person_id is not null) as last_success_at,
           (select max(p.finished_at) from public.source_polls p where p.data_source_id = d.id and p.status = 'error')                         as last_error_at,
           (select p.reason from public.source_polls p where p.data_source_id = d.id and p.status = 'error'   order by p.finished_at desc limit 1) as last_error,
           (select p.reason from public.source_polls p where p.data_source_id = d.id and p.status = 'skipped' order by p.finished_at desc limit 1) as last_skip_reason
  ) as last
  cross join lateral (
    select count(*) filter (where p.person_id is not null)                        as polls_24h,
           count(*) filter (where p.status = 'error')                             as errors_24h,
           round(avg(p.latency_ms) filter (where p.status = 'ok'))                as avg_latency_ms_24h,
           coalesce(sum(p.signals_created), 0)                                    as signals_24h,
           coalesce(sum(p.blocked_dropped), 0)                                    as blocked_24h,
           coalesce(sum(p.duplicates_collapsed), 0)                               as collapsed_24h
      from public.source_polls p
     where p.data_source_id = d.id
       and p.finished_at >= now() - interval '24 hours'
  ) as day;

comment on view public.source_health is 'Per-source health: last poll, last success, last error, trailing-day poll count, error rate, latency, signals, blocked drops and duplicate collapses. Service role only.';

revoke all on public.source_health from anon, authenticated;
