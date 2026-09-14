-- =============================================================================
-- Momentum Terminal — Phase 9: the operator's baseline clock, and admin access.
--
-- metric_baseline_progress answers the question the operator actually has —
-- "how far off is this metric from saying anything?" — WITHOUT exposing a
-- single raw level. The Phase 7 privacy rule holds for admin too: admin is a
-- user-facing path. So the view is the boundary, enforced by the schema rather
-- than by convention: it selects samples, minimums, window lengths, the span
-- of history and the last outcome, and it CANNOT select value, previous,
-- delta, observed, mean, sd or sigma because they are not columns of it. The
-- admin code reads this view and never names raw_metric_observations or
-- raw_source_snapshots at all.
--
-- Service role only, like every other internal relation.
-- =============================================================================

create view public.metric_baseline_progress with (security_invoker = true) as
with latest as (
  select distinct on (o.person_id, o.data_source_id, o.metric_key)
         o.person_id,
         o.data_source_id,
         o.metric_key,
         o.outcome,
         o.samples,
         o.min_samples,
         o.window_hours,
         o.recorded_at,
         o.signal_id
    from public.raw_metric_observations o
   order by o.person_id, o.data_source_id, o.metric_key, o.recorded_at desc, o.id desc
),
history as (
  select s.person_id,
         s.data_source_id,
         s.metric_key,
         count(*)                                                                  as snapshots,
         min(s.recorded_at)                                                        as first_snapshot_at,
         max(s.recorded_at)                                                        as last_snapshot_at,
         extract(epoch from (max(s.recorded_at) - min(s.recorded_at))) / 3600.0    as span_hours
    from public.raw_source_snapshots s
   group by s.person_id, s.data_source_id, s.metric_key
)
select p.slug                                    as person_slug,
       p.display_name                            as person_name,
       d.name                                    as source,
       coalesce(latest.metric_key, history.metric_key) as metric_key,
       latest.outcome                            as last_outcome,
       latest.samples,
       latest.min_samples,
       case
         when latest.min_samples is null or latest.min_samples = 0 then null
         when latest.samples is null then 0
         else least(1.0, round(latest.samples::numeric / latest.min_samples, 4))
       end                                       as sample_progress,
       latest.window_hours,
       history.snapshots,
       round(history.span_hours::numeric, 2)     as span_hours,
       case
         when latest.window_hours is null or latest.window_hours = 0 then null
         else least(1.0, round(history.span_hours::numeric / latest.window_hours, 4))
       end                                       as span_progress,
       history.first_snapshot_at,
       history.last_snapshot_at,
       latest.recorded_at                        as last_observed_at,
       (latest.signal_id is not null)            as last_emitted_signal
  from history
  full join latest
    on latest.person_id = history.person_id
   and latest.data_source_id = history.data_source_id
   and latest.metric_key = history.metric_key
  join public.people       p on p.id = coalesce(latest.person_id, history.person_id)
  join public.data_sources d on d.id = coalesce(latest.data_source_id, history.data_source_id);

comment on view public.metric_baseline_progress is
  'Per (person, source, metric): how far the baseline has filled — samples against the declared minimum, history span against the declared window, snapshot count, last outcome. Counts, configuration and timestamps ONLY: no level, delta, mean, sd or sigma is selectable here, which is how the privacy rule is kept on a user-facing admin path. Service role only.';

revoke all on public.metric_baseline_progress from anon, authenticated;

-- Admin access ------------------------------------------------------------------
-- users.is_admin has existed since the initial schema, defaulting false, and is
-- already unwritable by users: the RLS grant covers username, display_name and
-- avatar_url only, so a signed-in user can read their own flag and never set it.
comment on column public.users.is_admin is
  'Operator flag. Enforced SERVER-SIDE on every /admin route and every admin query; a non-admin gets 404, never 403. Not in the authenticated UPDATE grant, so it cannot be self-granted — only the service role sets it.';

update public.users set is_admin = true where email = 'anthonyjbv1@gmail.com';
