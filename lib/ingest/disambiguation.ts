import type { Json } from "@/types/database";

/**
 * ENTITY DISAMBIGUATION.
 *
 * A person-scoped news feed searches for a NAME, and a name is not an
 * identifier. "Drake" is a rapper, a university with a Division I athletics
 * programme, an NFL quarterback, a child actor, an English privateer and a tax
 * software company. Every item the feed returns for the wrong one inflates
 * news_volume_24h — a metric being actively baselined — and hands the sentiment
 * scorer text about somebody else, so a Drake University loss reads as bad news
 * about the artist.
 *
 * This is not a Drake problem. It is structural for any subject who shares a
 * name with another entity, which is most people, and it gets worse rather than
 * better as the roster grows toward consenting individuals who are not globally
 * unique strings.
 *
 * WHAT THIS CAN AND CANNOT DO. The rules here are substring matches over the
 * headline and the outlet. That catches the cases where the other entity is
 * named or where the wrong subject's vocabulary shows up — and the real
 * production example is instructive, because it is the second kind:
 *
 *     "Michigan State Adds Non-Conference Game Against Drake"
 *
 * carries neither "Drake University" nor "Bulldogs". Only "non-conference"
 * gives it away. So exclusions have to cover the DISCOURSE the wrong entity
 * lives in, not just its name.
 *
 * What no substring rule can catch is an item that names neither — "Drake beats
 * Bradley 70-65" would pass. `require_any` exists for subjects where that risk
 * is worth trading recall for: an item must then carry at least one context
 * term or it is refused. It is deliberately left unset for the subjects seeded
 * so far, because a legitimate story ("Drake sued over sample") often carries
 * none of the obvious context words and over-filtering a real signal is worse
 * than admitting a rare wrong one.
 *
 * All of it is CONFIGURATION on the person_data_sources row. Adding a term is
 * an update, never a deploy.
 */

/** Why an item was refused. */
export type ExclusionReason = "excluded_term" | "missing_context";

export interface Disambiguation {
  /** An item naming any of these is a different entity. Case-insensitive substring. */
  exclude_terms: string[];
  /** When non-empty, an item must name at least one of these to be admitted. */
  require_any: string[];
}

export const EMPTY_DISAMBIGUATION: Disambiguation = { exclude_terms: [], require_any: [] };

function termList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const term = entry.trim().toLowerCase();
    if (term) seen.add(term);
  }
  return [...seen];
}

/** Reads the disambiguation block off a person_data_sources config. Tolerant: anything malformed is simply absent. */
export function readDisambiguation(config: Record<string, Json | undefined> | null | undefined): Disambiguation {
  if (!config || typeof config !== "object") return EMPTY_DISAMBIGUATION;
  const block = config.disambiguation;
  if (!block || typeof block !== "object" || Array.isArray(block)) return EMPTY_DISAMBIGUATION;
  const record = block as Record<string, Json | undefined>;
  return { exclude_terms: termList(record.exclude_terms), require_any: termList(record.require_any) };
}

export function hasRules(rules: Disambiguation): boolean {
  return rules.exclude_terms.length > 0 || rules.require_any.length > 0;
}

export interface ExclusionVerdict {
  reason: ExclusionReason;
  /** The term that decided it; null when the verdict is that NO required term was present. */
  term: string | null;
}

/**
 * Judges one item's text. Returns null to admit it.
 *
 * Matching is case-insensitive substring over the whole haystack rather than
 * word-boundary, so a term like "bulldogs" also catches "Bulldogs'". The cost
 * is that a short term can match inside an unrelated word, which is a reason to
 * seed phrases ("drake university") over fragments ("drake").
 */
export function excludeReason(text: string, rules: Disambiguation): ExclusionVerdict | null {
  const haystack = text.toLowerCase();
  for (const term of rules.exclude_terms) {
    if (haystack.includes(term)) return { reason: "excluded_term", term };
  }
  if (rules.require_any.length > 0 && !rules.require_any.some((term) => haystack.includes(term))) {
    return { reason: "missing_context", term: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Query-level exclusion
// ---------------------------------------------------------------------------

/** Google News RSS search: the one feed shape whose query accepts negative terms. */
const GOOGLE_NEWS_SEARCH = /^https:\/\/news\.google\.com\/rss\/search/i;

export function isGoogleNewsSearch(feedUrl: string): boolean {
  return GOOGLE_NEWS_SEARCH.test(feedUrl.trim());
}

/**
 * Pushes the exclusions into the QUERY, so the wrong entity's items are never
 * sent at all — cheaper than fetching and discarding them, and it leaves room
 * in the feed's fixed-size window for items that are actually about the
 * subject, which matters because a page of Drake University results would
 * otherwise crowd out real ones.
 *
 * Google News reads `-term` as an exclusion and `-"a phrase"` for a multi-word
 * one. A term already present in the query is not added twice. The post-fetch
 * filter still runs over whatever comes back: this is a narrowing, not a
 * guarantee, and it does not apply to feeds that are not Google News searches.
 */
export function applyQueryExclusions(feedUrl: string, rules: Disambiguation): string {
  if (rules.exclude_terms.length === 0 || !isGoogleNewsSearch(feedUrl)) return feedUrl;
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return feedUrl;
  }
  const query = url.searchParams.get("q");
  if (!query) return feedUrl;

  const existing = query.toLowerCase();
  const additions: string[] = [];
  for (const term of rules.exclude_terms) {
    // Quote anything that is not a single plain word. A phrase obviously needs
    // it, but so does a hyphenated term: "-non-conference" puts a second minus
    // inside the term, which the search parser is entitled to read as excluding
    // "conference" from a search for "non". Quoting removes the question.
    const quoted = /^[a-z0-9]+$/.test(term) ? `-${term}` : `-"${term}"`;
    if (existing.includes(quoted.toLowerCase())) continue;
    additions.push(quoted);
  }
  if (additions.length === 0) return feedUrl;
  url.searchParams.set("q", `${query} ${additions.join(" ")}`);
  return url.toString();
}
