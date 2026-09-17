import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { DORMANT_TARGET_DRIFT, advanceTargetDrift, driftDecay, driftOffset, effectiveTarget, presumedDriftState, projectedOffset, readTargetDriftState } from "./target-drift";

const DRIFT = DEFAULT_ENGINE_CONFIG.targetDrift;
const TICK_HOURS = 30 / 3600;
const DAY_HOURS = 24;

/** Advance `days` of daily ticks, each carrying `impactPerDay` of Signals force. */
function days(state = DORMANT_TARGET_DRIFT, count: number, impactPerDay: number | ((day: number) => number)) {
  let current = state;
  for (let day = 0; day < count; day += 1) current = advanceTargetDrift(current, typeof impactPerDay === "function" ? impactPerDay(day) : impactPerDay, DAY_HOURS, DRIFT);
  return current;
}

describe("the drifting target — the mapping", () => {
  it("no evidence is the floor, full balanced coverage is the seed, full positive coverage is the ceiling", () => {
    const C = DRIFT.fullCoverageImpactPerHour;
    expect(driftOffset(0, 0, DRIFT)).toBe(-DRIFT.bound);
    expect(driftOffset(C, 0, DRIFT)).toBe(0);
    expect(driftOffset(C, C, DRIFT)).toBe(DRIFT.bound);
    expect(driftOffset(C, -C, DRIFT)).toBe(-DRIFT.bound);
    // Half the coverage, balanced: halfway down to the floor. Half the coverage, entirely positive: still 2 under the seed;
    // entirely positive coverage earns the seed at about 62 % of full (f + f² = 1), balanced coverage only at full.
    expect(driftOffset(C / 2, 0, DRIFT)).toBe(-DRIFT.bound / 2);
    expect(driftOffset(C / 2, C / 2, DRIFT)).toBe(-2);
    expect(driftOffset(0.618 * C, 0.618 * C, DRIFT)).toBeCloseTo(0, 1);
    // Bounded whatever the evidence says.
    expect(driftOffset(10 * C, 10 * C, DRIFT)).toBe(DRIFT.bound);
    expect(driftOffset(10 * C, -10 * C, DRIFT)).toBe(-DRIFT.bound);
  });

  it("is monotone in both attention and direction", () => {
    const C = DRIFT.fullCoverageImpactPerHour;
    for (let a = 0; a <= 2 * C; a += C / 10) {
      for (let d = -a; d <= a - C / 20; d += C / 20) {
        expect(driftOffset(a, d + C / 20, DRIFT)).toBeGreaterThanOrEqual(driftOffset(a, d, DRIFT));
      }
      if (a < 2 * C) expect(driftOffset(a + C / 10, 0, DRIFT)).toBeGreaterThanOrEqual(driftOffset(a, 0, DRIFT));
    }
  });

  it("a never-measured person is presumed fully covered and balanced: turning the switch on moves no target", () => {
    expect(presumedDriftState(DRIFT)).toEqual({ attention: DRIFT.fullCoverageImpactPerHour, direction: 0 });
    const first = advanceTargetDrift(DORMANT_TARGET_DRIFT, 0, TICK_HOURS, DRIFT);
    expect(first.offset).toBeCloseTo(0, 3);
    expect(effectiveTarget(63, first.offset)).toBeCloseTo(63, 3);
    expect(effectiveTarget(63, DORMANT_TARGET_DRIFT.offset)).toBe(63);
    expect(effectiveTarget(63, null)).toBe(63);
  });
});

describe("the drifting target — the clock", () => {
  it("halves an evidence average every halfLifeHours, whatever the tick size", () => {
    expect(DRIFT.halfLifeHours).toBe(336);
    expect(driftDecay(336, 336)).toBeCloseTo(0.5, 12);
    expect(driftDecay(672, 336)).toBeCloseTo(0.25, 12);
    // 336 hours of 30-second ticks and one 336-hour tick decay the same.
    let fine = DRIFT.fullCoverageImpactPerHour;
    for (let i = 0; i < 336 * 120; i += 1) fine *= driftDecay(TICK_HOURS, 336);
    expect(fine).toBeCloseTo(DRIFT.fullCoverageImpactPerHour * driftDecay(336, 336), 6);
  });

  it("an INERT person sinks toward their own floor over weeks: −4 at two weeks, −6 at four, −7 at six, never past the bound", () => {
    expect(days(DORMANT_TARGET_DRIFT, 14, 0).offset).toBeCloseTo(-4, 1);
    expect(days(DORMANT_TARGET_DRIFT, 28, 0).offset).toBeCloseTo(-6, 1);
    expect(days(DORMANT_TARGET_DRIFT, 42, 0).offset).toBeCloseTo(-7, 1);
    const long = days(DORMANT_TARGET_DRIFT, 365, 0);
    expect(long.offset).toBeGreaterThanOrEqual(-DRIFT.bound);
    expect(long.offset).toBeCloseTo(-DRIFT.bound, 1);
    // The floor is the person's own: two seeds keep their distance.
    expect(effectiveTarget(63, long.offset) - effectiveTarget(52, long.offset)).toBeCloseTo(11, 6);
  });

  it("SUSTAINED POSITIVE coverage settles higher, sustained negative lower, mixed near the seed; it takes weeks, not hours", () => {
    const full = DRIFT.fullCoverageImpactPerHour * DAY_HOURS; // a day's worth of full coverage
    const positive = days(DORMANT_TARGET_DRIFT, 56, full);
    expect(positive.offset).toBeGreaterThan(7);
    expect(positive.offset).toBeLessThanOrEqual(DRIFT.bound);
    // Two weeks in: about halfway there.
    expect(days(DORMANT_TARGET_DRIFT, 14, full).offset).toBeCloseTo(4, 0);
    // One day in: barely moved. Signals freshness would have forgotten the day by then; this has barely noticed it.
    expect(Math.abs(days(DORMANT_TARGET_DRIFT, 1, full).offset)).toBeLessThan(0.5);

    // Sustained negative: attention stays full, direction sinks to −1 asymptotically: 15/16 of the way after four half-lives.
    const negative = days(DORMANT_TARGET_DRIFT, 56, -full);
    expect(negative.offset).toBeCloseTo(-7.5, 1);
    expect(days(DORMANT_TARGET_DRIFT, 365, -full).offset).toBeCloseTo(-DRIFT.bound, 1);

    const mixed = days(DORMANT_TARGET_DRIFT, 56, (day) => (day % 2 === 0 ? full : -full));
    expect(Math.abs(mixed.offset)).toBeLessThan(1);
    expect(mixed.attention).toBeCloseTo(DRIFT.fullCoverageImpactPerHour, 2);
  });

  it("a tick with no elapsed time changes no evidence and still fills in a presumed state", () => {
    const zero = advanceTargetDrift(DORMANT_TARGET_DRIFT, 5, 0, DRIFT);
    expect(zero).toEqual({ attention: DRIFT.fullCoverageImpactPerHour, direction: 0, offset: 0 });
    const held = advanceTargetDrift({ attention: 0.1, direction: 0.05, offset: -1 }, 5, Number.NaN, DRIFT);
    expect(held.attention).toBe(0.1);
    expect(held.direction).toBe(0.05);
  });
});

describe("the drifting target — the row and the projection", () => {
  it("reads the people row, numeric strings included, and treats a missing state as never measured", () => {
    expect(readTargetDriftState({ target_attention: "0.15", target_direction: "-0.02", target_offset: "-2.5" })).toEqual({ attention: 0.15, direction: -0.02, offset: -2.5 });
    expect(readTargetDriftState({ target_attention: null, target_direction: null, target_offset: 0 })).toEqual(DORMANT_TARGET_DRIFT);
    expect(readTargetDriftState({})).toEqual(DORMANT_TARGET_DRIFT);
    expect(readTargetDriftState({ target_attention: "x", target_offset: "y" })).toEqual(DORMANT_TARGET_DRIFT);
  });

  it("projects where the first run's seven would settle at their observed rates (gross / net Signals impact per hour)", () => {
    // From score_events over the first 23.9 hours of the Engine: gross and net Signals impact per hour.
    const observed: Record<string, { seed: number; gross: number; net: number }> = {
      drake: { seed: 65, gross: 0.277, net: 0.267 },
      mrbeast: { seed: 68, gross: 0.5, net: 0.082 },
      "kai-cenat": { seed: 60, gross: 0.208, net: 0.171 },
      "jensen-huang": { seed: 63, gross: 0, net: 0 },
      "patrick-mahomes": { seed: 61, gross: 0.318, net: 0.252 },
      "kendrick-lamar": { seed: 63, gross: 0, net: 0 },
      "warren-buffett": { seed: 62, gross: 0, net: 0 },
    };
    const settle = (slug: string) => effectiveTarget(observed[slug].seed, projectedOffset(observed[slug].gross, observed[slug].net, DRIFT));
    expect(settle("drake")).toBe(73);
    expect(settle("patrick-mahomes")).toBe(69);
    expect(settle("mrbeast")).toBeCloseTo(71.3, 1);
    expect(settle("kai-cenat")).toBeCloseTo(66.8, 1);
    expect(settle("jensen-huang")).toBe(55);
    expect(settle("kendrick-lamar")).toBe(55);
    expect(settle("warren-buffett")).toBe(54);
    // The board that follows: evidence above no evidence, and the quiet keep their seeded order.
    const order = Object.keys(observed).sort((a, b) => settle(b) - settle(a));
    expect(order).toEqual(["drake", "mrbeast", "patrick-mahomes", "kai-cenat", "jensen-huang", "kendrick-lamar", "warren-buffett"]);
  });
});
