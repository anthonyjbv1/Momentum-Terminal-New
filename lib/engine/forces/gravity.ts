import type { EngineConfig } from "@/lib/engine/config";
import type { ForceEntry } from "@/lib/engine/types";

/**
 * FORCE 1 — Gravity (mean reversion).
 *
 *   decayed = revertTarget + (currentScore - revertTarget) * e^(-lambda * deltaHours)
 *   impact  = decayed - currentScore
 *
 * Pulls the score toward the person's equilibrium when nothing else is
 * happening. The pull is proportional to the distance from target and to the
 * time elapsed since the last tick.
 */
export function gravityForce(
  currentScore: number,
  revertTarget: number,
  deltaHours: number,
  config: EngineConfig["gravity"],
): ForceEntry {
  const decayed = revertTarget + (currentScore - revertTarget) * Math.exp(-config.lambdaPerHour * deltaHours);
  return {
    force: "gravity",
    impact: decayed - currentScore,
    details: { revertTarget, deltaHours, lambdaPerHour: config.lambdaPerHour, decayedScore: decayed },
  };
}
