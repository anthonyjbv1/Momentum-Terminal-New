import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AT_BASELINE_EPSILON, baselineDeviation } from "./baseline";

/**
 * The shared baseline: the one place that turns a reading and its trailing
 * series into "how unusual is this for this person", with the minimum-sample
 * guard, the sd floor and the deadband. Trading Activity and every metric
 * connector consume it; nothing re-implements it.
 */

const CONFIG = { minSamples: 5, sdFloor: 0.1, thresholdStdDevs: 1.0 };

describe("baselineDeviation", () => {
  it("reports the mean, population sd, deviation and sigma of a reading against its series", () => {
    const series = [1, 2, 3, 4, 10];
    const reading = baselineDeviation({ current: 10, baseline: series }, CONFIG);
    expect(reading.samples).toBe(5);
    expect(reading.sufficient).toBe(true);
    expect(reading.mean).toBe(4);
    expect(reading.sd).toBeCloseTo(Math.sqrt((9 + 4 + 1 + 0 + 36) / 5), 12);
    expect(reading.sdApplied).toBe(reading.sd);
    expect(reading.deviation).toBe(6);
    expect(reading.sigma).toBeCloseTo(6 / reading.sd, 12);
    expect(reading.band).toBe("outside");
    expect(reading.atBaseline).toBe(false);
  });

  it("MINIMUM SAMPLE: below minSamples nothing is a deviation, however large", () => {
    const thin = baselineDeviation({ current: 1000, baseline: [1, 1, 1, 1000] }, CONFIG);
    expect(thin.samples).toBe(4);
    expect(thin.sufficient).toBe(false);
    expect(thin.sigma).toBe(0);
    expect(thin.band).toBeNull();
    // The mean and sd are still reported, so a log can show what the thin history looked like.
    expect(thin.mean).toBeCloseTo(250.75, 12);

    const explicit = baselineDeviation({ current: 1000, baseline: [0, 0, 0, 0, 0, 0, 1000], samples: 2 }, CONFIG);
    expect(explicit.samples).toBe(2);
    expect(explicit.sufficient).toBe(false);
  });

  it("SD FLOOR: a flat history cannot make a small move many sigma", () => {
    const flat = baselineDeviation({ current: 1.05, baseline: [1, 1, 1, 1, 1, 1.05] }, CONFIG);
    expect(flat.sd).toBeLessThan(0.03);
    expect(flat.sdApplied).toBe(0.1);
    // Against the floored sd the blip is under half a sigma; against the raw sd it would be several.
    expect(flat.sigma).toBeCloseTo(flat.deviation / 0.1, 12);
    expect(flat.sigma).toBeLessThan(0.5);
    expect(flat.deviation / flat.sd).toBeGreaterThan(2);
    expect(flat.band).toBe("inside");
  });

  it("DEADBAND: inside the threshold the band is inside, the sign survives", () => {
    const series = [10, 12, 8, 11, 9, 10, 10.5];
    const nudge = baselineDeviation({ current: 10.5, baseline: series }, CONFIG);
    expect(nudge.band).toBe("inside");
    expect(nudge.sigma).toBeGreaterThan(0);
    const dip = baselineDeviation({ current: 9.9, baseline: [...series.slice(0, -1), 9.9] }, CONFIG);
    expect(dip.band).toBe("inside");
    expect(dip.sigma).toBeLessThan(0);
    const spike = baselineDeviation({ current: 20, baseline: [...series.slice(0, -1), 20] }, { ...CONFIG, thresholdStdDevs: 2 });
    expect(spike.band).toBe("outside");
    expect(spike.sigma).toBeGreaterThan(2);
  });

  it("marks a reading at its own mean as having no direction", () => {
    const flat = baselineDeviation({ current: 3, baseline: [3, 3, 3, 3, 3] }, CONFIG);
    expect(flat.deviation).toBe(0);
    expect(flat.atBaseline).toBe(true);
    expect(flat.sigma).toBe(0);
    expect(AT_BASELINE_EPSILON).toBe(1e-9);
  });

  it("handles an empty series without dividing by zero", () => {
    const empty = baselineDeviation({ current: 1, baseline: [] }, { ...CONFIG, sdFloor: 0 });
    expect(empty.samples).toBe(0);
    expect(empty.sufficient).toBe(false);
    expect(empty.sigma).toBe(0);
    expect(Number.isFinite(empty.deviation)).toBe(true);
  });
});

describe("one implementation", () => {
  const read = (file: string) => readFileSync(join(__dirname, file), "utf8");

  it("Trading Activity consumes the shared baseline rather than its own mean and sd", () => {
    const source = read("forces/trading-activity.ts");
    expect(source).toMatch(/from "@\/lib\/engine\/baseline"/);
    expect(source).not.toMatch(/standardDeviation|\bmean\(/);
  });

  it("the metric pipeline consumes the same baseline", () => {
    const source = readFileSync(join(__dirname, "..", "ingest", "metrics.ts"), "utf8");
    expect(source).toMatch(/from "@\/lib\/engine\/baseline"/);
    expect(source).not.toMatch(/standardDeviation|\bmean\(/);
  });
});
