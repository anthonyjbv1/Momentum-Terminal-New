import type { EngineConfig } from "@/lib/engine/config";
import type { ForceEntry } from "@/lib/engine/types";
import type { InversePair } from "@/types";

/**
 * Second pass — inverse pairs.
 *
 * Runs after every person has a first-pass score, so adjustments never cascade
 * through Gravity, Market Mood or the clamp. For each pair (A, B, dampening):
 * when A received a Signals impact this tick, B receives -(impact * dampening),
 * and symmetrically for B -> A. Returns the adjustment per person id.
 */
export function inversePairAdjustments(
  pairs: InversePair[],
  signalsImpactByPerson: Map<string, number>,
  config: EngineConfig["inversePairs"],
): Map<string, ForceEntry[]> {
  const entries = new Map<string, ForceEntry[]>();

  const push = (targetId: string, sourceId: string, sourceImpact: number, dampening: number) => {
    if (sourceImpact === 0) return;
    const impact = -(sourceImpact * dampening);
    const list = entries.get(targetId) ?? [];
    list.push({ force: "inverse_pair", impact, details: { pairedWith: sourceId, sourceSignalsImpact: sourceImpact, dampening } });
    entries.set(targetId, list);
  };

  for (const pair of pairs) {
    const dampening = pair.dampening ?? config.defaultDampening;
    push(pair.person_b_id, pair.person_a_id, signalsImpactByPerson.get(pair.person_a_id) ?? 0, dampening);
    push(pair.person_a_id, pair.person_b_id, signalsImpactByPerson.get(pair.person_b_id) ?? 0, dampening);
  }

  return entries;
}
