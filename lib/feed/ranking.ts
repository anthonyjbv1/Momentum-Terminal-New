import type { FeedEntry } from "./feed-model";

/**
 * THE ORDERING SWAP POINT.
 *
 * The Feed ships chronological, newest first, and only that. A personalised
 * ordering ("For You") needs behavioural history that does not exist yet,
 * and an invented heuristic with nothing to validate it would be worse than
 * none. When that layer arrives it plugs in here: a `FeedRanker` takes the
 * loaded window and returns it ordered; the stream calls `rankFeed` and
 * nothing else about the page changes. Paging stays keyset-chronological on
 * the server; a ranker reorders within what is loaded.
 */
export type FeedRanker = (entries: FeedEntry[], context: FeedRankingContext) => FeedEntry[];

export interface FeedRankingContext {
  /** Wall-clock time of the ranking, for recency terms. */
  now: number;
  /** Behavioural signal will arrive with the recommendation layer. Nothing reads it yet. */
  viewerId?: string | null;
}

export const chronologicalRanker: FeedRanker = (entries) =>
  [...entries].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));

/** The ranker in use. Chronological until a validated personalised ranker exists. */
export const activeRanker: FeedRanker = chronologicalRanker;

export function rankFeed(entries: FeedEntry[], context: FeedRankingContext, ranker: FeedRanker = activeRanker): FeedEntry[] {
  return ranker(entries, context);
}
