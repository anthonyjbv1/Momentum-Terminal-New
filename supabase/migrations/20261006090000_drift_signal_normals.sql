-- =============================================================================
-- THE DRIFT'S NORMALS (the drift redesign, 2026-10-04; written on the branch,
-- NOT applied).
--
-- In relative coverage mode the drifting target reads each listed person
-- against their own normal: the sums of the Signals force's audit rows over
-- the normal's window, which the Engine turns into a mean gross and a mean
-- signed impact per hour. One read for the listed people, aggregated here so
-- no row set crosses the wire. Read-only; service role only.
-- =============================================================================

create or replace function public.drift_signal_normals(
  p_person_ids uuid[],
  p_since      timestamptz
)
returns table (
  person_id     uuid,
  gross_impact  numeric,
  signed_impact numeric,
  events        integer,
  first_at      timestamptz,
  last_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.person_id,
         sum(abs(e.impact))  as gross_impact,
         sum(e.impact)       as signed_impact,
         count(*)::int       as events,
         min(e.created_at)   as first_at,
         max(e.created_at)   as last_at
    from public.score_events e
   where e.force = 'signals'
     and e.person_id = any (p_person_ids)
     and e.created_at >= p_since
   group by e.person_id;
$$;

comment on function public.drift_signal_normals(uuid[], timestamptz) is
  'The drift redesign (2026-10-04): per listed person, the Signals force''s gross and signed impact sums, row count and first/last instants since p_since, from which the Engine measures the person''s normal rate. Read-only; service role only.';

revoke execute on function public.drift_signal_normals(uuid[], timestamptz) from public, anon, authenticated;
grant  execute on function public.drift_signal_normals(uuid[], timestamptz) to service_role;
