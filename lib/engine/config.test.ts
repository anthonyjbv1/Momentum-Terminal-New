import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG, describeEngineOverrides, engineConfigFromEnv, parsePositiveInteger } from "./config";
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
    expect(engineConfigFromEnv({})).toEqual(DEFAULT_ENGINE_CONFIG);
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
