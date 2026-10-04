import type { EngineConfig } from "@/lib/engine/config";
import { clamp, round } from "@/lib/engine/math";

/**
 * THE DRIFTING TARGET (Phase 14): the arithmetic behind config.targetDrift,
 * pure so it is unit-tested without a tick.
 *
 * A person's Gravity target is their seed (people.revert_target) plus an
 * offset the Engine moves over weeks from sustained signal evidence:
 *
 *   attention  = EMA over halfLifeHours of |Signals impact| per hour
 *   direction  = EMA over halfLifeHours of  Signals impact  per hour
 *   coverage   = min(attention / scale, 1)
 *   lean       = clamp(direction / scale, −1, 1)
 *   offset     = bound × (coverage × (1 + lean) − 1)
 *   target     = seed + offset
 *
 * THE SCALE (the redesign, 2026-10-04). In "fixed" mode it is
 * fullCoverageImpactPerHour, the global constant Phase 14 shipped. In
 * "relative" mode it is the person's own NORMAL: their mean gross Signals
 * impact per hour over the normal's window, so coverage reads "as covered
 * as this person usually is" and the lean is read against their own
 * loudness. A person with no normal (no evidence in the window) falls back
 * to the fixed constant, and the evaluation says so.
 *
 * THE START (the redesign). The state (attention, direction, offset) lives on
 * the people row and is advanced once per tick from that tick's Signals
 * force. Null state means the drift has never measured the person. At that
 * first tick, with measuredStart on and a normal available, attention and
 * direction are set to the person's measured trailing averages, so the
 * target starts where the evidence puts it; otherwise (measuredStart off, or
 * nothing to measure) the Phase 14 presumption applies: fully covered and
 * balanced, so the target starts at the seed and sinks only as evidence
 * fails to accrue. With the switch off, or for a person not on the
 * allowlist, the tick writes the dormant state and the target is the seed.
 */

export interface TargetDriftState {
  /** Trailing gross Signals impact per hour. Null: never measured. */
  attention: number | null;
  /** Trailing signed Signals impact per hour. Null: never measured. */
  direction: number | null;
  /** The points added to the seed: target = seed + offset. 0 when dormant. */
  offset: number;
}

/** The state of a person the drift is not tracking: nothing accumulated, the target is the seed. */
export const DORMANT_TARGET_DRIFT: TargetDriftState = { attention: null, direction: null, offset: 0 };

/**
 * A person's measured normal: their trailing averages of Signals impact per
 * hour over the normal's window, from the Signals force's own audit rows.
 * `events` is how many rows went into it; zero means no evidence at all.
 */
export interface DriftNormal {
  /** Mean gross (|impact|) Signals impact per hour over the window. */
  grossPerHour: number;
  /** Mean signed Signals impact per hour over the window. */
  signedPerHour: number;
  /** The window's length in hours, as measured. */
  hours: number;
  /** Signals force rows in the window. */
  events: number;
}

/** How the state at a tick came to be: carried from the row, measured at the flip, presumed at the flip, or dormant (unlisted or off). */
export type DriftStart = "carried" | "measured" | "presumed" | "dormant";

/** What the tick records beside the state, so the audit row tells the mode, the scale and whether the fallback applied. */
export interface DriftEvaluation extends TargetDriftState {
  mode: EngineConfig["targetDrift"]["coverageMode"];
  /** The person's normal (gross impact per hour) in relative mode, when they have one; null otherwise. */
  normal: number | null;
  /** The scale coverage and lean divided by this tick: the normal, or the fixed constant. */
  scale: number;
  /** True when relative mode had no normal for the person and the fixed constant stood in. */
  fallback: boolean;
  started: DriftStart;
}

const EVIDENCE_DECIMALS = 6;
const OFFSET_DECIMALS = 4;

/** The fraction of an evidence average that survives deltaHours: 2^(−Δh / halfLife). */
export function driftDecay(deltaHours: number, halfLifeHours: number): number {
  return Math.pow(2, -deltaHours / halfLifeHours);
}

/** A usable normal: measured from at least one row, with a positive gross rate. */
export function hasNormal(normal: DriftNormal | null | undefined): normal is DriftNormal {
  return Boolean(normal && normal.events > 0 && Number.isFinite(normal.grossPerHour) && normal.grossPerHour > 0);
}

/** The scale coverage and lean divide by for this person, and whether the fallback applied. */
export function driftScale(config: EngineConfig["targetDrift"], normal: DriftNormal | null | undefined): { scale: number; normal: number | null; fallback: boolean } {
  if (config.coverageMode === "relative") {
    if (hasNormal(normal)) return { scale: normal.grossPerHour, normal: normal.grossPerHour, fallback: false };
    return { scale: config.fullCoverageImpactPerHour, normal: null, fallback: true };
  }
  return { scale: config.fullCoverageImpactPerHour, normal: null, fallback: false };
}

/** The offset the evidence implies against a scale, bounded to ±bound. */
export function driftOffsetAt(attention: number, direction: number, scale: number, config: EngineConfig["targetDrift"]): number {
  const coverage = clamp(attention / scale, 0, 1);
  const lean = clamp(direction / scale, -1, 1);
  return round(clamp(config.bound * (coverage * (1 + lean) - 1), -config.bound, config.bound), OFFSET_DECIMALS);
}

/** The offset the evidence implies in fixed mode (Phase 14), bounded to ±bound. */
export function driftOffset(attention: number, direction: number, config: EngineConfig["targetDrift"]): number {
  return driftOffsetAt(attention, direction, config.fullCoverageImpactPerHour, config);
}

/** What a never-measured person is presumed to be: fully covered and balanced on the given scale, so their target is their seed. */
export function presumedDriftState(config: EngineConfig["targetDrift"], scale = config.fullCoverageImpactPerHour): { attention: number; direction: number } {
  return { attention: scale, direction: 0 };
}

/**
 * The state a person starts from at this tick: their own, when the row
 * carries one; else, at the flip, their measured averages when measuredStart
 * is on and a normal exists; else the presumption on the scale in force.
 */
export function startDriftState(
  previous: TargetDriftState,
  config: EngineConfig["targetDrift"],
  normal: DriftNormal | null | undefined,
  scale: number,
): { attention: number; direction: number; started: DriftStart } {
  if (previous.attention !== null && previous.direction !== null) return { attention: previous.attention, direction: previous.direction, started: "carried" };
  if (config.measuredStart && hasNormal(normal)) return { attention: normal.grossPerHour, direction: normal.signedPerHour, started: "measured" };
  const presumed = presumedDriftState(config, scale);
  return { ...presumed, started: "presumed" };
}

/**
 * One tick of the drift, with everything the audit row records: fold this
 * tick's Signals impact (the force's value, after the cap and the volume
 * normalisation) into the two averages over deltaHours, and derive the
 * offset on the person's scale. A tick with no elapsed time changes nothing
 * but fills in the start state.
 */
export function evaluateTargetDrift(
  previous: TargetDriftState,
  signalsImpact: number,
  deltaHours: number,
  config: EngineConfig["targetDrift"],
  normal: DriftNormal | null | undefined = null,
): DriftEvaluation {
  const { scale, normal: normalUsed, fallback } = driftScale(config, normal);
  const start = startDriftState(previous, config, normal, scale);
  const detail = { mode: config.coverageMode, normal: normalUsed, scale, fallback, started: start.started };
  if (!(deltaHours > 0) || !Number.isFinite(deltaHours)) {
    return { attention: start.attention, direction: start.direction, offset: driftOffsetAt(start.attention, start.direction, scale, config), ...detail };
  }
  const decay = driftDecay(deltaHours, config.halfLifeHours);
  const attention = round(start.attention * decay + (1 - decay) * (Math.abs(signalsImpact) / deltaHours), EVIDENCE_DECIMALS);
  const direction = round(start.direction * decay + (1 - decay) * (signalsImpact / deltaHours), EVIDENCE_DECIMALS);
  return { attention, direction, offset: driftOffsetAt(attention, direction, scale, config), ...detail };
}

/** The dormant evaluation: the switch off, or a person not on the list. The row is written null, null, 0. */
export function dormantDriftEvaluation(config: EngineConfig["targetDrift"]): DriftEvaluation {
  return { ...DORMANT_TARGET_DRIFT, mode: config.coverageMode, normal: null, scale: config.fullCoverageImpactPerHour, fallback: false, started: "dormant" };
}

/**
 * One tick of the drift in fixed mode (Phase 14): the state alone. Kept for
 * the projection and the tests that pin the mapping; the tick itself calls
 * evaluateTargetDrift.
 */
export function advanceTargetDrift(previous: TargetDriftState, signalsImpact: number, deltaHours: number, config: EngineConfig["targetDrift"]): TargetDriftState {
  const { attention, direction, offset } = evaluateTargetDrift(previous, signalsImpact, deltaHours, { ...config, coverageMode: "fixed", measuredStart: false });
  return { attention, direction, offset };
}

/** The drift state as a people row carries it. Malformed or missing values read as never measured. */
export function readTargetDriftState(row: { target_attention?: number | string | null; target_direction?: number | string | null; target_offset?: number | string | null }): TargetDriftState {
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return { attention: num(row.target_attention), direction: num(row.target_direction), offset: num(row.target_offset) ?? 0 };
}

/** Gravity's target: the seed plus the offset the tick last wrote. The offset is 0 whenever the drift is off. */
export function effectiveTarget(seed: number, offset: number | null | undefined): number {
  return seed + (offset ?? 0);
}

/**
 * Where a person's target settles if their current evidence rates hold: the
 * projection the operator asks for. Rates are Signals impact per hour.
 */
export function projectedOffset(grossImpactPerHour: number, netImpactPerHour: number, config: EngineConfig["targetDrift"]): number {
  return driftOffset(grossImpactPerHour, netImpactPerHour, config);
}

/** Whether the drift applies to this person this tick: the switch on and the slug on the list. */
export function driftApplies(config: EngineConfig["targetDrift"], slug: string): boolean {
  return config.enabled && config.people.includes(slug);
}

/**
 * A normal from the Signals force's audit rows: the sums over the window
 * divided by its length in hours. `windowStart` is the later of the window's
 * edge and the regime start; `events` zero means no normal. Shared by the
 * Supabase store (from the RPC's sums) and the memory store (from its own
 * recorded events).
 */
export function normalFromSums(input: { grossImpact: number; signedImpact: number; events: number }, windowStart: Date, now: Date): DriftNormal {
  const hours = Math.max((now.getTime() - windowStart.getTime()) / 3_600_000, 1 / 120);
  return {
    grossPerHour: round(input.grossImpact / hours, EVIDENCE_DECIMALS),
    signedPerHour: round(input.signedImpact / hours, EVIDENCE_DECIMALS),
    hours: round(hours, 3),
    events: input.events,
  };
}

/** The window's start for the normal: now − normalWindowHours, or normalSince when that is later. */
export function normalWindowStart(config: EngineConfig["targetDrift"], now: Date): Date {
  const byWindow = new Date(now.getTime() - config.normalWindowHours * 3_600_000);
  if (config.normalSince === null) return byWindow;
  const since = Date.parse(config.normalSince);
  return Number.isFinite(since) && since > byWindow.getTime() ? new Date(since) : byWindow;
}
