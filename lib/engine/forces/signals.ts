import type { EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";
import type { SentimentResult } from "@/lib/engine/sentiment/types";
import type { EngineSignal, ForceEntry, ScoredSignal } from "@/lib/engine/types";

/**
 * FORCE 2 — Signals (news and metric impact).
 *
 *   impact(signal) = baseImpact * tierMultiplier(source tier) * confidence * direction
 *   force          = the person's signals this tick, volume-normalised, capped
 *                    at ±maxAbsImpactPerTick as a brake
 *
 * PER-PERSON VOLUME NORMALISATION (Phase 7). Once several connectors feed
 * one person, the number of signals in a tick says more about the sources
 * (a comment thread yields dozens, an API poll yields one) than about the
 * person. Two steps keep volume from driving magnitude by itself:
 *
 *   1. per-source cap: at most maxPerSourcePerTick signals per source count,
 *      the strongest kept, so a chatty source cannot outvote a quiet one
 *   2. sub-linear sum: the kept signals are summed and divided by
 *      count^volumeExponent (0.5): the force still grows with agreement,
 *      but four signals of one strength read twice one of them, not four
 *      times
 *
 * The assumption behind step 2 is that a tick's signals about one person
 * are partially redundant evidence of the same day, so they combine like
 * noise (in quadrature) rather than like independent events. Where it is
 * weak: it still grows with the number of sources, so adding sources to a
 * person raises their ceiling; it cannot tell a genuinely busy day from
 * four outlets covering one story; it dilutes a lone strong signal when
 * weak ones sit beside it; and the source cap may drop a real second story
 * on a day with three. The honest fix is to normalise each person's signal
 * volume against their own trailing volume, the same baseline the metrics
 * use, once there is history to build it from. Neutral signals (impact 0)
 * are carried in the details but never counted.
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

/** The strongest maxPerSource non-zero signals per source, in a stable order; the rest are reported as dropped. */
export function capPerSource(scored: ScoredSignal[], maxPerSource: number): { kept: ScoredSignal[]; dropped: ScoredSignal[] } {
  const bySource = new Map<string, ScoredSignal[]>();
  for (const entry of scored) {
    if (entry.impact === 0) continue;
    const list = bySource.get(entry.signal.sourceName) ?? [];
    list.push(entry);
    bySource.set(entry.signal.sourceName, list);
  }
  const kept: ScoredSignal[] = [];
  const dropped: ScoredSignal[] = [];
  for (const list of bySource.values()) {
    const ordered = [...list].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact) || a.signal.id.localeCompare(b.signal.id));
    kept.push(...ordered.slice(0, Math.max(0, maxPerSource)));
    dropped.push(...ordered.slice(Math.max(0, maxPerSource)));
  }
  return { kept, dropped };
}

export function signalsForce(scored: ScoredSignal[], config: EngineConfig["signals"]): ForceEntry {
  const { kept, dropped } = capPerSource(scored, config.maxPerSourcePerTick);
  const droppedIds = new Set(dropped.map((s) => s.signal.id));
  const raw = kept.reduce((sum, s) => sum + s.impact, 0);
  const volumeDivisor = kept.length > 1 ? Math.pow(kept.length, config.volumeExponent) : 1;
  const normalized = raw / volumeDivisor;
  const impact = clamp(normalized, -config.maxAbsImpactPerTick, config.maxAbsImpactPerTick);
  return {
    force: "signals",
    impact,
    details: {
      signalCount: scored.length,
      countedSignals: kept.length,
      droppedBySourceCap: dropped.length,
      maxPerSourcePerTick: config.maxPerSourcePerTick,
      rawImpact: raw,
      volumeExponent: config.volumeExponent,
      volumeDivisor,
      normalizedImpact: normalized,
      capped: impact !== normalized,
      signals: scored.map((s) => ({
        id: s.signal.id,
        source: s.signal.sourceName,
        tier: s.signal.sourceTier,
        label: s.sentiment.label,
        confidence: s.sentiment.confidence,
        direction: s.sentiment.direction,
        impact: s.impact,
        counted: s.impact !== 0 && !droppedIds.has(s.signal.id),
        scorer: s.sentiment.scorer,
        anomaly: s.sentiment.anomaly,
        rationale: s.sentiment.rationale,
      })),
    },
  };
}
