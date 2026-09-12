import { getScorerName } from "@/lib/env";

import { createDefaultLLMScorer } from "./llm";
import { rulesBasedScorer } from "./rules";
import type { SentimentScorer } from "./types";

export type { SentimentAnomaly, SentimentInput, SentimentResult, SentimentScorer } from "./types";
export { RulesBasedScorer, rulesBasedScorer } from "./rules";
export { LLMScorer, createDefaultLLMScorer } from "./llm";
export { MetricScorer, metricScorer, isMetricSignal, readMetricPayload } from "./metric";

/**
 * Scorer registry. The Engine asks for a scorer by name (SCORER env var,
 * default "llm") and only ever talks to the SentimentScorer interface.
 * SCORER=rules switches back to the Phase 3 keyword scorer instantly.
 */
const FACTORIES: Record<string, () => SentimentScorer> = {
  rules: () => rulesBasedScorer,
  llm: () => createDefaultLLMScorer(),
};

const instances = new Map<string, SentimentScorer>();

export function getSentimentScorer(name: string = getScorerName()): SentimentScorer {
  const key = name.trim().toLowerCase();
  const factory = FACTORIES[key];
  if (!factory) {
    throw new Error(`Unknown sentiment scorer "${name}". Registered: ${Object.keys(FACTORIES).join(", ")}`);
  }
  let scorer = instances.get(key);
  if (!scorer) {
    scorer = factory();
    instances.set(key, scorer);
  }
  return scorer;
}

export function listSentimentScorers(): string[] {
  return Object.keys(FACTORIES);
}

export function resetSentimentScorers(): void {
  instances.clear();
}
