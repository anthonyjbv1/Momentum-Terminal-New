-- =============================================================================
-- Momentum Terminal — Phase 21: the index behind the forces panel's window.
--
-- The panel now adds each force's contributions over the last hour rather than
-- showing the latest tick's, because at two decimals the per-tick figure can
-- never render (Gravity averages 0.005 points a tick, Market Mood 0.0006). The
-- read behind it is "every score_events row for this person since a timestamp",
-- and score_events had no index that answers it: the person index is keyed by
-- tick_number, so the query would have to read every row the person owns —
-- already about ten thousand each, and growing by six thousand a day.
--
-- (person_id, created_at desc) answers it directly. The existing
-- (person_id, tick_number desc) index stays: it serves the latest-tick read on
-- the same page.
-- =============================================================================

create index if not exists score_events_person_created_idx
  on public.score_events (person_id, created_at desc);
