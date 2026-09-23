import { LIVE_TICK_MS } from "@/lib/person/live-series";
import { FORCE_KEYS, isForceKey, periodChange, type ForceKey, type SeriesPoint } from "@/lib/person/profile-model";

/**
 * The landing page's model: what the public endpoint says about the featured
 * person, and nothing else.
 *
 * ONE PERSON, BY CONSTANT. The endpoint takes no parameter that could name
 * anyone: the slug is written here, in code, and the server read looks up
 * that slug and no other. Whatever a caller appends to the URL is ignored.
 * lib/landing/model.test.ts checks that the payload carries only the fields
 * listed in FeaturedPayload — no ids, no user, no trade, no position.
 *
 * Isomorphic: the page reads the payload server-side, the browser re-reads
 * it on the Engine's cadence, and both go through parseFeaturedPayload so
 * a stray field can never reach the screen from either side.
 */

export const FEATURED_SLUG = "anthony-baptiste";

/** The history the page draws: the last day, in ten-minute slices. */
export const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HISTORY_POINTS = 144;

/** How many recent signals the page shows. */
export const FEATURED_SIGNAL_LIMIT = 6;

/**
 * When the last tick is older than this, the page says "Last known" with
 * the time rather than "Live": three cadences is one missed tick plus the
 * slack of the tick that follows it.
 */
export const STALE_AFTER_MS = 3 * LIVE_TICK_MS;

export interface FeaturedSignal {
  source: string;
  headline: string;
  occurredAt: string;
  impact: number | null;
}

export interface FeaturedForce {
  key: ForceKey;
  /** Points over the window; null when the Engine has never ticked this person. */
  impact: number | null;
}

export interface FeaturedHistoryPoint {
  at: string;
  score: number;
}

export interface FeaturedPayload {
  /** Where the score is right now. */
  score: number;
  tickNumber: number | null;
  lastTickAt: string | null;
  /** Last tick minus the first tick of each window, in points; null with fewer than two ticks. */
  change: { h1: number | null; h24: number | null; d7: number | null };
  history: FeaturedHistoryPoint[];
  forces: FeaturedForce[];
  /** The window the forces were summed over, in minutes. */
  windowMinutes: number;
  signals: FeaturedSignal[];
  generatedAt: string;
}

/** The change over a range, as the profile's change line computes it. */
export function changeOver(series: SeriesPoint[]): number | null {
  return periodChange(series)?.change ?? null;
}

/** Which 30-second slot `now` falls in: the key the server memoises a read under. */
export function tickSlot(nowMs: number, cadenceMs: number = LIVE_TICK_MS): number {
  return Math.floor(nowMs / cadenceMs);
}

/** True when the value on screen should be labelled "Last known" rather than "Live". */
export function isStale(lastTickAt: string | null, nowMs: number, staleAfterMs: number = STALE_AFTER_MS): boolean {
  if (!lastTickAt) return true;
  const at = Date.parse(lastTickAt);
  return !Number.isFinite(at) || nowMs - at > staleAfterMs;
}

// ---------------------------------------------------------------------------
// Parsing: the allowlist, applied on both sides of the wire
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown, max = 512): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function time(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Reads a payload strictly: every field listed, no field kept that is not.
 * Null for anything that is not a payload, including one with no score —
 * a page with no number shows no number.
 */
export function parseFeaturedPayload(value: unknown): FeaturedPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const score = num(record.score);
  if (score === null) return null;

  const change = typeof record.change === "object" && record.change !== null ? (record.change as Record<string, unknown>) : {};
  const history = Array.isArray(record.history)
    ? record.history
        .map((point) => {
          if (typeof point !== "object" || point === null) return null;
          const p = point as Record<string, unknown>;
          const at = time(p.at);
          const s = num(p.score);
          return at && s !== null ? { at, score: s } : null;
        })
        .filter((point): point is FeaturedHistoryPoint => point !== null)
    : [];
  const forces = Array.isArray(record.forces)
    ? record.forces
        .map((force) => {
          if (typeof force !== "object" || force === null) return null;
          const f = force as Record<string, unknown>;
          return isForceKey(f.key) ? { key: f.key, impact: num(f.impact) } : null;
        })
        .filter((force): force is FeaturedForce => force !== null)
    : [];
  const signals = Array.isArray(record.signals)
    ? record.signals
        .map((signal) => {
          if (typeof signal !== "object" || signal === null) return null;
          const s = signal as Record<string, unknown>;
          const headline = text(s.headline, 300);
          const occurredAt = time(s.occurredAt);
          return headline && occurredAt ? { source: text(s.source, 80) ?? "Unknown source", headline, occurredAt, impact: num(s.impact) } : null;
        })
        .filter((signal): signal is FeaturedSignal => signal !== null)
        .slice(0, FEATURED_SIGNAL_LIMIT)
    : [];

  return {
    score,
    tickNumber: num(record.tickNumber),
    lastTickAt: time(record.lastTickAt),
    change: { h1: num(change.h1), h24: num(change.h24), d7: num(change.d7) },
    history,
    // Every force, in the canonical order, whatever order or subset arrived.
    forces: FORCE_KEYS.map((key) => forces.find((force) => force.key === key) ?? { key, impact: null }),
    windowMinutes: num(record.windowMinutes) ?? 60,
    signals,
    generatedAt: time(record.generatedAt) ?? new Date(0).toISOString(),
  };
}

/** The keys a payload may carry, for the test that proves nothing else leaks. */
export const FEATURED_PAYLOAD_KEYS = ["score", "tickNumber", "lastTickAt", "change", "history", "forces", "windowMinutes", "signals", "generatedAt"] as const;
