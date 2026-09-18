/**
 * FORECAST — the crowd layer's vocabulary and contracts (Phase 19).
 *
 * A forecast is a statement about TRAJECTORY: "is this person's momentum
 * rising or falling?" It is never a rating of the person, which is the
 * failure the whole design exists to avoid. So the vote is ▲ Rising / ▼
 * Falling — not bullish / bearish (too financial), not up / down votes
 * (reads as approval). Every vote carries one reason tag.
 *
 * THE ONE HARD RULE OF THIS PHASE: votes influence NOTHING. The Forecast
 * force exists in the Engine's config at weight 0.00 and nowhere else; no
 * vote reaches a score, a force, the drifting target, memory or a narrative.
 * lib/engine/forecast.test.ts pins the weight and proves a tick with votes
 * present scores identically to a tick without.
 *
 * This module is isomorphic (the vote buttons import it in the browser):
 * keep it free of server-only imports.
 */

/** The section's name, and the force's. Locked. */
export const FORECAST_SECTION_TITLE = "Forecast";

export const FORECAST_DIRECTIONS = ["rising", "falling"] as const;
export type ForecastDirection = (typeof FORECAST_DIRECTIONS)[number];

/** What the interface says for each direction. Locked. */
export const DIRECTION_LABELS: Record<ForecastDirection, { glyph: string; word: string; label: string }> = {
  rising: { glyph: "▲", word: "Rising", label: "▲ Rising" },
  falling: { glyph: "▼", word: "Falling", label: "▼ Falling" },
};

/** The seven reason tags, in the order the picker shows them. Locked. */
export const FORECAST_REASONS = ["professional", "social", "financial", "cultural", "performance", "media", "other"] as const;
export type ForecastReason = (typeof FORECAST_REASONS)[number];

export const REASON_LABELS: Record<ForecastReason, string> = {
  professional: "Professional",
  social: "Social",
  financial: "Financial",
  cultural: "Cultural",
  performance: "Performance",
  media: "Media",
  other: "Other",
};

/**
 * Distinct people one user may forecast in any trailing hour. Mirrors
 * forecast_rate_limit_per_hour() in the database, which is what actually
 * enforces it; lib/forecast/forecast.db.test.ts fails if the two disagree.
 */
export const FORECAST_RATE_LIMIT_PER_HOUR = 20;

/**
 * Active votes a person needs before the Rising / Falling split is shown.
 * Mirrors forecast_min_votes() in the database, which is what actually gates
 * the aggregate; below it only the total is ever returned.
 */
export const FORECAST_MIN_VOTES = 5;

export function isForecastDirection(value: unknown): value is ForecastDirection {
  return typeof value === "string" && (FORECAST_DIRECTIONS as readonly string[]).includes(value);
}

export function isForecastReason(value: unknown): value is ForecastReason {
  return typeof value === "string" && (FORECAST_REASONS as readonly string[]).includes(value);
}

/** The signed-in user's own vote on a person, as cast_forecast_vote() and the select-own policy return it. */
export interface OwnForecastVote {
  id: string;
  personId: string;
  direction: ForecastDirection;
  reason: ForecastReason;
  /** The person's score when the vote was cast: the anchor accuracy is measured from. */
  scoreAtVote: number;
  createdAt: string;
  supersededAt: string | null;
}

export interface ReasonCount {
  reason: ForecastReason;
  count: number;
}

/**
 * The crowd's forecast on a person, aggregates only. `revealed` is false
 * below FORECAST_MIN_VOTES, and then the split and the reasons are null: the
 * database never returns them, so the interface cannot leak them either.
 */
export interface ForecastSummary {
  personId: string;
  total: number;
  minVotes: number;
  revealed: boolean;
  rising: number | null;
  falling: number | null;
  risingReasons: ReasonCount[] | null;
  fallingReasons: ReasonCount[] | null;
}

export type ForecastRejectionCode = "unauthenticated" | "invalid" | "unknown_person" | "paused" | "rate_limited" | "unavailable";

export type CastForecastResult = { ok: true; changed: boolean; vote: OwnForecastVote } | { ok: false; code: ForecastRejectionCode; message: string };

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Reads one of the user's own votes off a database row or the RPC's JSON. Null when the shape is not a vote. */
export function readOwnVote(value: unknown): OwnForecastVote | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  const personId = typeof row.personId === "string" ? row.personId : typeof row.person_id === "string" ? row.person_id : null;
  const direction = row.direction;
  const reason = row.reason;
  const createdAt = typeof row.createdAt === "string" ? row.createdAt : typeof row.created_at === "string" ? row.created_at : null;
  if (!id || !personId || !isForecastDirection(direction) || !isForecastReason(reason) || !createdAt) return null;
  const superseded = row.supersededAt ?? row.superseded_at ?? null;
  return {
    id,
    personId,
    direction,
    reason,
    scoreAtVote: num(row.scoreAtVote ?? row.score_at_vote),
    createdAt,
    supersededAt: typeof superseded === "string" ? superseded : null,
  };
}

function readReasons(value: unknown): ReasonCount[] {
  if (!Array.isArray(value)) return [];
  const out: ReasonCount[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { reason, count } = entry as Record<string, unknown>;
    if (isForecastReason(reason)) out.push({ reason, count: num(count) });
  }
  return out;
}

/** Reads forecast_summary()'s JSON. Anything malformed reads as "no votes yet" rather than as a split. */
export function readForecastSummary(value: unknown, personId: string): ForecastSummary {
  const empty: ForecastSummary = { personId, total: 0, minVotes: FORECAST_MIN_VOTES, revealed: false, rising: null, falling: null, risingReasons: null, fallingReasons: null };
  if (typeof value !== "object" || value === null) return empty;
  const row = value as Record<string, unknown>;
  const total = Math.max(0, Math.round(num(row.total)));
  const minVotes = Math.max(1, Math.round(num(row.minVotes))) || FORECAST_MIN_VOTES;
  const revealed = row.revealed === true && total >= minVotes;
  if (!revealed) return { ...empty, total, minVotes };
  return {
    personId,
    total,
    minVotes,
    revealed: true,
    rising: Math.max(0, Math.round(num(row.rising))),
    falling: Math.max(0, Math.round(num(row.falling))),
    risingReasons: readReasons(row.risingReasons),
    fallingReasons: readReasons(row.fallingReasons),
  };
}

/** Reads cast_forecast_vote()'s JSON into a result the sheet can act on. */
export function readCastResult(value: unknown): CastForecastResult {
  if (typeof value !== "object" || value === null) return { ok: false, code: "unavailable", message: "The forecast could not be recorded." };
  const row = value as Record<string, unknown>;
  if (row.ok === true) {
    const vote = readOwnVote(row.vote);
    if (vote) return { ok: true, changed: row.changed === true, vote };
    return { ok: false, code: "unavailable", message: "The forecast could not be recorded." };
  }
  const code = typeof row.code === "string" ? row.code : "unavailable";
  const known: ForecastRejectionCode[] = ["unauthenticated", "invalid", "unknown_person", "paused", "rate_limited", "unavailable"];
  return {
    ok: false,
    code: (known as string[]).includes(code) ? (code as ForecastRejectionCode) : "unavailable",
    message: typeof row.message === "string" && row.message ? row.message : "The forecast could not be recorded.",
  };
}

/** Whole-number percentages that sum to 100 when both sides are present. */
export function splitPercent(rising: number, falling: number): { rising: number; falling: number } {
  const total = rising + falling;
  if (total <= 0) return { rising: 0, falling: 0 };
  const risingPct = Math.round((rising / total) * 100);
  return { rising: risingPct, falling: 100 - risingPct };
}
