import { isVoided } from "@/lib/signals/voided";

/**
 * WHAT A READER MAY SHOW (2026-10-09). A signal leaves every surface when it
 * is voided (a false input), hidden (the operator's display-only hide) or
 * held (the allegation rule). The signal itself, its score and its volume
 * count are untouched in the last two cases; this is about display alone.
 * `feed_entries()` applies the same three in SQL.
 */
export const DISPLAY_COLUMNS = "voided_at, hidden_at, allegation_held";

export function isDisplayable(row: { voided_at?: string | null; hidden_at?: string | null; allegation_held?: boolean | null; raw_payload?: unknown } | null | undefined): boolean {
  if (!row) return false;
  if (isVoided(row)) return false;
  if (typeof row.hidden_at === "string" && row.hidden_at.length > 0) return false;
  if (row.allegation_held === true) return false;
  return true;
}
