import { directionOf, type Direction } from "@/components/ui/direction-indicator";
import { categoryLabel, categoryOptions, type CategoryOption } from "@/lib/home/board-model";
import { formatSigned } from "@/lib/person/profile-model";

/**
 * The Feed's shape and the pure logic behind it: the entry, the Engine's
 * framing for a raw signal, the high-impact selection, category filtering,
 * paging and the cursor. No I/O here, so every rule is testable on its own.
 *
 * VOICE. The Feed is one narrator: the Engine describing what it observes.
 * A narrative entry is the Engine's own sentence, stored as written. A
 * signal entry is a raw observation that no narrative explains yet, so the
 * Engine frames it here, in presentation only (`frameSignal`), and the
 * headline it observed is carried as a quotation beneath. Stored text is
 * never rewritten.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * THE HIGH-IMPACT THRESHOLD, in score points. An entry whose recorded score
 * impact is at least this far from zero, in either direction, qualifies for
 * the pinned treatment at the top of the Feed.
 *
 * TUNABLE — A STARTING VALUE. On a 0–100 score with Gravity pulling every
 * person back toward baseline on every tick, a move the size of a full
 * chart height (Y_RANGE_FLOOR is 2.0) may be rare enough that the section
 * never appears and the treatment is never seen working. 1.25 sits well
 * under that while staying above what one routine signal moves a score.
 * Raise it once the real distribution of score moves is observable.
 */
export const HIGH_IMPACT_THRESHOLD = 1.25;

/** Only entries this recent are considered for the pinned treatment. */
export const PINNED_WINDOW_HOURS = 24;

/** At most this many pinned entries. */
export const PINNED_MAX = 3;

/** Entries per page from the database. */
export const FEED_PAGE_SIZE = 24;

/** The most entries the browser keeps loaded; the stream stops paging here. */
export const FEED_MAX_ENTRIES = 240;

/** How far below the viewport, in CSS pixels, the next page starts loading. */
export const FEED_PREFETCH_MARGIN_PX = 600;

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type FeedEntryKind = "narrative" | "signal";

export interface FeedPerson {
  id: string;
  slug: string;
  name: string;
  category: string;
  avatarUrl: string | null;
}

export type FeedEvidenceRelation = "direct" | "inverse_pair";

/**
 * A signal behind an entry: the evidence the Engine read. For a narrative
 * this is exactly what the Engine linked when it wrote the sentence
 * (narrative_signals); nothing is inferred from timing.
 */
export interface FeedEvidence {
  id: string;
  headline: string;
  source: string | null;
  impact: number | null;
  occurredAt: string;
  sentiment: string | null;
  confidence: number | null;
  processed: boolean | null;
  /** direct: about the entry's own person. inverse_pair: the paired person's signal, whose move the narrative reacts to. */
  relation: FeedEvidenceRelation;
  /** The paired person, for inverse_pair evidence; null otherwise. */
  person: { name: string; slug: string } | null;
}

export interface FeedEntry {
  id: string;
  kind: FeedEntryKind;
  person: FeedPerson;
  /** The hero text: the Engine's sentence, or its framing of a raw signal. */
  text: string;
  /** For a signal entry, the headline as observed, shown as a quotation beneath the framing. */
  quote: string | null;
  /** Recorded score impact: a narrative's move, or a signal's impact_score. Null when nothing was recorded. */
  impact: number | null;
  direction: Direction;
  scoreBefore: number | null;
  scoreAfter: number | null;
  tickNumber: number | null;
  occurredAt: string;
  /** Short source names, for the recessive attribution line. */
  sources: string[];
  evidence: FeedEvidence[];
}

/** A row of feed_entries() as the database returns it. */
export interface FeedRow {
  kind: string;
  id: string;
  person_id: string;
  person_slug: string;
  person_name: string;
  person_category: string;
  person_avatar: string | null;
  text: string;
  impact: number | string | null;
  score_before: number | string | null;
  score_after: number | string | null;
  tick_number: number | string | null;
  occurred_at: string;
  sources: string[] | null;
  evidence: unknown;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "RSS (per-person news feed)" → "RSS". Attribution is a name, not a description. */
export function shortSource(name: string | null | undefined): string | null {
  if (!name) return null;
  const short = name.replace(/\s*\(.*\)\s*$/, "").trim();
  return short.length > 0 ? short : null;
}

function toEvidence(value: unknown): FeedEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: FeedEvidence[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.headline !== "string") continue;
    const relation: FeedEvidenceRelation = record.relation === "inverse_pair" ? "inverse_pair" : "direct";
    const personName = typeof record.person_name === "string" ? record.person_name : null;
    const personSlug = typeof record.person_slug === "string" ? record.person_slug : "";
    out.push({
      id: record.id,
      headline: record.headline,
      source: shortSource(typeof record.source === "string" ? record.source : null),
      impact: toNullableNumber(record.impact),
      occurredAt: typeof record.occurred_at === "string" ? record.occurred_at : "",
      sentiment: typeof record.sentiment === "string" ? record.sentiment : null,
      confidence: toNullableNumber(record.confidence),
      processed: typeof record.processed === "boolean" ? record.processed : null,
      relation,
      person: relation === "inverse_pair" && personName ? { name: personName, slug: personSlug } : null,
    });
  }
  return out;
}

/**
 * The Engine's framing of a raw signal, in its own register: what it
 * observed, on whom, and what it made of it. Presentation only; the
 * headline itself is quoted beneath, untouched.
 */
/**
 * "A YouTube signal" but "An RSS signal": an initialism is read letter by
 * letter, so its article follows the sound of the first letter's name, not
 * whether the letter is a vowel. Letter names that open on a vowel sound:
 * A E F H I L M N O R S X.
 */
export function indefiniteArticle(word: string): "A" | "An" {
  const first = word.charAt(0);
  if (!first) return "A";
  const initialism = /^[A-Z](?:[A-Z0-9]|$)/.test(word);
  const vowelSound = initialism ? /[AEFHILMNORSX]/.test(first) : /[aeiouAEIOU]/.test(first);
  return vowelSound ? "An" : "A";
}

export function frameSignal(personName: string, source: string | null, impact: number | null, processed: boolean | null): string {
  const what = source ? `${indefiniteArticle(source)} ${source} signal` : "A signal";
  if (processed === false || (processed === null && impact === null)) {
    return `${what} on ${personName} is waiting for the Engine's next read.`;
  }
  if (impact === null) return `${what} on ${personName} has been read.`;
  if (Math.abs(impact) < 0.05) return `${what} on ${personName} read as neutral.`;
  return `${what} on ${personName} read ${formatSigned(impact, 1)}.`;
}

export function toFeedEntry(row: FeedRow): FeedEntry | null {
  const kind: FeedEntryKind | null = row.kind === "narrative" ? "narrative" : row.kind === "signal" ? "signal" : null;
  if (!kind || !row.id || !row.person_id || !row.occurred_at) return null;

  const evidence = toEvidence(row.evidence);
  const sources = [...new Set((row.sources ?? []).map(shortSource).filter((name): name is string => name !== null))];
  const impact = toNullableNumber(row.impact);
  const person: FeedPerson = {
    id: row.person_id,
    slug: row.person_slug,
    name: row.person_name,
    category: row.person_category,
    avatarUrl: row.person_avatar ?? null,
  };

  if (kind === "signal") {
    const own = evidence[0];
    const processed = own?.processed ?? null;
    return {
      id: row.id,
      kind,
      person,
      text: frameSignal(person.name, sources[0] ?? null, impact, processed),
      quote: row.text,
      impact,
      direction: directionOf(impact, 0),
      scoreBefore: null,
      scoreAfter: null,
      tickNumber: null,
      occurredAt: row.occurred_at,
      sources,
      evidence,
    };
  }

  return {
    id: row.id,
    kind,
    person,
    text: row.text,
    quote: null,
    impact,
    direction: directionOf(impact, 0),
    scoreBefore: toNullableNumber(row.score_before),
    scoreAfter: toNullableNumber(row.score_after),
    tickNumber: toNullableNumber(row.tick_number),
    occurredAt: row.occurred_at,
    sources,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export interface FeedCursor {
  before: string;
  beforeId: string;
}

export interface FeedPage {
  entries: FeedEntry[];
  /** Where the next page starts, or null when this was the last one. */
  nextCursor: FeedCursor | null;
}

export function cursorAfter(entries: FeedEntry[], pageSize: number): FeedCursor | null {
  if (entries.length < pageSize) return null;
  const last = entries[entries.length - 1];
  return { before: last.occurredAt, beforeId: last.id };
}

/** Appends a page, dropping anything already loaded and never growing past the cap. */
export function mergeEntries(existing: FeedEntry[], incoming: FeedEntry[], cap = FEED_MAX_ENTRIES): FeedEntry[] {
  const seen = new Set(existing.map((entry) => entry.id));
  const merged = existing.slice();
  for (const entry of incoming) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function filterEntries(entries: FeedEntry[], category: string): FeedEntry[] {
  return category === "all" ? entries : entries.filter((entry) => entry.person.category === category);
}

/**
 * The entries that earn the pinned treatment: a recorded impact at or beyond
 * HIGH_IMPACT_THRESHOLD, within the last PINNED_WINDOW_HOURS, strongest
 * first, at most PINNED_MAX. Empty means the section is absent.
 */
export function selectPinned(entries: FeedEntry[], now: number): FeedEntry[] {
  const since = now - PINNED_WINDOW_HOURS * 60 * 60 * 1000;
  return entries
    .filter((entry) => entry.impact !== null && Math.abs(entry.impact) >= HIGH_IMPACT_THRESHOLD && Date.parse(entry.occurredAt) >= since)
    .sort((a, b) => Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0) || b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, PINNED_MAX);
}

/** Filter options for the Feed: the same as Home's, from the people table. */
export function feedCategoryOptions(people: Array<{ category: string }>): CategoryOption[] {
  return categoryOptions(people);
}

export { categoryLabel };
