import type { Json } from "@/types/database";

import type { SentimentInput, SentimentResult, SentimentScorer } from "./types";

/**
 * RulesBasedScorer — keyword / pattern matching on the headline.
 *
 * Intentionally simple: it exists to prove the Engine end to end. Phase 4
 * swaps in a reasoning LLM behind the same SentimentScorer interface.
 *
 * Rules:
 *  - baseline signals (rawPayload.kind === "baseline") are neutral, direction
 *    0, confidence 0: zero impact by design
 *  - positive and negative pattern lists each carry a weight (clarity of the
 *    match); confidence starts at the strongest matched weight and grows a
 *    little with each extra distinct match
 *  - when both sides match, the stronger side wins with a confidence penalty;
 *    a near tie is neutral
 *  - nothing matched -> neutral, direction 0
 *  - connector hints in the payload refine the result: milestone kinds raise
 *    the floor of confidence, "change" kinds scale confidence by the size of
 *    the relative move
 */

interface Pattern {
  pattern: RegExp;
  weight: number;
  label: string;
}

const POSITIVE_PATTERNS: Pattern[] = [
  { pattern: /\b(record(?:-breaking)?|all-time high|new high)\b/i, weight: 0.9, label: "record" },
  { pattern: /\b(wins?|won|victory|victorious|champion(?:ship)?|award(?:ed|s)?|honou?red)\b/i, weight: 0.85, label: "win" },
  { pattern: /\b(crosses|passes|surpasses|tops|hits|reaches|clears)\b/i, weight: 0.8, label: "crosses" },
  { pattern: /\b(surges?|soars?|skyrockets?|rallies|rallying)\b/i, weight: 0.8, label: "surge" },
  { pattern: /\b(gains?|grows?|growth|rises?|rising|climbs?|jumps?|boosts?|increases?)\b/i, weight: 0.7, label: "gain" },
  { pattern: /\b(milestone|breakthrough|sold out|sells out|expands?|expansion|profits?|partnership|signs? (?:a )?deal)\b/i, weight: 0.65, label: "milestone" },
  { pattern: /\b(launch(?:es|ed)?|debuts?|releases?|uploads?|premieres?|unveils?|announces?)\b/i, weight: 0.55, label: "launch" },
  { pattern: /\b(up)\b/i, weight: 0.45, label: "up" },
];

const NEGATIVE_PATTERNS: Pattern[] = [
  { pattern: /\b(scandal|lawsuit|sued|sues|arrest(?:ed)?|indict(?:ed|ment)|fraud|charged with|convicted)\b/i, weight: 0.95, label: "scandal" },
  { pattern: /\b(controvers(?:y|ial)|backlash|boycott|outrage|apolog(?:y|ises|izes|ised|ized))\b/i, weight: 0.8, label: "controversy" },
  { pattern: /\b(crash(?:es|ed)?|plunges?|plummets?|collapses?|tanks?|slumps?|tumbles?)\b/i, weight: 0.8, label: "crash" },
  { pattern: /\b(ban(?:ned|s)?|suspend(?:ed|s)?|fined?|penalt(?:y|ies)|investigat(?:ion|ed|es)|probe)\b/i, weight: 0.75, label: "penalty" },
  { pattern: /\b(falls?|fell|drops?|dropped|declines?|declining|sinks?|slides?|dips?|loses?|lost|losses?|misses?|missed)\b/i, weight: 0.7, label: "fall" },
  { pattern: /\b(cuts?|layoffs?|fired|resigns?|resignation|steps? down|quits?|cancel(?:s|led|ed)?|delays?|delayed|below)\b/i, weight: 0.65, label: "cut" },
  { pattern: /\b(down)\b/i, weight: 0.45, label: "down" },
];

/** Extra distinct matches add this much confidence each, up to the cap. */
const EXTRA_MATCH_BONUS = 0.05;
const EXTRA_MATCH_CAP = 0.15;
/** Rules can never be fully certain. */
const MAX_CONFIDENCE = 0.95;
/** Confidence multiplier when both sides matched and one side won. */
const CONFLICT_PENALTY = 0.6;
/** |positive - negative| below this is a tie -> neutral. */
const TIE_MARGIN = 0.3;
/** Relative change at which a "change" signal reaches full confidence. */
const FULL_CONFIDENCE_RELATIVE_CHANGE = 0.05;
const MIN_CHANGE_SCALE = 0.2;

interface SideScore {
  strongest: number;
  matches: string[];
}

function scoreSide(headline: string, patterns: Pattern[]): SideScore {
  let strongest = 0;
  const matches: string[] = [];
  for (const { pattern, weight, label } of patterns) {
    if (pattern.test(headline)) {
      matches.push(label);
      strongest = Math.max(strongest, weight);
    }
  }
  return { strongest, matches };
}

function confidenceFor(side: SideScore): number {
  if (side.matches.length === 0) return 0;
  const bonus = Math.min(EXTRA_MATCH_CAP, (side.matches.length - 1) * EXTRA_MATCH_BONUS);
  return Math.min(MAX_CONFIDENCE, side.strongest + bonus);
}

function payloadField(payload: Json | null, key: string): Json | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

export function scoreHeadline(headline: string): SentimentResult {
  const positive = scoreSide(headline, POSITIVE_PATTERNS);
  const negative = scoreSide(headline, NEGATIVE_PATTERNS);
  const positiveConfidence = confidenceFor(positive);
  const negativeConfidence = confidenceFor(negative);

  if (positiveConfidence === 0 && negativeConfidence === 0) {
    return { label: "neutral", confidence: 0, direction: 0, rationale: "no sentiment patterns matched" };
  }

  if (positiveConfidence > 0 && negativeConfidence > 0) {
    const margin = positiveConfidence - negativeConfidence;
    if (Math.abs(margin) < TIE_MARGIN) {
      return {
        label: "neutral",
        confidence: 0,
        direction: 0,
        rationale: `mixed signals: +[${positive.matches.join(",")}] -[${negative.matches.join(",")}]`,
      };
    }
    const winnerIsPositive = margin > 0;
    return {
      label: winnerIsPositive ? "positive" : "negative",
      direction: winnerIsPositive ? 1 : -1,
      confidence: Math.max(positiveConfidence, negativeConfidence) * CONFLICT_PENALTY,
      rationale: `mixed, ${winnerIsPositive ? "positive" : "negative"} dominates: +[${positive.matches.join(",")}] -[${negative.matches.join(",")}]`,
    };
  }

  if (positiveConfidence > 0) {
    return { label: "positive", direction: 1, confidence: positiveConfidence, rationale: `matched [${positive.matches.join(",")}]` };
  }
  return { label: "negative", direction: -1, confidence: negativeConfidence, rationale: `matched [${negative.matches.join(",")}]` };
}

/** Applies connector hints carried in rawPayload (kind, relativeChange) to a headline result. */
export function applyPayloadHints(result: SentimentResult, payload: Json | null): SentimentResult {
  const kind = payloadField(payload, "kind");

  if (kind === "baseline") {
    return { label: "neutral", confidence: 0, direction: 0, rationale: "baseline signal: zero impact by design" };
  }

  if (kind === "milestone" && result.direction >= 0) {
    return { label: "positive", direction: 1, confidence: Math.max(result.confidence, 0.75), rationale: `${result.rationale ?? ""}; milestone hint`.trim() };
  }

  if (kind === "milestone_lost" && result.direction <= 0) {
    return { label: "negative", direction: -1, confidence: Math.max(result.confidence, 0.75), rationale: `${result.rationale ?? ""}; milestone lost hint`.trim() };
  }

  if (kind === "change") {
    const relativeChange = payloadField(payload, "relativeChange");
    if (typeof relativeChange === "number" && Number.isFinite(relativeChange)) {
      const scale = Math.min(1, Math.max(MIN_CHANGE_SCALE, Math.abs(relativeChange) / FULL_CONFIDENCE_RELATIVE_CHANGE));
      return { ...result, confidence: result.confidence * scale, rationale: `${result.rationale ?? ""}; change scaled ×${scale.toFixed(2)}`.trim() };
    }
  }

  return result;
}

export class RulesBasedScorer implements SentimentScorer {
  readonly name = "rules";

  async scoreSignal(signal: SentimentInput): Promise<SentimentResult> {
    const result = applyPayloadHints(scoreHeadline(signal.headline), signal.rawPayload);
    return { ...result, confidence: Math.round(result.confidence * 1000) / 1000 };
  }
}

export const rulesBasedScorer = new RulesBasedScorer();
