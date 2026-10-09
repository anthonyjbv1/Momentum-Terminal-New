-- =============================================================================
-- THE PER-VIDEO VIEW LEDGER (scoring batch, 2026-10-09).
--
-- The YouTube pace metric (recent_video_views, the summed views of the
-- newest ten uploads as a relative rate) scored the basket changing under
-- it: an upload leaving the basket read as a collapse (MrBeast −1.50 four
-- times in thirty days). The age-matched replacement, behind
-- YOUTUBE_PACE_AGE_MATCHED_ENABLED (ships off), judges the newest upload's
-- views at its own age against the channel's other recent uploads at the
-- same age (lib/connectors/youtube-pace.ts). That needs each upload's views
-- over time: this ledger, written on every YouTube poll whether or not the
-- switch is on, so the replacement has history on the day it is flipped.
-- Raw levels: service role only, like raw_source_snapshots.
--
-- The metric is declared on the youtube row now, dormant: the connector
-- reads it only while the switch is on, and a declared metric nobody reads
-- produces nothing. Off, the youtube poll is byte-identical to today.
-- =============================================================================

create table public.raw_video_view_samples (
  id              bigint      generated always as identity primary key,
  person_id       uuid        not null references public.people (id) on delete cascade,
  data_source_id  uuid        not null references public.data_sources (id) on delete cascade,
  video_id        text        not null,
  published_at    timestamptz,
  views           bigint      not null,
  recorded_at     timestamptz not null,
  -- The video's age at the sample, in hours: what the pace reads by. A
  -- generated column, so the read for "every upload at about this age" is
  -- an index range and not the whole ledger. Numeric, like every figure in
  -- the schema (nothing here is floating point), to the thousandth of an hour.
  age_hours       numeric     generated always as (round((extract(epoch from (recorded_at - published_at)) / 3600.0)::numeric, 3)) stored,
  constraint raw_video_view_samples_unique unique (person_id, data_source_id, video_id, recorded_at)
);

create index raw_video_view_samples_person_source_age_idx on public.raw_video_view_samples (person_id, data_source_id, age_hours);
create index raw_video_view_samples_person_source_recorded_idx on public.raw_video_view_samples (person_id, data_source_id, recorded_at desc);

comment on table public.raw_video_view_samples is
  'RAW per-video view counts of a channel''s recent uploads, one row per video per poll (2026-10-09): the ledger the age-matched pace reads. SERVICE ROLE ONLY: no policy, no grant, no user-facing surface reads this table.';

alter table public.raw_video_view_samples enable row level security;
revoke all on public.raw_video_view_samples from public, anon, authenticated;

-- The replacement metric, declared and dormant until the switch is on. A
-- level in log2 units: 0 is the channel's usual pace at the upload's age,
-- ±1 is twice or half of it. The sd floor of 0.5 is half a unit, so a
-- steady channel never reads noise as news; a fortnight's window, a day of
-- hourly polls before it may fire.
update public.data_sources
set config = jsonb_set(
  config,
  '{metrics,video_pace_age_matched}',
  '{"label": "YouTube video pace at the same age", "delta": "level", "polarity": 1, "baseline_window_hours": 336, "min_samples": 24, "sd_floor": 0.5, "scale": 0.8}'::jsonb,
  true
)
where name = 'youtube' and not (config->'metrics' ? 'video_pace_age_matched');
