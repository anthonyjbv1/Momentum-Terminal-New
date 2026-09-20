-- =============================================================================
-- Momentum Terminal — Phase 21+: a metric may publish its own count, but only
-- if it says so.
--
-- Phase 21+ takes σ out of the consumer app. σ is a derived statistic no
-- casual reader can check; the counts underneath are MORE transparent, not
-- less — "twelve stories today against a usual pace of four" is checkable by
-- anyone with the Feed in front of them. So the expand shows the observed
-- quantity and the pace it was judged against.
--
-- That needs two keys the Phase 7 allow-list did not carry, and Phase 7's
-- allow-list is the privacy boundary rather than a formality. This migration
-- widens it by exactly two keys and adds a PER-METRIC GATE in front of them.
--
-- WHY A GATE, AND WHY IT DEFAULTS OFF.
--
-- A count of news stories and a subscriber total are different categories of
-- fact. The first is public, small, and already visible in the Feed as the
-- individual articles it counts. The second is an absolute audience level,
-- which is what Phase 7 was written to keep out of a signal and what the
-- product's positioning rests on keeping out.
--
-- Today that distinction happens to be structural: every audience metric on
-- the board (subscriber_count, view_count, recent_video_views, follower_count)
-- is declared `relative_rate`, so its observed quantity is a GROWTH RATE and
-- no total can reach a payload by any route. But that is a property of today's
-- declarations, not a rule. Someone adding a `level` metric months from now
-- would publish its raw value because nobody thought about it.
--
-- So publication is OPT-IN, per metric, and absent means no. A metric that
-- does not declare `publish_observed: true` carries no observed value and no
-- baseline, exactly as before this migration. The next person to add a count
-- metric has to make this decision deliberately rather than inherit it.
--
-- WHICH METRICS, AND WHY NOT session_peak_viewers.
--
-- Set on six: news_volume_24h, company_news_volume_24h, viral_moment_rate
-- (counts of public items the platform already indexes and shows) and
-- stream_hours_7d, stream_days_7d, clips_per_stream_hour (counts of the
-- person's own public activity — how long they were live, how often, how much
-- got clipped).
--
-- NOT session_peak_viewers, though it is a Twitch session metric and a level.
-- Peak concurrent viewers is an audience size: the same category of fact as a
-- subscriber total, measured instantaneously rather than cumulatively. It
-- keeps its register-only sentence ("{name}'s stream drew a huge crowd") and
-- publishes no number.
--
-- NOT commentary_volume_24h, upload_rate or the three per-game metrics, which
-- are counts and arguably belong, but were not in the set this was approved
-- for. They are one row update away if that changes.
--
-- THE HEADLINE DIGIT REFUSAL IS UNCHANGED. A metric headline still may not
-- carry a run of four digits, a thousands grouping or a compact count, and
-- that is solved in the phrasing rather than by relaxing the rule: the
-- language layer says "over a thousand clips" where the count exceeds 999, and
-- "over 100x their usual pace" where the multiple would run to four digits.
-- =============================================================================

-- The allow-list gains exactly two keys ------------------------------------
create or replace function public.signals_enforce_metric_privacy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_key     text;
  v_allowed text[] := array[
    'kind', 'metric', 'label', 'sigma', 'direction', 'polarity', 'samples',
    'min_samples', 'window_hours', 'delta_kind', 'threshold_std_devs', 'scale', 'source',
    -- Phase 21+, and only for a metric whose declaration opts in. The runner
    -- writes them for nothing else; this list is the outer bound, not the rule.
    'observed', 'baseline'
  ];
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

  -- A published count must be a number and must come with the pace it is read
  -- against: half of the comparison is not transparency, it is a bare level.
  if new.raw_payload ? 'observed' or new.raw_payload ? 'baseline' then
    if jsonb_typeof(new.raw_payload->'observed') is distinct from 'number' or jsonb_typeof(new.raw_payload->'baseline') is distinct from 'number' then
      raise exception 'a metric signal that publishes an observed value must carry both observed and baseline as numbers'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The headline speaks in plain language: no run of four digits, no thousands
  -- grouping, no compact count (516M, 2.3B, 45K). UNCHANGED from Phase 7 — the
  -- language layer words its way around it rather than the rule bending.
  if new.headline ~ '\d{4,}' or new.headline ~ '\d{1,3}(,\d{3})+' or new.headline ~ '\d(\.\d+)?\s?[KMB]\y' then
    raise exception 'metric signal headline must not carry a raw level' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.signals_enforce_metric_privacy() is
  'A metric signal (raw_payload.kind = metric) stores direction and normalised magnitude only: allow-listed payload keys, explicit polarity, numeric sigma, no raw level in the headline. Since Phase 21+ a metric whose declaration carries publish_observed = true may also carry observed and baseline — a small public count and the pace it is judged against — and must carry both or neither. Absent the declaration the runner writes neither, so the default is publication off.';

-- The six metrics that opt in ----------------------------------------------
update public.data_sources
   set config = jsonb_set(config, '{metrics,news_volume_24h,publish_observed}', 'true'::jsonb)
 where name = 'rss' and config->'metrics' ? 'news_volume_24h';

update public.data_sources
   set config = jsonb_set(config, '{metrics,viral_moment_rate,publish_observed}', 'true'::jsonb)
 where name = 'rss' and config->'metrics' ? 'viral_moment_rate';

update public.data_sources
   set config = jsonb_set(config, '{metrics,company_news_volume_24h,publish_observed}', 'true'::jsonb)
 where name = 'finnhub' and config->'metrics' ? 'company_news_volume_24h';

update public.data_sources
   set config = jsonb_set(config, '{metrics,stream_hours_7d,publish_observed}', 'true'::jsonb)
 where name = 'twitch' and config->'metrics' ? 'stream_hours_7d';

update public.data_sources
   set config = jsonb_set(config, '{metrics,stream_days_7d,publish_observed}', 'true'::jsonb)
 where name = 'twitch' and config->'metrics' ? 'stream_days_7d';

update public.data_sources
   set config = jsonb_set(config, '{live,metrics,clips_per_stream_hour,publish_observed}', 'true'::jsonb)
 where name = 'twitch' and config->'live'->'metrics' ? 'clips_per_stream_hour';

comment on column public.data_sources.config is
  'Connector options plus the metric declarations. config.metrics.<key> = {label, polarity (1 | -1, explicit), delta (level | absolute_rate | relative_rate), baseline_window_hours, min_samples, sd_floor, scale, threshold_std_devs?, publish_observed?}. publish_observed (Phase 21+, DEFAULT FALSE) lets a metric put its observed count and the baseline pace into the signal payload, so the consumer app can show "12 stories against a usual 4" instead of a sigma; it is set only for small public counts, never for an audience level, and absent means no. config.derived.<key> = {from, kind (rate | spike_count), window_hours, ...}. Never secrets.';
