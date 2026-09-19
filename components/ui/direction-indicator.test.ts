import { describe, expect, it } from "vitest";

import { FEED_IMPACT_DECIMALS } from "@/lib/feed/feed-model";
import { FORCE_IMPACT_DECIMALS, formatSigned, readForces } from "@/lib/person/profile-model";

import { FLAT_THRESHOLD, directionAtPrecision, directionOf, formatChange, roundsToZero } from "./direction-indicator";

/**
 * PHASE 19+ — A DISPLAYED ZERO IS NEVER COLOURED.
 *
 * Colour means direction in this design system, and zero has no direction.
 * A value can keep its sign after rounding to nothing — Gravity's pull toward
 * a target just above the score is a small negative that reads "0.00" at two
 * decimals — and since Phase 14 stored scores at four decimals, that is the
 * common case rather than the rare one.
 *
 * The rule is one-directional: a figure shown as zero is neutral. Nothing
 * about rounding or precision changes, and a value that still shows something
 * keeps the direction it always had.
 */

describe("a value that rounds to zero at the precision it is shown at", () => {
  it("is neutral however small and however signed the number underneath", () => {
    for (const precision of [0, 1, 2, 4]) {
      expect(directionAtPrecision(0, precision, 0)).toBe("neutral");
      expect(directionAtPrecision(-0, precision, 0)).toBe("neutral");
    }
    // The reported Gravity case: a pull downward that rounds away at two decimals.
    expect(formatSigned(-0.0038, FORCE_IMPACT_DECIMALS)).toBe("0.00");
    expect(directionAtPrecision(-0.0038, FORCE_IMPACT_DECIMALS, 0)).toBe("neutral");
    expect(directionAtPrecision(0.0038, FORCE_IMPACT_DECIMALS, 0)).toBe("neutral");
    // …and the same number at four decimals, where it does show, keeps its direction.
    expect(directionAtPrecision(-0.0038, 4, 0)).toBe("cooling");
  });

  it("keeps the direction of anything that still shows a figure", () => {
    expect(directionAtPrecision(-0.01, FORCE_IMPACT_DECIMALS, 0)).toBe("cooling");
    expect(directionAtPrecision(0.01, FORCE_IMPACT_DECIMALS, 0)).toBe("heating");
    expect(directionAtPrecision(-2.4, FORCE_IMPACT_DECIMALS, 0)).toBe("cooling");
  });

  it("never disagrees with the text beside it, at any precision", () => {
    const values = [0, -0, 0.0001, -0.0001, 0.004, -0.004, 0.005, -0.005, 0.006, -0.006, 0.05, -0.05, 0.4, -0.4, 12.3, -12.3];
    for (const precision of [0, 1, 2, 3]) {
      for (const value of values) {
        const shown = formatSigned(value, precision);
        const neutral = directionAtPrecision(value, precision, 0) === "neutral";
        // "0.00" and "0" carry no sign; anything else does.
        expect(neutral, `${value} at ${precision}dp shows "${shown}"`).toBe(!/[+−]/.test(shown));
        expect(formatChange(value, precision).startsWith("+") || formatChange(value, precision).startsWith("−")).toBe(!neutral);
      }
    }
  });

  it("leaves the flat threshold alone above the rounding: it is a floor, not a replacement", () => {
    // At one decimal the threshold and half a unit coincide, so nothing moves.
    expect(directionAtPrecision(0.04, 1)).toBe(directionOf(0.04));
    expect(directionAtPrecision(0.06, 1)).toBe(directionOf(0.06));
    // With the default threshold a small move stays flat even though it shows.
    expect(FLAT_THRESHOLD).toBe(0.05);
    expect(directionAtPrecision(0.03, 2)).toBe("neutral");
    // With the threshold explicitly off, the displayed figure decides alone.
    expect(directionAtPrecision(0.03, 2, 0)).toBe("heating");
  });

  it("treats no reading at all as neutral, not as zero", () => {
    expect(directionAtPrecision(null, 2, 0)).toBe("neutral");
    expect(directionAtPrecision(undefined, 2, 0)).toBe("neutral");
    expect(directionAtPrecision(Number.NaN, 2, 0)).toBe("neutral");
  });

  it("rounds the way the formatters round", () => {
    expect(roundsToZero(0.004, 2)).toBe(true);
    expect(roundsToZero(0.005, 2)).toBe(false);
    expect(roundsToZero(-0.9, 0)).toBe(false);
    expect(roundsToZero(0.4, 0)).toBe(true);
  });
});

describe("the surfaces that colour a number by its sign", () => {
  it("the five forces: a force that rounds to 0.00 is shown flat, not red", () => {
    const window = [
      { force: "gravity", impact: -0.0038 },
      { force: "signals", impact: 1.2 },
      { force: "market_mood", impact: 0.0071 },
      { force: "conviction", impact: -0.12 },
    ];
    const forces = readForces(window, [], 7);
    const byKey = Object.fromEntries(forces.map((force) => [force.key, force]));
    expect(byKey.gravity.impact).toBe(-0.0038);
    expect(formatSigned(byKey.gravity.impact!, FORCE_IMPACT_DECIMALS)).toBe("0.00");
    expect(byKey.gravity.direction).toBe("neutral"); // the defect Phase 19+ fixed
    expect(byKey.signals.direction).toBe("heating");
    expect(byKey.market_mood.direction).toBe("heating"); // 0.01 shows, so it keeps its colour
    expect(byKey.conviction.direction).toBe("cooling");
    // A force that never ran is idle, which is not the same as flat.
    expect(readForces([], [], null)[0].impact).toBeNull();
    expect(readForces([], [], null)[0].direction).toBe("neutral");
  });

  it("the Feed reads an entry's direction at the decimals the Feed shows", () => {
    expect(FEED_IMPACT_DECIMALS).toBe(1);
    expect(formatSigned(-0.04, FEED_IMPACT_DECIMALS)).toBe("0.0");
    expect(directionAtPrecision(-0.04, FEED_IMPACT_DECIMALS, 0)).toBe("neutral");
    expect(directionAtPrecision(-0.4, FEED_IMPACT_DECIMALS, 0)).toBe("cooling");
  });
});
