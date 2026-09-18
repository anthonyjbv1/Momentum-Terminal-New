import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { REFERENCE_DRIFT_FACTOR, UNCOUNTED_SIGNAL_KINDS, UNWEIGHTED, describeVolume, isUncountedSignal, readSignalVolumeRow, volumeSpread, volumeWeight } from "./signal-volume";

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
    // Phase 18++: re-derived from the roster's measured geometric mean.
    expect(VOLUME.referenceSignalsPerDay).toBe(4);
    expect(volumeWeight({ trackedSince: null, current24h: 4, daily: week(4) }, VOLUME).weight).toBe(1);
    expect(volumeWeight({ trackedSince: null, current24h: 20, daily: week(20) }, VOLUME).weight).toBe(0.2);
    expect(volumeWeight({ trackedSince: null, current24h: 8, daily: week(8) }, VOLUME).weight).toBe(0.5);
    expect(volumeWeight({ trackedSince: null, current24h: 2, daily: week(2) }, VOLUME).weight).toBe(2);
  });

  it("is bounded: the most-covered person never reads below a tenth, the least never above double", () => {
    expect(volumeWeight({ trackedSince: null, current24h: 500, daily: week(500) }, VOLUME).weight).toBe(VOLUME.minWeight);
    expect(volumeWeight({ trackedSince: null, current24h: 1, daily: week(1) }, VOLUME).weight).toBe(VOLUME.maxWeight);
    expect(volumeWeight({ trackedSince: null, current24h: 0, daily: week(0) }, VOLUME).weight).toBe(VOLUME.maxWeight);
    // Phase 18++: WHERE the bounds now bite, which is the test of whether they
    // are guards or the mechanism. The ceiling takes over below reference / 2
    // events a day, where a rate is estimated from a handful of events; the
    // floor above reference / minWeight, which nobody is near.
    expect(volumeWeight({ trackedSince: null, current24h: 2.01, daily: week(2.01) }, VOLUME).weight).toBeLessThan(VOLUME.maxWeight);
    expect(volumeWeight({ trackedSince: null, current24h: 1.99, daily: week(1.99) }, VOLUME).weight).toBe(VOLUME.maxWeight);
    expect(volumeWeight({ trackedSince: null, current24h: 39, daily: week(39) }, VOLUME).weight).toBeGreaterThan(VOLUME.minWeight);
    expect(volumeWeight({ trackedSince: null, current24h: 41, daily: week(41) }, VOLUME).weight).toBe(VOLUME.minWeight);
  });

  it("uses the shared baseline: the sigma of today's count says how unusual the day is FOR THEM, and a big day is not a bigger weight", () => {
    // Fourteen days at 20, then a day of 80: four times the usual, an outlier of many sigma with the sd floored at 2.
    const big = volumeWeight({ trackedSince: null, current24h: 80, daily: week(20, 14) }, VOLUME);
    expect(big.reading?.mean).toBeCloseTo(24, 6); // the current day counts in the mean, as the utility expects
    expect(big.reading?.sigma).toBeGreaterThan(3);
    expect(big.reading?.band).toBe("outside");
    // The weight follows the typical day, so the four-fold count reaches the force four-fold: that is the big day.
    expect(big.weight).toBeCloseTo(4 / 24, 4);
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

  /**
   * PHASE 18++. THE DERIVATION, pinned against the measured roster.
   *
   * Phase 15 chose 20 against an ASSUMED roster of 3-100 events a day. These
   * are the MEASURED three-complete-day rates to 2026-09-17, counting events
   * only (the denominator Phase 18+ corrected). The reference is now the
   * geometric mean of that distribution, rounded, and these two tests are
   * what "discriminates" means: at 20 the ceiling decided fourteen of sixteen
   * weights and a typical day's impact still spanned 15x; at 4 the ceiling
   * decides five and the spread is 3x.
   */
  const MEASURED: Record<string, number> = {
    "patrick-mahomes": 30.33,
    "jensen-huang": 10.33,
    "elon-musk": 9.67,
    drake: 9.33,
    "mark-zuckerberg": 8.33,
    "warren-buffett": 6.0,
    "kai-cenat": 4.67,
    mrbeast: 3.33,
    "larry-ellison": 2.67,
    "jeff-bezos": 2.33,
    "sergey-brin": 2.0,
    "larry-page": 1.67,
    "michael-dell": 1.67,
    "adin-ross": 0.67,
    "kendrick-lamar": 0.67,
    "anthony-baptiste": 0.0,
  };
  const weigh = (reference: number) =>
    Object.entries(MEASURED).map(([slug, perDay]) => [slug, perDay, volumeWeight({ trackedSince: null, current24h: perDay, daily: week(perDay) }, { ...VOLUME, referenceSignalsPerDay: reference }).weight] as const);
  /** The spread of a typical day's total impact across the roster: 1 would be perfect normalisation. */
  const typicalDaySpread = (reference: number) => {
    const impacts = weigh(reference)
      .map(([, perDay, weight]) => perDay * weight)
      .filter((impact) => impact > 0);
    return Math.max(...impacts) / Math.min(...impacts);
  };

  it("derives the reference as the geometric mean of the measured rates, not the arithmetic mean or the median", () => {
    const rates = Object.values(MEASURED).filter((rate) => rate > 0);
    const geometric = Math.exp(rates.reduce((total, rate) => total + Math.log(rate), 0) / rates.length);
    const arithmetic = rates.reduce((total, rate) => total + rate, 0) / rates.length;
    const sorted = [...rates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(geometric).toBeCloseTo(3.70, 1);
    expect(median).toBeCloseTo(3.33, 1);
    expect(arithmetic).toBeCloseTo(6.24, 1);
    // The shipped value is the geometric mean rounded. The arithmetic mean,
    // dragged by one subject's game-day spikes, is nearly twice it.
    expect(VOLUME.referenceSignalsPerDay).toBe(Math.round(geometric));
    expect(arithmetic / geometric).toBeGreaterThan(1.6);
  });

  it("discriminates at the derived reference where it saturated at the old one", () => {
    const capped = (reference: number) => weigh(reference).filter(([, , weight]) => weight === VOLUME.maxWeight).length;
    // Before: the ceiling decided all but two, so the weight was a constant.
    expect(capped(20)).toBe(14);
    expect(typicalDaySpread(20)).toBeGreaterThan(14);
    // After: the ceiling is a guard again, and the quiet half is scaled rather
    // than flattened. Six sit at it, of whom one (sergey-brin at 2.00 a day)
    // lands on it exactly rather than being clamped down to it; four are
    // genuinely clamped and one has no volume at all to divide by.
    expect(capped(VOLUME.referenceSignalsPerDay)).toBe(6);
    const clamped = weigh(VOLUME.referenceSignalsPerDay).filter(([, perDay]) => perDay > 0 && VOLUME.referenceSignalsPerDay / perDay > VOLUME.maxWeight);
    expect(clamped.map(([slug]) => slug)).toEqual(["larry-page", "michael-dell", "adin-ross", "kendrick-lamar"]);
    expect(typicalDaySpread(VOLUME.referenceSignalsPerDay)).toBeLessThan(3.1);
    // And it is not the opposite failure either: the weights still span an
    // order of magnitude, so they are saying something about each person.
    const weights = weigh(VOLUME.referenceSignalsPerDay).map(([, , weight]) => weight);
    expect(Math.max(...weights) / Math.min(...weights)).toBeGreaterThan(10);
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

/**
 * PHASE 18++ PARTS 2 AND 3. The reference is fixed on purpose, so its
 * staleness has to be visible instead of latent: these are the two symptoms
 * the console shows, and the engaged count that makes the two-wave transition
 * of 2026-09-25 / 09-26 watchable rather than inferred.
 */
describe("the volume spread, for the operator", () => {
  const week = (perDay: number, days = 7) => Array.from({ length: days }, () => perDay);
  const person = (id: string, perDay: number, days = 7) => [id, { trackedSince: null, current24h: perDay, daily: week(perDay, days) }] as const;

  it("counts who the weight is live for, and says nothing about a person whose baseline is still thin", () => {
    const spread = volumeSpread(new Map([person("a", 4), person("b", 4, 6), person("c", 4, 0)]), VOLUME);
    expect(spread.engaged).toBe(1);
    expect(spread.people).toBe(3);
    const thin = spread.rows.find((row) => row.personId === "b")!;
    expect(thin).toMatchObject({ engaged: false, weight: 1, typicalPerDay: null, bound: null, samples: 6 });
    expect(spread.rows.find((row) => row.personId === "a")).toMatchObject({ engaged: true, weight: 1, typicalPerDay: 4, bound: null });
  });

  it("names which bound is deciding a weight, and only for the engaged", () => {
    const spread = volumeSpread(new Map([person("loud", 200), person("quiet", 0.5), person("middling", 4), person("new", 4, 1)]), VOLUME);
    expect(Object.fromEntries(spread.rows.map((row) => [row.personId, row.bound]))).toEqual({ loud: "floor", quiet: "ceiling", middling: null, new: null });
    expect(spread.atCeiling).toBe(1);
    expect(spread.atFloor).toBe(1);
  });

  it("SYMPTOM ONE: more than a third of the engaged sitting on a bound means the reference is wrong for this roster", () => {
    // The roster as it stood at reference 20: everything on the ceiling.
    const stale = volumeSpread(new Map([person("a", 2), person("b", 3), person("c", 4)]), { ...VOLUME, referenceSignalsPerDay: 20 });
    expect(stale.atCeiling).toBe(3);
    expect(stale.boundedShareHigh).toBe(true);
    // At the derived reference the same three are scaled, not flattened.
    const derived = volumeSpread(new Map([person("a", 2), person("b", 3), person("c", 4)]), VOLUME);
    expect(derived.rows.map((row) => row.weight)).toEqual([1, 1.3333, 2]);
    expect(derived.boundedShareHigh).toBe(false);
  });

  it("SYMPTOM TWO: the roster's own geometric mean drifting past a factor of two from the reference", () => {
    const here = volumeSpread(new Map([person("a", 2), person("b", 4), person("c", 8)]), VOLUME);
    expect(here.liveGeometricMean).toBeCloseTo(4, 6);
    expect(here.referenceDrifted).toBe(false);
    // Ten quiet subjects join: the geometric mean falls out of the band and the
    // console says to re-derive, rather than the weights quietly going wrong.
    const widened = new Map([person("a", 2), person("b", 4), person("c", 8), ...Array.from({ length: 10 }, (_, index) => person(`q${index}`, 0.5))]);
    const after = volumeSpread(widened, VOLUME);
    expect(after.liveGeometricMean).toBeLessThan(VOLUME.referenceSignalsPerDay / REFERENCE_DRIFT_FACTOR);
    expect(after.referenceDrifted).toBe(true);
    // And this is exactly why the reference is NOT roster-relative: a live
    // geometric mean would have cut the three originals' weights by a factor
    // of five for reasons that have nothing to do with them.
    expect(here.liveGeometricMean! / after.liveGeometricMean!).toBeGreaterThan(4);
  });

  it("has no geometric mean to report before anyone is engaged, and does not divide by it", () => {
    const empty = volumeSpread(new Map([person("a", 4, 2)]), VOLUME);
    expect(empty.liveGeometricMean).toBeNull();
    expect(empty.referenceDrifted).toBe(false);
    expect(empty.boundedShareHigh).toBe(false);
    expect(volumeSpread(new Map(), VOLUME)).toMatchObject({ engaged: 0, people: 0, liveGeometricMean: null });
  });
});
