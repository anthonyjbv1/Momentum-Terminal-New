import type { EngineConfig } from "@/lib/engine/config";
import type { ForceEntry } from "@/lib/engine/types";

/**
 * FORCE 4 — Conviction (capital concentration).
 *
 *   concentration = open capital on the person / max_allocation_cents
 *
 *   0 – 60%   -> 0            (neutral)
 *   60 – 85%  -> +0.05..+0.15 (linear ramp: conviction)
 *   > 85%     -> -0.05..-0.15 (linear ramp to 100%, continuing past it),
 *                capped at -0.30 (over-extension resistance)
 *
 * With no open positions the concentration is 0 and the force is 0.
 */

export function convictionImpact(concentration: number, config: EngineConfig["conviction"]): number {
  if (concentration <= config.neutralUpTo) return 0;
  if (concentration <= config.positiveUpTo) {
    const t = (concentration - config.neutralUpTo) / (config.positiveUpTo - config.neutralUpTo);
    return config.positiveMin + t * (config.positiveMax - config.positiveMin);
  }
  const t = (concentration - config.positiveUpTo) / (1 - config.positiveUpTo);
  const negative = -(config.negativeMin + t * (config.negativeMax - config.negativeMin));
  return Math.max(-config.cap, negative);
}

export function convictionForce(openCapitalCents: number, maxAllocationCents: number, config: EngineConfig["conviction"]): ForceEntry {
  const concentration = maxAllocationCents > 0 ? openCapitalCents / maxAllocationCents : 0;
  return {
    force: "conviction",
    impact: convictionImpact(concentration, config),
    details: { openCapitalCents, maxAllocationCents, concentration },
  };
}
