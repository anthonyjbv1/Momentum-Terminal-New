-- PHASE 19+ — Market Mood over a trailing window.
--
-- The mood was computed from the signals processed in ONE tick. Signals
-- arrive in fifteen-minute bursts against two ticks a minute, so the reading
-- was zero on 96.5% of ticks (5,556 of 5,760 in the 48 hours to 2026-09-18)
-- and the header's Mood indicator was decoration rather than information.
--
-- The Engine now reads the tide over the last marketMood.windowMinutes (60)
-- from the Signals force's own audit trail in this table, and applies it as a
-- rate per hour times the person's elapsed time, exactly as Gravity applies
-- lambdaPerHour. Nothing about the schema has to change for that — only the
-- read has to be fast, and what the mood column means has to be recorded.

-- The read is `force = 'signals' and created_at >= now() - interval '60 min'`,
-- once per tick. Signals rows are a thousandth of this table (1,019 of
-- 102,474 at the time of writing), so the index is partial: it stays small
-- while the table grows with the forces that fire every tick.
create index if not exists score_events_signals_window_idx
  on public.score_events (created_at desc)
  where force = 'signals';

comment on index public.score_events_signals_window_idx is
  'Phase 19+: Market Mood reads the Signals force''s impacts over its trailing window once per tick. Partial on the signals rows, which are a thousandth of the table.';

comment on column public.engine_ticks.mood is
  'Market Mood at this tick, in score points. FROM PHASE 19+ this is the board''s mean per-person Signals movement over the trailing window (60 minutes by default), taken across the ticks in it that moved anyone. Rows written before 2026-09-18 hold the older instantaneous reading: that tick''s signals alone, and therefore 0.00 on 96.5% of ticks.';
