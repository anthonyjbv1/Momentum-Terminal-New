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
 * THE NAMESAKE WHO SHARES THE SURNAME (Phase 31). The second production
 * example is a relative, not a university: ten stories about David Ellison
 * (Paramount) were scored for Larry Ellison in one fortnight, at +4.32 points
 * of absolute impact, because a Google News search for "Larry Ellison" matches
 * the article BODY and every Paramount story mentions the father once. A plain
 * exclusion of "David Ellison" would also refuse "Larry and David Ellison have
 * all the money", which is about both. So Phase 31 adds three rules, each one
 * conditional on whether the SUBJECT is named:
 *
 *   exclude_unless_named   a term that marks a namesake's story ("David
 *                          Ellison", "Page Auto", "Paramount") UNLESS the
 *                          subject is named alongside it
 *   namesake_guard         an item from a publisher the allowlist does not
 *                          know (the tier floor) must name the subject in its
 *                          headline; a body match alone is not enough from an
 *                          unknown outlet
 *   aliases                the names that count as naming the subject, beyond
 *                          their display and full name ("Larry" inside Larry
 *                          Ellison's own feed, "Nvidia CEO" for Jensen Huang)
 *
 * and one rule that needs no configuration at all: an OBITUARY (a funeral
 * home's notice for a namesake) is never about a public figure who is alive,
 * and two of them were scored in September 2026.
 *
 * All of it is CONFIGURATION on the person_data_sources row. Adding a term is
 * an update, never a deploy. The Phase 31 rules are dormant until the connector
 * is handed a subject (SIGNAL_QUALITY_ENABLED): `excludeReason` without a
 * subject is byte-for-byte the Phase 10 function.
 */

/** Why an item was refused. */
export type ExclusionReason = "excluded_term" | "missing_context" | "excluded_unless_named" | "namesake_unnamed" | "obituary";

export interface Disambiguation {
  /** An item naming any of these is a different entity. Case-insensitive substring. */
  exclude_terms: string[];
  /** When non-empty, an item must name at least one of these to be admitted. */
  require_any: string[];
  /** Phase 31. An item naming any of these is a different entity UNLESS the subject is named too. */
  exclude_unless_named: string[];
  /** Phase 31. An item from an unknown publisher must name the subject in its headline. */
  namesake_guard: boolean;
  /** Phase 31. What else counts as naming the subject, beyond their display and full name. Word-boundary matched. */
  aliases: string[];
}

export const EMPTY_DISAMBIGUATION: Disambiguation = { exclude_terms: [], require_any: [], exclude_unless_named: [], namesake_guard: false, aliases: [] };

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
  return {
    exclude_terms: termList(record.exclude_terms),
    require_any: termList(record.require_any),
    exclude_unless_named: termList(record.exclude_unless_named),
    namesake_guard: record.namesake_guard === true,
    aliases: termList(record.aliases),
  };
}

export function hasRules(rules: Disambiguation): boolean {
  return rules.exclude_terms.length > 0 || rules.require_any.length > 0 || rules.exclude_unless_named.length > 0 || rules.namesake_guard;
}

export interface ExclusionVerdict {
  reason: ExclusionReason;
  /** The term that decided it; null when the verdict is that NO required term was present. */
  term: string | null;
}

/**
 * The subject an item is judged against (Phase 31). Absent, the two
 * name-conditional rules do not run.
 */
export interface ExclusionSubject {
  /** The names that count as naming the subject: display name, full name, configured aliases. */
  names: string[];
  /** The item's publisher is unknown to the allowlist (the tier floor). */
  unknownPublisher: boolean;
}

/** Lower case, ASCII-folded (é → e), whitespace collapsed. */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the text names the subject by any of the given names, as whole
 * words: "Ellison's" and "Mahomes," match, "Ellisons" does not name Larry
 * Ellison and "Mahomesville" does not name Patrick Mahomes. Substring matching
 * is right for EXCLUSIONS (a fragment of the wrong entity's vocabulary is
 * evidence enough to refuse) and wrong for NAMING, where a short name inside a
 * longer word is not a mention.
 */
export function namesSubject(text: string, names: string[]): boolean {
  const haystack = fold(text);
  return names.some((name) => {
    const needle = fold(name);
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(haystack);
  });
}

/** The names an item must carry to count as naming the subject: their display and full name, plus the configured aliases. */
export function subjectNames(person: { display_name: string; full_name: string | null }, rules: Disambiguation): string[] {
  const out = new Set<string>();
  for (const name of [person.display_name, person.full_name, ...rules.aliases]) {
    if (typeof name === "string" && name.trim()) out.add(name.trim());
  }
  return [...out];
}

/**
 * Judges one item's text. Returns null to admit it.
 *
 * Matching is case-insensitive substring over the whole haystack rather than
 * word-boundary, so a term like "bulldogs" also catches "Bulldogs'". The cost
 * is that a short term can match inside an unrelated word, which is a reason to
 * seed phrases ("drake university") over fragments ("drake").
 *
 * With a subject (Phase 31) two more rules run, both conditional on whether
 * the subject is NAMED in the text: an `exclude_unless_named` term refuses the
 * item only when the subject is absent, and the namesake guard refuses an
 * unknown publisher's item that does not name the subject at all. Without a
 * subject the function is exactly what it was.
 */
export function excludeReason(text: string, rules: Disambiguation, subject?: ExclusionSubject): ExclusionVerdict | null {
  const haystack = text.toLowerCase();
  for (const term of rules.exclude_terms) {
    if (haystack.includes(term)) return { reason: "excluded_term", term };
  }
  if (rules.require_any.length > 0 && !rules.require_any.some((term) => haystack.includes(term))) {
    return { reason: "missing_context", term: null };
  }
  if (!subject) return null;
  const named = namesSubject(text, subject.names);
  if (!named) {
    for (const term of rules.exclude_unless_named) {
      if (haystack.includes(term)) return { reason: "excluded_unless_named", term };
    }
    if (rules.namesake_guard && subject.unknownPublisher) return { reason: "namesake_unnamed", term: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Obituaries (Phase 31)
// ---------------------------------------------------------------------------

/**
 * The vocabulary of a funeral notice, in the headline: a public figure's death
 * is reported as news ("dies at 91"), never as "Obituary, Visitation & Funeral
 * Information". Word-boundary, so "obituary" matches and "obituaries editor"
 * does too — a headline about an obituaries editor is a rare loss against two
 * namesakes scored in one month.
 */
const OBITUARY_HEADLINE = /\b(obituary|obituaries|funeral|visitation|memorial service|passed away|celebration of life|in loving memory|death notice|tribute wall)\b/i;
/** A funeral home or memorial site, by the outlet's name or its domain. */
const OBITUARY_PUBLISHER = /(funeral|cremation|burial|mortuary|memorial|obituar|legacy\.com|dignitymemorial|tributearchive|echovita|everloved)/i;

/** Refuses a funeral notice for a namesake. Needs no configuration; nothing about a living public figure reads like one. */
export function obituaryReason(item: { headline: string; outlet?: string | null; domain?: string | null }): ExclusionVerdict | null {
  const headline = OBITUARY_HEADLINE.exec(item.headline);
  if (headline) return { reason: "obituary", term: headline[1].toLowerCase() };
  for (const publisher of [item.outlet, item.domain]) {
    if (!publisher) continue;
    const match = OBITUARY_PUBLISHER.exec(publisher);
    if (match) return { reason: "obituary", term: match[1].toLowerCase() };
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
 *
 * Only the unconditional terms go into the query. An `exclude_unless_named`
 * term cannot: the query has no way to say "unless the subject is named".
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
