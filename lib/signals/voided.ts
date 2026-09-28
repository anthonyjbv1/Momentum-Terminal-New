/**
 * A VOIDED SIGNAL (hotfix, 2026-09-28). A signal the operator has voided as a
 * demonstrably false input carries a `voided` object in its payload: when,
 * by whom, why, and (for the one that produced a narrative) the narrative it
 * produced, kept whole. Nothing else about the row changes: its score event
 * and the score history it moved are published history and stay as they
 * are. Every reader that shows signals, and the Engine's reads that count
 * them, leave a voided signal out.
 *
 * The marker lives in the payload rather than in a column because the void
 * had to happen the hour it was found and a column is a migration, which
 * waits on the backup rule. The migration that moves it into `voided_at` /
 * `void_reason`, filters `feed_entries()` and `person_signal_volume()` in
 * SQL and gives the audit log a `void_signal` action is the follow-up; this
 * helper is the one place the shape is read, so that move touches one file.
 */
export function isVoidedPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const voided = (payload as Record<string, unknown>).voided;
  return typeof voided === "object" && voided !== null;
}

/** The PostgREST filter that leaves voided rows out of a `signals` read: `.is("raw_payload->voided", null)`. */
export const VOIDED_COLUMN_PATH = "raw_payload->voided";
