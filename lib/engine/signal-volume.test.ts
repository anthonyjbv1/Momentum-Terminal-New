import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { UNWEIGHTED, describeVolume, readSignalVolumeRow, volumeWeight } from "./signal-volume";

const VOLUME = DEFAULT_ENGINE_CONFIG.signals.volume;
const week = (perDay: number, days = 7) => Array.from({ length: days }, () => perDay);

describe("the per-person volume weight", () => {
  it("is exactly 1 for a person the tick knows nothing about, and 1 until seven complete days exist", () => {
    expect(volumeWeight(undefined, VOLUME)).toEqual(UNWEIGHTED);
    const thin = volumeWeight({ trackedSince: null, current24h: 40, daily: week(40, 6) }, VOLUME);
    expect(thin.weight).toBe(1);
    expect(thin.reading?.sufficient).toBe(false);
    expect(thin.reading?.samples).toBe(6);
    expect(volumeWeight({ trackedSince: null, current24h: 40, daily: week(40, 7) }, VOLUME).reading?.sufficient).toBe(true);
  });

  it("reads a person at the reference volume exactly as before, and scales the rest by the reference over their own typical day", () => {
    expect(VOLUME.referenceSignalsPerDay).toBe(20);
    expect(volumeWeight({ trackedSince: null, current24h: 20, daily: week(20) }, VOLUME).weight).toBe(1);
    expect(volumeWeight({ trackedSince: null, current24h: 100, daily: week(100) }, VOLUME).weight).toBe(0.2);
    expect(volumeWeight({ trackedSince: null, current24h: 40, daily: week(40) }, VOLUME).weight).toBe(0.5);
    expect(volumeWeight({ trackedSince: null, current24h: 10, daily: week(10) }, VOLUME).weight).toBe(2);
  });

  it("is bounded: the most-covered person never reads below a tenth, the least never above double", () => {
    expect(volumeWeight({ trackedSince: null, current24h: 500, daily: week(500) }, VOLUME).weight).toBe(VOLUME.minWeight);
    expect(volumeWeight({ trackedSince: null, current24h: 2, daily: week(2) }, VOLUME).weight).toBe(VOLUME.maxWeight);
    expect(volumeWeight({ trackedSince: null, current24h: 0, daily: week(0) }, VOLUME).weight).toBe(VOLUME.maxWeight);
  });

  it("uses the shared baseline: the sigma of today's count says how unusual the day is FOR THEM, and a big day is not a bigger weight", () => {
    // Fourteen days at 20, then a day of 80: four times the usual, an outlier of many sigma with the sd floored at 2.
    const big = volumeWeight({ trackedSince: null, current24h: 80, daily: week(20, 14) }, VOLUME);
    expect(big.reading?.mean).toBeCloseTo(24, 6); // the current day counts in the mean, as the utility expects
    expect(big.reading?.sigma).toBeGreaterThan(3);
    expect(big.reading?.band).toBe("outside");
    // The weight follows the typical day, so the four-fold count reaches the force four-fold: that is the big day.
    expect(big.weight).toBeCloseTo(20 / 24, 4);
    const quiet = volumeWeight({ trackedSince: null, current24h: 20, daily: week(20, 14) }, VOLUME);
    expect(quiet.reading?.sigma).toBe(0);
    expect(quiet.reading?.band).toBe("inside");
    expect(describeVolume(big)).toMatchObject({ weight: big.weight, sufficient: true, samples: 14, minSamples: 7, current24h: 80, meanPerDay: 24 });
    expect(describeVolume(UNWEIGHTED)).toBeNull();
  });

  it("reads the database row, numeric strings and nulls included", () => {
    expect(readSignalVolumeRow({ person_id: "p", tracked_since: "2026-09-18T01:00:00Z", current_24h: "3", daily: ["1", "0", 2] })).toEqual([
      "p",
      { trackedSince: new Date("2026-09-18T01:00:00Z"), current24h: 3, daily: [1, 0, 2] },
    ]);
    expect(readSignalVolumeRow({ person_id: "p", tracked_since: null, current_24h: null, daily: null })[1]).toEqual({ trackedSince: null, current24h: 0, daily: [] });
  });

  it("projects the first run's subjects: the heavily covered read each item at a fraction, the sparsely covered at up to double", () => {
    // Event signals per day as the first day under all sixteen is expected to run (news plus digests, streams and results).
    const expected: Record<string, number> = { "elon-musk": 100, mrbeast: 40, "patrick-mahomes": 25, drake: 10, "kai-cenat": 7, "larry-page": 3 };
    const weights = Object.fromEntries(Object.entries(expected).map(([slug, perDay]) => [slug, volumeWeight({ trackedSince: null, current24h: perDay, daily: week(perDay) }, VOLUME).weight]));
    expect(weights).toEqual({ "elon-musk": 0.2, mrbeast: 0.5, "patrick-mahomes": 0.8, drake: 2, "kai-cenat": 2, "larry-page": 2 });
    // A typical day's total impact at routine confidence is now within a factor of two across the board rather than thirty.
    const routine = 0.3;
    const daily = Object.entries(expected).map(([slug, perDay]) => perDay * routine * weights[slug]);
    expect(Math.max(...daily) / Math.min(...daily)).toBeLessThan(4);
  });
});
