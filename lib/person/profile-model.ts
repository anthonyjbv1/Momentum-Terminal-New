import { directionOf, type Direction } from "@/components/ui/direction-indicator";
import { categoryLabel } from "@/lib/home/board-model";

/**
 * The person profile's shape and the pure logic that produces it: chart
 * ranges, period change, the dossier STATE and CONVICTION readings, the five
 * forces, and the merged signal list. No I/O here, so every rule is testable
 * on its own and safe to import from either side of the server boundary.
 *
 * Nothing in this module invents data. Every reading is derived from rows the
 * Engine actually wrote, and every "not enough to say" case is a null or a
 * "stable" that the UI presents as such.
 */

export { categoryLabel };

// ---------------------------------------------------------------------------
// The person
// ---------------------------------------------------------------------------

export interface ProfilePerson {
  id: string;
  slug: string;
  displayName: string;
  category: string;
  avatarUrl: string | null;
  score: number;
  /** The Gravity force's target: where the score drifts with nothing happening. */
  revertTarget: number;
  spread: number;
  buyPrice: number | null;
  sellPrice: number | null;
  /** When the person entered the board. */
  createdAt: string;
  lastTickAt: string | null;
}

/** The people row as it comes back from the database. */
export interface ProfilePersonRow {
  id: string;
  slug: string;
  display_name: string;
  category: string;
  avatar_url: string | null;
  current_score: number | string;
  revert_target: number | string;
  spread: number | string;
  buy_price: number | string | null;
  sell_price: number | string | null;
  created_at: string;
  last_tick_at: string | null;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toProfilePerson(row: ProfilePersonRow): ProfilePerson {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    category: row.category,
    avatarUrl: row.avatar_url,
    score: toNumber(row.current_score),
    revertTarget: toNumber(row.revert_target),
    spread: toNumber(row.spread),
    buyPrice: toNullableNumber(row.buy_price),
    sellPrice: toNullableNumber(row.sell_price),
    createdAt: row.created_at,
    lastTickAt: row.last_tick_at,
  };
}

/** Slugs are lowercase words joined by hyphens; anything else is a 404 before it reaches the database. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return slug.length <= 80 && SLUG_PATTERN.test(slug);
}

// ---------------------------------------------------------------------------
// Chart ranges and series
// ---------------------------------------------------------------------------

export type RangeKey = "1h" | "24h" | "7d" | "all";

export interface RangeDefinition {
  key: RangeKey;
  label: string;
  /** Window length in milliseconds; null means everything since the first tick. */
  windowMs: number | null;
  /** How many time slices the database downsamples the window into. */
  points: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The ranges the chart offers, in display order. */
export const RANGES: readonly RangeDefinition[] = [
  { key: "1h", label: "1H", windowMs: HOUR, points: 120 }, // one slice per 30-second tick
  { key: "24h", label: "24H", windowMs: DAY, points: 144 }, // ten-minute slices
  { key: "7d", label: "7D", windowMs: 7 * DAY, points: 168 }, // hourly slices
  { key: "all", label: "ALL", windowMs: null, points: 160 },
];

export const RANGE_KEYS = RANGES.map((range) => range.key) as readonly RangeKey[];

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

/** One downsampled slice of score history. `at` is the time of the slice's last tick. */
export interface SeriesPoint {
  at: string;
  /** Score at the slice's last tick. */
  score: number;
  /** Score at the slice's first tick. */
  open: number;
  /** How many ticks the slice holds. */
  samples: number;
}

export type SeriesByRange = Record<RangeKey, SeriesPoint[]>;

/** A row of person_score_series() as the database returns it. */
export interface SeriesRow {
  bucket_at: string;
  score: number | string;
  open: number | string | null;
  samples: number | string;
}

export function toSeries(rows: SeriesRow[]): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    const score = toNullableNumber(row.score);
    if (score === null || !row.bucket_at) continue;
    points.push({
      at: row.bucket_at,
      score,
      open: toNullableNumber(row.open) ?? score,
      samples: Math.max(1, Math.round(toNumber(row.samples, 1))),
    });
  }
  return points.sort((a, b) => a.at.localeCompare(b.at));
}

export function emptySeries(): SeriesByRange {
  return { "1h": [], "24h": [], "7d": [], all: [] };
}

/** How many ticks a series is built from. */
export function tickCount(series: SeriesPoint[]): number {
  return series.reduce((total, point) => total + point.samples, 0);
}

/** A range can be drawn once it has two distinct points to join. */
export function rangeAvailable(series: SeriesPoint[]): boolean {
  return series.length >= 2;
}

/**
 * The range the chart opens on: the shortest one with a line to draw, so a
 * freshly started Engine shows its last hour at full resolution rather than a
 * three-point day. Null when there is nothing to draw at all.
 */
export function defaultRange(series: SeriesByRange): RangeKey | null {
  for (const range of RANGES) {
    if (rangeAvailable(series[range.key])) return range.key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Period change
// ---------------------------------------------------------------------------

export interface PeriodChange {
  /** Points moved from the first tick in the window to the last. */
  change: number;
  /** The same move as a percentage of the opening score; null when the opening score is 0. */
  percent: number | null;
  direction: Direction;
  from: string;
  to: string;
  ticks: number;
}

/**
 * The change over a range: last tick minus first tick, exactly, using each
 * slice's open and close. Needs at least two ticks; one reading is not a
 * change, so it is null rather than 0.
 */
export function periodChange(series: SeriesPoint[]): PeriodChange | null {
  if (series.length === 0) return null;
  const ticks = tickCount(series);
  if (ticks < 2) return null;

  const first = series[0];
  const last = series[series.length - 1];
  const change = last.score - first.open;
  return {
    change,
    percent: first.open !== 0 ? (change / first.open) * 100 : null,
    direction: directionOf(change),
    from: first.at,
    to: last.at,
    ticks,
  };
}

// ---------------------------------------------------------------------------
// STATE — the one accent-coloured value in the dossier
// ---------------------------------------------------------------------------

export type MarketState = "heating" | "cooling" | "stable";

/**
 * THE STATE THRESHOLD. A person is HEATING or COOLING only when, over the
 * trailing 24 hours of score_history, (a) the Engine has recorded at least
 * `minTicks` ticks for them and (b) the score has moved by at least
 * `threshold` points from the first of those ticks to the last. Anything
 * else — including no history at all — is STABLE. The rule is deliberately
 * strict: a person the Engine has not touched reads as stable, not as
 * mysteriously quiet.
 */
export const STATE_RULE = {
  /** Which range the reading is taken over. */
  range: "24h" as RangeKey,
  /** Fewer recorded ticks than this in the window and the reading is STABLE regardless of movement. */
  minTicks: 10,
  /** Absolute score change, in points, at or beyond which the state is HEATING (up) or COOLING (down). */
  threshold: 1.0,
} as const;

export interface StateReading {
  state: MarketState;
  /** The 24-hour change the reading is based on; null when fewer than two ticks exist. */
  change: number | null;
  /** Ticks recorded in the window. */
  ticks: number;
  /** True when the window held enough ticks for the threshold to apply. */
  qualified: boolean;
}

export function deriveState(series24h: SeriesPoint[]): StateReading {
  const period = periodChange(series24h);
  const ticks = tickCount(series24h);
  const qualified = ticks >= STATE_RULE.minTicks && period !== null;

  if (!qualified || period === null) {
    return { state: "stable", change: period?.change ?? null, ticks, qualified: false };
  }
  if (period.change >= STATE_RULE.threshold) return { state: "heating", change: period.change, ticks, qualified };
  if (period.change <= -STATE_RULE.threshold) return { state: "cooling", change: period.change, ticks, qualified };
  return { state: "stable", change: period.change, ticks, qualified };
}

export const stateLabels: Record<MarketState, string> = {
  heating: "Heating",
  cooling: "Cooling",
  stable: "Stable",
};

// ---------------------------------------------------------------------------
// The five forces
// ---------------------------------------------------------------------------

export const FORCE_KEYS = ["gravity", "signals", "market_mood", "conviction", "trading_activity"] as const;
export type ForceKey = (typeof FORCE_KEYS)[number];

export const FORCE_DEFINITIONS: Record<ForceKey, { label: string; description: string }> = {
  gravity: { label: "Gravity", description: "Drift toward the gravity target" },
  signals: { label: "Signals", description: "News and data about the person" },
  market_mood: { label: "Market Mood", description: "The tide across the whole board" },
  conviction: { label: "Conviction", description: "How much capital is committed" },
  trading_activity: { label: "Trading Activity", description: "Live Buy and Sell flow" },
};

export function isForceKey(value: unknown): value is ForceKey {
  return typeof value === "string" && (FORCE_KEYS as readonly string[]).includes(value);
}

/** A score_events row as the database returns it. */
export interface ScoreEventRow {
  force: string;
  impact: number | string;
  tick_number: number | string;
  details: unknown;
}

export interface ForceReading {
  key: ForceKey;
  label: string;
  description: string;
  /**
   * Points this force contributed on the person's latest tick. 0 when the tick
   * ran and the force did nothing (the Engine writes no row for zero impact);
   * null when the Engine has never ticked this person.
   */
  impact: number | null;
  direction: Direction;
  /** The Engine's working for the force on that tick, when it recorded any. */
  details: Record<string, unknown> | null;
}

function toDetails(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The five forces as of the person's latest tick. `latestTickNumber` comes
 * from score_history; events from any other tick are ignored, so a force that
 * fired last week but not on the latest tick correctly reads 0, not stale.
 */
export function readForces(events: ScoreEventRow[], latestTickNumber: number | null): ForceReading[] {
  const atLatest = new Map<ForceKey, { impact: number; details: Record<string, unknown> | null }>();
  if (latestTickNumber !== null) {
    for (const event of events) {
      if (toNumber(event.tick_number, -1) !== latestTickNumber || !isForceKey(event.force)) continue;
      const impact = toNullableNumber(event.impact);
      if (impact === null) continue;
      const existing = atLatest.get(event.force);
      // A force writes one row per tick; if two ever appear, sum them.
      atLatest.set(event.force, { impact: (existing?.impact ?? 0) + impact, details: toDetails(event.details) ?? existing?.details ?? null });
    }
  }

  return FORCE_KEYS.map((key) => {
    const entry = atLatest.get(key);
    const impact = latestTickNumber === null ? null : (entry?.impact ?? 0);
    return {
      key,
      label: FORCE_DEFINITIONS[key].label,
      description: FORCE_DEFINITIONS[key].description,
      impact,
      direction: directionOf(impact, 0),
      details: entry?.details ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// CONVICTION — read from the Conviction force
// ---------------------------------------------------------------------------

export type ConvictionLevel = "low" | "moderate" | "high";

/**
 * The Conviction force is a function of capital concentration (open capital
 * on the person over their allocation cap). These bands mirror the Engine's
 * own regimes — DEFAULT_ENGINE_CONFIG.conviction.neutralUpTo and positiveUpTo
 * — and the test suite pins them to those values.
 */
export const CONVICTION_BANDS = {
  /** Concentration at or below this is LOW (the force is 0 and writes no row). */
  lowUpTo: 0.6,
  /** Concentration above lowUpTo and at or below this is MODERATE. */
  moderateUpTo: 0.85,
} as const;

/**
 * LOW / MODERATE / HIGH from the latest Conviction reading. The recorded
 * concentration decides when the Engine wrote it; without one, the sign of
 * the impact does (the force is positive only in the moderate band and
 * negative only above it). Null until the person has been ticked.
 */
export function convictionLevel(force: ForceReading | undefined): ConvictionLevel | null {
  if (!force || force.impact === null) return null;
  const concentration = toNullableNumber(force.details?.concentration);
  if (concentration !== null) {
    if (concentration <= CONVICTION_BANDS.lowUpTo) return "low";
    if (concentration <= CONVICTION_BANDS.moderateUpTo) return "moderate";
    return "high";
  }
  if (force.impact > 0) return "moderate";
  if (force.impact < 0) return "high";
  return "low";
}

export const convictionLabels: Record<ConvictionLevel, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

// ---------------------------------------------------------------------------
// Signals and the Engine's narratives, one list, newest first
// ---------------------------------------------------------------------------

export interface ProfileSignal {
  id: string;
  kind: "signal" | "narrative";
  /** Where it came from: the data source's display name, or "The Engine" for a narrative. */
  source: string;
  headline: string;
  occurredAt: string;
  /** Score impact, when one was recorded: the signal's impact_score, or the narrative's before → after move. */
  impact: number | null;
  sentiment: { label: string; confidence: number | null } | null;
  /** For narratives: the scores either side of the move. */
  scoreBefore: number | null;
  scoreAfter: number | null;
  /** Signals only: whether the Engine has scored it yet. */
  processed: boolean | null;
}

export interface SignalRow {
  id: string;
  headline: string;
  occurred_at: string;
  impact_score: number | string | null;
  sentiment_label: string | null;
  sentiment_confidence: number | string | null;
  processed: boolean | null;
  data_sources: { display_name: string } | null;
}

export interface NarrativeRow {
  id: string;
  text: string;
  created_at: string;
  score_before: number | string;
  score_after: number | string;
}

export const ENGINE_SOURCE_LABEL = "The Engine";

export function mergeSignals(signals: SignalRow[], narratives: NarrativeRow[], limit = 30): ProfileSignal[] {
  const items: ProfileSignal[] = [
    ...signals.map((row) => ({
      id: `signal:${row.id}`,
      kind: "signal" as const,
      source: row.data_sources?.display_name ?? "Unknown source",
      headline: row.headline,
      occurredAt: row.occurred_at,
      impact: toNullableNumber(row.impact_score),
      sentiment: row.sentiment_label ? { label: row.sentiment_label, confidence: toNullableNumber(row.sentiment_confidence) } : null,
      scoreBefore: null,
      scoreAfter: null,
      processed: row.processed ?? null,
    })),
    ...narratives.map((row) => {
      const before = toNumber(row.score_before);
      const after = toNumber(row.score_after);
      return {
        id: `narrative:${row.id}`,
        kind: "narrative" as const,
        source: ENGINE_SOURCE_LABEL,
        headline: row.text,
        occurredAt: row.created_at,
        // Scores carry one decimal; keep the move free of float noise.
        impact: Math.round((after - before) * 1000) / 1000,
        sentiment: null,
        scoreBefore: before,
        scoreAfter: after,
        processed: null,
      };
    }),
  ];
  // Newest first, then id, so items at the same instant keep one order on every load.
  return items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)).slice(0, limit);
}

/** The raw signal id behind a merged item, for the expand_signal event. Null for narratives. */
export function signalIdOf(item: ProfileSignal): string | null {
  return item.kind === "signal" ? item.id.slice("signal:".length) : null;
}

// ---------------------------------------------------------------------------
// The assembled profile
// ---------------------------------------------------------------------------

export interface PersonProfile {
  person: ProfilePerson;
  series: SeriesByRange;
  state: StateReading;
  forces: ForceReading[];
  conviction: ConvictionLevel | null;
  /** The person's newest score_history row, or null before their first tick. */
  latestTick: { tickNumber: number; at: string } | null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const trackedSinceFormatter = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "2026-09-05T20:57:26Z" → "Sep 5, 2026". */
export function formatTrackedSince(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "—" : trackedSinceFormatter.format(time);
}

/** "+1.2", "−0.4", "0.0" — the sign is a real minus, not a hyphen. */
export function formatSigned(value: number, precision = 1): string {
  const fixed = Math.abs(value).toFixed(precision);
  if (value > 0 && Number(fixed) !== 0) return `+${fixed}`;
  if (value < 0 && Number(fixed) !== 0) return `−${fixed}`;
  return fixed;
}

/** 2.345 → "+2.3%", −0.04 → "−0.04%". Small moves keep an extra digit so they do not read as zero. */
export function formatSignedPercent(percent: number): string {
  const digits = Math.abs(percent) < 1 ? 2 : 1;
  return `${formatSigned(percent, digits)}%`;
}
