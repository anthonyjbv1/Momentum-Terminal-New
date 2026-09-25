import { detailForPayload, type MetricDetailLine } from "@/lib/signals/metric-language";
import { directionAtPrecision, type Direction } from "@/components/ui/direction-indicator";
import { categoryLabel, categoryOptions, type CategoryOption } from "@/lib/home/board-model";

import {
  CARD_MOVE_DECIMALS,
  detailSourceLines,
  evidenceSentence,
  narrativeCard,
  showsAsCard,
  signalCard,
  signalDetailLines,
  type CardCopy,
  type CardEvidenceInput,
  type CardSubject,
  type SignalDetail,
} from "./card-copy";

/**
 * The Feed's shape and the pure logic behind it: the entry, the high-impact
 * selection, category filtering, paging and the cursor. No I/O here, so every
 * rule is testable on its own.
 *
 * VOICE (Phase 30). Every word on a card comes from `./card-copy`, shared with
 * the profile, the landing page and the Home rail: the entry carries the
 * rendered `copy` beside the stored `text`. Stored text is never rewritten.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Decimals the Feed shows an entry's impact to (the DirectionIndicator beside
 * it, and the card's line). An entry's direction is read at the same
 * precision, so a move that rounds to zero carries no colour (Phase 19+).
 */
export const FEED_IMPACT_DECIMALS = CARD_MOVE_DECIMALS;

/**
 * THE HIGH-IMPACT THRESHOLD, in score points. An entry whose recorded score
 * impact is at least this far from zero, in either direction, qualifies for
 * the pinned treatment at the top of the Feed.
 *
 * TUNABLE, RETUNED IN PHASE 14 against the first 24-hour Engine run: 45,360
 * score moves, of which none reached the previous 1.25 (the largest was
 * exactly 1.25 once, on a backlog tick), nine cleared 0.5, and the mean
 * move when anything moved at all was 0.28. 0.5 is the Engine's own unit of
 * "notable" (narratives.minAbsChange and memory.notableImpactThreshold are
 * both 0.5), about twice a routine signal's move, and on a day like that
 * one it qualifies roughly ten moves across the covered subjects, of which
 * PINNED_MAX shows the three strongest. The Feed's idea of notable now
 * agrees with the Engine's instead of sitting two and a half times above it.
 */
export const HIGH_IMPACT_THRESHOLD = 0.5;

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
  /** The company behind the person's company-news signals, from their Finnhub mapping; null for everyone else. */
  company: string | null;
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
  /** The data source's display name, as the database returns it. Rendered through card-copy, never shown raw. */
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
  /**
   * The signal's payload when it is a METRIC, else null (Phase 21+). The
   * display layer renders a metric's sentence and its counts from this rather
   * than from `headline`, which is what lets a signal stored in sigma read as
   * plain language without rewriting it.
   */
  payload: unknown;
  /** What the server added (Phase 30): the outlet, the link, the payload kind, a digest's shape. Null when it could not. */
  detail: SignalDetail | null;
}

export interface FeedEntry {
  id: string;
  kind: FeedEntryKind;
  person: FeedPerson;
  /** The stored text: the Engine's sentence, or the signal's headline. Kept for the behavioural log; the card shows `copy`. */
  text: string;
  /** Every word on the card (Phase 30). */
  copy: CardCopy;
  /** Recorded score impact: a narrative's move, or a signal's impact_score. Null when nothing was recorded. */
  impact: number | null;
  direction: Direction;
  scoreBefore: number | null;
  scoreAfter: number | null;
  tickNumber: number | null;
  occurredAt: string;
  /** The data sources behind the entry, display names as stored. */
  sources: string[];
  evidence: FeedEvidence[];
  /** A signal card's detail lines: the source, then a metric's arithmetic. Empty for a narrative. */
  detailLines: MetricDetailLine[];
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

/** What the server read alongside a page (Phase 30): signal detail by signal id, company by person id. */
export interface FeedRowContext {
  details: ReadonlyMap<string, SignalDetail>;
  companies: ReadonlyMap<string, string>;
}

export const EMPTY_CONTEXT: FeedRowContext = { details: new Map(), companies: new Map() };

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "RSS (per-person news feed)" → "RSS". A short handle for a source, for logs and tests; never shown to a reader. */
export function shortSource(name: string | null | undefined): string | null {
  if (!name) return null;
  const short = name.replace(/\s*\(.*\)\s*$/, "").trim();
  return short.length > 0 ? short : null;
}

function toEvidence(value: unknown, details: ReadonlyMap<string, SignalDetail>): FeedEvidence[] {
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
      source: typeof record.source === "string" ? record.source : null,
      impact: toNullableNumber(record.impact),
      occurredAt: typeof record.occurred_at === "string" ? record.occurred_at : "",
      sentiment: typeof record.sentiment === "string" ? record.sentiment : null,
      confidence: toNullableNumber(record.confidence),
      processed: typeof record.processed === "boolean" ? record.processed : null,
      relation,
      person: relation === "inverse_pair" && personName ? { name: personName, slug: personSlug } : null,
      payload: record.payload ?? null,
      detail: details.get(record.id) ?? null,
    });
  }
  return out;
}

export function subjectOf(person: Pick<FeedPerson, "name" | "category" | "company">): CardSubject {
  return { name: person.name, category: person.category, company: person.company };
}

function toEvidenceInput(item: FeedEvidence): CardEvidenceInput {
  return {
    id: item.id,
    headline: item.headline,
    sourceName: item.source,
    impact: item.impact,
    occurredAt: item.occurredAt,
    payload: item.payload,
    detail: item.detail,
    relation: item.relation,
    personName: item.person?.name ?? null,
  };
}

/**
 * A piece of evidence as a reader should meet it: a metric from its payload
 * (Phase 21+), a comment digest from its shape, an article as titled. The
 * paired person's evidence is rendered for them.
 */
export function evidenceHeadline(item: FeedEvidence, subject: CardSubject): string {
  return evidenceSentence(toEvidenceInput(item), subject).headline;
}

/** The detail lines for one piece of evidence: where it came from, then a metric's arithmetic. */
export function evidenceDetailLines(item: FeedEvidence, subject: CardSubject): MetricDetailLine[] {
  const about: CardSubject = item.person ? { name: item.person.name, category: null, company: null } : subject;
  return [...detailSourceLines({ sourceName: item.source, payload: item.payload, detail: item.detail }), ...detailForPayload(item.payload, about.name, { category: about.category, company: about.company })];
}

export function toFeedEntry(row: FeedRow, context: FeedRowContext = EMPTY_CONTEXT): FeedEntry | null {
  const kind: FeedEntryKind | null = row.kind === "narrative" ? "narrative" : row.kind === "signal" ? "signal" : null;
  if (!kind || !row.id || !row.person_id || !row.occurred_at) return null;

  const evidence = toEvidence(row.evidence, context.details);
  const sources = [...new Set((row.sources ?? []).filter((name): name is string => typeof name === "string" && name.length > 0))];
  const impact = toNullableNumber(row.impact);
  const person: FeedPerson = {
    id: row.person_id,
    slug: row.person_slug,
    name: row.person_name,
    category: row.person_category,
    avatarUrl: row.person_avatar ?? null,
    company: context.companies.get(row.person_id) ?? null,
  };
  const subject = subjectOf(person);

  if (kind === "signal") {
    const own = evidence[0];
    const input = {
      subject,
      headline: own?.headline ?? row.text,
      sourceName: own?.source ?? sources[0] ?? null,
      impact,
      processed: own?.processed ?? null,
      sentiment: own?.sentiment ?? null,
      occurredAt: row.occurred_at,
      payload: own?.payload ?? null,
      detail: own?.detail ?? null,
    };
    return {
      id: row.id,
      kind,
      person,
      text: row.text,
      copy: signalCard(input),
      impact,
      direction: directionAtPrecision(impact, FEED_IMPACT_DECIMALS, 0),
      scoreBefore: null,
      scoreAfter: null,
      tickNumber: null,
      occurredAt: row.occurred_at,
      sources,
      evidence,
      detailLines: signalDetailLines(input),
    };
  }

  return {
    id: row.id,
    kind,
    person,
    text: row.text,
    copy: narrativeCard({ subject, text: row.text, impact, evidence: evidence.map(toEvidenceInput) }),
    impact,
    direction: directionAtPrecision(impact, FEED_IMPACT_DECIMALS, 0),
    scoreBefore: toNullableNumber(row.score_before),
    scoreAfter: toNullableNumber(row.score_after),
    tickNumber: toNullableNumber(row.tick_number),
    occurredAt: row.occurred_at,
    sources,
    evidence,
    detailLines: [],
  };
}

/**
 * Whether an entry is a card (Phase 30, rule 6): a narrative always (it is
 * written only for a move of 0.5 or more); a signal only once the Engine has
 * read it and only when its move prints as something other than zero.
 */
export function isCard(entry: FeedEntry): boolean {
  if (entry.kind === "narrative") return true;
  return showsAsCard(entry.impact, entry.evidence[0]?.processed ?? null);
}

/** Every signal id a page's rows refer to, for the server's detail read. */
export function signalIdsOf(rows: FeedRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.evidence)) continue;
    for (const item of row.evidence) {
      if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") ids.push((item as { id: string }).id);
    }
  }
  return ids;
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

/**
 * A page from the database's rows: the cursor is taken from the LAST ROW,
 * before any hiding, so a page that hides half its cards still points at the
 * right place; the entries are the cards that remain.
 */
export function pageFromRows(rows: FeedRow[], limit: number, context: FeedRowContext = EMPTY_CONTEXT): FeedPage {
  const all = rows.map((row) => toFeedEntry(row, context)).filter((entry): entry is FeedEntry => entry !== null);
  const last = rows[rows.length - 1];
  const nextCursor = rows.length >= limit && last && last.occurred_at && last.id ? { before: last.occurred_at, beforeId: last.id } : null;
  return { entries: all.filter(isCard), nextCursor };
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
