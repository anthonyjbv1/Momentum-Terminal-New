/**
 * Every tuning constant of the Engine lives here. Nothing else in lib/engine
 * hard-codes a number. Adjust values in DEFAULT_ENGINE_CONFIG; tests and the
 * tick runner can pass overrides through withEngineConfig().
 *
 * The values mirror the proven formulas of the previous platform:
 *   theta decay λ = 0.35/h, tier-weighted confidence-scaled news impact,
 *   tidal propagation with a brake, the open-interest ramp, the baseline-
 *   relative net-order-flow force (1.0σ deadband, weighted 0.25, 0.4× when
 *   unconfirmed, with a minimum-sample guard and an sd floor) and the LMSR
 *   spread with liquidity parameter b = 5000.
 */

export interface EngineConfig {
  tick: {
    /** Target cadence of the Engine, in seconds. */
    intervalSeconds: number;
    /** deltaHours used by Gravity when a person has never been ticked (no last_tick_at). */
    firstTickDeltaHours: number;
    /** Upper bound on deltaHours so a long pause does not snap scores to target in one tick. */
    maxDeltaHours: number;
    /**
     * WALL-CLOCK BUDGET OF ONE TICK, in milliseconds, from the moment it
     * starts to the moment its scoring must be finished. The commit follows
     * immediately. Two ticks run per one-minute cron invocation inside a
     * 55-second budget under the route's 60-second maxDuration, so each tick
     * gets roughly half of that. The deadline gates STARTS (no model call
     * begins after budgetMs − llm.timeoutMs); nothing is aborted, and what
     * could not start is deferred to the next tick.
     */
    budgetMs: number;
    /**
     * Unprocessed rows READ per tick, oldest first. This is a read ceiling,
     * not the amount of work: the selection below decides what is scored.
     * It has to see past one subject's backlog to reach the others', which is
     * why it is much larger than the event bound.
     */
    loadCeiling: number;
    /**
     * EVENT SIGNALS SCORED PER TICK, the load in LLM shape:
     * llm.callBudgetPerTick × llm.maxSignalsPerCall, one wave of the pool.
     * Metric and baseline signals are free (they never reach the model) and
     * are not counted against it. Whatever is not selected simply stays
     * unprocessed for the next tick.
     */
    maxEventSignalsPerTick: number;
    /**
     * ONE CHUNK PER PERSON PER TICK: at most llm.maxSignalsPerCall event
     * signals of one person are selected in a tick, so a single subject's
     * backlog cannot own the whole tick. A requirement, not a tuning (see
     * sentiment/budget.ts); pinned by config.test.ts.
     */
    maxEventSignalsPerPersonPerTick: number;
  };
  score: {
    floor: number;
    ceiling: number;
    /**
     * Decimal places scores are rounded to when persisted. FOUR, since Phase
     * 14, and this is the precision of the STORED score only: every surface
     * formats to one or two decimals and every quote is rounded to whole
     * cents on both sides (points_to_cents, pointsToCents), so nothing
     * user-facing changes with it.
     *
     * Why not two. At the 30-second cadence Gravity's pull in one tick is
     * gap × (1 − e^(−0.35/120)) = gap × 0.0029; once a score is within 1.72
     * points of its target that is under half a cent, and rounding to two
     * decimals discarded it on EVERY tick. The first 24-hour run showed the
     * result: every person without signals stuck 1.3 to 1.7 points short of
     * their target, moved only when Market Mood tipped a tick over the
     * rounding edge, and the board read as frozen. Four decimals keep the
     * dead zone under 0.02 points. Not a force constant: no force changed.
     */
    decimals: number;
  };
  /** FORCE 1 — Gravity (mean reversion toward the person's target: revert_target, plus the drift below when it is on). */
  gravity: {
    /** Decay rate per hour: decayed = target + (score - target) * e^(-lambda * deltaHours). */
    lambdaPerHour: number;
  };
  /**
   * THE DRIFTING TARGET (Phase 14). Gravity's target as "what is normal for
   * this person", moved by sustained signal evidence over WEEKS, instead of
   * a seeded constant that becomes the ranking once every score has settled.
   *
   *   target = revert_target (the seed) + offset,   |offset| ≤ bound
   *
   * The evidence is the Signals force itself, the one thing that moved the
   * score because of the world rather than because of the platform (Market
   * Mood, trades and Gravity never feed it): two exponential averages of its
   * impact per hour with this section's own half-life, ATTENTION (the gross
   * impact, direction ignored) and DIRECTION (the signed impact). Then
   *
   *   coverage = min(attention / fullCoverageImpactPerHour, 1)      0..1
   *   lean     = clamp(direction / fullCoverageImpactPerHour, −1, 1) −1..1
   *   offset   = bound × (coverage × (1 + lean) − 1)
   *
   * so with no evidence the normal sinks to seed − bound (the floor); full
   * coverage that is balanced holds the seed; full coverage that is as
   * positive as it is full holds seed + bound (the ceiling); and sustained
   * negative coverage sinks to the floor as an inert person does, while the
   * Signals force keeps pushing their score below it in real time. The
   * floor is PER PERSON (their own seed less the bound), so the seeded order
   * of prominence survives among the quiet; a common floor would erase it.
   *
   * A person the drift has never measured is presumed fully covered and
   * balanced (attention = fullCoverageImpactPerHour, direction = 0, offset
   * 0), so turning the switch on moves no target at all; the normal then
   * drifts from the seed at the half-life's pace as evidence accrues or
   * fails to. Off, the state is not kept: nothing accumulates in the dark,
   * and a target is its seed.
   *
   * THE FOURTH CLOCK, kept apart on purpose: Signals freshness weights a
   * signal in the queue (hours); memory expiry decides what the model is
   * shown verbatim (a 30-day cutoff); Gravity decays a score toward its
   * target (λ per hour); this moves the target itself, and is the slowest
   * of the four by an order of magnitude. Its constants are its own and
   * must stay its own. TUNABLE, all three.
   */
  targetDrift: {
    /** The switch. Ships false. ENGINE_TARGET_DRIFT_ENABLED=true turns it on deliberately. */
    enabled: boolean;
    /** The clock: half-life, in hours, of the two evidence averages. 336 is two weeks. */
    halfLifeHours: number;
    /** The bound: the target never leaves seed ± this many points. */
    bound: number;
    /**
     * The gross Signals impact per hour, averaged over the half-life, at
     * which a person counts as fully covered. 0.2 is about five points of
     * signal impact a day, roughly twenty scored items at routine
     * confidence: what every covered subject of the first run produced.
     * The one constant here most likely to move, and the known weakness of
     * the design: it is global, so a person with more sources reaches it
     * more easily, the same weakness the volume normalisation carries and
     * with the same honest fix (each person's own trailing volume) once
     * there is history to build it from.
     */
    fullCoverageImpactPerHour: number;
  };
  /** FORCE 2 — Signals (news impact). */
  signals: {
    /** Maximum impact of one signal at confidence 1 and tier multiplier 1. */
    baseImpact: number;
    /** data_sources.tier -> multiplier. */
    tierMultipliers: Record<number, number>;
    /** Used for tiers missing from the table above. */
    defaultTierMultiplier: number;
    /** Brake: |sum of signal impacts| per person per tick is capped here. */
    maxAbsImpactPerTick: number;
    /**
     * PER-PERSON VOLUME NORMALISATION (Phase 7). Signals from one source
     * beyond this count in a tick are dropped, strongest kept, so a source
     * that produces many items per poll (comments, a busy feed) cannot
     * outvote a source that produces one.
     */
    maxPerSourcePerTick: number;
    /**
     * The kept signals are summed and divided by count^volumeExponent, so the
     * force grows with the number of signals but not linearly: at 0.5, four
     * signals of one strength read twice one of them, not four times.
     * Assumption: signals in one tick are partially redundant evidence of the
     * same day, so they add like independent noise (in quadrature) rather
     * than like independent events. 0 sums, 1 averages.
     */
    volumeExponent: number;
    /**
     * FRESHNESS (Phase 12). An event signal's impact is multiplied by
     * 2^(−age / freshnessHalfLifeHours), where age is the gap between its
     * occurred_at and the tick, and is exactly zero at and past
     * freshnessMaxAgeHours: a signal that old contributes nothing, is never
     * sent to the model, and is still marked processed so it cannot linger
     * in the backlog. Metric signals are never aged: their own baseline
     * windows say what is stale for them.
     *
     * This weights staleness in the QUEUE, once, at the moment the signal
     * contributes. Staleness in the SCORE is Gravity's job and nothing here
     * decays a score. TUNABLE.
     */
    freshnessHalfLifeHours: number;
    freshnessMaxAgeHours: number;
    /**
     * ONE MOMENT, ONE READING (Phase 13+). Metric signals from one source
     * that share an occurred_at are facets of one observation — the three
     * per-game figures of one football game, the subscriber and view growth
     * of one channel poll — not independent evidence of a busy day. When
     * true, the force folds them into ONE reading whose impact is the mean
     * of theirs before the per-source cap, so a game contributes its event
     * and its stat line and never three correlated copies of the line.
     * Event signals are never folded.
     */
    oneReadingPerMetricMoment: boolean;
    /**
     * PER-PERSON VOLUME NORMALISATION, the trailing kind (Phase 15). Every
     * event signal's impact is multiplied by referenceSignalsPerDay divided
     * by the person's own typical event signals per day (the mean of their
     * daily counts on complete days since their newest source mapping was
     * created, over windowDays), bounded to [minWeight, maxWeight]. A person
     * at the reference volume reads exactly as before; one covered five
     * times as much reads each item at a fifth; one covered a quarter as
     * much reads each item at up to maxWeight. Until minSamples complete
     * days exist the weight is 1. The shared baseline utility supplies the
     * mean, and its sigma of the trailing-24h count is carried into the
     * force's details as "how unusual today's volume is for this person".
     * Metric signals are never weighted: they carry their own baseline.
     *
     * THE REFERENCE, RE-DERIVED 2026-09-18 FROM MEASURED VOLUME (Phase 18++).
     * Phase 15 chose 20 against an assumed roster of 3-100 events a day. The
     * real roster runs 0.5 to 30, so 20 put fourteen of sixteen people on the
     * maxWeight ceiling: a near-constant 2x on the force, which normalises
     * nobody. The value is now the GEOMETRIC MEAN of the roster's per-person
     * daily event rate, rounded:
     *
     *   window              geometric mean   median   arithmetic mean
     *   last 2 complete          3.85          3.00         6.40
     *   last 3 complete          3.70          3.33         6.24
     *   last 4 complete          3.50          3.25         5.43
     *
     * measured over the days in which the whole roster was ingesting, people
     * with no volume at all excluded from the mean (log 0 is undefined) and
     * reported separately. The geometric mean is the right centre because the
     * weight is multiplicative: setting log(reference) to the mean of
     * log(rate) centres the log-weights on zero, so as many subjects are
     * scaled up as down and by proportionate amounts. The arithmetic mean
     * (5.4-6.4) is dragged by one subject's game-day spikes and would push
     * the quiet majority below 1; the median (3.0-3.3) agrees within 20 %,
     * which is itself evidence the choice is not knife-edge. Rounded to 4.
     *
     * What it buys, on the three-day rates: the spread of a TYPICAL DAY's
     * total impact across the roster falls from 14.9x (at 20) to 3.0x, and
     * the ceiling catches five of sixteen rather than fourteen.
     *
     * IT WILL GO STALE AGAIN, because it is a cross-person constant inside a
     * per-person mechanism. That is deliberate: a roster-relative reference
     * would self-correct but couple every person's weight to every other
     * person's. Ten new subjects at half an event a day would move the live
     * geometric mean 3.71 -> 1.66 and so cut every existing subject's weight
     * by 55 % overnight, for reasons having nothing to do with them (at one a
     * day, 41 %; three loud subjects at eight a day would raise every weight
     * 14 %). A fixed constant goes stale visibly instead. REVIEW WHEN EITHER
     * more than a third of the people with a sufficient baseline sit at a
     * bound, OR the roster's live geometric mean leaves [reference / 2,
     * reference x 2]. Both are on /admin under Signal volume, and
     * volumeSpread() in lib/engine/signal-volume.ts computes them.
     *
     * THE BOUNDS, examined with the reference (Phase 18++). maxWeight 2 now
     * binds below 2 events a day, where a person's rate is estimated from a
     * handful of events and its relative error is large: it is a variance
     * guard on the subjects we know least about, which is what a cap should
     * be, and at 20 it had become the mechanism itself. minWeight 0.1 binds
     * above 40 events a day and nobody is close; a floor that never fires is
     * a floor doing its job, and it remains the guard against a runaway
     * connector reading as a person with no news.
     *
     * TUNABLE, and overridable without a code change: ENGINE_VOLUME_REFERENCE.
     */
    volume: {
      referenceSignalsPerDay: number;
      windowDays: number;
      minSamples: number;
      /** Floor on the daily-count standard deviation, in signals per day. */
      sdFloor: number;
      thresholdStdDevs: number;
      minWeight: number;
      maxWeight: number;
    };
  };
  /** The metric scorer (Phase 7): how a normalised deviation becomes confidence. */
  metrics: {
    /** |sigma| at which a metric with scale 1 reaches confidence 1. */
    fullConfidenceSigma: number;
    /** |sigma| from which a metric reading is remembered as notable. */
    notableSigma: number;
    /** |sigma| from which a metric reading is remembered as anomalous. */
    anomalousSigma: number;
  };
  /**
   * FORCE 6 — Forecast, the crowd layer (Phase 19). Present in name only.
   *
   * The crowd's forecasts (▲ Rising / ▼ Falling on a person, with a reason)
   * are captured and displayed, and they influence NOTHING: this weight is
   * 0.00, no force module reads it, and no vote is loaded by the tick. The
   * spec starts the crowd's weight at zero until accuracy history exists,
   * and the regulatory gate (reflexivity limits, awaiting counsel) is the
   * same number. Raising it is a deliberate act with a test to change first:
   * lib/engine/forecast.test.ts pins it at 0 and proves a tick with votes
   * present scores exactly as a tick without.
   */
  forecast: {
    /** Ships 0.00. Nothing multiplies by it yet; a non-zero value here does nothing until a force is built to read it. */
    weight: number;
  };
  /**
   * The prescored scorer (Phase 16): a live moment arrives with its own
   * direction and confidence, declared by the live runner from the session's
   * arithmetic; the Engine only decides how memorable it is.
   */
  live: {
    /** Declared confidence from which a live moment is remembered as notable. */
    notableConfidence: number;
    /** Declared confidence from which a live moment is remembered as anomalous. */
    anomalousConfidence: number;
  };
  /** FORCE 3 — Market Mood (global sentiment tide). */
  marketMood: {
    /** Fraction of the mood applied to each person. */
    fraction: number;
    /** Sensitivity used for people not listed in sensitivityBySlug. */
    defaultSensitivity: number;
    /** Per-person overrides keyed by people.slug. */
    sensitivityBySlug: Record<string, number>;
    /** Brake: the mood itself is clamped to ±this before the fraction is applied. */
    maxAbsMood: number;
    /** Brake: the per-person impact is clamped to ±this. */
    maxAbsImpact: number;
  };
  /** FORCE 4 — Conviction (capital concentration = open capital / max_allocation). */
  conviction: {
    /** Up to this concentration the force is 0. */
    neutralUpTo: number;
    /** Between neutralUpTo and this, a linear ramp from positiveMin to positiveMax. */
    positiveUpTo: number;
    positiveMin: number;
    positiveMax: number;
    /** Above positiveUpTo, a linear ramp from -negativeMin (just above) to -negativeMax at 100%. */
    negativeMin: number;
    negativeMax: number;
    /** Absolute cap of the negative side. */
    cap: number;
  };
  /**
   * FORCE 5 — Trading Activity (live Buy/Sell velocity), measured against a
   * rolling baseline rather than against zero.
   *
   * TUNABLES: `baselineHours` and `weight` are the two knobs expected to move
   * once real flow exists. Retune them against live trade_events when the
   * heartbeat is on, and again when platform_settings.shorting_enabled is
   * flipped and flow can go negative.
   */
  tradingActivity: {
    /** Rolling window for the current net flow, in seconds. */
    windowSeconds: number;
    /**
     * BASELINE WINDOW. How far back the rolling baseline reaches, in hours:
     * the mean of windowed net flow over this span is "normal flow" for the
     * person, its standard deviation is the noise floor. Longer is steadier
     * and slower to adopt a new normal; shorter adapts faster.
     */
    baselineHours: number;
    /**
     * MINIMUM SAMPLE GUARD. Windows in the baseline that saw at least one
     * trade. Below this count the force returns 0 and reports "insufficient
     * baseline": on day one, and for a newly added person, the variance of a
     * mostly-empty baseline is near zero and every trade would otherwise land
     * far outside the band.
     */
    minPopulatedWindows: number;
    /**
     * STANDARD-DEVIATION FLOOR, in flow-score units (net flow as a fraction of
     * max_allocation_cents per window). The baseline sd is never taken below
     * this, so a quiet but non-zero period cannot produce a many-sigma reading
     * from a small deviation.
     */
    sdFloor: number;
    /**
     * DEADBAND THRESHOLD, in baseline standard deviations. Inside the band the
     * force reports the small in-band value; outside it the full deviation.
     * TUNABLE.
     */
    thresholdStdDevs: number;
    /**
     * IN-BAND SCALING. Inside the band the adjustment is deviation × weight ×
     * this, so normal trading nudges rather than moves. TUNABLE.
     */
    inBandScale: number;
    /**
     * IN-BAND FLOOR, in score points. The smallest magnitude the force reports
     * once a baseline exists and flow is off it (signed by the deviation), so
     * the force reads alive during normal trading. 0.01 is the smallest
     * non-zero force at the score's two decimals. TUNABLE.
     */
    inBandMinImpact: number;
    /**
     * SCALING FACTOR. adjustment = (flowScore − baselineMean) · weight, where
     * flowScore is net flow as a fraction of max_allocation_cents.
     */
    weight: number;
    /** Multiplier when no signal confirms the move this tick (pump protection). */
    unconfirmedDampening: number;
    /** Gate: skip evaluation when the person's capital concentration is below this. */
    minConcentration: number;
    /** Absolute cap of the adjustment. */
    maxAbsImpact: number;
  };
  /** Second pass — inverse pairs. */
  inversePairs: {
    /** Used when an inverse_pairs row has no dampening. */
    defaultDampening: number;
  };
  /** LLM reasoning layer (Phase 4): cost controls and anomaly folding. */
  llm: {
    /**
     * PER-TICK CALL BUDGET: a plain count of model calls one tick may make,
     * owned by the tick (sentiment/budget.ts). Chunks beyond it are DEFERRED
     * to the next tick, not scored by rules. Distinct from the rolling rate
     * limit below, which is what the old "maxCallsPerTick" actually was.
     */
    callBudgetPerTick: number;
    /**
     * ROLLING RATE LIMIT: at most this many calls per tick interval across
     * the whole process, whatever tick they belong to. A safety net against
     * a caller hammering the manual route, never the per-tick budget: it
     * rolls with the clock, so it cannot bound one tick's work.
     */
    rollingWindowMaxCalls: number;
    /** How many per-person calls run concurrently. */
    maxConcurrentCalls: number;
    /**
     * Per-call timeout, ONE ATTEMPT. The adapter does not retry inside a
     * tick: the next tick, thirty seconds later, is the retry, and it costs
     * one attempt rather than two. A timed-out chunk falls back to rules.
     */
    timeoutMs: number;
    /** Most signals about one person reasoned together in a single call. */
    maxSignalsPerCall: number;
    /** Confidence multipliers by anomaly assessment: routine noise is damped, genuine anomalies amplified (capped at 1). */
    routineConfidenceMultiplier: number;
    notableConfidenceMultiplier: number;
    anomalousConfidenceMultiplier: number;
    /** "change" signals below this relative move never reach the LLM (rules scorer instead). */
    minRelativeChangeForLlm: number;
    /** Per-entity memory is cached this long so a profile is not re-fetched within a tick. */
    memoryCacheTtlMs: number;
  };
  /** Narrative generation (the Engine explaining meaningful moves). */
  narratives: {
    /** Only moves with |change| >= this get a narrative. */
    minAbsChange: number;
    /** Most narratives written per tick. */
    maxPerTick: number;
  };
  /** Per-entity memory updates. */
  memory: {
    /** A processed signal with |impact| >= this (or flagged notable / anomalous) is remembered. */
    notableImpactThreshold: number;
    /** How many recent notable events are kept verbatim; older ones are folded into the summary. A size cap. */
    maxRecentEvents: number;
    /**
     * EVENT EXPIRY (Phase 12+). A notable event older than this leaves the
     * verbatim list whatever the count, folded into the summary with its
     * date as history, so one dramatic event cannot frame a quiet person
     * for months. This is the "what is normal for this person" clock: much
     * slower than the Signals force's freshness half-life on purpose, and
     * a separate constant that must stay separate. TUNABLE.
     */
    maxEventAgeDays: number;
    /** Use the LLM to fold overflowing events into the summary (one small call); otherwise a deterministic summary. */
    llmSummaries: boolean;
  };
  /** LMSR dynamic spread. */
  spread: {
    base: number;
    max: number;
    /** LMSR liquidity parameter b, in dollars (capital / b feeds exp()). */
    lmsrLiquidity: number;
    /** Window for "signal activity depth" and confidence, in hours. */
    depthWindowHours: number;
    /** Number of processed signals in the window at which depth tightening saturates. */
    depthSaturationSignals: number;
    /** Tightening weights (should sum to 1). */
    weights: { concentration: number; depth: number; confidence: number };
  };
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  tick: {
    intervalSeconds: 30,
    firstTickDeltaHours: 30 / 3600,
    maxDeltaHours: 24,
    budgetMs: 25_000,
    loadCeiling: 500,
    maxEventSignalsPerTick: 48,
    maxEventSignalsPerPersonPerTick: 12,
  },
  score: { floor: 35, ceiling: 100, decimals: 4 },
  gravity: { lambdaPerHour: 0.35 },
  targetDrift: { enabled: false, halfLifeHours: 336, bound: 8, fullCoverageImpactPerHour: 0.2 },
  signals: {
    baseImpact: 1.5,
    tierMultipliers: { 1: 1.5, 2: 1.0, 3: 0.5, 4: 0.3, 5: 0.3 },
    defaultTierMultiplier: 0.3,
    maxAbsImpactPerTick: 10,
    maxPerSourcePerTick: 3,
    volumeExponent: 0.5,
    freshnessHalfLifeHours: 24,
    freshnessMaxAgeHours: 168,
    oneReadingPerMetricMoment: true,
    volume: { referenceSignalsPerDay: 4, windowDays: 14, minSamples: 7, sdFloor: 2, thresholdStdDevs: 1, minWeight: 0.1, maxWeight: 2 },
  },
  metrics: { fullConfidenceSigma: 3, notableSigma: 2, anomalousSigma: 3 },
  live: { notableConfidence: 0.5, anomalousConfidence: 0.9 },
  forecast: { weight: 0 },
  marketMood: {
    fraction: 0.25,
    defaultSensitivity: 1.0,
    sensitivityBySlug: {},
    maxAbsMood: 2.0,
    maxAbsImpact: 0.5,
  },
  conviction: {
    neutralUpTo: 0.6,
    positiveUpTo: 0.85,
    positiveMin: 0.05,
    positiveMax: 0.15,
    negativeMin: 0.05,
    negativeMax: 0.15,
    cap: 0.3,
  },
  tradingActivity: {
    windowSeconds: 60,
    baselineHours: 24,
    minPopulatedWindows: 30,
    sdFloor: 0.01,
    thresholdStdDevs: 1.0,
    inBandScale: 0.25,
    inBandMinImpact: 0.01,
    weight: 0.25,
    unconfirmedDampening: 0.4,
    minConcentration: 0.15,
    maxAbsImpact: 0.3,
  },
  inversePairs: { defaultDampening: 0.4 },
  llm: {
    callBudgetPerTick: 4,
    rollingWindowMaxCalls: 20,
    maxConcurrentCalls: 4,
    timeoutMs: 15_000,
    maxSignalsPerCall: 12,
    routineConfidenceMultiplier: 0.5,
    notableConfidenceMultiplier: 1.0,
    anomalousConfidenceMultiplier: 1.2,
    minRelativeChangeForLlm: 0.002,
    memoryCacheTtlMs: 60_000,
  },
  narratives: { minAbsChange: 0.5, maxPerTick: 16 },
  memory: { notableImpactThreshold: 0.5, maxRecentEvents: 8, maxEventAgeDays: 30, llmSummaries: true },
  spread: {
    base: 0.5,
    max: 1.5,
    lmsrLiquidity: 5000,
    depthWindowHours: 24,
    depthSaturationSignals: 10,
    weights: { concentration: 0.5, depth: 0.3, confidence: 0.2 },
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** DEFAULT_ENGINE_CONFIG with nested overrides applied (one level deep per section). */
export function withEngineConfig(overrides: DeepPartial<EngineConfig>, base: EngineConfig = DEFAULT_ENGINE_CONFIG): EngineConfig {
  const merged = { ...base } as Record<string, unknown>;
  for (const [section, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const current = (base as unknown as Record<string, unknown>)[section];
    merged[section] =
      current !== null && typeof current === "object" && value !== null && typeof value === "object"
        ? { ...(current as object), ...(value as object) }
        : value;
  }
  return merged as unknown as EngineConfig;
}

// ---------------------------------------------------------------------------
// Environment overrides (the controlled test)
// ---------------------------------------------------------------------------

/**
 * The raw strings of the environment variables that may move a tunable from
 * outside the code. lib/env.ts reads them; this module only parses them, so
 * the parsing is unit-tested without touching process.env.
 *
 * Every override is opt-in and strict: unset, empty or malformed leaves the
 * code default exactly as it is. Nothing here lowers a default.
 */
export interface EngineEnvOverrides {
  /**
   * ENGINE_TRADING_MIN_POPULATED_WINDOWS. The Trading Activity minimum-sample
   * guard (tradingActivity.minPopulatedWindows, default 30). A small beta
   * group trading occasionally may never populate thirty windows in a day,
   * which would leave the force permanently silent and untested; during the
   * controlled test it can be lowered DELIBERATELY here. The default is not
   * changed. A positive integer; anything else is ignored.
   */
  tradingMinPopulatedWindows?: string | undefined;
  /**
   * ENGINE_TARGET_DRIFT_ENABLED. The switch of the drifting target
   * (targetDrift.enabled, default false). Only the exact string "true"
   * turns it on, like the two cron flags; anything else leaves it off.
   */
  targetDriftEnabled?: string | undefined;
  /**
   * ENGINE_VOLUME_REFERENCE. The per-person volume weight's reference rate
   * (signals.volume.referenceSignalsPerDay, default 4, derived from the
   * roster's measured geometric mean). This one is EXPECTED to need
   * re-deriving as subjects and sources are added, so it can be re-set here
   * rather than waiting on a code change; the default stands until it is. A
   * positive number, decimals allowed; anything else is ignored.
   */
  volumeReference?: string | undefined;
}

/** A strictly positive integer from a raw environment string, or null. */
export function parsePositiveInteger(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The exact string "true", trimmed, and nothing else: the same rule as the cron flags. */
export function parseExactTrue(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.trim() === "true";
}

/** A strictly positive finite number from a raw environment string, or null. Decimals allowed. */
export function parsePositiveNumber(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** DEFAULT_ENGINE_CONFIG with any environment overrides applied. */
export function engineConfigFromEnv(env: EngineEnvOverrides, base: EngineConfig = DEFAULT_ENGINE_CONFIG): EngineConfig {
  const overrides: DeepPartial<EngineConfig> = {};
  const minPopulatedWindows = parsePositiveInteger(env.tradingMinPopulatedWindows);
  if (minPopulatedWindows !== null) overrides.tradingActivity = { minPopulatedWindows };
  if (parseExactTrue(env.targetDriftEnabled)) overrides.targetDrift = { enabled: true };
  const volumeReference = parsePositiveNumber(env.volumeReference);
  // withEngineConfig merges ONE level deep, so a nested section has to be
  // handed over whole: `{ volume: { referenceSignalsPerDay } }` alone would
  // replace the volume block and lose minSamples, the bounds and the rest.
  if (volumeReference !== null) overrides.signals = { volume: { ...base.signals.volume, referenceSignalsPerDay: volumeReference } };
  return withEngineConfig(overrides, base);
}

/** The overrides that differ from the defaults, for the tick log. */
export function describeEngineOverrides(config: EngineConfig, base: EngineConfig = DEFAULT_ENGINE_CONFIG): string[] {
  const out: string[] = [];
  if (config.tradingActivity.minPopulatedWindows !== base.tradingActivity.minPopulatedWindows) {
    out.push(`tradingActivity.minPopulatedWindows = ${config.tradingActivity.minPopulatedWindows} (default ${base.tradingActivity.minPopulatedWindows})`);
  }
  if (config.targetDrift.enabled !== base.targetDrift.enabled) {
    out.push(`targetDrift.enabled = ${config.targetDrift.enabled} (default ${base.targetDrift.enabled})`);
  }
  if (config.signals.volume.referenceSignalsPerDay !== base.signals.volume.referenceSignalsPerDay) {
    out.push(`signals.volume.referenceSignalsPerDay = ${config.signals.volume.referenceSignalsPerDay} (default ${base.signals.volume.referenceSignalsPerDay})`);
  }
  return out;
}
