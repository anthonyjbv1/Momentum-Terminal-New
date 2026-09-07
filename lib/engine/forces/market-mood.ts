import type { EngineConfig } from "@/lib/engine/config";
import { clamp, mean } from "@/lib/engine/math";
import type { ForceEntry } from "@/lib/engine/types";

/**
 * FORCE 3 — Market Mood (global sentiment tide).
 *
 * The mood is the platform-wide average Signals movement this tick: when the
 * news is good across the board, everyone drifts up a little; when it is bad,
 * everyone drifts down. Each person receives
 *
 *   impact = fraction * sensitivity(person) * clamp(mood_excluding_self, ±maxAbsMood)
 *
 * Brakes against cascade amplification:
 *   - the mood is built from this tick's Signals force only (never from
 *     scores that already contain mood, so it cannot feed back on itself)
 *   - a person's own signals are excluded from their mood (a big headline
 *     cannot amplify itself through the tide)
 *   - the mood and the impact are both clamped
 *
 * With no signals anywhere the mood is 0 and the force is 0.
 */

/** Platform-wide mood: the mean Signals impact across all active people. */
export function computeMood(signalsImpacts: number[]): number {
  return mean(signalsImpacts);
}

export function marketMoodForce(
  personSlug: string,
  ownSignalsImpact: number,
  allSignalsImpacts: number[],
  config: EngineConfig["marketMood"],
): ForceEntry {
  const others = allSignalsImpacts.length > 1 ? (allSignalsImpacts.reduce((sum, v) => sum + v, 0) - ownSignalsImpact) / (allSignalsImpacts.length - 1) : 0;
  const moodExcludingSelf = clamp(others, -config.maxAbsMood, config.maxAbsMood);
  const sensitivity = config.sensitivityBySlug[personSlug] ?? config.defaultSensitivity;
  const impact = clamp(config.fraction * sensitivity * moodExcludingSelf, -config.maxAbsImpact, config.maxAbsImpact);
  return {
    force: "market_mood",
    impact,
    details: { mood: computeMood(allSignalsImpacts), moodExcludingSelf, sensitivity, fraction: config.fraction },
  };
}
