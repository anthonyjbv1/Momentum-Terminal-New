import { describe, expect, it } from "vitest";

import { emissionDecision, outcomeReported, type MetricOutcome, type PreviousObservation } from "@/lib/ingest/metrics";

import { METRIC_REGISTERS, REGISTER_BANDS, REGISTER_HYSTERESIS_SIGMA, heldRegister, registerFloor, registerFor } from "./register";

/**
 * THE REGISTER, and the rule Phase 24 built on it — tested against the window
 * that produced it.
 *
 * The replay at the foot of this file is the real deliverable: the sigma
 * series below is the ledger as it was actually written on 2026-09-21, the
 * day of the first live NFL game, and the rule is run over it through the
 * same `emissionDecision` the ingestion runner calls. 39 emissions become 7.
 */

describe("the bands", () => {
  it("are a function of the reading alone, and every sigma lands in one", () => {
    expect(registerFor(4.0)).toBe("spiking");
    expect(registerFor(REGISTER_BANDS.spiking)).toBe("spiking");
    expect(registerFor(3.49)).toBe("concrete");
    expect(registerFor(REGISTER_BANDS.concrete)).toBe("concrete");
    expect(registerFor(2.49)).toBe("elevated");
    expect(registerFor(0)).toBe("elevated");
    expect(registerFor(-0.01)).toBe("quiet");
    expect(registerFor(-9)).toBe("quiet");
    // A reading with no magnitude is not silently promoted or demoted.
    expect(registerFor(Number.NaN)).toBe("elevated");
    expect(METRIC_REGISTERS).toEqual(["quiet", "elevated", "concrete", "spiking"]);
  });

  it("start where registerFloor says they start", () => {
    for (const register of METRIC_REGISTERS) {
      if (register === "quiet") {
        expect(registerFloor(register)).toBe(Number.NEGATIVE_INFINITY);
        continue;
      }
      expect(registerFor(registerFloor(register)), register).toBe(register);
    }
  });
});

describe("holding a band", () => {
  it("takes the reading's own register when nothing is on the record", () => {
    for (const sigma of [-1, 0, 2.4, 2.6, 4]) expect(heldRegister(sigma, null)).toBe(registerFor(sigma));
  });

  it("escalates at the boundary itself, with no margin", () => {
    // The sentence a signal carries is chosen from the reading alone, so a
    // signal that emitted late would be worded for a band it never announced.
    expect(heldRegister(REGISTER_BANDS.concrete, "elevated")).toBe("concrete");
    expect(heldRegister(REGISTER_BANDS.spiking, "concrete")).toBe("spiking");
    expect(heldRegister(REGISTER_BANDS.spiking, "elevated")).toBe("spiking");
  });

  it("de-escalates only a margin below the held band's floor", () => {
    const floor = REGISTER_BANDS.concrete;
    expect(heldRegister(floor - 0.01, "concrete")).toBe("concrete");
    expect(heldRegister(floor - REGISTER_HYSTERESIS_SIGMA, "concrete")).toBe("concrete");
    expect(heldRegister(floor - REGISTER_HYSTERESIS_SIGMA - 0.001, "concrete")).toBe("elevated");
    // And from the top band down.
    expect(heldRegister(REGISTER_BANDS.spiking - 0.2, "spiking")).toBe("spiking");
    expect(heldRegister(REGISTER_BANDS.spiking - 0.3, "spiking")).toBe("concrete");
  });

  it("holds 'elevated' against a dip below the person's own pace, on the same margin", () => {
    expect(heldRegister(-0.2, "elevated")).toBe("elevated");
    expect(heldRegister(-0.3, "elevated")).toBe("quiet");
  });

  it("is idempotent: a band already held by a reading stays held by it", () => {
    for (const sigma of [-2, 0.5, 2.6, 3.9]) {
      const first = heldRegister(sigma, null);
      expect(heldRegister(sigma, first)).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

/**
 * raw_metric_observations for Patrick Mahomes on the `rss` source,
 * 2026-09-21, from 07:00 UTC (the first reading to clear the deadband) to
 * 14:00. Every row here was outside the deadband; everything earlier in the
 * day was inside it, so the record starts empty.
 *
 * `same` marks a reading whose observed quantity was identical to the one
 * before it — the rows Phase 21's identity rule already caught.
 */
interface LedgerRow {
  at: string;
  sigma: number;
  same?: true;
}

const NEWS_VOLUME_24H: LedgerRow[] = [
  { at: "07:00", sigma: 2.022 },
  { at: "07:15", sigma: 2.009, same: true },
  { at: "07:30", sigma: 2.095 },
  { at: "07:45", sigma: 2.179 },
  { at: "08:00", sigma: 2.261 },
  { at: "08:15", sigma: 2.244, same: true },
  { at: "08:30", sigma: 2.323 },
  { at: "08:45", sigma: 2.209 },
  { at: "09:00", sigma: 2.288 },
  { at: "09:15", sigma: 2.365 },
  { at: "09:30", sigma: 2.157 },
  { at: "09:45", sigma: 2.704 },
  { at: "10:00", sigma: 2.305 },
  { at: "10:15", sigma: 2.473 },
  { at: "10:30", sigma: 2.635 },
  { at: "10:45", sigma: 2.700 },
  { at: "11:00", sigma: 2.311 },
  { at: "11:15", sigma: 2.653 },
  { at: "11:30", sigma: 2.538 },
  { at: "11:45", sigma: 2.692 },
  { at: "12:00", sigma: 2.402 },
  { at: "12:15", sigma: 2.383, same: true },
  { at: "12:30", sigma: 2.363, same: true },
  { at: "12:45", sigma: 2.431 },
  { at: "13:30", sigma: 2.239 },
  { at: "13:45", sigma: 2.223, same: true },
  { at: "14:00", sigma: 2.207, same: true },
];

const VIRAL_MOMENT_RATE: LedgerRow[] = [
  { at: "08:45", sigma: 2.066 },
  { at: "09:00", sigma: 2.051, same: true },
  { at: "09:15", sigma: 2.259 },
  { at: "09:30", sigma: 2.460 },
  { at: "09:45", sigma: 2.655 },
  { at: "10:00", sigma: 2.842 },
  { at: "10:15", sigma: 3.020 },
  { at: "10:30", sigma: 2.981, same: true },
  { at: "10:45", sigma: 3.150 },
  { at: "11:00", sigma: 3.310 },
  { at: "11:15", sigma: 3.459 },
  { at: "11:30", sigma: 2.204 },
  { at: "11:45", sigma: 2.388 },
  { at: "12:00", sigma: 2.567 },
  { at: "12:15", sigma: 2.739 },
  { at: "12:30", sigma: 2.904 },
  { at: "12:45", sigma: 2.677 },
  { at: "13:30", sigma: 2.841 },
  { at: "13:45", sigma: 2.998 },
  { at: "14:00", sigma: 3.147 },
];

/** Walks a series through the shipped rule, exactly as the runner does poll by poll. */
function replay(rows: LedgerRow[]): { at: string; outcome: MetricOutcome }[] {
  let previous: PreviousObservation | null = null;
  let observed = 1000;
  return rows.map((row) => {
    // Any move at all; the identity rule is exercised by `same` instead.
    if (!row.same) observed += 1;
    const decision = emissionDecision(row.sigma, observed, previous);
    previous = { observed, register: decision.register, reported: outcomeReported(decision.outcome) };
    return { at: row.at, outcome: decision.outcome };
  });
}

const emitted = (rows: LedgerRow[]) =>
  replay(rows)
    .filter((row) => row.outcome === "emitted")
    .map((row) => row.at);

describe("replayed against the first live NFL game", () => {
  it("cuts news volume from 21 emissions to 3, and keeps the two that a reader would call news", () => {
    // What actually happened: 21 signals, most of them "Coverage of Patrick
    // Mahomes is running hot", roughly every fifteen minutes.
    expect(NEWS_VOLUME_24H.filter((row) => !row.same)).toHaveLength(21);
    // What would happen now: the first sighting, the moment it turned
    // concrete as the game story broke, and the moment it cooled back.
    expect(emitted(NEWS_VOLUME_24H)).toEqual(["07:00", "09:45", "13:30"]);
  });

  it("cuts viral moments from 18 emissions to 4", () => {
    expect(VIRAL_MOMENT_RATE.filter((row) => !row.same)).toHaveLength(18);
    expect(emitted(VIRAL_MOMENT_RATE)).toEqual(["08:45", "09:45", "11:30", "12:00"]);
  });

  it("is 39 emissions to 7 across the two metrics, an 82% cut on the day it mattered", () => {
    const before = [...NEWS_VOLUME_24H, ...VIRAL_MOMENT_RATE].filter((row) => !row.same).length;
    const after = emitted(NEWS_VOLUME_24H).length + emitted(VIRAL_MOMENT_RATE).length;
    expect(before).toBe(39);
    expect(after).toBe(7);
    expect(Math.round((1 - after / before) * 100)).toBe(82);
  });

  it("owes the cut to the BAND and not to the hysteresis alone: banding without the margin chatters six times", () => {
    // Banding alone would have flipped news volume across 2.5σ six times in
    // four hours, which is what the margin exists to absorb. Stated as a
    // measurement rather than as an assertion about the design.
    const plain = NEWS_VOLUME_24H.map((row) => registerFor(row.sigma));
    const flips = plain.filter((register, index) => index > 0 && register !== plain[index - 1]).length;
    expect(flips).toBe(6);
    // With the margin, the same series changes band twice.
    expect(emitted(NEWS_VOLUME_24H)).toHaveLength(3);
  });

  it("still reports the escalation promptly: the band turns concrete on the reading that crosses, not one later", () => {
    const walked = replay(NEWS_VOLUME_24H);
    const crossing = NEWS_VOLUME_24H.findIndex((row) => row.sigma >= REGISTER_BANDS.concrete);
    expect(NEWS_VOLUME_24H[crossing].at).toBe("09:45");
    expect(walked[crossing].outcome).toBe("emitted");
  });

  it("suppresses as same_register rather than silently, so the ledger still says why", () => {
    const outcomes = new Set(replay(NEWS_VOLUME_24H).map((row) => row.outcome));
    expect(outcomes).toEqual(new Set(["emitted", "same_register", "unchanged"]));
  });
});
