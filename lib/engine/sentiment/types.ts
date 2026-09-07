import type { SentimentLabel } from "@/types";
import type { Json } from "@/types/database";

/** What a scorer gets to look at. Kept minimal so an LLM scorer can be dropped in unchanged. */
export interface SentimentInput {
  id: string;
  headline: string;
  /** The connector's raw payload; `kind: "baseline"` marks zero-impact baseline signals. */
  rawPayload: Json | null;
  sourceName: string;
  sourceTier: number;
}

export interface SentimentResult {
  label: SentimentLabel;
  /** 0–1. How sure the scorer is; scales the Signals impact. */
  confidence: number;
  /** +1 positive, -1 negative, 0 neutral. */
  direction: 1 | -1 | 0;
  /** Optional human-readable explanation, kept in score_events details. */
  rationale?: string;
}

/**
 * The swappable sentiment interface. The Engine only ever calls scoreSignal();
 * Phase 4 replaces RulesBasedScorer with a reasoning-LLM implementation
 * without touching the Engine.
 */
export interface SentimentScorer {
  readonly name: string;
  scoreSignal(signal: SentimentInput): Promise<SentimentResult>;
}

export const NEUTRAL_RESULT: SentimentResult = { label: "neutral", confidence: 0, direction: 0 };
