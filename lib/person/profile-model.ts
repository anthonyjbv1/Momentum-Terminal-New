import { detailForPayload, sentenceForPayload, type MetricDetailLine } from "@/lib/signals/metric-language";
import { directionAtPrecision, directionOf, type Direction } from "@/components/ui/direction-indicator";

/** Decimals a force's contribution is shown to, everywhere it is shown. Its colour follows the same rounding. */
export const FORCE_IMPACT_DECIMALS = 2;
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

export type SubjectTier = "public_figure" | "private_individual";
export type TradingMode = "tradeable" | "display_only" | "paused";

export interface ProfilePerson {
  id: string;
  slug: string;
  displayName: string;
  category: string;
  avatarUrl: string | null;
  score: number;
  /** The Gravity force's target as the Engine last used it: the seed plus the drifting target's offset (Phase 14). Where the score settles with nothing happening. */
  revertTarget: number;
  spread: number;
  /** The market price's Buy side: score + premium + spread (Phase 29). */
  buyPrice: number | null;
  /** The market price's Sell side: score + premium − spread. */
  sellPrice: number | null;
  /**
   * THE PREMIUM (Phase 29), in cents per share: how far the market price sits
   * from the data. 0 means the market price is the score.
   */
  premiumCents: number;
  /** score + premium, in points. */
  marketPrice: number;
  /** The dealer's inventory in units, and the depth the cost curve runs on (null: a flat market). */
  inventoryUnits: number;
  depthUnits: number | null;
  premiumCapCents: number | null;
  tier: SubjectTier;
  tradingMode: TradingMode;
  /** While in the future, every order is refused. */
  haltedUntil: string | null;
  haltReason: string | null;
  /** The allocation cap Conviction's concentration is read against, in cents. 0 when the row did not carry it. */
  maxAllocationCents: number;
  /** When the person entered the board. */
  createdAt: string;
  lastTickAt: string | null;
  /** Phase 19: the per-person kill switch on the crowd layer. True hides the Forecast section and refuses new votes. */
  forecastPaused: boolean;
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
  /** The drifting target's offset (Phase 14); absent or null reads as 0, the seed alone. */
  target_offset?: number | string | null;
  spread: number | string;
  buy_price: number | string | null;
  sell_price: number | string | null;
  /** Phase 29; absent (an older row shape) reads as a flat market at the score. */
  premium_cents?: number | string | null;
  market_price?: number | string | null;
  market_inventory_units?: number | string | null;
  tier?: string | null;
  trading_mode?: string | null;
  halted_until?: string | null;
  halt_reason?: string | null;
  /** The effective market parameters, joined by the reader; absent reads as a flat market. */
  depth_units?: number | string | null;
  premium_cap_cents?: number | string | null;
  max_allocation_cents?: number | string | null;
  created_at: string;
  last_tick_at: string | null;
  /** Phase 19; absent reads as not paused. */
  forecast_paused?: boolean | null;
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
  const score = toNumber(row.current_score);
  const premiumCents = Math.trunc(toNumber(row.premium_cents));
  const haltedUntil = typeof row.halted_until === "string" ? row.halted_until : null;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    category: row.category,
    avatarUrl: row.avatar_url,
    score,
    revertTarget: toNumber(row.revert_target) + toNumber(row.target_offset),
    spread: toNumber(row.spread),
    buyPrice: toNullableNumber(row.buy_price),
    sellPrice: toNullableNumber(row.sell_price),
    premiumCents,
    marketPrice: toNullableNumber(row.market_price) ?? score + premiumCents / 100,
    inventoryUnits: Math.trunc(toNumber(row.market_inventory_units)),
    depthUnits: toNullableNumber(row.depth_units) === null ? null : Math.trunc(toNumber(row.depth_units)),
    premiumCapCents: toNullableNumber(row.premium_cap_cents) === null ? null : Math.trunc(toNumber(row.premium_cap_cents)),
    tier: row.tier === "private_individual" ? "private_individual" : "public_figure",
    tradingMode: row.trading_mode === "display_only" || row.trading_mode === "paused" ? row.trading_mode : "tradeable",
    haltedUntil,
    haltReason: haltedUntil && typeof row.halt_reason === "string" ? row.halt_reason : null,
    maxAllocationCents: Math.max(0, Math.trunc(toNumber(row.max_allocation_cents))),
    createdAt: row.created_at,
    lastTickAt: row.last_tick_at,
    forecastPaused: row.forecast_paused === true,
  };
}

/**
 * THE MARKET LINE under the score (Phase 29): "Market $66.00 · +4.0 above the
 * data" / "in line with the data" / "−2.1 below the data". The premium is
 * spoken at one decimal, so anything under 0.05 of a point reads as in line.
 */
export function marketLine(person: Pick<ProfilePerson, "premiumCents">): { relation: "above" | "below" | "in_line"; points: number; text: string } {
  const points = Math.round(Math.abs(person.premiumCents) / 10) / 10;
  if (points === 0) return { relation: "in_line", points: 0, text: "in line with the data" };
  const figure = points.toFixed(1);
  return person.premiumCents > 0 ? { relation: "above", points, text: `+${figure} above the data` } : { relation: "below", points, text: `−${figure} below the data` };
}

/**
 * Whether the person can be traded right now, and the sentence to show when
 * not. A halt outranks the mode: a display-only person can still be closed
 * out of, but not while halted.
 */
export type TradingAvailability =
  | { state: "tradeable" }
  | { state: "halted"; until: string; reason: string | null }
  | { state: "display_only" }
  | { state: "paused" };

export function tradingAvailability(person: Pick<ProfilePerson, "tradingMode" | "haltedUntil" | "haltReason">, now: number): TradingAvailability {
  if (person.haltedUntil && Date.parse(person.haltedUntil) > now) return { state: "halted", until: person.haltedUntil, reason: person.haltReason };
  if (person.tradingMode === "paused") return { state: "paused" };
  if (person.tradingMode === "display_only") return { state: "display_only" };
  return { state: "tradeable" };
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
  /**
   * THE MARKET PRICE at the slice's last tick (Phase 29): the score plus the
   * premium as it stood then. Absent on a series that carries no market line
   * (the portfolio's value series, a row from before Phase 29).
   */
  market?: number;
  /** The market price at the slice's first tick. */
  marketOpen?: number;
}

export type SeriesByRange = Record<RangeKey, SeriesPoint[]>;

/** A row of person_score_series() / person_market_series() as the database returns it. */
export interface SeriesRow {
  bucket_at: string;
  score: number | string;
  open: number | string | null;
  samples: number | string;
  market?: number | string | null;
  market_open?: number | string | null;
}

export function toSeries(rows: SeriesRow[]): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    const score = toNullableNumber(row.score);
    if (score === null || !row.bucket_at) continue;
    const market = toNullableNumber(row.market);
    const point: SeriesPoint = {
      at: row.bucket_at,
      score,
      open: toNullableNumber(row.open) ?? score,
      samples: Math.max(1, Math.round(toNumber(row.samples, 1))),
    };
    if (market !== null) {
      point.market = market;
      point.marketOpen = toNullableNumber(row.market_open) ?? market;
    }
    points.push(point);
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

/**
 * What each force does. Since Phase 29 two of the five move the MARKET PRICE
 * rather than the score: Conviction and Trading Activity read participant
 * activity, and nothing derived from participant activity may feed the index.
 */
export type ForceRole = "score" | "market";

export const FORCE_DEFINITIONS: Record<ForceKey, { label: string; description: string; role: ForceRole }> = {
  gravity: { label: "Gravity", description: "Drift toward the gravity target", role: "score" },
  signals: { label: "Signals", description: "News and data about the person", role: "score" },
  market_mood: { label: "Market Mood", description: "The tide across the whole board", role: "score" },
  conviction: { label: "Conviction", description: "Capital committed · moves the market price", role: "market" },
  trading_activity: { label: "Trading Activity", description: "Buy and Sell flow · moves the market price", role: "market" },
};

/**
 * The forces that move the MOMENTUM SCORE: Gravity, Signals, Market Mood.
 * Anything that explains why the score moved (the landing's "why it moved")
 * reads these and only these; the market forces move the market price.
 */
export const SCORE_FORCE_KEYS = ["gravity", "signals", "market_mood"] as const satisfies readonly ForceKey[];
export type ScoreForceKey = (typeof SCORE_FORCE_KEYS)[number];

export function isScoreForceKey(value: unknown): value is ScoreForceKey {
  return typeof value === "string" && (SCORE_FORCE_KEYS as readonly string[]).includes(value);
}

export function isForceKey(value: unknown): value is ForceKey {
  return typeof value === "string" && (FORCE_KEYS as readonly string[]).includes(value);
}

/**
 * THE SPAN THE FORCES PANEL ADDS UP, in minutes. TUNABLE, and a DISPLAY
 * window only — no force's weight or behaviour depends on it.
 *
 * 60, from Phase 21. The panel showed each force's contribution on the LATEST
 * TICK, and at two decimals that figure says nothing: the Engine ticks twice a
 * minute, so Gravity's per-tick contribution averages 0.005 points — which
 * flickers between 0.00 and the rounding grain — and Market Mood's averages
 * 0.0006, which is 0.00 forever. Over an hour the same three forces read
 * −0.60, −0.07 and +0.53 (MrBeast, 2026-09-19): the same arithmetic, summed
 * rather than sampled, at a size a person can see.
 *
 * An hour because it is the span Market Mood itself is measured over
 * (ENGINE_MOOD_WINDOW_MINUTES, also 60), so the panel's Market Mood row and
 * the banner's Mood indicator describe the same hour. Shorter and Gravity
 * disappears again; longer and the panel stops describing now.
 */
export const FORCES_WINDOW_MINUTES = 60;

/**
 * The window in words. The panel's caption is built from this rather than
 * writing "hour" down, so the number and the words cannot come apart when the
 * constant changes.
 */
export function forcesWindowLabel(minutes: number): string {
  if (minutes === 60) return "hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** A score_events row as the database returns it. */
export interface ScoreEventRow {
  force: string;
  impact: number | string;
  tick_number: number | string;
  details: unknown;
}

/** The narrow read behind the panel's figures: force and impact, for every tick in the window. */
export interface ForceImpactRow {
  force: string;
  impact: number | string;
}

export interface ForceReading {
  key: ForceKey;
  label: string;
  description: string;
  /** Whether the force moves the score or the market price (Phase 29). */
  role: ForceRole;
  /**
   * Points this force added to the score over the last FORCES_WINDOW_MINUTES:
   * the sum of its per-tick contributions, which is exactly what it moved the
   * score by. 0 when the Engine ticked and the force did nothing (it writes no
   * row for zero impact); null when it has never ticked this person. For a
   * MARKET force it is always 0 once the Engine has ticked: it adds nothing to
   * the score by construction, and the panel shows its market reading instead.
   */
  impact: number | null;
  direction: Direction;
  /**
   * The Engine's working for the force on the LATEST tick, when it recorded
   * any — a state reading (Conviction's capital concentration), not something
   * that accumulates over the window the way `impact` does.
   */
  details: Record<string, unknown> | null;
}

function toDetails(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The five forces over the display window: `window` is every score_events row
 * inside it, summed per force, and `latest` is the latest tick's rows, read
 * only for the working each force recorded there.
 *
 * `latestTickNumber` comes from score_history and is the idle sentinel: null
 * means the Engine has never ticked this person and every force reads Idle
 * rather than zero. A force that fired last week but not in this window
 * correctly reads 0, not stale.
 */
export function readForces(window: ForceImpactRow[], latest: ScoreEventRow[], latestTickNumber: number | null): ForceReading[] {
  const summed = new Map<ForceKey, number>();
  const details = new Map<ForceKey, Record<string, unknown>>();
  if (latestTickNumber !== null) {
    for (const row of window) {
      if (!isForceKey(row.force)) continue;
      const impact = toNullableNumber(row.impact);
      if (impact === null) continue;
      summed.set(row.force, (summed.get(row.force) ?? 0) + impact);
    }
    for (const event of latest) {
      if (toNumber(event.tick_number, -1) !== latestTickNumber || !isForceKey(event.force) || details.has(event.force)) continue;
      const working = toDetails(event.details);
      if (working) details.set(event.force, working);
    }
  }

  return FORCE_KEYS.map((key) => {
    const impact = latestTickNumber === null ? null : (summed.get(key) ?? 0);
    return {
      key,
      label: FORCE_DEFINITIONS[key].label,
      description: FORCE_DEFINITIONS[key].description,
      role: FORCE_DEFINITIONS[key].role,
      impact,
      // Coloured by the figure the panel shows, not by the sign underneath:
      // Gravity's pull toward a target just above the score is a small
      // negative that reads 0.00 at two decimals, and a 0.00 in red says
      // "falling" where the number says "nothing happened" (Phase 19+).
      direction: directionAtPrecision(impact, FORCE_IMPACT_DECIMALS, 0),
      details: details.get(key) ?? null,
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

/** The same bands, from the concentration itself: what the profile reads since the force stopped writing score_events (Phase 29). */
export function convictionLevelFromConcentration(concentration: number | null): ConvictionLevel | null {
  if (concentration === null || !Number.isFinite(concentration)) return null;
  if (concentration <= CONVICTION_BANDS.lowUpTo) return "low";
  if (concentration <= CONVICTION_BANDS.moderateUpTo) return "moderate";
  return "high";
}

export const convictionLabels: Record<ConvictionLevel, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

// ---------------------------------------------------------------------------
// THE MARKET READINGS (Phase 29): what the two market forces describe
// ---------------------------------------------------------------------------

/**
 * Conviction and Trading Activity move the MARKET PRICE, not the score, so
 * the forces panel shows what each of them reads rather than a points figure
 * that is zero by construction. Both are participant activity, and both are
 * computed from the same rows the Engine reads: open paper capital on the
 * person over their allocation cap, and the trade tape over the display
 * window.
 */
export interface MarketReadings {
  conviction: {
    /** Open paper capital on the person, in cents. */
    openCapitalCents: number;
    maxAllocationCents: number;
    /** openCapital / maxAllocation, or null when the cap is zero. */
    concentration: number | null;
  };
  tradingActivity: {
    /** Buy cents minus Sell cents over the window. */
    netFlowCents: number;
    trades: number;
    windowMinutes: number;
  };
}

export function emptyMarketReadings(): MarketReadings {
  return {
    conviction: { openCapitalCents: 0, maxAllocationCents: 0, concentration: null },
    tradingActivity: { netFlowCents: 0, trades: 0, windowMinutes: FORCES_WINDOW_MINUTES },
  };
}

/** A trade_events row as the profile reads it. */
export interface TradeEventRow {
  side: string;
  amount_cents: number | string;
}

export function readMarketReadings(openCapitalCents: number, maxAllocationCents: number, trades: TradeEventRow[], windowMinutes = FORCES_WINDOW_MINUTES): MarketReadings {
  let netFlow = 0;
  for (const trade of trades) {
    const amount = toNumber(trade.amount_cents);
    netFlow += trade.side === "SELL" ? -amount : amount;
  }
  return {
    conviction: {
      openCapitalCents,
      maxAllocationCents,
      concentration: maxAllocationCents > 0 ? openCapitalCents / maxAllocationCents : null,
    },
    tradingActivity: { netFlowCents: netFlow, trades: trades.length, windowMinutes },
  };
}

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
  /**
   * For a METRIC signal, the lines the expand shows: what was observed, the
   * person's own pace, how they compare, and the window and sample behind it
   * (Phase 21+). Empty for everything else.
   */
  detail: MetricDetailLine[];
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
  /** The signal's payload. For a METRIC it is what the headline and the expand are rendered from (Phase 21+). */
  raw_payload?: unknown;
}

export interface NarrativeRow {
  id: string;
  text: string;
  created_at: string;
  score_before: number | string;
  score_after: number | string;
}

export const ENGINE_SOURCE_LABEL = "The Engine";

/**
 * `personName` renders a metric signal's headline and its expand from the
 * PAYLOAD rather than from the stored string, exactly as the Feed does — so a
 * signal stored in sigma reads as plain language here too. Absent (a caller
 * that has no person to hand), stored headlines are shown as they are.
 */
export function mergeSignals(signals: SignalRow[], narratives: NarrativeRow[], limit = 30, personName?: string): ProfileSignal[] {
  const items: ProfileSignal[] = [
    ...signals.map((row) => ({
      id: `signal:${row.id}`,
      kind: "signal" as const,
      source: row.data_sources?.display_name ?? "Unknown source",
      headline: (personName ? sentenceForPayload(row.raw_payload, personName, row.occurred_at) : null) ?? row.headline,
      detail: personName ? detailForPayload(row.raw_payload, personName) : [],
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
        detail: [],
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
  /** What the two market forces read right now (Phase 29). */
  market: MarketReadings;
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
