-- =============================================================================
-- Momentum Terminal — Phase 2 migration 2/3: source snapshots + signal metadata
--
-- * source_snapshots: last known value of every (person, source, metric), so a
--   connector can turn a cumulative number (subscribers, views, net worth) into
--   a delta. Every ingestion run appends a row, which also gives a raw time
--   series per metric. Service role writes, authenticated users read.
-- * signals.occurred_at: when the underlying event happened (an article's
--   publish time, the poll time for a stats snapshot). created_at stays the
--   insertion time.
-- * signals.dedupe_key: optional connector-supplied key (article GUID,
--   milestone id) so re-running ingestion never stores the same event twice.
--   NULL keys never conflict.
-- =============================================================================

-- source_snapshots -------------------------------------------------------------
create table public.source_snapshots (
  id             uuid        primary key default gen_random_uuid(),
  person_id      uuid        not null references public.people (id) on delete cascade,
  data_source_id uuid        not null references public.data_sources (id) on delete cascade,
  metric_key     text        not null,
  value          numeric     not null,
  recorded_at    timestamptz not null default now(),

  constraint source_snapshots_metric_key_format check (metric_key ~ '^[a-z0-9_]+$')
);

-- One index serves both jobs: it is the uniqueness rule
-- (person, source, metric, recorded_at) and the "latest value" lookup,
-- ordered newest-first.
create unique index source_snapshots_person_source_metric_recorded_idx
  on public.source_snapshots (person_id, data_source_id, metric_key, recorded_at desc);

-- Foreign-key coverage for data_source_id (person_id leads the index above).
create index source_snapshots_data_source_id_idx on public.source_snapshots (data_source_id);

comment on table  public.source_snapshots is 'Last known value per person / data source / metric. Connectors diff against the newest row to detect changes.';
comment on column public.source_snapshots.metric_key is 'Snake-case metric name, e.g. subscriber_count, view_count, video_count.';

alter table public.source_snapshots enable row level security;

create policy source_snapshots_select_authenticated
  on public.source_snapshots for select
  to authenticated
  using (true);

revoke insert, update, delete on public.source_snapshots from anon, authenticated;

-- signals: event time + idempotency key ---------------------------------------
alter table public.signals
  add column occurred_at timestamptz not null default now(),
  add column dedupe_key  text;

alter table public.signals
  add constraint signals_source_dedupe_key_unique unique (data_source_id, dedupe_key);

comment on column public.signals.occurred_at is 'When the underlying event happened, as reported by the connector. created_at is when the row was stored.';
comment on column public.signals.dedupe_key  is 'Optional connector-supplied idempotency key, unique per data source. NULL never conflicts.';
