-- PHASE 29d: a poll can carry the connector's own account of what it did.
--
-- "No insider signal ever" (Finnhub) could not be checked: the connector
-- dropped every Form 4 line that did not become a signal without a count,
-- so no filing, a name we fail to match and a person who only files awards
-- all looked the same. The connector now accounts for every line — fetched,
-- the tracked person's, kept or dropped with the reason — and the runner
-- writes that account here, under a key ('insider_filings'), as well as to
-- the run log. Unlike `reason` it says nothing about the poll's health.
-- Additive and nullable: nothing reads it until the code that writes it ships.

alter table public.source_polls add column detail jsonb;

comment on column public.source_polls.detail is
  'Phase 29d: the connector''s structured account of this poll, by key (e.g. insider_filings: every Form 4 line fetched, which were the tracked person''s, kept or dropped with the reason). Share counts only, never a price. Null: nothing to account.';
