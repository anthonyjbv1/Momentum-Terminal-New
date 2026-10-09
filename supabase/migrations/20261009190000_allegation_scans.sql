-- =============================================================================
-- DETECTION SCAN RESULTS (2026-10-09). The allegation scan compared the two
-- detection methods (the scoring call's label, the 59-term backstop) over
-- the stored backlog and returned its result to the caller's browser only.
-- From here every run is stored, so the console reads it back: when it ran,
-- who ran it, the window, the counts, every flagged story and every
-- disagreement. Service role only; the operator reads it through the console.
-- =============================================================================

create table public.allegation_scans (
  id             uuid        primary key default gen_random_uuid(),
  run_at         timestamptz not null default now(),
  -- The admin whose session ran it; null when a shared-secret caller did.
  run_by         uuid,
  params         jsonb       not null,
  counts         jsonb       not null,
  flagged        jsonb       not null default '[]'::jsonb,
  disagreements  jsonb       not null default '[]'::jsonb,
  llm_calls      integer     not null default 0,
  created_at     timestamptz not null default now()
);

alter table public.allegation_scans enable row level security;
revoke all on public.allegation_scans from public, anon, authenticated;
grant select, insert on public.allegation_scans to service_role;

create index allegation_scans_run_at_idx on public.allegation_scans (run_at desc);

comment on table public.allegation_scans is 'Every detection scan (label vs terms over the stored backlog): params, counts, the flagged stories and the disagreements, for the console.';
