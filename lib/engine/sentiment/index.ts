import { rulesBasedScorer } from "./rules";
import type { SentimentScorer } from "./types";

export type { SentimentInput, SentimentResult, SentimentScorer } from "./types";
export { RulesBasedScorer, rulesBasedScorer } from "./rules";

/**
 * Scorer registry. The Engine asks for a scorer by name and only ever talks
 * to the SentimentScorer interface. Phase 4 registers an LLM scorer here and
 * switches the default (or the SENTIMENT_SCORER env var) — the Engine does
 * not change.
 */
const SCORERS: Record<string, SentimentScorer> = {
  rules: rulesBasedScorer,
};

export const DEFAULT_SCORER_NAME = "rules";

export function getSentimentScorer(name: string = process.env.SENTIMENT_SCORER ?? DEFAULT_SCORER_NAME): SentimentScorer {
  const scorer = SCORERS[name];
  if (!scorer) {
    throw new Error(`Unknown sentiment scorer "${name}". Registered: ${Object.keys(SCORERS).join(", ")}`);
  }
  return scorer;
}

export function listSentimentScorers(): string[] {
  return Object.keys(SCORERS);
}
