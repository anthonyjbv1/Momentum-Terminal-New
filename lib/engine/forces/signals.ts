import type { EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";
import type { SentimentResult } from "@/lib/engine/sentiment/types";
import type { EngineSignal, ForceEntry, ScoredSignal } from "@/lib/engine/types";

/**
 * FORCE 2 — Signals (news impact).
 *
 *   impact(signal) = baseImpact * tierMultiplier(source tier) * confidence * direction
 *   force          = sum over this tick's signals for the person, capped at
 *                    ±maxAbsImpactPerTick as a brake
 */

export function tierMultiplier(tier: number, config: EngineConfig["signals"]): number {
  return config.tierMultipliers[tier] ?? config.defaultTierMultiplier;
}

export function signalImpact(signal: EngineSignal, sentiment: SentimentResult, config: EngineConfig["signals"]): number {
  const confidence = clamp(sentiment.confidence, 0, 1);
  return config.baseImpact * tierMultiplier(signal.sourceTier, config) * confidence * sentiment.direction;
}

export function scoreSignals(
  signals: EngineSignal[],
  sentiments: Map<string, SentimentResult>,
  config: EngineConfig["signals"],
): ScoredSignal[] {
  return signals.map((signal) => {
    const sentiment = sentiments.get(signal.id) ?? { label: "neutral", confidence: 0, direction: 0 };
    return { signal, sentiment, impact: signalImpact(signal, sentiment, config) };
  });
}

export function signalsForce(scored: ScoredSignal[], config: EngineConfig["signals"]): ForceEntry {
  const raw = scored.reduce((sum, s) => sum + s.impact, 0);
  const impact = clamp(raw, -config.maxAbsImpactPerTick, config.maxAbsImpactPerTick);
  return {
    force: "signals",
    impact,
    details: {
      signalCount: scored.length,
      rawImpact: raw,
      capped: impact !== raw,
      signals: scored.map((s) => ({
        id: s.signal.id,
        source: s.signal.sourceName,
        tier: s.signal.sourceTier,
        label: s.sentiment.label,
        confidence: s.sentiment.confidence,
        direction: s.sentiment.direction,
        impact: s.impact,
        scorer: s.sentiment.scorer,
        anomaly: s.sentiment.anomaly,
        rationale: s.sentiment.rationale,
      })),
    },
  };
}
