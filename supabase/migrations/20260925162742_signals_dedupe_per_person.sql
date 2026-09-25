-- PHASE 29d, step 1 of 2: a signal's dedupe key is unique per source AND PERSON.
--
-- signals_source_dedupe_key_unique made a connector's idempotency key unique
-- per data source alone, and the store inserts with ON CONFLICT DO NOTHING on
-- it. An item that belongs to two people — Alphabet's company-news count for
-- Larry Page and Sergey Brin (both GOOGL), an article in two people's feeds, a
-- game two tracked players played in — carries the same key for both, so the
-- second person's copy was refused, silently, every time: Brin has never had a
-- Finnhub signal. The key identifies the ITEM; the person it is stored for is
-- part of what makes the row unique.
--
-- Two steps, so the deploy never meets a missing ON CONFLICT target: this adds
-- the per-person rule beside the old one (old code keeps inserting against the
-- old target); the code moves to the new target; step 2 drops the old rule.
-- Every existing row is unique on (source, key), so it is unique on (source,
-- person, key): the constraint cannot fail to build, and no row changes.

alter table public.signals
  add constraint signals_source_person_dedupe_key_unique unique (data_source_id, person_id, dedupe_key);

comment on constraint signals_source_person_dedupe_key_unique on public.signals is
  'Phase 29d: a connector''s idempotency key is unique per data source and person. The same item (a shared ticker, an article about two people) is stored once for each person it belongs to. NULL never conflicts.';
