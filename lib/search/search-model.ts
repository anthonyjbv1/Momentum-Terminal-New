import { directionOf, type Direction } from "@/components/ui/direction-indicator";

/**
 * Search's shape, its copy and the pure logic around both. No I/O, so it can
 * be imported from either side of the server boundary and tested on its own.
 *
 * What a result row is allowed to say is decided here rather than in the
 * component: who the person is, what they do, where their score stands and
 * which way it is moving. Nothing else comes back from the database, so
 * nothing else can leak into the row by accident.
 */

/** A person as a search result renders them. Numbers are already coerced. */
export interface SearchResult {
  id: string;
  slug: string;
  displayName: string;
  category: string;
  avatarUrl: string | null;
  score: number;
  /** Score movement over the trailing hour; null when there is no history to read yet. */
  change: number | null;
  direction: Direction;
}

/** A row exactly as public.search_people() returns it. */
export interface SearchRow {
  id: string;
  slug: string;
  display_name: string;
  category: string;
  avatar_url: string | null;
  current_score: number | string;
  change: number | string | null;
  match_rank: number;
}

/** How many results a search shows. The RPC caps its own limit at 25. */
export const SEARCH_LIMIT = 8;

/** Shortest query that is worth asking the database about. */
export const MIN_QUERY_LENGTH = 1;

/** How long after the last keystroke the query is sent. */
export const QUERY_DEBOUNCE_MS = 250;

/**
 * How long a query must then sit still, with its results already in hand,
 * before it counts as a search worth logging. Logging after the results
 * arrive rather than before is what lets the event carry the number of
 * results the person actually saw.
 */
export const QUERY_SETTLE_MS = 700;

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rows to results. The database has already ranked them (match quality, then
 * score, then name, then id), so this preserves the order it was given rather
 * than re-sorting — two callers asking the same thing get the same list.
 */
export function readSearchResults(rows: readonly SearchRow[]): SearchResult[] {
  return rows.map((row) => {
    const change = toNullableNumber(row.change);
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      category: row.category,
      avatarUrl: row.avatar_url,
      score: toNumber(row.current_score),
      change,
      direction: directionOf(change),
    } satisfies SearchResult;
  });
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------
//
// Two states, and they are not the same job.
//
// The EMPTY state — nothing typed yet — says what search is for. It is not an
// apology for having no results; there is no query to have results for.
//
// The NO RESULT state is the one that matters, because of who is reading it.
// Search is the first surface a beta invitee touches and the first thing most
// people type is their own name. Finding yourself listed here as something
// with a score is a real moment; not finding yourself is also a real moment,
// and "0 results" answers neither. So the copy answers the question actually
// being asked — why am I not here? — plainly, and without pretending the
// absence is a malfunction. Nobody is on this list by accident, which is true:
// the roster is set one slug at a time and is_discoverable defaults to off.
//
// House rules (Phase 21+): plain words, no jargon, no gendered pronouns, no
// statistics vocabulary. No count is quoted, so nothing here goes stale the
// day the seventeenth person is added.

export const SEARCH_COPY = {
  empty: {
    title: "Find a person.",
    body: "Type a name or a handle. Everyone here carries a score that moves with what happens to them — open a result to see what moved it.",
  },
  noResults: {
    title: "No one here by that name.",
    body: "The list is short, and it grows one name at a time. If you were looking for yourself and came up empty, that is not an oversight — nobody is on this list by accident.",
  },
  failed: {
    title: "Search is not answering.",
    body: "Give it a moment and type again. The board on Home is still there in the meantime.",
  },
} as const;
