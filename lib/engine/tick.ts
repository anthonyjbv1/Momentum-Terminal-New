import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { convictionForce } from "@/lib/engine/forces/conviction";
import { gravityForce } from "@/lib/engine/forces/gravity";
import { computeMood, marketMoodForce } from "@/lib/engine/forces/market-mood";
import { scoreSignals, signalsForce } from "@/lib/engine/forces/signals";
import { tradingActivityForce } from "@/lib/engine/forces/trading-activity";
import { inversePairAdjustments } from "@/lib/engine/inverse-pairs";
import { clamp, round } from "@/lib/engine/math";
import { getSentimentScorer } from "@/lib/engine/sentiment";
import type { SentimentResult, SentimentScorer } from "@/lib/engine/sentiment/types";
import { buySellPrices, computeSpreads } from "@/lib/engine/spread";
import type { EngineStore } from "@/lib/engine/store";
import type { ForceEntry, PersonSummary, PersonTickResult, TickContext, TickPersistence, TickSummary, TickTrigger } from "@/lib/engine/types";
import type { Person } from "@/types";

/**
 * The Engine tick.
 *
 *  1. load active people, unprocessed signals, open capital, signal activity,
 *     the trade tape, inverse pairs and the last tick number
 *  2. score every signal through the SentimentScorer
 *  3. first pass, per person: Gravity, Signals, Market Mood, Conviction,
 *     Trading Activity -> clamp(previous + Σ, floor, ceiling)
 *  4. second pass: inverse pairs, re-clamp
 *  5. LMSR spread -> Buy / Sell prices
 *  6. persist atomically (people, score_history, score_events, signals,
 *     engine_ticks) unless dryRun
 *  7. return the tick summary
 */

export interface EngineTickOptions {
  store: EngineStore;
  scorer?: SentimentScorer;
  config?: EngineConfig;
  now?: Date;
  /** Compute everything and return the summary without persisting. */
  dryRun?: boolean;
  /** Recorded in the summary (and therefore engine_ticks.summary) so cron and manual ticks can be told apart. */
  trigger?: TickTrigger;
}

const FORCE_DECIMALS = 4;
/** Contributions smaller than this are treated as zero and never logged. */
const ZERO_EPSILON = 1e-9;

function deltaHoursFor(person: Person, now: Date, config: EngineConfig): number {
  const last = person.last_tick_at;
  if (!last) return config.tick.firstTickDeltaHours;
  const hours = (now.getTime() - new Date(last).getTime()) / 3_600_000;
  return clamp(hours, 0, config.tick.maxDeltaHours);
}

function roundForce(entry: ForceEntry): ForceEntry {
  const impact = round(entry.impact, FORCE_DECIMALS);
  return { ...entry, impact: Math.abs(impact) < ZERO_EPSILON ? 0 : impact };
}

export async function runEngineTick(options: EngineTickOptions): Promise<TickSummary> {
  const { store, config = DEFAULT_ENGINE_CONFIG, dryRun = false, trigger = "manual" } = options;
  const scorer = options.scorer ?? getSentimentScorer();
  const startedAt = options.now ?? new Date();
  const wallClockStart = Date.now();

  const context: TickContext = await store.loadTickContext(startedAt, config);
  const { floor, ceiling, decimals } = config.score;

  // 2. Sentiment -------------------------------------------------------------
  const sentiments = new Map<string, SentimentResult>();
  await Promise.all(
    context.signals.map(async (signal) => {
      const result = await scorer.scoreSignal({
        id: signal.id,
        personId: signal.personId,
        headline: signal.headline,
        rawPayload: signal.rawPayload,
        sourceName: signal.sourceName,
        sourceTier: signal.sourceTier,
      });
      sentiments.set(signal.id, result);
    }),
  );

  const signalsByPerson = new Map<string, TickContext["signals"]>();
  for (const signal of context.signals) {
    const list = signalsByPerson.get(signal.personId) ?? [];
    list.push(signal);
    signalsByPerson.set(signal.personId, list);
  }

  // 3. First pass ------------------------------------------------------------
  // Gravity and Signals first for everyone, because Market Mood needs the
  // platform-wide Signals movement before it can be applied to anyone.
  const partial = context.people.map((person) => {
    const previousScore = Number(person.current_score);
    const deltaHours = deltaHoursFor(person, startedAt, config);
    const gravity = roundForce(gravityForce(previousScore, Number(person.revert_target), deltaHours, config.gravity));
    const scoredSignals = scoreSignals(signalsByPerson.get(person.id) ?? [], sentiments, config.signals);
    const signals = roundForce(signalsForce(scoredSignals, config.signals));
    const openCapital = context.openCapitalCentsByPerson.get(person.id) ?? 0;
    const concentration = Number(person.max_allocation_cents) > 0 ? openCapital / Number(person.max_allocation_cents) : 0;
    return { person, previousScore, deltaHours, gravity, scoredSignals, signals, openCapital, concentration };
  });

  const allSignalsImpacts = partial.map((p) => p.signals.impact);
  const mood = computeMood(allSignalsImpacts);
  const signalsImpactByPerson = new Map(partial.map((p) => [p.person.id, p.signals.impact]));

  const results: PersonTickResult[] = partial.map((p) => {
    const marketMood = roundForce(marketMoodForce(p.person.slug, p.signals.impact, allSignalsImpacts, config.marketMood));
    const conviction = roundForce(convictionForce(p.openCapital, Number(p.person.max_allocation_cents), config.conviction));
    const tradingActivity = roundForce(
      tradingActivityForce({
        events: context.tradeEvents.filter((e) => e.personId === p.person.id),
        now: startedAt,
        maxAllocationCents: Number(p.person.max_allocation_cents),
        concentration: p.concentration,
        confirmedBySignals: p.scoredSignals.length > 0,
        config: config.tradingActivity,
      }),
    );

    const forces = [p.gravity, p.signals, marketMood, conviction, tradingActivity];
    const sum = forces.reduce((total, f) => total + f.impact, 0);
    const firstPassScore = round(clamp(p.previousScore + sum, floor, ceiling), decimals);

    return {
      person: p.person,
      previousScore: p.previousScore,
      deltaHours: p.deltaHours,
      concentration: p.concentration,
      forces,
      scoredSignals: p.scoredSignals,
      signalsImpact: p.signals.impact,
      firstPassScore,
      inverseAdjustment: 0,
      newScore: firstPassScore,
      spread: Number(p.person.spread),
      buyPrice: 0,
      sellPrice: 0,
    };
  });

  // 4. Second pass: inverse pairs -------------------------------------------
  const inverseEntries = inversePairAdjustments(context.inversePairs, signalsImpactByPerson, config.inversePairs);
  for (const result of results) {
    const entries = (inverseEntries.get(result.person.id) ?? []).map(roundForce).filter((e) => e.impact !== 0);
    if (entries.length === 0) continue;
    result.forces.push(...entries);
    result.inverseAdjustment = round(entries.reduce((sum, e) => sum + e.impact, 0), FORCE_DECIMALS);
    result.newScore = round(clamp(result.firstPassScore + result.inverseAdjustment, floor, ceiling), decimals);
  }

  // 5. LMSR spread + Buy / Sell ---------------------------------------------
  const spreads = computeSpreads(
    results.map((r) => {
      const activity = context.signalActivityByPerson.get(r.person.id);
      const thisTick = r.scoredSignals.length;
      const previousCount = activity?.count ?? 0;
      const previousConfidenceSum = (activity?.averageConfidence ?? 0) * previousCount;
      const thisTickConfidenceSum = r.scoredSignals.reduce((sum, s) => sum + s.sentiment.confidence, 0);
      const depth = previousCount + thisTick;
      return {
        personId: r.person.id,
        openCapitalCents: context.openCapitalCentsByPerson.get(r.person.id) ?? 0,
        maxAllocationCents: Number(r.person.max_allocation_cents),
        signalDepth: depth,
        averageConfidence: depth > 0 ? (previousConfidenceSum + thisTickConfidenceSum) / depth : 0,
      };
    }),
    config.spread,
  );
  for (const result of results) {
    result.spread = round(spreads.get(result.person.id)?.spread ?? config.spread.base, decimals);
    const prices = buySellPrices(result.newScore, result.spread);
    result.buyPrice = round(prices.buyPrice, decimals);
    result.sellPrice = round(prices.sellPrice, decimals);
  }

  // 6. Persist ---------------------------------------------------------------
  // finishedAt is measured relative to the (possibly injected) start time so
  // that runs are reproducible and last_tick_at stays consistent with `now`.
  const elapsedMs = Math.max(0, Date.now() - wallClockStart);
  const finishedAt = new Date(startedAt.getTime() + elapsedMs);
  const summaryPeople: PersonSummary[] = results.map((r) => ({
    id: r.person.id,
    slug: r.person.slug,
    displayName: r.person.display_name,
    revertTarget: Number(r.person.revert_target),
    previousScore: r.previousScore,
    newScore: r.newScore,
    change: round(r.newScore - r.previousScore, decimals),
    spread: r.spread,
    buyPrice: r.buyPrice,
    sellPrice: r.sellPrice,
    forces: Object.fromEntries(
      r.forces.filter((f) => f.impact !== 0).map((f) => [f.force, round(f.impact, FORCE_DECIMALS)]),
    ) as PersonSummary["forces"],
    signalsProcessed: r.scoredSignals.length,
  }));

  const slugById = new Map(results.map((r) => [r.person.id, r.person.slug]));
  const scoredAll = results.flatMap((r) => r.scoredSignals);

  const expectedTickNumber = context.lastTickNumber + 1;
  const summary: TickSummary = {
    tickNumber: expectedTickNumber,
    dryRun,
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: elapsedMs,
    mood: round(mood, FORCE_DECIMALS),
    peopleUpdated: dryRun ? 0 : results.length,
    signalsProcessed: dryRun ? 0 : scoredAll.length,
    people: summaryPeople,
    signals: scoredAll.map((s) => ({
      id: s.signal.id,
      personSlug: slugById.get(s.signal.personId) ?? s.signal.personId,
      headline: s.signal.headline,
      label: s.sentiment.label,
      confidence: s.sentiment.confidence,
      direction: s.sentiment.direction,
      impact: round(s.impact, FORCE_DECIMALS),
      scorer: s.sentiment.scorer,
      rationale: s.sentiment.rationale,
      anomaly: s.sentiment.anomaly,
      narrative: s.sentiment.narrative,
    })),
  };

  if (dryRun) return summary;

  const persistence: TickPersistence = {
    expectedTickNumber,
    startedAt,
    finishedAt,
    mood: summary.mood,
    summary,
    people: results.map((r) => ({ id: r.person.id, score: r.newScore, spread: r.spread })),
    signals: scoredAll.map((s) => ({
      id: s.signal.id,
      impactScore: round(s.impact, FORCE_DECIMALS),
      sentimentLabel: s.sentiment.label,
      sentimentConfidence: s.sentiment.confidence,
    })),
    events: results.flatMap((r) =>
      r.forces
        .filter((f) => f.impact !== 0)
        .map((f) => ({ personId: r.person.id, force: f.force, impact: round(f.impact, FORCE_DECIMALS), details: f.details })),
    ),
  };

  const applied = await store.applyTick(persistence);
  summary.tickNumber = applied.tickNumber;
  summary.peopleUpdated = applied.peopleUpdated;
  summary.signalsProcessed = applied.signalsProcessed;
  return summary;
}
