/**
 * A VOIDED SIGNAL (2026-09-28). A signal the operator has voided as a
 * demonstrably false input (an "obvious error") carries `voided_at` and
 * `void_reason` on its row, and an audit row (`void_signal`) names it. Nothing
 * else about the row changes: its score event and the score history it moved
 * are published history and stay as they are. Every reader that shows
 * signals, and the Engine's reads that count them, leave a voided signal out;
 * `feed_entries()` and `person_signal_volume()` do the same in SQL.
 *
 * The first two voids, on the day, were written as a `voided` object in the
 * payload before the columns existed (the migration waited on the backup
 * rule); the migration backfilled them and the markers stay as the record,
 * one of them holding the deleted narrative's full row. This helper reads
 * both, so a row is voided if either says so.
 */
export function isVoidedPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const voided = (payload as Record<string, unknown>).voided;
  return typeof voided === "object" && voided !== null;
}

/** Whether a signals row is voided: by its column, or by the payload marker of the first day. */
export function isVoided(row: { voided_at?: string | null; raw_payload?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return (typeof row.voided_at === "string" && row.voided_at.length > 0) || isVoidedPayload(row.raw_payload);
}

/** The column a `signals` read filters on to leave voided rows out: `.is(VOIDED_COLUMN, null)`. */
export const VOIDED_COLUMN_PATH = "voided_at";
