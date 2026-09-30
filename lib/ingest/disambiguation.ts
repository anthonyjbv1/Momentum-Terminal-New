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
 *   the name requirement   every item must name the subject, by full name,
 *                          alias or surname, in its headline or its first
 *                          paragraph, whatever its publisher's tier (decided
 *                          2026-09-29; until then a `namesake_guard` flag
 *                          applied it to unknown publishers only, and the key
 *                          is still read, and ignored)
 *   aliases                the names that count as naming the subject, beyond
 *                          their display and full name ("Larry" inside Larry
 *                          Ellison's own feed, "Nvidia CEO" for Jensen Huang)
 *   surname_alone          whether the bare surname names the subject
 *                          (decided 2026-09-29: only when it is distinctive;
 *                          off by default, so "Dell" is a company, "Page" a
 *                          word and "Ross", "Lamar", "Huang" other people
 *                          until the full name or an alias appears)
 *   surname_context        where surname_alone is off, words beside which
 *                          the bare surname still names the subject:
 *                          "Ellison" with "Oracle" is Larry, "Huang" with
 *                          "Nvidia" is Jensen. The exclusions always win:
 *                          "David Ellison" with "Oracle" is still David.
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
  /** Retired 2026-09-29: the name requirement now holds for every publisher. The key is read and ignored, so an existing row is not an error. */
  namesake_guard: boolean;
  /** Phase 31. What else counts as naming the subject, beyond their display and full name. Word-boundary matched. */
  aliases: string[];
  /** Whether the bare surname names the subject for the name requirement (2026-09-29). Off unless the row says `true`. */
  surname_alone: boolean;
  /** Words beside which the bare surname names the subject when surname_alone is off ("Oracle" for Ellison, "Nvidia" for Huang). Lower-cased, substring matched like every term. */
  surname_context: string[];
}

export const EMPTY_DISAMBIGUATION: Disambiguation = { exclude_terms: [], require_any: [], exclude_unless_named: [], namesake_guard: false, aliases: [], surname_alone: false, surname_context: [] };

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
    surname_alone: record.surname_alone === true,
    surname_context: termList(record.surname_context),
    aliases: termList(record.aliases),
  };
}

export function hasRules(rules: Disambiguation): boolean {
  return rules.exclude_terms.length > 0 || rules.require_any.length > 0 || rules.exclude_unless_named.length > 0;
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
  /**
   * The subject's surname, for the NAME REQUIREMENT only, never for the
   * name-conditional exclusions: "Ellison pledges shares" can be Larry,
   * "David Ellison attends" is not, and the exclusion term decides the second
   * before the surname is consulted. Null for a one-word name (Drake,
   * MrBeast), whose names list already is the surname.
   */
  surname: string | null;
  /** The row says the surname is distinctive enough to name the subject on its own. */
  surnameAlone: boolean;
  /** Otherwise, the words beside which it still does (lower-cased). */
  surnameContext: string[];
}

/** Lower case, ASCII-folded (é → e), whitespace collapsed. */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // A typographic apostrophe is an apostrophe: "Nvidia’s Huang" names Nvidia's Huang.
    .replace(/[\u2018\u2019\u02bc]/g, "'")
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

/** The subject's surname: the last word of a display name of two or more words; null otherwise. */
export function subjectSurname(person: { display_name: string }): string | null {
  const parts = person.display_name.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/** The subject as the rules judge an item against them: their names and aliases, and their surname. */
export function exclusionSubject(person: { display_name: string; full_name: string | null }, rules: Disambiguation): ExclusionSubject {
  return { names: subjectNames(person, rules), surname: subjectSurname(person), surnameAlone: rules.surname_alone, surnameContext: rules.surname_context };
}

/** Whether the bare surname names the subject here: on its own when the row says so, else beside one of the row's context words. */
export function namesBySurname(text: string, subject: ExclusionSubject): boolean {
  if (!subject.surname || !namesSubject(text, [subject.surname])) return false;
  if (subject.surnameAlone) return true;
  const haystack = fold(text);
  return subject.surnameContext.some((term) => haystack.includes(fold(term)));
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
 * item only when the subject is absent, and THE NAME REQUIREMENT refuses any
 * item that names the subject nowhere, by full name, alias or surname. The
 * requirement holds for every publisher at every tier (decided 2026-09-29:
 * listing an outlet must not bypass it; a tier changes trust and grave-claim
 * eligibility only). Without a subject the function is exactly what it was.
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
  if (named) return null;
  for (const term of rules.exclude_unless_named) {
    if (haystack.includes(term)) return { reason: "excluded_unless_named", term };
  }
  if (namesBySurname(text, subject)) return null;
  return { reason: "namesake_unnamed", term: null };
}

// ---------------------------------------------------------------------------
// Obituaries (the Phase 31 guard, shipped alone as a hotfix on 2026-09-28)
// ---------------------------------------------------------------------------

/**
 * THE OBITUARY GUARD. A funeral home's notice for a namesake is never about a
 * public figure who is alive, and it needs no configuration to recognise:
 * three were scored in September 2026 (Larry Dean Ellison, Michael Henry
 * Dell, and a Larry Page of Greeneville, TN whose Legacy.com notice primed
 * the model to read a bare-name item from a local station as a death, and to
 * write one). It runs on every news feed, with or without rules and with or
 * without the Phase 31 switch, and refuses on either of two grounds:
 *
 *   the headline carries the vocabulary of a funeral notice: a public
 *   figure's death is reported as news ("dies at 91"), never as "Obituary,
 *   Visitation & Funeral Information". Word-boundary, so "obituary" matches
 *   and "obituaries editor" does too, a rare loss against three namesakes in
 *   one month;
 *
 *   the outlet or its domain is a funeral home or a memorial site.
 *
 * What it does NOT catch, by design and on record: an item whose headline is
 * nothing but the subject's name from an unknown outlet (the wgrv.com item of
 * 2026-09-28 17:35 UTC). That is a namesake problem, not an obituary one; the
 * narrative guard (lib/engine/sentiment/grave-claims.ts) is what keeps such
 * an item from becoming a death sentence on the Feed.
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
