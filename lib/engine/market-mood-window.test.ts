import { describe, expect, it } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";

import { DEFAULT_ENGINE_CONFIG, withEngineConfig } from "./config";
import { EMPTY_MOOD_WINDOW_HISTORY, foldTickIntoWindow, windowedMood } from "./forces/market-mood";
import { rulesBasedScorer } from "./sentiment/rules";
import { createMemoryEngineStore, readMoodWindowHistory } from "./store";
import { runEngineTick } from "./tick";
import type { EngineSignal } from "./types";

/**
 * PHASE 19+ — Market Mood over a trailing window, applied per hour.
 *
 * Two things this file exists to hold still:
 *
 *  1. THE RATE IS DERIVED, NOT CHOSEN. 1.41 points an hour is the old
 *     per-tick fraction of 0.25 divided by the measured rise in the force's
 *     firing, then expressed per hour. If someone edits the rate without
 *     re-deriving it, the arithmetic here stops agreeing.
 *  2. THE FORCE IS CADENCE-INDEPENDENT. The same wall-clock hour of the same
 *     tide moves a score the same distance whether the Engine ticks every
 *     thirty seconds or every minute. A per-tick force would have re-levelled
 *     the whole board the moment the interval changed — the class of bug that
 *     produced the poll-interval skip and the stale volume reference.
 */

/**
 * Measured over the 48 hours to 2026-09-18, on 5,759 ticks: the windowed mood
 * would have carried 21.27× the gross movement the instantaneous one did
 * (99.8% of ticks nonzero against 3.5%, each reading smaller). This is a
 * measurement of the board, not a constant of nature; re-derive it when the
 * burst cadence moves.
 */
const MEASURED_GROSS_CONTRIBUTION_RATIO = 21.27;
const OLD_PER_TICK_FRACTION = 0.25;
const TICKS_PER_HOUR_AT_30S = 120;

describe("the rate is derived from the measured firing, not chosen", () => {
  it("equals the old per-tick fraction divided by the measured ratio, expressed per hour", () => {
    const equivalentPerTickFraction = OLD_PER_TICK_FRACTION / MEASURED_GROSS_CONTRIBUTION_RATIO;
    expect(equivalentPerTickFraction).toBeCloseTo(0.01175, 5);
    expect(equivalentPerTickFraction * TICKS_PER_HOUR_AT_30S).toBeCloseTo(DEFAULT_ENGINE_CONFIG.marketMood.ratePerHour, 2);
  });

  it("ships the window and the rate as the two tunables, both stated", () => {
    expect(DEFAULT_ENGINE_CONFIG.marketMood.windowMinutes).toBe(60);
    expect(DEFAULT_ENGINE_CONFIG.marketMood.ratePerHour).toBe(1.41);
    // The brakes are unchanged by the re-derivation.
    expect(DEFAULT_ENGINE_CONFIG.marketMood.maxAbsMood).toBe(2);
    expect(DEFAULT_ENGINE_CONFIG.marketMood.maxAbsImpact).toBe(0.5);
  });
});

describe("the window read back from the Signals force's audit trail", () => {
  const active = new Set(["p1", "p2"]);

  it("counts a tick that moved anyone once, however many people it moved", () => {
    const history = readMoodWindowHistory(
      [
        { person_id: "p1", impact: 1.2, tick_number: 10 },
        { person_id: "p2", impact: -0.4, tick_number: 10 },
        { person_id: "p1", impact: 0.6, tick_number: 14 },
      ],
      active,
    );
    expect(history.readings).toBe(2);
    expect(history.totalImpact).toBeCloseTo(1.4);
    expect(history.totalByPerson.get("p1")).toBeCloseTo(1.8);
    expect(history.totalByPerson.get("p2")).toBeCloseTo(-0.4);
  });

  it("drops people who have left the board, and rows that carry nothing", () => {
    const history = readMoodWindowHistory(
      [
        { person_id: "gone", impact: 9, tick_number: 1 },
        { person_id: "p1", impact: 0, tick_number: 2 },
        { person_id: "p1", impact: null, tick_number: 3 },
        { person_id: "p1", impact: "0.5", tick_number: 4 },
      ],
      active,
    );
    expect(history.readings).toBe(1);
    expect(history.totalImpact).toBeCloseTo(0.5);
  });

  it("spreads the board's movement across the people on it now", () => {
    const history = readMoodWindowHistory([{ person_id: "p1", impact: 1.2, tick_number: 10 }], active);
    expect(windowedMood({ ...history, people: 2 })).toBeCloseTo(0.6);
    expect(windowedMood({ ...history, people: 4 })).toBeCloseTo(0.3);
    expect(windowedMood({ ...EMPTY_MOOD_WINDOW_HISTORY, people: 4 })).toBe(0);
  });

  it("a tick that moved nobody is not a reading: it cannot dilute the tide", () => {
    const burst = foldTickIntoWindow(EMPTY_MOOD_WINDOW_HISTORY, new Map([["p1", 1.2]]), 2);
    let held = burst;
    for (let i = 0; i < 119; i += 1) held = foldTickIntoWindow(held, new Map([["p1", 0]]), 2);
    expect(held.readings).toBe(1);
    expect(windowedMood(held)).toBeCloseTo(windowedMood(burst));
  });
});

describe("the force is independent of the tick cadence", () => {
  const NOW = new Date("2026-09-19T12:00:00.000Z");
  const drake = makePerson({ id: "p-drake", slug: "drake", display_name: "Drake", revert_target: 65, current_score: 50 });
  const quiet = makePerson({ id: "p-quiet", slug: "quiet", display_name: "Quiet", revert_target: 50, current_score: 50 });
  const headline = (): EngineSignal => ({
    id: "s1",
    personId: "p-drake",
    headline: "Drake crosses 100M monthly listeners",
    rawPayload: { kind: "milestone" },
    sourceName: "spotify",
    sourceTier: 2,
    occurredAt: NOW,
    createdAt: NOW,
  });

  /**
   * One hour of ticks at `intervalSeconds`, with a single burst on the first
   * tick. Returns everything Market Mood moved the quiet person, who has no
   * signals of their own and so feels the tide and nothing else.
   */
  async function moodMovementOverOneHour(intervalSeconds: number): Promise<number> {
    // Gravity is off for this person (target = score) and the drift is off,
    // so the tide is the only force writing to them.
    const store = createMemoryEngineStore({ people: [drake, quiet], signals: [headline()] });
    const config = withEngineConfig({ marketMood: { ...DEFAULT_ENGINE_CONFIG.marketMood } });
    const ticks = 3600 / intervalSeconds;
    for (let i = 0; i < ticks; i += 1) {
      await runEngineTick({ store, scorer: rulesBasedScorer, now: new Date(NOW.getTime() + i * intervalSeconds * 1000), config });
    }
    return store.scoreEvents.filter((event) => event.personId === "p-quiet" && event.force === "market_mood").reduce((sum, event) => sum + event.impact, 0);
  }

  it("moves a score the same distance over the same hour at 30 and at 60 seconds a tick", async () => {
    const fast = await moodMovementOverOneHour(30);
    const slow = await moodMovementOverOneHour(60);
    expect(fast).toBeGreaterThan(0);
    // Within a percent. The two cadences quantise the same integral at
    // different step sizes, and the first tick of each run is credited the
    // same firstTickDeltaHours whatever the interval, which is where the
    // residual comes from. A PER-TICK force would differ by 2×: 120 splashes
    // against 60.
    expect(Math.abs(slow / fast - 1)).toBeLessThan(0.02);
  });
});
