import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG, describeEngineOverrides, engineConfigFromEnv, parseExactTrue, parsePositiveInteger, parsePositiveNumber } from "./config";
import { CRON_DEFAULTS } from "./cron";
import { CALLS_PER_PERSON_PER_TICK } from "./sentiment/budget";
import { CALL_OVERHEAD_MS } from "./sentiment/llm";

/**
 * THE TICK THAT ALWAYS COMMITS: the numbers that make it true, pinned.
 *
 * These are relations, not tunings. Each one is a line of the failure
 * analysis of the first cron run (a ~65 s tick killed at 60 s every minute,
 * committed never), and loosening any of them re-opens that failure.
 */
describe("Phase 11 invariants", () => {
  const { tick, llm } = DEFAULT_ENGINE_CONFIG;

  it("ONE CHUNK PER PERSON PER TICK: the per-person selection bound is exactly one call's worth, and a person gets one call", () => {
    expect(CALLS_PER_PERSON_PER_TICK).toBe(1);
    expect(tick.maxEventSignalsPerPersonPerTick).toBe(llm.maxSignalsPerCall);
    expect(tick.maxEventSignalsPerPersonPerTick).toBe(12);
  });

  it("the event load is one wave of the pool: callBudgetPerTick × maxSignalsPerCall, with the budget equal to the concurrency", () => {
    expect(tick.maxEventSignalsPerTick).toBe(llm.callBudgetPerTick * llm.maxSignalsPerCall);
    expect(llm.callBudgetPerTick).toBe(llm.maxConcurrentCalls);
    expect(tick.maxEventSignalsPerTick).toBe(48);
    expect(llm.callBudgetPerTick).toBe(4);
  });

  it("the per-tick budget is a count, distinct from the rolling rate limit; the old name is gone", () => {
    expect("maxCallsPerTick" in llm).toBe(false);
    expect("maxSignalsPerTick" in tick).toBe(false);
    expect(llm.rollingWindowMaxCalls).toBe(20);
    expect(llm.rollingWindowMaxCalls).toBeGreaterThan(llm.callBudgetPerTick);
  });

  it("one attempt of 15 s per call, and a call can always start at the top of a 25 s tick", () => {
    expect(llm.timeoutMs).toBe(15_000);
    expect(tick.budgetMs).toBe(25_000);
    expect(llm.timeoutMs + CALL_OVERHEAD_MS).toBeLessThan(tick.budgetMs);
  });

  it("two ticks fit the cron invocation: the second slot, at 30 s, holds a full tick less the commit reserve", () => {
    const secondSlot = CRON_DEFAULTS.budgetMs - CRON_DEFAULTS.spacingMs - CRON_DEFAULTS.commitReserveMs;
    expect(secondSlot).toBeGreaterThanOrEqual(CRON_DEFAULTS.minTickBudgetMs);
    expect(secondSlot).toBeGreaterThan(llm.timeoutMs + CALL_OVERHEAD_MS); // a call can still start in the second tick
    expect(CRON_DEFAULTS.spacingMs + tick.budgetMs).toBeLessThan(60_000); // and the second tick's own budget ends under maxDuration
  });

  it("reads past one subject's backlog: the load ceiling is far above the event bound", () => {
    expect(tick.loadCeiling).toBe(500);
    expect(tick.loadCeiling).toBeGreaterThanOrEqual(tick.maxEventSignalsPerTick * 10);
  });
});

/**
 * FRESHNESS (Phase 12): the tunables, and the promise that they are the only
 * age mechanism — the score's own decay is Gravity's and is untouched.
 */
describe("Phase 12 invariants", () => {
  const { signals, gravity } = DEFAULT_ENGINE_CONFIG;

  it("half-life 24 h, zero at 7 days, named as tunables on the Signals force", () => {
    expect(signals.freshnessHalfLifeHours).toBe(24);
    expect(signals.freshnessMaxAgeHours).toBe(168);
    expect(signals.freshnessMaxAgeHours).toBeGreaterThan(signals.freshnessHalfLifeHours);
  });

  it("no second score-decay mechanism: Gravity is the only decay of a score, and its constant is unchanged", () => {
    expect(gravity).toEqual({ lambdaPerHour: 0.35 });
    expect(Object.keys(DEFAULT_ENGINE_CONFIG).filter((key) => /decay|freshness|age/i.test(key))).toEqual([]);
  });

  it("THREE CLOCKS: memory event expiry is its own constant, much slower than signal freshness, and neither is Gravity", () => {
    const { memory } = DEFAULT_ENGINE_CONFIG;
    expect(memory.maxEventAgeDays).toBe(30);
    expect(memory.maxEventAgeDays * 24).toBeGreaterThan(signals.freshnessMaxAgeHours * 4);
    expect(memory.maxRecentEvents).toBe(8); // the size cap is still there, beside the clock
  });
});

/**
 * THE DRIFTING TARGET (Phase 14): its own constants, behind a switch that
 * ships off, on a clock an order of magnitude slower than the others'.
 */
describe("Phase 14 invariants", () => {
  const { targetDrift, signals, memory, gravity, score } = DEFAULT_ENGINE_CONFIG;

  it("ships OFF, and only the exact string \"true\" in ENGINE_TARGET_DRIFT_ENABLED turns it on", () => {
    expect(targetDrift.enabled).toBe(false);
    expect(engineConfigFromEnv({}).targetDrift.enabled).toBe(false);
    expect(engineConfigFromEnv({ targetDriftEnabled: "true" }).targetDrift.enabled).toBe(true);
    expect(engineConfigFromEnv({ targetDriftEnabled: " true " }).targetDrift.enabled).toBe(true);
    for (const bad of ["", "1", "TRUE", "yes", "false", "on"]) expect(engineConfigFromEnv({ targetDriftEnabled: bad }).targetDrift.enabled).toBe(false);
    expect(parseExactTrue("true")).toBe(true);
    expect(parseExactTrue(undefined)).toBe(false);
    expect(describeEngineOverrides(engineConfigFromEnv({ targetDriftEnabled: "true" }))).toEqual(["targetDrift.enabled = true (default false)"]);
  });

  /**
   * PHASE 18++. The volume reference is the one tunable that is EXPECTED to
   * need re-deriving as subjects and sources are added, so it has an override
   * — otherwise the next re-derivation waits on a deploy, and a constant that
   * is awkward to change is a constant that stays stale.
   */
  it("takes the volume reference from ENGINE_VOLUME_REFERENCE, decimals included, and ignores anything malformed", () => {
    expect(signals.volume.referenceSignalsPerDay).toBe(4);
    expect(engineConfigFromEnv({}).signals.volume.referenceSignalsPerDay).toBe(4);
    expect(engineConfigFromEnv({ volumeReference: "3.7" }).signals.volume.referenceSignalsPerDay).toBe(3.7);
    expect(engineConfigFromEnv({ volumeReference: " 12 " }).signals.volume.referenceSignalsPerDay).toBe(12);
    for (const bad of ["", "0", "-2", "abc", "4x", "1e3", "NaN", "Infinity"]) {
      expect(engineConfigFromEnv({ volumeReference: bad }).signals.volume.referenceSignalsPerDay, bad).toBe(4);
    }
    expect(parsePositiveNumber("0.5")).toBe(0.5);
    expect(parsePositiveNumber(undefined)).toBeNull();
    expect(describeEngineOverrides(engineConfigFromEnv({ volumeReference: "3" }))).toEqual(["signals.volume.referenceSignalsPerDay = 3 (default 4)"]);
    // The override touches nothing else in the block.
    const overridden = engineConfigFromEnv({ volumeReference: "3" }).signals.volume;
    expect(overridden).toEqual({ ...signals.volume, referenceSignalsPerDay: 3 });
  });

  it("names the drift rate, the bound and the coverage rate as tunables: half-life 14 days, ±8 points, 0.2 points an hour", () => {
    expect(targetDrift.halfLifeHours).toBe(336);
    expect(targetDrift.bound).toBe(8);
    expect(targetDrift.fullCoverageImpactPerHour).toBe(0.2);
  });

  it("THE FOURTH CLOCK: separate from Signals freshness and memory expiry, and at least ten times slower than freshness", () => {
    expect(targetDrift.halfLifeHours).toBeGreaterThanOrEqual(signals.freshnessHalfLifeHours * 10);
    expect(targetDrift.halfLifeHours).not.toBe(signals.freshnessMaxAgeHours);
    expect(targetDrift.halfLifeHours).not.toBe(memory.maxEventAgeDays * 24);
    // Its constants are its own: nothing in the Signals or memory sections reads as a drift constant, and the switch only lives here.
    expect(Object.keys(signals)).not.toContain("targetDrift");
    expect(Object.keys(memory)).not.toContain("targetDrift");
    expect(Object.keys(targetDrift).sort()).toEqual(["bound", "enabled", "fullCoverageImpactPerHour", "halfLifeHours"]);
  });

  it("changed no force constant: Gravity's λ, the freshness curve and memory expiry are what they were", () => {
    expect(gravity).toEqual({ lambdaPerHour: 0.35 });
    expect(signals.freshnessHalfLifeHours).toBe(24);
    expect(signals.freshnessMaxAgeHours).toBe(168);
    expect(memory.maxEventAgeDays).toBe(30);
    expect(signals.maxAbsImpactPerTick).toBe(10);
  });

  it("stores the score at four decimals so Gravity's pull inside 1.72 points of the target is no longer rounded away", () => {
    expect(score.decimals).toBe(4);
    // At 30 s, Gravity moves gap × (1 − e^(−λ/120)); the dead zone is the gap at which that is under half a unit of the stored precision.
    const perTick = 1 - Math.exp(-gravity.lambdaPerHour / 120);
    expect(0.005 / perTick).toBeCloseTo(1.72, 2); // what two decimals cost
    expect(0.00005 / perTick).toBeLessThan(0.02); // what four decimals cost
  });
});

/**
 * The environment overrides for the controlled test: strictly parsed, opt-in,
 * and never able to move a default. The production default of the
 * Trading Activity minimum-sample guard stays 30 whatever happens here.
 */
describe("engineConfigFromEnv", () => {
  it("keeps the production default of the minimum-sample guard at 30", () => {
    expect(DEFAULT_ENGINE_CONFIG.tradingActivity.minPopulatedWindows).toBe(30);
    expect(engineConfigFromEnv({}).tradingActivity.minPopulatedWindows).toBe(30);
    expect(engineConfigFromEnv({ tradingMinPopulatedWindows: undefined }).tradingActivity.minPopulatedWindows).toBe(30);
  });

  it("lowers the guard only when the variable holds a positive integer", () => {
    expect(engineConfigFromEnv({ tradingMinPopulatedWindows: "5" }).tradingActivity.minPopulatedWindows).toBe(5);
    expect(engineConfigFromEnv({ tradingMinPopulatedWindows: " 12 " }).tradingActivity.minPopulatedWindows).toBe(12);
    for (const bad of ["", "0", "-3", "2.5", "ten", "1e3", "NaN"]) {
      expect(engineConfigFromEnv({ tradingMinPopulatedWindows: bad }).tradingActivity.minPopulatedWindows).toBe(30);
    }
  });

  it("touches nothing else in the config", () => {
    const config = engineConfigFromEnv({ tradingMinPopulatedWindows: "3" });
    expect({ ...config.tradingActivity, minPopulatedWindows: 30 }).toEqual(DEFAULT_ENGINE_CONFIG.tradingActivity);
    expect(config.gravity).toEqual(DEFAULT_ENGINE_CONFIG.gravity);
    expect(config.spread).toEqual(DEFAULT_ENGINE_CONFIG.spread);
    expect(config.targetDrift).toEqual(DEFAULT_ENGINE_CONFIG.targetDrift);
    expect(engineConfigFromEnv({})).toEqual(DEFAULT_ENGINE_CONFIG);
    // The drift switch moves the switch and nothing else: the rate, the bound and the coverage rate are code constants.
    const drifting = engineConfigFromEnv({ targetDriftEnabled: "true" });
    expect({ ...drifting.targetDrift, enabled: false }).toEqual(DEFAULT_ENGINE_CONFIG.targetDrift);
    expect(drifting.gravity).toEqual(DEFAULT_ENGINE_CONFIG.gravity);
  });

  it("names an active override for the tick log, and nothing when there is none", () => {
    expect(describeEngineOverrides(engineConfigFromEnv({}))).toEqual([]);
    expect(describeEngineOverrides(engineConfigFromEnv({ tradingMinPopulatedWindows: "8" }))).toEqual(["tradingActivity.minPopulatedWindows = 8 (default 30)"]);
  });

  it("parses positive integers strictly", () => {
    expect(parsePositiveInteger("30")).toBe(30);
    expect(parsePositiveInteger("007")).toBe(7);
    expect(parsePositiveInteger(undefined)).toBeNull();
    expect(parsePositiveInteger("0")).toBeNull();
    expect(parsePositiveInteger("99999999999999999999")).toBeNull();
  });
});
