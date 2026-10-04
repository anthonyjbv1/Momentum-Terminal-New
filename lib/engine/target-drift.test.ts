import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import {
  DORMANT_TARGET_DRIFT,
  advanceTargetDrift,
  dormantDriftEvaluation,
  driftApplies,
  driftDecay,
  driftOffset,
  driftOffsetAt,
  driftScale,
  effectiveTarget,
  evaluateTargetDrift,
  normalFromSums,
  normalWindowStart,
  presumedDriftState,
  projectedOffset,
  readTargetDriftState,
  startDriftState,
} from "./target-drift";

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

describe("the drift redesign (2026-10-04) — relative coverage, the measured start, the fallback", () => {
  const RELATIVE = { ...DRIFT, coverageMode: "relative" as const };
  const normal = { grossPerHour: 0.1, signedPerHour: 0.03, hours: 672, events: 120 };

  it("the scale: the person's own normal in relative mode, the constant in fixed mode, the constant as a fallback when there is no normal", () => {
    expect(driftScale(DRIFT, normal)).toEqual({ scale: DRIFT.fullCoverageImpactPerHour, normal: null, fallback: false });
    expect(driftScale(RELATIVE, normal)).toEqual({ scale: 0.1, normal: 0.1, fallback: false });
    expect(driftScale(RELATIVE, null)).toEqual({ scale: DRIFT.fullCoverageImpactPerHour, normal: null, fallback: true });
    expect(driftScale(RELATIVE, { ...normal, events: 0, grossPerHour: 0 })).toEqual({ scale: DRIFT.fullCoverageImpactPerHour, normal: null, fallback: true });
  });

  it("relative offsets read coverage and lean against the normal: the person's own rate is full coverage, and the lean is their own loudness", () => {
    // At their normal, balanced: the seed. At their normal, as positive as they are loud: the ceiling. Half their normal, balanced: halfway to the floor.
    expect(driftOffsetAt(0.1, 0, 0.1, DRIFT)).toBe(0);
    expect(driftOffsetAt(0.1, 0.1, 0.1, DRIFT)).toBe(DRIFT.bound);
    expect(driftOffsetAt(0.05, 0, 0.1, DRIFT)).toBe(-DRIFT.bound / 2);
    // The same evidence under the fixed constant reads as half coverage: the relative rule is what lets a quiet person reach their seed.
    expect(driftOffset(0.1, 0, DRIFT)).toBe(-DRIFT.bound / 2);
    // A lean of 0.03 on a 0.1 normal is 0.3; on the 0.2 constant it would be 0.15.
    expect(driftOffsetAt(0.1, 0.03, 0.1, DRIFT)).toBeCloseTo(DRIFT.bound * 0.3, 4);
    expect(driftOffset(0.2, 0.03, DRIFT)).toBeCloseTo(DRIFT.bound * 0.15, 4);
  });

  it("the start state: carried from the row, else measured at the flip when there is a normal, else presumed on the scale in force", () => {
    expect(startDriftState({ attention: 0.07, direction: -0.01, offset: -2 }, RELATIVE, normal, 0.1)).toEqual({ attention: 0.07, direction: -0.01, started: "carried" });
    expect(startDriftState(DORMANT_TARGET_DRIFT, RELATIVE, normal, 0.1)).toEqual({ attention: 0.1, direction: 0.03, started: "measured" });
    expect(startDriftState(DORMANT_TARGET_DRIFT, { ...RELATIVE, measuredStart: false }, normal, 0.1)).toEqual({ attention: 0.1, direction: 0, started: "presumed" });
    expect(startDriftState(DORMANT_TARGET_DRIFT, RELATIVE, null, DRIFT.fullCoverageImpactPerHour)).toEqual({ attention: DRIFT.fullCoverageImpactPerHour, direction: 0, started: "presumed" });
    // A measured start puts the target exactly where the evidence says: coverage 1, the lean the person's own.
    const flip = evaluateTargetDrift(DORMANT_TARGET_DRIFT, 0, TICK_HOURS, RELATIVE, normal);
    expect(flip.started).toBe("measured");
    expect(flip.offset).toBeCloseTo(DRIFT.bound * 0.3, 2);
    expect(flip).toMatchObject({ mode: "relative", normal: 0.1, scale: 0.1, fallback: false });
  });

  it("the fallback path for a person with no normal is the Phase 14 path exactly: about −1 at 2.7 days, −2 at 5.8, −4 at 14, never an instant −8", () => {
    const hours = (t: number) => evaluateTargetDrift(DORMANT_TARGET_DRIFT, 0, t, RELATIVE, null);
    expect(hours(2.7 * 24).offset).toBeCloseTo(-1, 1);
    expect(hours(5.8 * 24).offset).toBeCloseTo(-2, 1);
    expect(hours(14 * 24).offset).toBeCloseTo(-4, 1);
    expect(hours(TICK_HOURS).offset).toBeCloseTo(0, 3);
    expect(hours(2.7 * 24)).toMatchObject({ mode: "relative", normal: null, scale: DRIFT.fullCoverageImpactPerHour, fallback: true, started: "presumed" });
    // And it is the fixed path, number for number.
    for (const t of [12, 64.8, 139.2, 336, 672]) expect(hours(t).offset).toBe(advanceTargetDrift(DORMANT_TARGET_DRIFT, 0, t, DRIFT).offset);
  });

  it("advanceTargetDrift is the fixed path whatever the config says, so the Phase 14 projection stands; the dormant evaluation is the switch off", () => {
    const state = advanceTargetDrift({ attention: 0.1, direction: 0.03, offset: 0 }, 0, 24, RELATIVE);
    expect(state).toEqual({ attention: expect.any(Number), direction: expect.any(Number), offset: expect.any(Number) });
    expect(state.offset).toBe(evaluateTargetDrift({ attention: 0.1, direction: 0.03, offset: 0 }, 0, 24, DRIFT).offset);
    expect(dormantDriftEvaluation(RELATIVE)).toEqual({ attention: null, direction: null, offset: 0, mode: "relative", normal: null, scale: DRIFT.fullCoverageImpactPerHour, fallback: false, started: "dormant" });
  });

  it("the allowlist and the window: a slug on the list with the switch on, and the later of the window's edge and the regime start", () => {
    expect(driftApplies({ ...DRIFT, enabled: true, people: ["kai-cenat"] }, "kai-cenat")).toBe(true);
    expect(driftApplies({ ...DRIFT, enabled: true, people: ["kai-cenat"] }, "mrbeast")).toBe(false);
    expect(driftApplies({ ...DRIFT, enabled: false, people: ["kai-cenat"] }, "kai-cenat")).toBe(false);
    expect(driftApplies({ ...DRIFT, enabled: true, people: [] }, "kai-cenat")).toBe(false);
    const now = new Date("2026-10-04T12:00:00.000Z");
    expect(normalWindowStart(DRIFT, now).toISOString()).toBe("2026-09-06T12:00:00.000Z");
    expect(normalWindowStart({ ...DRIFT, normalSince: "2026-10-03T00:00:00.000Z" }, now).toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(normalWindowStart({ ...DRIFT, normalSince: "2026-01-01T00:00:00.000Z" }, now).toISOString()).toBe("2026-09-06T12:00:00.000Z");
    // The normal from sums: per hour of the window measured, six decimals.
    const measured = normalFromSums({ grossImpact: 67.2, signedImpact: -13.44, events: 40 }, new Date(now.getTime() - 672 * 3_600_000), now);
    expect(measured).toEqual({ grossPerHour: 0.1, signedPerHour: -0.02, hours: 672, events: 40 });
  });
});
