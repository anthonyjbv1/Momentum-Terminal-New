import type { EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";
import { isMetricSignal } from "@/lib/engine/sentiment/metric";
import type { SentimentResult } from "@/lib/engine/sentiment/types";
import type { EngineSignal, ForceEntry, ScoredSignal } from "@/lib/engine/types";

/**
 * FORCE 2 — Signals (news and metric impact).
 *
 *   impact(signal) = baseImpact * tierMultiplier(source tier) * confidence * direction * freshness
 *   force          = the person's signals this tick, volume-normalised, capped
 *                    at ±maxAbsImpactPerTick as a brake
 *
 * FRESHNESS (Phase 12). The Engine used to score an eight-month-old article
 * exactly as one published this minute: occurred_at was loaded and never
 * read. Now an event signal's impact carries 2^(−age / halfLife), age being
 * the gap between occurred_at and the tick, and is exactly zero from
 * freshnessMaxAgeHours on. An expired signal contributes nothing, is never
 * sent to the model, and is still processed, so a backlog of stale news
 * drains at no cost instead of moving scores or lingering.
 *
 * Two clocks, kept apart on purpose: this weights staleness in the QUEUE,
 * once, at the moment a signal contributes; Gravity handles staleness in the
 * SCORE afterwards. Nothing here decays a score, and a metric signal is never
 * aged — its own baseline window already says what is stale for it.
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
 *
 * ONE MOMENT, ONE READING (Phase 13+). Before either step, metric signals
 * from one source that share an occurred_at are folded into one reading
 * whose impact is the MEAN of their impacts (neutral ones left out). Three
 * per-game figures of one football game are one performance, not three
 * pieces of evidence: without the fold they would take three of the
 * source's cap slots and read as √3 of one reading, a busier week than it
 * was. The mean, not the strongest, so a mixed line (rating up, picks up)
 * reads mixed. Event signals are never folded; the game's result event and
 * its stat line stay two readings, which is where a poor line in a big win
 * and the "commanding win" headline meet and partly cancel. The fold is
 * config.oneReadingPerMetricMoment and the folded members stay visible in
 * the details.
 */

export function tierMultiplier(tier: number, config: EngineConfig["signals"]): number {
  return config.tierMultipliers[tier] ?? config.defaultTierMultiplier;
}

/** Hours between the signal's occurred_at and the tick. Negative when the clock says it has not happened yet. */
export function signalAgeHours(signal: Pick<EngineSignal, "occurredAt">, now: Date): number {
  return (now.getTime() - signal.occurredAt.getTime()) / 3_600_000;
}

/** The freshness curve: 1 at zero age, halving every halfLife, exactly 0 at and past maxAge. */
export function freshnessWeight(ageHours: number, config: EngineConfig["signals"]): number {
  if (!Number.isFinite(ageHours) || ageHours <= 0) return 1;
  if (ageHours >= config.freshnessMaxAgeHours) return 0;
  return Math.pow(2, -ageHours / config.freshnessHalfLifeHours);
}

/** Age and weight of one signal at this tick. A metric signal is never aged. */
export function signalFreshness(signal: Pick<EngineSignal, "occurredAt" | "rawPayload">, now: Date, config: EngineConfig["signals"]): { ageHours: number; weight: number } {
  const ageHours = signalAgeHours(signal, now);
  return { ageHours, weight: isMetricSignal(signal.rawPayload) ? 1 : freshnessWeight(ageHours, config) };
}

/** An event signal past the freshness limit: it will contribute nothing, so it must not cost a model call either. */
export function isExpiredSignal(signal: Pick<EngineSignal, "occurredAt" | "rawPayload">, now: Date, config: EngineConfig["signals"]): boolean {
  return signalFreshness(signal, now, config).weight === 0;
}

export function signalImpact(signal: EngineSignal, sentiment: SentimentResult, config: EngineConfig["signals"], now: Date): number {
  const confidence = clamp(sentiment.confidence, 0, 1);
  const { weight } = signalFreshness(signal, now, config);
  return config.baseImpact * tierMultiplier(signal.sourceTier, config) * confidence * sentiment.direction * weight;
}

export function scoreSignals(
  signals: EngineSignal[],
  sentiments: Map<string, SentimentResult>,
  config: EngineConfig["signals"],
  now: Date,
): ScoredSignal[] {
  return signals.map((signal) => {
    const sentiment = sentiments.get(signal.id) ?? { label: "neutral", confidence: 0, direction: 0 };
    const { ageHours, weight } = signalFreshness(signal, now, config);
    return { signal, sentiment, impact: signalImpact(signal, sentiment, config, now), ageHours, freshness: weight };
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

/** One moment's metric readings from one source, folded into one. */
export interface MetricMoment {
  source: string;
  at: string;
  /** The signal that stands for the moment: the strongest member. */
  representative: string;
  members: string[];
  /** The mean of the members' non-zero impacts: what the moment contributes. */
  impact: number;
}

/**
 * Folds metric signals from one source that share an occurred_at into one
 * reading each: the strongest member stands for the moment and carries the
 * mean of the members' impacts. Everything else passes through untouched.
 */
export function foldMetricMoments(scored: ScoredSignal[]): { folded: ScoredSignal[]; moments: MetricMoment[]; foldedInto: Map<string, string> } {
  const groups = new Map<string, ScoredSignal[]>();
  for (const entry of scored) {
    if (entry.impact === 0 || !isMetricSignal(entry.signal.rawPayload)) continue;
    const key = `${entry.signal.sourceName}|${entry.signal.occurredAt.toISOString()}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const moments: MetricMoment[] = [];
  const foldedInto = new Map<string, string>();
  const replacement = new Map<string, ScoredSignal>();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact) || a.signal.id.localeCompare(b.signal.id));
    const representative = ordered[0];
    const impact = members.reduce((sum, member) => sum + member.impact, 0) / members.length;
    const [source, at] = key.split("|");
    moments.push({ source, at, representative: representative.signal.id, members: ordered.map((member) => member.signal.id), impact });
    for (const member of ordered.slice(1)) foldedInto.set(member.signal.id, representative.signal.id);
    replacement.set(representative.signal.id, { ...representative, impact });
  }
  const folded = scored.filter((entry) => !foldedInto.has(entry.signal.id)).map((entry) => replacement.get(entry.signal.id) ?? entry);
  return { folded, moments, foldedInto };
}

export function signalsForce(scored: ScoredSignal[], config: EngineConfig["signals"]): ForceEntry {
  const { folded, moments, foldedInto } = config.oneReadingPerMetricMoment ? foldMetricMoments(scored) : { folded: scored, moments: [], foldedInto: new Map<string, string>() };
  const { kept, dropped } = capPerSource(folded, config.maxPerSourcePerTick);
  const droppedIds = new Set(dropped.map((s) => s.signal.id));
  const momentImpact = new Map(moments.map((moment) => [moment.representative, moment.impact]));
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
      oneReadingPerMetricMoment: config.oneReadingPerMetricMoment,
      metricMoments: moments,
      foldedIntoMoments: foldedInto.size,
      rawImpact: raw,
      volumeExponent: config.volumeExponent,
      volumeDivisor,
      normalizedImpact: normalized,
      capped: impact !== normalized,
      freshnessHalfLifeHours: config.freshnessHalfLifeHours,
      freshnessMaxAgeHours: config.freshnessMaxAgeHours,
      signals: scored.map((s) => ({
        id: s.signal.id,
        source: s.signal.sourceName,
        tier: s.signal.sourceTier,
        label: s.sentiment.label,
        confidence: s.sentiment.confidence,
        direction: s.sentiment.direction,
        impact: s.impact,
        ageHours: Math.round(s.ageHours * 10) / 10,
        freshness: Math.round(s.freshness * 1000) / 1000,
        counted: s.impact !== 0 && !droppedIds.has(s.signal.id) && !foldedInto.has(s.signal.id),
        // A member folded into a moment names the reading it joined; the reading names what it contributed.
        ...(foldedInto.has(s.signal.id) ? { foldedInto: foldedInto.get(s.signal.id) } : {}),
        ...(momentImpact.has(s.signal.id) ? { momentImpact: momentImpact.get(s.signal.id) } : {}),
        scorer: s.sentiment.scorer,
        anomaly: s.sentiment.anomaly,
        rationale: s.sentiment.rationale,
      })),
    },
  };
}
