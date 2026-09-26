import type { TickDeadline } from "@/lib/engine/deadline";
import type { SentimentLabel } from "@/types";
import type { Json } from "@/types/database";

import type { DeferralReason, TickCallBudget } from "./budget";

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
  /**
   * What the story says about THIS person's trajectory (Phase 31, the
   * version-2 prompt only): relevant, incidental or unrelated. The Signals
   * force multiplies by it when the quality rules are on. Absent from the
   * version-1 prompt, so nothing changes while they are off.
   */
  salience?: SentimentSalience;
  /** One-sentence explanation of the person's net movement, in the Engine's voice (LLM scorer, per batch). */
  narrative?: string;
  /** The direction the narrative claims (Phase 31, version 2): checked against the Signals force before the sentence is published. */
  narrativeDirection?: NarrativeDirection;
  /** Which scorer produced the result: "rules", "llm", "prefilter", "rules-fallback". */
  scorer?: string;
}

export type SentimentAnomaly = "routine" | "notable" | "anomalous";

/**
 * SALIENCE BY INFORMATION, NOT PROMINENCE (Phase 31). Not "is this person the
 * main subject" but "does this story say something about this person's
 * trajectory": "Zuckerberg overtakes Dell" is relevant, and negative, for
 * Dell; a name in an attendee list is incidental; a namesake is unrelated.
 */
export type SentimentSalience = "relevant" | "incidental" | "unrelated";

export type NarrativeDirection = "up" | "down" | "flat";

/**
 * THE SECOND OUTCOME. A scorer that did not ATTEMPT a signal this tick says
 * so, instead of handing back a rules score as if it had. The distinction is
 * the whole fix for the tick that never committed:
 *
 *   - a call that FAILED (error, timeout, refusal, malformed JSON, an id the
 *     model omitted) falls back to the rules scorer. That is a real answer;
 *     the signal is processed.
 *   - a chunk that was NEVER ATTEMPTED (deadline reached, per-tick budget
 *     spent, the person already had their call, the rolling rate limit) is
 *     deferred. The signal is left out of the commit, stays processed = false
 *     and is scored by a later tick, at one attempt's cost.
 */
export interface DeferredSignal {
  deferred: true;
  reason: DeferralReason;
  detail: string;
}

export type ScoringOutcome = SentimentResult | DeferredSignal;

export function isDeferred(outcome: ScoringOutcome): outcome is DeferredSignal {
  return (outcome as DeferredSignal).deferred === true;
}

/**
 * What one tick hands its scorer: the instant scoring must be finished by,
 * and the call budget for this tick. Both belong to the tick and die with it.
 * A scorer called without a context (tests, tools) is under no deadline.
 */
export interface ScoringContext {
  deadline: TickDeadline;
  callBudget: TickCallBudget;
}

/**
 * The swappable sentiment interface. The Engine only ever calls scoreSignal();
 * Phase 4 replaces RulesBasedScorer with a reasoning-LLM implementation
 * without touching the Engine. Only a scorer that spends money can defer;
 * the rules and metric scorers always answer.
 */
export interface SentimentScorer {
  readonly name: string;
  scoreSignal(signal: SentimentInput, context?: ScoringContext): Promise<ScoringOutcome>;
}

export const NEUTRAL_RESULT: SentimentResult = { label: "neutral", confidence: 0, direction: 0 };
