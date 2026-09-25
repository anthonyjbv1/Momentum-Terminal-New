-- PHASE 29d, step 2 of 2: drop the source-only dedupe rule.
--
-- Applied after the code inserts against (data_source_id, person_id,
-- dedupe_key) (step 1). While both rules stood, a key shared by two people was
-- still refused by this one; from here each person keeps their own copy.

alter table public.signals drop constraint signals_source_dedupe_key_unique;

comment on column public.signals.dedupe_key is
  'Optional connector-supplied idempotency key, unique per data source and person (Phase 29d; per data source alone before). NULL never conflicts.';
