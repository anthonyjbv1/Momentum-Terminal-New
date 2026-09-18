import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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

/**
 * PHASE 18. The robust-spread replay recommended deferring the change again;
 * these pin the two facts that recommendation rests on, so a later attempt has
 * to confront them rather than rediscover them.
 */
describe("robust spread: why it is deferred", () => {
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length / 2;
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.floor(middle)];
  };

  it("MAD degenerates to zero on the small-integer count windows these metrics actually produce", () => {
    // A real shape: a weekly total that barely moves. Half the window shares a
    // value, so the median absolute deviation is 0 and sdApplied would collapse
    // to the constant sd floor — the series would stop being normalised against
    // itself. 773 of the 3,130 replayed windows look like this.
    const window = [14, 14, 14, 14, 14, 14, 15, 13, 14, 20];
    expect(median(window.map((value) => Math.abs(value - median(window))))).toBe(0);

    // The shipped rule still has a usable spread on the same window.
    const reading = baselineDeviation({ current: 20, baseline: window }, { minSamples: 5, sdFloor: 1, thresholdStdDevs: 1 });
    expect(reading.sd).toBeGreaterThan(1);
    expect(reading.sdApplied).toBe(reading.sd);
  });

  it("winsorizing at ±3 sd moves the one real reading it changes only across the deadband edge", () => {
    // patrick-mahomes / news_volume_24h at 2026-09-18 06:45, the single
    // classification that changed in 3,130 replayed readings:
    // mean 37.5566 -> 37.5496, sd 9.5671 -> 9.5458, observed 28.
    const sigmaNow = (28 - 37.5566) / 9.5671;
    const sigmaWinsorized = (28 - 37.5496) / 9.5458;
    expect(Math.abs(sigmaNow)).toBeLessThan(1);
    expect(Math.abs(sigmaWinsorized)).toBeGreaterThan(1);
    expect(Math.abs(Math.abs(sigmaWinsorized) - Math.abs(sigmaNow))).toBeLessThan(0.002);
  });
});

/**
 * PHASE 18 VERIFY 3 / PHASE 18+ PART 3. The four clocks are kept apart on
 * purpose, and the shared baseline has exactly four callers. A change to the
 * function reaches all four — including the volume weight, which has no
 * history to replay against until 2026-09-25.
 */
describe("the four clocks stay apart", () => {
  const source = (...parts: string[]) => readFileSync(join(__dirname, ...parts), "utf8");
  const IMPORTS_BASELINE = /from "@\/lib\/engine\/baseline"/;

  /**
   * Every caller of the shared baseline, by repository path. The docstring in
   * baseline.ts says what each one takes from the reading; this asserts the
   * list is complete. A fifth caller fails here until it is written down
   * there, because the test cannot know what a new one does with the reading.
   */
  const CALLERS = ["lib/engine/forces/trading-activity.ts", "lib/engine/signal-volume.ts", "lib/ingest/metrics.ts"];

  it("has exactly the callers its docstring accounts for", () => {
    const root = join(__dirname, "..", "..");
    const skip = new Set(["node_modules", ".next", ".git", "supabase", "public", "types"]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry)) files.push(full);
      }
    };
    walk(root);
    const importers = files
      .filter((file) => IMPORTS_BASELINE.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
      .sort();
    expect(importers).toEqual(CALLERS);

    // Three files, four call sites: the metric pipeline calls it twice, once
    // for the reading itself and once for the derived spike_count cutoff.
    const metrics = readFileSync(join(root, "lib", "ingest", "metrics.ts"), "utf8");
    expect(metrics.match(/baselineDeviation\(/g)).toHaveLength(2);
    for (const caller of CALLERS) expect(source("..", "..", ...caller.split("/")), caller).toMatch(IMPORTS_BASELINE);
    // And the docstring names each of them, so the list above is not the only record.
    const docs = source("baseline.ts");
    for (const caller of CALLERS) expect(docs, caller).toContain(caller);
  });

  it("the volume weight and Trading Activity are on the shared baseline: a change here moves them", () => {
    expect(source("signal-volume.ts")).toMatch(IMPORTS_BASELINE);
    // It divides by the reading's mean, so any rule that re-centres the window
    // re-levels every person's volume weight with it.
    expect(source("signal-volume.ts")).toMatch(/reading\.mean/);
    expect(source("forces", "trading-activity.ts")).toMatch(IMPORTS_BASELINE);
    // The recommendation is recorded where the next change is made, not only
    // in the README.
    expect(source("baseline.ts")).toMatch(/PER-CALL-SITE OPTION/);
  });

  it("the Signals freshness curve, memory expiry and the Gravity drift clock do not read the baseline at all", () => {
    for (const file of [["forces", "signals.ts"], ["memory", "update.ts"], ["target-drift.ts"]]) {
      expect(source(...file), file.join("/")).not.toMatch(IMPORTS_BASELINE);
    }
    // Each clock keeps its own constant, and they are all different numbers.
    const config = source("config.ts");
    expect(config).toMatch(/freshnessHalfLifeHours: 24/);
    expect(config).toMatch(/maxEventAgeDays: 30/);
    expect(config).toMatch(/targetDrift: \{ enabled: false, halfLifeHours: 336/);
    expect(config).toMatch(/volume: \{ referenceSignalsPerDay: 20, windowDays: 14, minSamples: 7/);
  });
});
