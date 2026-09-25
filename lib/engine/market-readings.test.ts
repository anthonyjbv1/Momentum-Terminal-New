import { afterEach, describe, expect, it, vi } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";

import { rulesBasedScorer } from "./sentiment/rules";
import { createMemoryEngineStore, type MemoryEngineSeed } from "./store";
import { runEngineTick } from "./tick";
import { MARKET_FORCES, SCORE_FORCES, type TradeEvent } from "./types";

/**
 * THE SCORE IS INDEPENDENT OF TRADING (Phase 29, Option A).
 *
 * Conviction reads open paper capital and Trading Activity reads the trade
 * tape. Both are participant activity, and nothing derived from participant
 * activity may feed the index. So both are still computed every tick and
 * reported as MARKET readings, and neither is in the sum that moves the
 * score nor in the audit trail of what did. Two Engines, one under heavy
 * trading and one under none, write byte-identical score history.
 */

const NOW = new Date("2026-09-25T12:00:00.000Z");
const mrbeast = makePerson({ id: "p-mrbeast", slug: "mrbeast", display_name: "MrBeast", revert_target: 68, max_allocation_cents: 9_000_000 });
const drake = makePerson({ id: "p-drake", slug: "drake", display_name: "Drake", revert_target: 65, category: "musician" });

/** A day of steady buying, then a burst in the last half minute: enough baseline for the force to read, and a deviation for it to read as. */
function heavyTape(): TradeEvent[] {
  const events: TradeEvent[] = [];
  for (let minute = 1; minute <= 24 * 60; minute += 1) {
    events.push({ personId: "p-mrbeast", side: "BUY", amountCents: 100_000, createdAt: new Date(NOW.getTime() - minute * 60_000) });
  }
  for (let i = 0; i < 20; i += 1) {
    events.push({ personId: "p-mrbeast", side: "BUY", amountCents: 500_000, createdAt: new Date(NOW.getTime() - 1_000 * (i + 1)) });
  }
  return events;
}

function seed(extra: Partial<MemoryEngineSeed> = {}): MemoryEngineSeed {
  return { people: [mrbeast, drake], ...extra };
}

/**
 * The Engine stamps last_tick_at with its finish time, measured on the wall
 * clock, and Gravity reads the hours since that stamp. Two runs that take a
 * different number of milliseconds would therefore differ by that many
 * milliseconds of Gravity, which is the clock, not trading. The clock is
 * pinned to each tick's `now` so the only difference between the runs is the
 * trading.
 */
async function runDay(seedFor: MemoryEngineSeed, ticks: number) {
  const store = createMemoryEngineStore(seedFor);
  const summaries = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    const now = new Date(NOW.getTime() + tick * 30_000);
    vi.spyOn(Date, "now").mockImplementation(() => now.getTime());
    summaries.push(await runEngineTick({ store, scorer: rulesBasedScorer, now }));
    vi.restoreAllMocks();
  }
  return { store, summaries };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the score under trading (Phase 29, Option A)", () => {
  it("names which forces move the score and which describe the market", () => {
    expect(SCORE_FORCES).toEqual(["gravity", "signals", "market_mood", "inverse_pair"]);
    expect(MARKET_FORCES).toEqual(["conviction", "trading_activity"]);
  });

  it("writes byte-identical score history with and without heavy trading, while still reporting the market readings", async () => {
    // 78% of the allocation cap committed and a buying burst on the tape.
    const traded = await runDay(seed({ openCapitalCents: { "p-mrbeast": 7_000_000 }, tradeEvents: heavyTape() }), 40);
    const quiet = await runDay(seed(), 40);

    // THE PROPERTY. Every score, every tick, identical to the last digit.
    const historyOf = (store: typeof traded.store) => store.scoreHistory.map((row) => `${row.personId}:${row.tickNumber}:${row.score}`);
    expect(historyOf(traded.store)).toEqual(historyOf(quiet.store));
    expect(traded.store.people.map((p) => p.current_score)).toEqual(quiet.store.people.map((p) => p.current_score));

    // The readings are computed and carried: Conviction reads the concentration, Trading Activity the burst.
    const first = traded.summaries[0].people.find((p) => p.slug === "mrbeast")!;
    expect(first.market).toBeDefined();
    expect(first.market!.conviction).toBeGreaterThan(0.05);
    expect(first.market!.conviction).toBeLessThan(0.15);
    expect(first.market!.tradingActivity).not.toBe(0);
    const quietFirst = quiet.summaries[0].people.find((p) => p.slug === "mrbeast")!;
    expect(quietFirst.market).toEqual({ conviction: 0, tradingActivity: 0 });

    // And neither reading is in the score's sum or its audit trail.
    for (const summary of traded.summaries) {
      for (const person of summary.people) {
        expect(Object.keys(person.forces)).not.toContain("conviction");
        expect(Object.keys(person.forces)).not.toContain("trading_activity");
      }
    }
    expect(traded.store.scoreEvents.some((event) => event.force === "conviction" || event.force === "trading_activity")).toBe(false);
    expect(traded.store.scoreEvents.length).toBeGreaterThan(0);
  });
});
