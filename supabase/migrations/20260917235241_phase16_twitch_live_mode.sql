-- =============================================================================
-- Momentum Terminal — Phase 16: live mode.
--
-- The Engine ticks every thirty seconds and news arrives every fifteen
-- minutes at best; a live broadcast is the one thing here that moves minute
-- by minute, and it was sampled hourly. Live mode follows a broadcast while
-- it is on air: its own every-minute cron (/api/ingest/live), one platform
-- request a minute to learn who is live, and a sample every few minutes per
-- broadcaster who is. PER BROADCASTER: the state is a session row per
-- (source, stream), never a flag on the source, so any number can be live
-- at once, and a streamer added later gets it by mapping.
--
-- WHAT IS MEASURED, AND AS WHAT (the reasoning is on lib/ingest/live/rules.ts):
--   EVENTS, within a session, judged against the session itself: an audience
--   surge over a ten-minute window, a burst of clips against the session's
--   own pace. Each carries its own direction and confidence and the Engine
--   scores it without a model call. No sigma anywhere: a session's standard
--   deviation would describe how long the stream ran, not how unusual a
--   moment was.
--   METRICS, once per session when it ends, through the ordinary pipeline:
--   peak concurrent viewers and clips per stream hour. Per-session
--   aggregates sampled once per session — a session being the person's own
--   choice of when to stream — so their sigma over a month of sessions
--   describes how big and how clippable this stream was for THEM, and the
--   two-minute cadence moves a peak by less than any two sessions differ.
--   Complete sessions only (watched from the start, no gap).
--   NOT registered: average viewers, peak-to-average, time-to-peak (they
--   describe the stream's format before the person), category switches (no
--   direction). Recorded on the session and said in its summary.
-- =============================================================================

-- ingest_runs: a third trigger. A closing session observes its metrics under
-- a run row of trigger 'live', opened only when there is something to observe.
alter table public.ingest_runs drop constraint ingest_runs_trigger_check;
alter table public.ingest_runs add constraint ingest_runs_trigger_check check (trigger in ('manual', 'cron', 'live'));

-- The sessions -----------------------------------------------------------------
create table public.live_sessions (
  id                    uuid        primary key default gen_random_uuid(),
  person_id             uuid        not null references public.people(id) on delete cascade,
  data_source_id        uuid        not null references public.data_sources(id) on delete cascade,
  stream_id             text        not null,
  broadcaster_id        text        not null,
  channel               text        not null,
  started_at            timestamptz not null,
  first_seen_at         timestamptz not null,
  last_seen_at          timestamptz not null,
  last_sampled_at       timestamptz,
  ended_at              timestamptz,
  missed_checks         integer     not null default 0,
  complete              boolean     not null default true,
  sample_count          integer     not null default 0,
  viewer_sum            bigint      not null default 0,
  viewer_latest         integer,
  viewer_peak           integer,
  peak_at               timestamptz,
  category_latest       text,
  category_switches     integer     not null default 0,
  title_latest          text,
  clips_total           integer     not null default 0,
  clips_counted_to      timestamptz,
  last_surge_at         timestamptz,
  last_drop_at          timestamptz,
  last_burst_at         timestamptz,
  largest_drop_fraction numeric,
  signals_created       integer     not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint live_sessions_stream_unique unique (data_source_id, stream_id)
);

create index live_sessions_open_idx on public.live_sessions (data_source_id, person_id) where ended_at is null;
create index live_sessions_person_started_idx on public.live_sessions (person_id, started_at desc);

comment on table public.live_sessions is
  'One broadcast followed by live mode (Phase 16): per (source, stream id), from first sighting to end, with the running aggregates the moments are judged against. Raw viewer counts: service role only.';

alter table public.live_sessions enable row level security;
revoke all on public.live_sessions from anon, authenticated;

-- The samples ------------------------------------------------------------------
create table public.live_samples (
  id                bigint      generated always as identity primary key,
  session_id        uuid        not null references public.live_sessions(id) on delete cascade,
  sampled_at        timestamptz not null,
  viewer_count      integer,
  category          text,
  title             text,
  clips_window_from timestamptz,
  clips_window_to   timestamptz,
  clips_in_window   integer     not null default 0,
  clips_truncated   boolean     not null default false,
  latency_ms        integer,
  status            text        not null,
  error             text,
  signals_created   integer     not null default 0,
  constraint live_samples_status_check check (status in ('ok', 'error'))
);

create index live_samples_session_sampled_idx on public.live_samples (session_id, sampled_at desc);

comment on table public.live_samples is
  'One sample of a live session (Phase 16): the audience and category at that minute, the clips created in the window since the last sample, and what the sample produced. The live ledger, deliberately not source_polls. Raw: service role only.';

alter table public.live_samples enable row level security;
revoke all on public.live_samples from anon, authenticated;

-- Twitch: live mode on, and the two session metrics ------------------------------
--
-- The live block is configuration: every threshold has a code default
-- (lib/ingest/live/rules.ts) and any of them can be set per person on the
-- mapping's config.live. The sample interval is bounded to 1–5 minutes.
update public.data_sources
   set config = coalesce(config, '{}'::jsonb)
             || jsonb_build_object(
                  'live', jsonb_build_object(
                    'enabled', true,
                    'sample_interval_minutes', 2,
                    'warmup_minutes', 20,
                    'delta_window_minutes', 10,
                    'surge_fraction', 0.2,
                    'drop_fraction', null,
                    'min_viewers', 500,
                    'cooldown_minutes', 30,
                    'clip_window_minutes', 10,
                    'burst_multiple', 3,
                    'burst_min_clips', 5,
                    'floor_clips_per_hour', 6,
                    'end_after_missed_checks', 2
                  )
                )
             || jsonb_build_object(
                  'metrics', coalesce(config -> 'metrics', '{}'::jsonb)
                    || jsonb_build_object(
                         -- Peak concurrent viewers of one complete session, recorded at its end.
                         -- Sessions are the person's own; a month of them is the baseline.
                         -- The sd floor is in viewers and small: a channel of thousands is
                         -- not compared to one of millions, only to itself.
                         'session_peak_viewers', jsonb_build_object(
                           'label', 'Twitch peak live audience per stream',
                           'delta', 'level',
                           'polarity', 1,
                           'baseline_window_hours', 720,
                           'min_samples', 5,
                           'sd_floor', 50,
                           'scale', 0.8
                         ),
                         -- Clips created per hour of one complete session: someone
                         -- deciding a moment was worth keeping, per hour of stream.
                         'clips_per_stream_hour', jsonb_build_object(
                           'label', 'Twitch clips per stream hour',
                           'delta', 'level',
                           'polarity', 1,
                           'baseline_window_hours', 720,
                           'min_samples', 5,
                           'sd_floor', 2,
                           'scale', 1.0
                         )
                       )
                )
 where name = 'twitch';

-- Volume: a live moment is the platform's own sampling, not coverage ---------------
--
-- person_signal_volume (Phase 15) counts a person's event signals per day for
-- the Engine's volume weight. A prescored live moment is a derivative of the
-- platform's own sampling of a session, not something the world wrote about
-- the person, so it is not volume — as a metric signal is not.
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
       and coalesce(s.raw_payload ->> 'kind', '') not in ('metric', 'baseline', 'live_moment')
     group by s.person_id, (s.occurred_at at time zone 'utc')::date
  )
  select b.person_id,
         b.tracked_since,
         (select count(*) from public.signals s
           where s.person_id = b.person_id
             and s.occurred_at >= now() - interval '24 hours'
             and coalesce(s.raw_payload ->> 'kind', '') not in ('metric', 'baseline', 'live_moment')) as current_24h,
         coalesce(
           (select array_agg(coalesce(c.n, 0) order by d.day)
              from generate_series(b.first_day::timestamp, b.last_day::timestamp, interval '1 day') as d(day)
              left join counts c on c.person_id = b.person_id and c.day = d.day::date
             where b.first_day <= b.last_day),
           '{}'::bigint[]) as daily
    from bounds b;
$$;

comment on function public.person_signal_volume(integer) is
  'Per active person: the start of their current volume regime (newest active mapping), event signals in the trailing 24 h, and event signals per complete UTC day since then (oldest first, at most p_days). Metric, baseline and live-moment signals are not volume. Feeds the Engine''s per-person volume weight. Service role only.';
