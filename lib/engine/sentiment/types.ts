import type { SentimentLabel } from "@/types";
import type { Json } from "@/types/database";

/** What a scorer gets to look at. Kept minimal so an LLM scorer can be dropped in unchanged. */
export interface SentimentInput {
  id: string;
  /** The person the signal is about; scorers with per-entity memory batch and contextualise by it. */
  personId: string;
  headline: string;
  /** The connector's raw payload; `kind: "baseline"` marks zero-impact baseline signals. */
  rawPayload: Json | null;
  sourceName: string;
  sourceTier: number;
  /** The tick this signal is being scored for, so LLM usage can be attributed to it. Absent outside a tick. */
  tickNumber?: number;
}

export interface SentimentResult {
  label: SentimentLabel;
  /** 0–1. How sure the scorer is; scales the Signals impact. */
  confidence: number;
  /** +1 positive, -1 negative, 0 neutral. */
  direction: 1 | -1 | 0;
  /** Optional human-readable explanation, kept in score_events details. */
  rationale?: string;
  /** How unusual this signal is for THIS person (LLM scorer). */
  anomaly?: SentimentAnomaly;
  /** One-sentence explanation of the person's net movement, in the Engine's voice (LLM scorer, per batch). */
  narrative?: string;
  /** Which scorer produced the result: "rules", "llm", "prefilter", "rules-fallback". */
  scorer?: string;
}

export type SentimentAnomaly = "routine" | "notable" | "anomalous";

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
