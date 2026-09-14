/**
 * Story identity, for deduplicating news at ingestion.
 *
 * One story syndicates across many outlets under many URLs, so a URL is not
 * a story. Two items are the same story when their headlines say the same
 * thing: each headline is reduced to its content words (the outlet suffix
 * Google News appends, the person's own name, stop words and inflection
 * removed) and compared with the Sørensen–Dice coefficient,
 * 2·|A ∩ B| / (|A| + |B|). Dice tolerates the length asymmetry syndication
 * produces (a short wire headline against an outlet's expanded one) better
 * than Jaccard, and stays low for two different stories about the same
 * person on the same day, which share little beyond the name that was
 * removed.
 *
 * Two duplicates keep ONE signal: the highest-tier publisher's, then the
 * earliest. Deduplication runs within a poll and against the signals already
 * stored inside STORY_DEDUP_LOOKBACK_HOURS, because syndication trails over
 * hours. When a better-tier outlet arrives later for a story already stored
 * unprocessed, the stored signal is upgraded in place rather than joined by
 * a second one.
 */

/**
 * STORY_SIMILARITY_THRESHOLD — the Dice coefficient at or above which two
 * headlines are one story. TUNABLE.
 *
 * 0.4 (lowered from 0.5 after two production runs). Over-collapse is the worse
 * error — it silently deletes a real story, where under-collapse only adds a
 * signal the per-source cap and the square-root sum already damp — so the
 * threshold sits above every distinct-story pair observed so far: the widest
 * was 0.167 ("100 Hottest Rappers Right Now" against "Future Ties Drake's
 * Historic Record"). Measured syndication runs 0.5–1.0 for national outlets
 * rewriting one wire story.
 *
 * WHAT IT STILL MISSES, measured on real data: local-TV rewrites of one event
 * that share almost no vocabulary. "MrBeast surprises Tonganoxie students with
 * year of free lunches" against "MrBeast surprises Kansas school after
 * teacher's yearlong lunch debt push" scores 0.353; "Ind. troopers hunt down
 * MrBeast in 'Escape 100 Cops' challenge" against "MrBeast hides from 100
 * Indiana State Police troopers" scores 0.286, because "Ind." and "cops" are
 * an abbreviation and a synonym of words the other headline spells out. No
 * threshold catches those without also collapsing genuinely different stories;
 * word overlap is the wrong instrument for them, not the wrong setting. Both
 * pairs are pinned as tests so the day the instrument changes, they say so.
 */
export const STORY_SIMILARITY_THRESHOLD = 0.4;

/**
 * STORY_DEDUP_LOOKBACK_HOURS — how far back a new item is compared against
 * stored signals of the same person and source, and how far apart two items
 * may be published and still count as one story. TUNABLE. Wire pickups and
 * aggregator copies land within a day or two; the same headline a week later
 * is a recurring topic, not a syndication.
 */
export const STORY_DEDUP_LOOKBACK_HOURS = 48;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with", "from", "by", "as", "is", "are", "was", "were", "be", "been",
  "it", "its", "this", "that", "these", "those", "his", "her", "their", "he", "she", "they", "him", "them", "you", "your", "we", "our", "i",
  "has", "have", "had", "do", "does", "did", "not", "no", "so", "if", "then", "than", "into", "over", "after", "before", "about", "up", "out",
  "off", "just", "more", "new", "says", "say", "said", "gets", "get", "got", "here", "there", "what", "why", "how", "who", "when", "where", "which",
  "amid", "via", "vs", "will", "can", "could", "would", "should", "may", "might", "also", "all", "any", "some", "one", "two", "first", "latest",
  "news", "report", "reports", "reportedly", "watch", "video", "exclusive", "update", "live", "again", "still", "now", "today", "yesterday",
]);

/** Google News formats a title as "Headline - Outlet". Strip the suffix when it names the outlet, and only then. */
export function stripOutletSuffix(title: string, outlet: string | null | undefined): string {
  const trimmed = title.trim();
  if (!outlet) return trimmed;
  const match = /^([\s\S]*\S)\s+[-–—|]\s+(\S[\s\S]*)$/.exec(trimmed);
  if (!match) return trimmed;
  return fold(match[2]) === fold(outlet) ? match[1].trim() : trimmed;
}

/** Lower case, ASCII-folded (é → e), whitespace collapsed. */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A light stem: plural and possessive stripped, so "albums" and "album's"
 * meet "album". The "-es" cases are handled only where the ending is
 * unambiguous (ches / shes / sses / xes / zes), so "lunches" meets "lunch"
 * while "surprises" still meets "surprise" rather than becoming "surpris".
 */
function stem(token: string): string {
  if (token.length > 4 && /(ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  return fold(text)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= 2)
    .map(stem);
}

export interface StoryTokenOptions {
  /** The person the feed is about; their name carries no information within their own feed. */
  personNames?: string[];
  /** The outlet Google News appended to the title, to strip. */
  outlet?: string | null;
}

/** The names an item's story text is compared without: the person's own, which every item in their feed shares. */
export function personNames(person: { display_name: string; full_name: string | null }): string[] {
  return [person.display_name, person.full_name].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

/** The content words of a headline, as a set. */
export function storyTokens(text: string, options: StoryTokenOptions = {}): Set<string> {
  const names = new Set((options.personNames ?? []).flatMap((name) => tokenize(name)));
  const tokens = tokenize(stripOutletSuffix(text, options.outlet)).filter((token) => !STOPWORDS.has(token) && !names.has(token));
  return new Set(tokens);
}

/** Sørensen–Dice over two token sets; 0 when either is empty. */
export function storySimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** A candidate item in the poll being deduplicated. */
export interface StoryCandidate {
  tokens: Set<string>;
  /** Credibility tier, 1 best. */
  tier: number;
  occurredAt: Date;
}

/** A signal already stored for the same person and source inside the lookback. */
export interface StoredStory {
  id: string;
  tokens: Set<string>;
  tier: number;
  processed: boolean;
  occurredAt: Date;
}

export type StoryCollapse<T> =
  | { item: T; similarity: number; into: { kind: "stored"; id: string; tier: number; processed: boolean }; /** The stored, unprocessed signal is of a worse tier: upgrade it to this item's publisher. */ upgrade: boolean }
  | { item: T; similarity: number; into: { kind: "run"; item: T }; upgrade: false };

export interface CollapseResult<T> {
  kept: T[];
  collapsed: StoryCollapse<T>[];
}

export interface CollapseOptions {
  threshold?: number;
  lookbackHours?: number;
}

/**
 * Collapses the poll's items into distinct stories.
 *
 * Items are considered best publisher first (lowest tier number, then
 * earliest, then feed order), so the survivor of a cluster is always its
 * highest-tier item. A story is a cluster: the stored signals inside the
 * lookback seed one cluster each, and every item joins the cluster holding
 * the member it is most similar to, at or above the threshold, or starts its
 * own. Comparing against every member, not only the survivor, follows a
 * syndication chain whose ends are worded differently (single linkage); the
 * threshold keeps two different stories from being bridged by an accident of
 * wording. An item that joins a stored story is collapsed into it (the
 * stored signal wins), except that a better-tier item upgrades a stored
 * signal the Engine has not read yet. Two items published further apart than
 * the lookback are never one story.
 */
export function collapseStories<T>(items: T[], describe: (item: T) => StoryCandidate, stored: StoredStory[], options: CollapseOptions = {}): CollapseResult<T> {
  const threshold = options.threshold ?? STORY_SIMILARITY_THRESHOLD;
  const lookbackMs = (options.lookbackHours ?? STORY_DEDUP_LOOKBACK_HOURS) * 3_600_000;
  type Described = StoryCandidate & { item: T; index: number };
  type Member = { tokens: Set<string>; occurredAt: Date };
  type Cluster = { into: { kind: "stored"; story: StoredStory; tier: number } | { kind: "run"; entry: Described }; members: Member[] };

  const described: Described[] = items.map((item, index) => ({ item, index, ...describe(item) }));
  described.sort((a, b) => a.tier - b.tier || a.occurredAt.getTime() - b.occurredAt.getTime() || a.index - b.index);

  const clusters: Cluster[] = stored.map((story) => ({ into: { kind: "stored", story, tier: story.tier }, members: [{ tokens: story.tokens, occurredAt: story.occurredAt }] }));
  const kept: Described[] = [];
  const collapsed: StoryCollapse<T>[] = [];
  const within = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) <= lookbackMs;

  for (const candidate of described) {
    let best: { cluster: Cluster; similarity: number } | null = null;
    for (const cluster of clusters) {
      for (const member of cluster.members) {
        if (!within(candidate.occurredAt, member.occurredAt)) continue;
        const similarity = storySimilarity(candidate.tokens, member.tokens);
        // Strictly better only: on a tie the earlier cluster (a stored story before a new one) keeps the item.
        if (similarity >= threshold && (best === null || similarity > best.similarity)) best = { cluster, similarity };
      }
    }

    if (best) {
      const { cluster, similarity } = best;
      cluster.members.push({ tokens: candidate.tokens, occurredAt: candidate.occurredAt });
      if (cluster.into.kind === "stored") {
        const { story } = cluster.into;
        const upgrade = !story.processed && candidate.tier < cluster.into.tier;
        collapsed.push({ item: candidate.item, similarity, into: { kind: "stored", id: story.id, tier: story.tier, processed: story.processed }, upgrade });
        if (upgrade) cluster.into.tier = candidate.tier;
      } else {
        collapsed.push({ item: candidate.item, similarity, into: { kind: "run", item: cluster.into.entry.item }, upgrade: false });
      }
      continue;
    }

    clusters.push({ into: { kind: "run", entry: candidate }, members: [{ tokens: candidate.tokens, occurredAt: candidate.occurredAt }] });
    kept.push(candidate);
  }

  // Survivors back in feed order, so what is stored reads as the feed listed it.
  kept.sort((a, b) => a.index - b.index);
  return { kept: kept.map((entry) => entry.item), collapsed };
}
