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
    /** Target cadence of the Engine, in seconds. Not scheduled yet (manual trigger only). */
    intervalSeconds: number;
    /** deltaHours used by Gravity when a person has never been ticked (no last_tick_at). */
    firstTickDeltaHours: number;
    /** Upper bound on deltaHours so a long pause does not snap scores to target in one tick. */
    maxDeltaHours: number;
    /** Most unprocessed signals loaded per tick. */
    maxSignalsPerTick: number;
  };
  score: {
    floor: number;
    ceiling: number;
    /** Decimal places scores are rounded to when persisted. */
    decimals: number;
  };
  /** FORCE 1 — Gravity (mean reversion toward people.revert_target). */
  gravity: {
    /** Decay rate per hour: decayed = target + (score - target) * e^(-lambda * deltaHours). */
    lambdaPerHour: number;
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
    /** Hard cap on LLM calls per tick (rolling tick-interval window). Beyond it, signals use the rules scorer. */
    maxCallsPerTick: number;
    /** How many per-person calls run concurrently. */
    maxConcurrentCalls: number;
    /** Per-call timeout. On timeout the signals fall back to the rules scorer. */
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
    /** How many recent notable events are kept verbatim; older ones are folded into the summary. */
    maxRecentEvents: number;
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
    maxSignalsPerTick: 500,
  },
  score: { floor: 35, ceiling: 100, decimals: 2 },
  gravity: { lambdaPerHour: 0.35 },
  signals: {
    baseImpact: 1.5,
    tierMultipliers: { 1: 1.5, 2: 1.0, 3: 0.5, 4: 0.3, 5: 0.3 },
    defaultTierMultiplier: 0.3,
    maxAbsImpactPerTick: 10,
    maxPerSourcePerTick: 3,
    volumeExponent: 0.5,
  },
  metrics: { fullConfidenceSigma: 3, notableSigma: 2, anomalousSigma: 3 },
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
    maxCallsPerTick: 20,
    maxConcurrentCalls: 4,
    timeoutMs: 20_000,
    maxSignalsPerCall: 12,
    routineConfidenceMultiplier: 0.5,
    notableConfidenceMultiplier: 1.0,
    anomalousConfidenceMultiplier: 1.2,
    minRelativeChangeForLlm: 0.002,
    memoryCacheTtlMs: 60_000,
  },
  narratives: { minAbsChange: 0.5, maxPerTick: 16 },
  memory: { notableImpactThreshold: 0.5, maxRecentEvents: 8, llmSummaries: true },
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
}

/** A strictly positive integer from a raw environment string, or null. */
export function parsePositiveInteger(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** DEFAULT_ENGINE_CONFIG with any environment overrides applied. */
export function engineConfigFromEnv(env: EngineEnvOverrides, base: EngineConfig = DEFAULT_ENGINE_CONFIG): EngineConfig {
  const overrides: DeepPartial<EngineConfig> = {};
  const minPopulatedWindows = parsePositiveInteger(env.tradingMinPopulatedWindows);
  if (minPopulatedWindows !== null) overrides.tradingActivity = { minPopulatedWindows };
  return withEngineConfig(overrides, base);
}

/** The overrides that differ from the defaults, for the tick log. */
export function describeEngineOverrides(config: EngineConfig, base: EngineConfig = DEFAULT_ENGINE_CONFIG): string[] {
  const out: string[] = [];
  if (config.tradingActivity.minPopulatedWindows !== base.tradingActivity.minPopulatedWindows) {
    out.push(`tradingActivity.minPopulatedWindows = ${config.tradingActivity.minPopulatedWindows} (default ${base.tradingActivity.minPopulatedWindows})`);
  }
  return out;
}
