import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { deadlineAfter, type TickDeadline } from "@/lib/engine/deadline";
import { convictionForce } from "@/lib/engine/forces/conviction";
import { gravityForce } from "@/lib/engine/forces/gravity";
import { computeMood, marketMoodForce } from "@/lib/engine/forces/market-mood";
import { isExpiredSignal, scoreSignals, signalAgeHours, signalsForce } from "@/lib/engine/forces/signals";
import { tradingActivityForce } from "@/lib/engine/forces/trading-activity";
import { inversePairAdjustments } from "@/lib/engine/inverse-pairs";
import { clamp, round } from "@/lib/engine/math";
import { isFreeSignal, selectTickSignals } from "@/lib/engine/selection";
import { getSentimentScorer } from "@/lib/engine/sentiment";
import { TickCallBudget, type DeferralReason } from "@/lib/engine/sentiment/budget";
import { isMetricSignal, metricScorer as defaultMetricScorer } from "@/lib/engine/sentiment/metric";
import { isDeferred, type ScoringContext, type SentimentResult, type SentimentScorer } from "@/lib/engine/sentiment/types";
import { buySellPrices, computeSpreads } from "@/lib/engine/spread";
import type { EngineStore } from "@/lib/engine/store";
import type { EngineSignal, ForceEntry, PersonSummary, PersonTickResult, TickContext, TickPersistence, TickScoringSummary, TickSummary, TickTrigger } from "@/lib/engine/types";
import type { Person } from "@/types";

/**
 * The Engine tick.
 *
 *  1. load active people, the unprocessed backlog (oldest first, up to a
 *     ceiling), open capital, signal activity, the trade tape, inverse pairs
 *     and the last tick number
 *  2. SELECT what this tick takes on: every metric and baseline signal (they
 *     cost nothing) and at most one chunk of event signals per person, one
 *     wave in total (lib/engine/selection.ts)
 *  3. score the selection through the SentimentScorer under the tick's
 *     DEADLINE and CALL BUDGET. A signal comes back scored or DEFERRED; a
 *     deferred signal was never attempted and is left out of everything
 *     below, so it stays unprocessed for the next tick
 *  4. first pass, per person: Gravity, Signals, Market Mood, Conviction,
 *     Trading Activity -> clamp(previous + Σ, floor, ceiling)
 *  5. second pass: inverse pairs, re-clamp
 *  6. LMSR spread -> Buy / Sell prices
 *  7. persist atomically (people, score_history, score_events, the scored
 *     signals, engine_ticks) unless dryRun
 *  8. return the tick summary, with what was attempted, deferred and left
 *
 * THE PROPERTY. The tick always reaches step 7: the deadline gates the start
 * of every model call so scoring finishes inside the budget, and what could
 * not start is deferred rather than waited for. Gravity moves every person
 * on every tick whatever the scorer managed. A tick that does less but
 * always commits beats one that does everything and sometimes dies.
 */

export interface EngineTickOptions {
  store: EngineStore;
  /** Scores event signals (news, comments). */
  scorer?: SentimentScorer;
  /** Scores metric signals (payload kind "metric") from their explicit polarity and sigma. Defaults to the MetricScorer. */
  metricScorer?: SentimentScorer;
  config?: EngineConfig;
  now?: Date;
  /** Compute everything and return the summary without persisting. */
  dryRun?: boolean;
  /** Recorded in the summary (and therefore engine_ticks.summary) so cron and manual ticks can be told apart. */
  trigger?: TickTrigger;
  /** When scoring must be finished. Defaults to config.tick.budgetMs from now. */
  deadline?: TickDeadline;
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
  const metricScorer = options.metricScorer ?? defaultMetricScorer;
  const startedAt = options.now ?? new Date();
  const wallClockStart = Date.now();
  // The clock starts before the load: loading time is tick time.
  const deadline = options.deadline ?? deadlineAfter(config.tick.budgetMs);
  const budgetMs = Number.isFinite(deadline.at) ? Math.max(0, deadline.at - wallClockStart) : null;

  const context: TickContext = await store.loadTickContext(startedAt, config);
  const { floor, ceiling, decimals } = config.score;
  const expectedTickNumber = context.lastTickNumber + 1;
  const slugById = new Map(context.people.map((p) => [p.id, p.slug]));

  // 2. Selection --------------------------------------------------------------
  // Expired event signals (past the freshness limit) are free like metrics:
  // they cost no call, contribute nothing, and are processed so they do not
  // linger. A stale backlog drains in one tick instead of moving a score.
  const expired = (signal: EngineSignal) => isExpiredSignal(signal, startedAt, config.signals);
  const selection = selectTickSignals(context.signals, config.tick, (signal) => isFreeSignal(signal) || expired(signal));

  // 3. Sentiment -------------------------------------------------------------
  // Routed by what the signal IS, not where it came from: a metric signal
  // (payload kind "metric") goes to the metric scorer, everything else to
  // the sentiment scorer. No source is named here. Both get the tick's
  // context; only a scorer that spends money ever defers.
  const scoring: ScoringContext = { deadline, callBudget: new TickCallBudget(config.llm.callBudgetPerTick) };
  const sentiments = new Map<string, SentimentResult>();
  const deferred: TickSummary["deferred"] = [];
  let expiredCount = 0;
  await Promise.all(
    selection.selected.map(async (signal) => {
      if (expired(signal)) {
        expiredCount += 1;
        const days = signalAgeHours(signal, startedAt) / 24;
        sentiments.set(signal.id, {
          label: "neutral",
          confidence: 0,
          direction: 0,
          scorer: "expired",
          rationale: `occurred ${days.toFixed(1)} days ago, past the ${config.signals.freshnessMaxAgeHours / 24}-day freshness limit: processed with zero impact, not scored`,
        });
        return;
      }
      const chosen = isMetricSignal(signal.rawPayload) ? metricScorer : scorer;
      const outcome = await chosen.scoreSignal(
        {
          id: signal.id,
          personId: signal.personId,
          headline: signal.headline,
          rawPayload: signal.rawPayload,
          sourceName: signal.sourceName,
          sourceTier: signal.sourceTier,
          tickNumber: expectedTickNumber,
        },
        scoring,
      );
      if (isDeferred(outcome)) {
        deferred.push({ id: signal.id, personSlug: slugById.get(signal.personId) ?? signal.personId, reason: outcome.reason, detail: outcome.detail });
      } else {
        sentiments.set(signal.id, outcome);
      }
    }),
  );
  const remainingMs = deadline.remainingMs();

  // Only what was actually scored goes any further. A deferred signal is not
  // in the forces, not in the summary's signals, not in the commit.
  const signalsByPerson = new Map<string, TickContext["signals"]>();
  for (const signal of selection.selected) {
    if (!sentiments.has(signal.id)) continue;
    const list = signalsByPerson.get(signal.personId) ?? [];
    list.push(signal);
    signalsByPerson.set(signal.personId, list);
  }

  // 4. First pass ------------------------------------------------------------
  // Gravity and Signals first for everyone, because Market Mood needs the
  // platform-wide Signals movement before it can be applied to anyone.
  const partial = context.people.map((person) => {
    const previousScore = Number(person.current_score);
    const deltaHours = deltaHoursFor(person, startedAt, config);
    const gravity = roundForce(gravityForce(previousScore, Number(person.revert_target), deltaHours, config.gravity));
    const scoredSignals = scoreSignals(signalsByPerson.get(person.id) ?? [], sentiments, config.signals, startedAt);
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

  // 5. Second pass: inverse pairs -------------------------------------------
  const inverseEntries = inversePairAdjustments(context.inversePairs, signalsImpactByPerson, config.inversePairs);
  for (const result of results) {
    const entries = (inverseEntries.get(result.person.id) ?? []).map(roundForce).filter((e) => e.impact !== 0);
    if (entries.length === 0) continue;
    result.forces.push(...entries);
    result.inverseAdjustment = round(entries.reduce((sum, e) => sum + e.impact, 0), FORCE_DECIMALS);
    result.newScore = round(clamp(result.firstPassScore + result.inverseAdjustment, floor, ceiling), decimals);
  }

  // 6. LMSR spread + Buy / Sell ---------------------------------------------
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

  // 7. Persist ---------------------------------------------------------------
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

  const scoredAll = results.flatMap((r) => r.scoredSignals);
  const processed = dryRun ? 0 : scoredAll.length;
  const deferredByReason: Partial<Record<DeferralReason, number>> = {};
  for (const entry of deferred) deferredByReason[entry.reason] = (deferredByReason[entry.reason] ?? 0) + 1;
  const llmScored = scoredAll.filter((s) => s.sentiment.scorer === "llm").length;
  const fallbacks = scoredAll.filter((s) => s.sentiment.scorer === "rules-fallback").length;
  const scoringSummary: TickScoringSummary = {
    backlogBefore: context.backlog,
    loaded: context.signals.length,
    selected: selection.selected.length,
    attempted: llmScored + fallbacks,
    llmScored,
    fallbacks,
    withoutModel: scoredAll.length - llmScored - fallbacks,
    expired: expiredCount,
    deferred: deferred.length,
    deferredByReason,
    llmCalls: scoring.callBudget.used,
    llmCallBudget: config.llm.callBudgetPerTick,
    processed,
    backlogAfter: Math.max(0, context.backlog - processed),
    partial: context.backlog - processed > 0,
    budgetMs,
    remainingMs: Number.isFinite(remainingMs) ? Math.round(remainingMs) : null,
  };

  const summary: TickSummary = {
    tickNumber: expectedTickNumber,
    dryRun,
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: elapsedMs,
    mood: round(mood, FORCE_DECIMALS),
    peopleUpdated: dryRun ? 0 : results.length,
    signalsProcessed: processed,
    scoring: scoringSummary,
    people: summaryPeople,
    signals: scoredAll.map((s) => ({
      id: s.signal.id,
      personSlug: slugById.get(s.signal.personId) ?? s.signal.personId,
      headline: s.signal.headline,
      label: s.sentiment.label,
      confidence: s.sentiment.confidence,
      direction: s.sentiment.direction,
      impact: round(s.impact, FORCE_DECIMALS),
      ageHours: Math.round(s.ageHours * 10) / 10,
      freshness: Math.round(s.freshness * 1000) / 1000,
      scorer: s.sentiment.scorer,
      rationale: s.sentiment.rationale,
      anomaly: s.sentiment.anomaly,
      narrative: s.sentiment.narrative,
    })),
    deferred,
  };

  if (dryRun) return summary;

  // Only the scored signals are in the payload; apply_engine_tick marks
  // processed exactly the ids it is given, so a deferred signal is untouched.
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
  summary.scoring.processed = applied.signalsProcessed;
  summary.scoring.backlogAfter = Math.max(0, context.backlog - applied.signalsProcessed);
  summary.scoring.partial = context.backlog - applied.signalsProcessed > 0;
  return summary;
}
