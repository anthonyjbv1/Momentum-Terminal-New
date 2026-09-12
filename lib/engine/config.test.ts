import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG, describeEngineOverrides, engineConfigFromEnv, parsePositiveInteger } from "./config";

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
