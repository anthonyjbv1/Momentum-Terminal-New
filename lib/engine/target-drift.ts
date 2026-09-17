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
 *   coverage   = min(attention / fullCoverageImpactPerHour, 1)
 *   lean       = clamp(direction / fullCoverageImpactPerHour, −1, 1)
 *   offset     = bound × (coverage × (1 + lean) − 1)
 *   target     = seed + offset
 *
 * The state (attention, direction, offset) lives on the people row and is
 * advanced once per tick from that tick's Signals force. Null state means
 * the drift has never measured the person: they are presumed fully covered
 * and balanced, so the target starts at the seed and moves only as evidence
 * accrues or fails to. With the switch off the tick writes the dormant
 * state and every target is its seed.
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

const EVIDENCE_DECIMALS = 6;
const OFFSET_DECIMALS = 4;

/** The fraction of an evidence average that survives deltaHours: 2^(−Δh / halfLife). */
export function driftDecay(deltaHours: number, halfLifeHours: number): number {
  return Math.pow(2, -deltaHours / halfLifeHours);
}

/** The offset the evidence implies, bounded to ±bound. */
export function driftOffset(attention: number, direction: number, config: EngineConfig["targetDrift"]): number {
  const coverage = clamp(attention / config.fullCoverageImpactPerHour, 0, 1);
  const lean = clamp(direction / config.fullCoverageImpactPerHour, -1, 1);
  return round(clamp(config.bound * (coverage * (1 + lean) - 1), -config.bound, config.bound), OFFSET_DECIMALS);
}

/** What a never-measured person is presumed to be: fully covered and balanced, so their target is their seed. */
export function presumedDriftState(config: EngineConfig["targetDrift"]): { attention: number; direction: number } {
  return { attention: config.fullCoverageImpactPerHour, direction: 0 };
}

/**
 * One tick of the drift: fold this tick's Signals impact (the force's
 * value, after the cap and the volume normalisation) into the two averages
 * over deltaHours, and derive the offset. A tick with no elapsed time
 * changes nothing but fills in a presumed state.
 */
export function advanceTargetDrift(previous: TargetDriftState, signalsImpact: number, deltaHours: number, config: EngineConfig["targetDrift"]): TargetDriftState {
  const presumed = presumedDriftState(config);
  const attention0 = previous.attention ?? presumed.attention;
  const direction0 = previous.direction ?? presumed.direction;
  if (!(deltaHours > 0) || !Number.isFinite(deltaHours)) {
    return { attention: attention0, direction: direction0, offset: driftOffset(attention0, direction0, config) };
  }
  const decay = driftDecay(deltaHours, config.halfLifeHours);
  const attention = round(attention0 * decay + (1 - decay) * (Math.abs(signalsImpact) / deltaHours), EVIDENCE_DECIMALS);
  const direction = round(direction0 * decay + (1 - decay) * (signalsImpact / deltaHours), EVIDENCE_DECIMALS);
  return { attention, direction, offset: driftOffset(attention, direction, config) };
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
