-- =============================================================================
-- Momentum Terminal — Phase 7: metric connectors, privacy, observability
--
-- * raw_source_snapshots: source_snapshots renamed so its nature is obvious.
--   RAW metric levels (a subscriber count, a follower total, a popularity
--   index). Service role only; the authenticated read policy is dropped.
--   No user-facing surface reads this table.
-- * raw_metric_observations: every reading judged against the person's own
--   baseline: the level, the previous level, the delta, the mean, the sd,
--   the sigma, the outcome, and the signal it produced if any. Service role
--   only. Enough to reconstruct a score move back to the poll.
-- * ingest_runs, source_polls: every run and every poll (source, person,
--   ok / error / skipped with the reason, latency), so per-source health is
--   a query. source_health is that query.
-- * llm_model_prices, llm_cost_per_tick: token usage priced per tick.
-- * signals_enforce_metric_privacy: a metric signal (raw_payload.kind =
--   'metric') may carry direction and normalised magnitude only. The
--   payload keys are an allow-list; the headline may not carry a raw level.
-- * The registry: youtube, youtube_comments, rss, spotify with their metric
--   declarations (polarity, baseline window, minimum sample, sd floor,
--   scale) and the MrBeast / Drake mappings. Data, not code.
-- =============================================================================

-- raw_source_snapshots (was source_snapshots) ---------------------------------
alter table public.source_snapshots rename to raw_source_snapshots;
alter table public.raw_source_snapshots rename constraint source_snapshots_pkey to raw_source_snapshots_pkey;
alter table public.raw_source_snapshots rename constraint source_snapshots_person_id_fkey to raw_source_snapshots_person_id_fkey;
alter table public.raw_source_snapshots rename constraint source_snapshots_data_source_id_fkey to raw_source_snapshots_data_source_id_fkey;
alter table public.raw_source_snapshots rename constraint source_snapshots_metric_key_format to raw_source_snapshots_metric_key_format;
alter index public.source_snapshots_person_source_metric_recorded_idx rename to raw_source_snapshots_person_source_metric_recorded_idx;
alter index public.source_snapshots_data_source_id_idx rename to raw_source_snapshots_data_source_id_idx;

drop policy if exists source_snapshots_select_authenticated on public.raw_source_snapshots;
revoke all on public.raw_source_snapshots from anon, authenticated;

comment on table public.raw_source_snapshots is
  'RAW metric levels as connectors read them (subscriber counts, follower totals, popularity indexes). SERVICE ROLE ONLY: no policy, no grant, no user-facing surface reads this table. Signals carry direction and normalised magnitude only.';

-- ingest_runs -------------------------------------------------------------------
create table public.ingest_runs (
  id                 uuid        primary key default gen_random_uuid(),
  started_at         timestamptz not null,
  finished_at        timestamptz,
  trigger            text        not null,
  forced             boolean     not null default false,
  requested_sources  text[],
  summary            jsonb,
  sources_run        integer     not null default 0,
  signals_created    integer     not null default 0,
  snapshots_recorded integer     not null default 0,
  observations       integer     not null default 0,
  errors             integer     not null default 0,
  created_at         timestamptz not null default now(),

  constraint ingest_runs_trigger_check check (trigger in ('manual', 'cron'))
);

create index ingest_runs_started_idx on public.ingest_runs (started_at desc);

comment on table public.ingest_runs is 'One row per ingestion run: when, what triggered it, and its summary. Service role only.';

alter table public.ingest_runs enable row level security;
revoke all on public.ingest_runs from anon, authenticated;

-- source_polls ------------------------------------------------------------------
create table public.source_polls (
  id                 uuid        primary key default gen_random_uuid(),
  run_id             uuid        not null references public.ingest_runs (id) on delete cascade,
  data_source_id     uuid        not null references public.data_sources (id) on delete cascade,
  person_id          uuid        references public.people (id) on delete cascade,
  status             text        not null,
  reason             text,
  latency_ms         integer,
  signals_created    integer     not null default 0,
  snapshots_recorded integer     not null default 0,
  observations       integer     not null default 0,
  started_at         timestamptz not null,
  finished_at        timestamptz not null,
  created_at         timestamptz not null default now(),

  constraint source_polls_status_check check (status in ('ok', 'error', 'skipped'))
);

create index source_polls_source_finished_idx on public.source_polls (data_source_id, finished_at desc);
create index source_polls_run_id_idx on public.source_polls (run_id);
create index source_polls_person_id_idx on public.source_polls (person_id);

comment on table public.source_polls is 'Every poll of a source for a person (or a source-level skip, person null): outcome, reason, latency, what it produced. Service role only.';

alter table public.source_polls enable row level security;
revoke all on public.source_polls from anon, authenticated;

-- raw_metric_observations -------------------------------------------------------
create table public.raw_metric_observations (
  id             uuid        primary key default gen_random_uuid(),
  run_id         uuid        not null references public.ingest_runs (id) on delete cascade,
  person_id      uuid        not null references public.people (id) on delete cascade,
  data_source_id uuid        not null references public.data_sources (id) on delete cascade,
  metric_key     text        not null,
  recorded_at    timestamptz not null,
  value          numeric     not null,
  previous       numeric,
  delta          numeric,
  delta_kind     text,
  observed       numeric,
  mean           numeric,
  sd             numeric,
  sd_applied     numeric,
  sigma          numeric,
  samples        integer,
  min_samples    integer,
  window_hours   numeric,
  outcome        text        not null,
  signal_id      uuid        references public.signals (id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint raw_metric_observations_metric_key_format check (metric_key ~ '^[a-z0-9_]+$'),
  constraint raw_metric_observations_delta_kind_check  check (delta_kind is null or delta_kind in ('level', 'absolute_rate', 'relative_rate')),
  constraint raw_metric_observations_outcome_check     check (outcome in ('no_config', 'first_contact', 'insufficient_baseline', 'inside_band', 'emitted'))
);

create index raw_metric_observations_person_source_metric_idx on public.raw_metric_observations (person_id, data_source_id, metric_key, recorded_at desc);
create index raw_metric_observations_run_id_idx   on public.raw_metric_observations (run_id);
create index raw_metric_observations_signal_id_idx on public.raw_metric_observations (signal_id);
create index raw_metric_observations_data_source_id_idx on public.raw_metric_observations (data_source_id);

comment on table public.raw_metric_observations is
  'RAW: every metric reading with its level, delta, baseline statistics, sigma and outcome, and the signal it produced. SERVICE ROLE ONLY; no user-facing surface reads this table.';

alter table public.raw_metric_observations enable row level security;
revoke all on public.raw_metric_observations from anon, authenticated;

-- source_health -----------------------------------------------------------------
create view public.source_health with (security_invoker = true) as
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
       day.signals_24h
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
           coalesce(sum(p.signals_created), 0)                                    as signals_24h
      from public.source_polls p
     where p.data_source_id = d.id
       and p.finished_at >= now() - interval '24 hours'
  ) as day;

comment on view public.source_health is 'Per-source health: last poll, last success, last error, trailing-day poll count, error rate and latency. Service role only.';

revoke all on public.source_health from anon, authenticated;

-- llm_model_prices + llm_cost_per_tick ------------------------------------------
create table public.llm_model_prices (
  model                text        primary key,
  input_per_mtok       numeric     not null,
  output_per_mtok      numeric     not null,
  cache_read_per_mtok  numeric     not null,
  cache_write_per_mtok numeric     not null,
  note                 text,
  updated_at           timestamptz not null default now(),

  constraint llm_model_prices_nonneg check (input_per_mtok >= 0 and output_per_mtok >= 0 and cache_read_per_mtok >= 0 and cache_write_per_mtok >= 0)
);

comment on table public.llm_model_prices is 'USD per million tokens by model, for llm_cost_per_tick. A usage row matches the longest price row whose model is a prefix of its own. Service role only.';

insert into public.llm_model_prices (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, note) values
  ('claude-haiku-4-5',  1,  5,  0.10, 1.25, 'Anthropic list price at the time of writing'),
  ('claude-sonnet-4-5', 3, 15,  0.30, 3.75, 'Anthropic list price at the time of writing'),
  ('claude-opus-4-5',   5, 25,  0.50, 6.25, 'Anthropic list price at the time of writing'),
  ('claude-sonnet-5',   3, 15,  0.30, 3.75, 'ASSUMED equal to claude-sonnet-4-5: verify against the current price list'),
  ('claude-opus-5',     5, 25,  0.50, 6.25, 'ASSUMED equal to claude-opus-4-5: verify against the current price list')
on conflict (model) do nothing;

alter table public.llm_model_prices enable row level security;
revoke all on public.llm_model_prices from anon, authenticated;

create view public.llm_cost_per_tick with (security_invoker = true) as
select u.tick_number,
       count(*)                                                       as calls,
       count(*) filter (where u.task_type = 'sentiment')              as sentiment_calls,
       count(*) filter (where u.task_type = 'anomaly')                as anomaly_calls,
       count(*) filter (where u.task_type = 'narrative')              as narrative_calls,
       count(*) filter (where u.task_type = 'memory')                 as memory_calls,
       sum(u.input_tokens)                                            as input_tokens,
       sum(u.output_tokens)                                           as output_tokens,
       sum(u.cache_read_input_tokens)                                 as cache_read_input_tokens,
       sum(u.cache_creation_input_tokens)                             as cache_creation_input_tokens,
       round(sum(
         (u.input_tokens * p.input_per_mtok
          + u.output_tokens * p.output_per_mtok
          + u.cache_read_input_tokens * p.cache_read_per_mtok
          + u.cache_creation_input_tokens * p.cache_write_per_mtok) / 1000000.0
       ), 6)                                                          as cost_usd,
       count(*) filter (where p.model is null)                        as unpriced_calls,
       round(avg(u.latency_ms))                                       as avg_latency_ms,
       min(u.created_at)                                              as first_call_at,
       max(u.created_at)                                              as last_call_at
  from public.llm_usage u
  left join lateral (
    select pr.*
      from public.llm_model_prices pr
     where u.model = pr.model or u.model like pr.model || '%'
     order by length(pr.model) desc
     limit 1
  ) as p on true
 group by u.tick_number;

comment on view public.llm_cost_per_tick is 'LLM calls, tokens and priced cost per Engine tick (tick_number null = outside a tick). cost_usd covers priced calls only; unpriced_calls says how many had no price row. Service role only.';

revoke all on public.llm_cost_per_tick from anon, authenticated;

-- Metric signal privacy: direction and normalised magnitude only ----------------
create or replace function public.signals_enforce_metric_privacy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_key     text;
  v_allowed text[] := array['kind', 'metric', 'label', 'sigma', 'direction', 'polarity', 'samples', 'min_samples', 'window_hours', 'delta_kind', 'threshold_std_devs', 'scale', 'source'];
begin
  if new.raw_payload is null or jsonb_typeof(new.raw_payload) <> 'object' or new.raw_payload->>'kind' is distinct from 'metric' then
    return new;
  end if;

  for v_key in select jsonb_object_keys(new.raw_payload) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'metric signal payload key "%" is not allowed: a metric signal carries direction and normalised magnitude only', v_key
        using errcode = 'check_violation';
    end if;
  end loop;

  if new.raw_payload->>'polarity' is null or new.raw_payload->>'polarity' not in ('1', '-1') then
    raise exception 'metric signal must declare polarity 1 or -1' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(new.raw_payload->'sigma') is distinct from 'number' then
    raise exception 'metric signal must carry a numeric sigma' using errcode = 'check_violation';
  end if;
  if new.raw_payload->>'direction' not in ('1', '-1') then
    raise exception 'metric signal must carry direction 1 or -1' using errcode = 'check_violation';
  end if;

  -- The headline speaks in sigma: no run of four digits, no thousands
  -- grouping, no compact count (516M, 2.3B, 45K).
  if new.headline ~ '\d{4,}' or new.headline ~ '\d{1,3}(,\d{3})+' or new.headline ~ '\d(\.\d+)?\s?[KMB]\y' then
    raise exception 'metric signal headline must not carry a raw level' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger signals_enforce_metric_privacy
  before insert or update of raw_payload, headline on public.signals
  for each row execute function public.signals_enforce_metric_privacy();

comment on function public.signals_enforce_metric_privacy() is 'A metric signal (raw_payload.kind = metric) stores direction and normalised magnitude only: allow-listed payload keys, explicit polarity, numeric sigma, no raw level in the headline.';

-- The registry ------------------------------------------------------------------
comment on column public.data_sources.config is
  'Connector options plus the metric declarations. config.metrics.<key> = {label, polarity (1 | -1, explicit), delta (level | absolute_rate | relative_rate), baseline_window_hours, min_samples, sd_floor, scale, threshold_std_devs?}. config.derived.<key> = {from, kind (rate | spike_count), window_hours, ...}. Never secrets.';

insert into public.data_sources (name, display_name, tier, poll_interval_minutes, is_active, config) values
  (
    'youtube', 'YouTube', 2, 60, true,
    '{
      "recent_videos": 10,
      "commentary": { "window_hours": 24, "max_results": 50 },
      "metrics": {
        "subscriber_count":      { "label": "YouTube subscriber growth",        "polarity": 1, "delta": "relative_rate", "baseline_window_hours": 168, "min_samples": 24, "sd_floor": 0.00001, "scale": 1.0 },
        "view_count":            { "label": "YouTube channel view growth",      "polarity": 1, "delta": "relative_rate", "baseline_window_hours": 168, "min_samples": 24, "sd_floor": 0.00002, "scale": 0.8 },
        "recent_video_views":    { "label": "YouTube recent-video view growth", "polarity": 1, "delta": "relative_rate", "baseline_window_hours": 168, "min_samples": 24, "sd_floor": 0.0001,  "scale": 0.8 },
        "commentary_volume_24h": { "label": "YouTube commentary volume",        "polarity": 1, "delta": "level",         "baseline_window_hours": 336, "min_samples": 24, "sd_floor": 1.0,     "scale": 0.7 },
        "upload_rate":           { "label": "YouTube upload cadence",           "polarity": 1, "delta": "level",         "baseline_window_hours": 720, "min_samples": 48, "sd_floor": 0.15,    "scale": 0.6 }
      },
      "derived": {
        "upload_rate": { "from": "video_count", "kind": "rate", "window_hours": 168, "per_hours": 24, "min_span_hours": 160 }
      }
    }'::jsonb
  ),
  (
    'youtube_comments', 'YouTube comments', 4, 60, true,
    '{ "videos": 3, "max_comments_per_video": 10 }'::jsonb
  ),
  (
    'rss', 'RSS (per-person news feed)', 3, 60, true,
    '{
      "max_items": 30,
      "volume_window_hours": 24,
      "metrics": {
        "news_volume_24h":   { "label": "news volume",            "polarity": 1, "delta": "level", "baseline_window_hours": 336, "min_samples": 24, "sd_floor": 0.5,  "scale": 0.7 },
        "viral_moment_rate": { "label": "viral-moment frequency", "polarity": 1, "delta": "level", "baseline_window_hours": 720, "min_samples": 48, "sd_floor": 0.25, "scale": 0.5 }
      },
      "derived": {
        "viral_moment_rate": { "from": "news_volume_24h", "kind": "spike_count", "window_hours": 168, "spike_std_devs": 2, "spike_sd_floor": 0.5, "min_source_samples": 24 }
      }
    }'::jsonb
  ),
  (
    'spotify', 'Spotify', 2, 60, true,
    '{
      "metrics": {
        "popularity":     { "label": "Spotify popularity",      "polarity": 1, "delta": "level",         "baseline_window_hours": 720, "min_samples": 48, "sd_floor": 0.5,     "scale": 1.0 },
        "follower_count": { "label": "Spotify follower growth", "polarity": 1, "delta": "relative_rate", "baseline_window_hours": 168, "min_samples": 24, "sd_floor": 0.00001, "scale": 1.0 }
      }
    }'::jsonb
  )
on conflict (name) do update
  set display_name          = excluded.display_name,
      tier                  = excluded.tier,
      poll_interval_minutes = excluded.poll_interval_minutes,
      is_active             = excluded.is_active,
      config                = excluded.config;

insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active)
select p.id, d.id, v.identifier, true
  from (values
    ('mrbeast', 'youtube',          'UCX6OQ3DkcsbYNE6H8uQQuVA'),
    ('mrbeast', 'youtube_comments', 'UCX6OQ3DkcsbYNE6H8uQQuVA'),
    ('mrbeast', 'rss',              'https://news.google.com/rss/search?q=%22MrBeast%22&hl=en-US&gl=US&ceid=US%3Aen'),
    ('drake',   'rss',              'https://news.google.com/rss/search?q=%22Drake%22+rapper&hl=en-US&gl=US&ceid=US%3Aen'),
    ('drake',   'spotify',          '3TVXtAsR1Inumwj472S9r4')
  ) as v (slug, source, identifier)
  join public.people       p on p.slug = v.slug
  join public.data_sources d on d.name = v.source
on conflict (person_id, data_source_id) do update
  set external_identifier = excluded.external_identifier,
      is_active           = true;
