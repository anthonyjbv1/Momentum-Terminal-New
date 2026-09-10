/**
 * Every tuning constant of the Engine lives here. Nothing else in lib/engine
 * hard-codes a number. Adjust values in DEFAULT_ENGINE_CONFIG; tests and the
 * tick runner can pass overrides through withEngineConfig().
 *
 * The values mirror the proven formulas of the previous platform:
 *   theta decay λ = 0.35/h, tier-weighted confidence-scaled news impact,
 *   tidal propagation with a brake, the open-interest ramp, the 1.5σ
 *   net-order-flow pre-emption weighted 0.25 (0.4× when unconfirmed) and the
 *   LMSR spread with liquidity parameter b = 5000.
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
    /** Only act when the current flow score is further than this many baseline standard deviations from the baseline mean. */
    thresholdStdDevs: number;
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
  },
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
    thresholdStdDevs: 1.5,
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

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

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
