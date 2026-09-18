import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { UNCOUNTED_SIGNAL_KINDS, UNWEIGHTED, describeVolume, isUncountedSignal, readSignalVolumeRow, volumeWeight } from "./signal-volume";

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

  it("projects a roster at the reference: the heavily covered read each item at a fraction, the sparsely covered at up to double", () => {
    // The volumes Phase 15 projected, against which referenceSignalsPerDay = 20 was chosen.
    const expected: Record<string, number> = { "elon-musk": 100, mrbeast: 40, "patrick-mahomes": 25, drake: 10, "kai-cenat": 7, "larry-page": 3 };
    const weights = Object.fromEntries(Object.entries(expected).map(([slug, perDay]) => [slug, volumeWeight({ trackedSince: null, current24h: perDay, daily: week(perDay) }, VOLUME).weight]));
    expect(weights).toEqual({ "elon-musk": 0.2, mrbeast: 0.5, "patrick-mahomes": 0.8, drake: 2, "kai-cenat": 2, "larry-page": 2 });
    // A typical day's total impact at routine confidence is now within a factor of two across the board rather than thirty.
    const routine = 0.3;
    const daily = Object.entries(expected).map(([slug, perDay]) => perDay * routine * weights[slug]);
    expect(Math.max(...daily) / Math.min(...daily)).toBeLessThan(4);
  });

  /**
   * PHASE 18+. The projection above is not what the roster turned out to
   * produce. These are the measured seven-day means to 2026-09-17, counting
   * events only (the denominator this phase corrected). Pinned because they
   * say something the projection cannot: at referenceSignalsPerDay = 20 the
   * weight saturates at maxWeight for fifteen of sixteen people, so when it
   * engages it is very nearly a constant 2x on the Signals force rather than
   * a normalisation. Re-deriving the reference from the real roster is its
   * own decision and has not been made.
   */
  it("saturates at the maximum for all but one of the real roster, which is the open question the reference constant leaves", () => {
    const measured: Record<string, number> = {
      "patrick-mahomes": 13.86,
      drake: 6.14,
      "kai-cenat": 5.57,
      "elon-musk": 4.71,
      "jensen-huang": 4.71,
      "mark-zuckerberg": 3.71,
      "warren-buffett": 3.29,
      "larry-ellison": 2.14,
      mrbeast: 1.71,
      "michael-dell": 1.71,
      "jeff-bezos": 1.57,
      "larry-page": 1.0,
      "sergey-brin": 1.0,
      "kendrick-lamar": 0.86,
      "adin-ross": 0.29,
      "anthony-baptiste": 0.0,
    };
    const weights = Object.entries(measured).map(([slug, perDay]) => [slug, volumeWeight({ trackedSince: null, current24h: perDay, daily: week(perDay) }, VOLUME).weight] as const);
    const atCeiling = weights.filter(([, weight]) => weight === VOLUME.maxWeight);
    expect(atCeiling).toHaveLength(15);
    expect(weights.filter(([, weight]) => weight !== VOLUME.maxWeight)).toEqual([["patrick-mahomes", 1.4430]]);
    // A person with no events at all takes the ceiling too, not a division by zero.
    expect(volumeWeight({ trackedSince: null, current24h: 0, daily: week(0) }, VOLUME).weight).toBe(VOLUME.maxWeight);
  });
});

describe("what the volume series counts", () => {
  it("names the five uncounted kinds, artifacts of our own sampling rather than events", () => {
    expect([...UNCOUNTED_SIGNAL_KINDS]).toEqual(["metric", "baseline", "comment_digest", "comment", "live_moment"]);
  });

  it("reads the kind off a payload and tolerates anything that is not an object", () => {
    for (const kind of UNCOUNTED_SIGNAL_KINDS) expect(isUncountedSignal({ kind }), kind).toBe(true);
    for (const payload of [{ kind: "article" }, { kind: "stream_summary" }, { kind: "game_result" }, { kind: "insider_filing" }, { kind: "stream" }]) {
      expect(isUncountedSignal(payload), JSON.stringify(payload)).toBe(false);
    }
    for (const payload of [null, undefined, 3, "article", [], {}, { kind: 7 }]) expect(isUncountedSignal(payload), String(payload)).toBe(false);
  });

  /**
   * The contract with the database: the denominator must be exactly the set
   * the weight multiplies, so the migration's exclusion list and the array
   * above are the same five kinds. This fails if either side moves alone.
   */
  it("is the same list the RPC excludes", () => {
    const migrations = join(__dirname, "..", "..", "supabase", "migrations");
    const file = readdirSync(migrations)
      .filter((name) => name.endsWith("_phase18plus_volume_counts_events_only.sql"))
      .sort()
      .at(-1);
    expect(file, "the migration that set the exclusion list").toBeDefined();
    const sql = readFileSync(join(migrations, file!), "utf8");
    const clauses = sql.match(/<> all \(array\[[^\]]+\]\)/g) ?? [];
    // Once for the daily series, once for the trailing 24 hours.
    expect(clauses).toHaveLength(2);
    for (const clause of clauses) {
      const kinds = [...clause.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
      expect(kinds).toEqual([...UNCOUNTED_SIGNAL_KINDS]);
    }
  });
});
