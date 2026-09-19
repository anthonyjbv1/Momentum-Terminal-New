import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { STANDBY_AFTER_TICK_INTERVALS, readBoardPulse } from "./board-pulse";

/**
 * The banner's reading of the board (Phase 19+). The Mood indicator carried
 * null from Phase 6a and always said "—"; it now shows the windowed mood and
 * whether the Engine is still ticking.
 */

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const tickAgo = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const INTERVAL = DEFAULT_ENGINE_CONFIG.tick.intervalSeconds;

describe("the board pulse", () => {
  it("reads the latest tick's mood and says the Engine is live", () => {
    const pulse = readBoardPulse({ mood: 0.0342, started_at: tickAgo(20) }, NOW);
    expect(pulse).toEqual({ mood: 0.0342, at: tickAgo(20), status: "live", windowMinutes: 60 });
  });

  it("falls to standby only once several ticks have been missed", () => {
    expect(readBoardPulse({ mood: 0.03, started_at: tickAgo(INTERVAL * STANDBY_AFTER_TICK_INTERVALS) }, NOW).status).toBe("live");
    expect(readBoardPulse({ mood: 0.03, started_at: tickAgo(INTERVAL * STANDBY_AFTER_TICK_INTERVALS + 1) }, NOW).status).toBe("standby");
    // A stopped Engine still reports its last reading; the dot, not the
    // number, is what says the board is no longer moving.
    expect(readBoardPulse({ mood: 0.03, started_at: tickAgo(3600) }, NOW).mood).toBe(0.03);
  });

  it("has no reading before the first tick, or when the row is unusable", () => {
    for (const row of [null, { mood: 0.1, started_at: "not a date" }]) {
      expect(readBoardPulse(row, NOW)).toMatchObject({ mood: null, at: null, status: "standby" });
    }
    expect(readBoardPulse({ mood: null, started_at: tickAgo(10) }, NOW).mood).toBeNull();
    expect(readBoardPulse({ mood: "0.0412", started_at: tickAgo(10) }, NOW).mood).toBe(0.0412);
  });

  it("carries the window it was read over, so the indicator can say so", () => {
    expect(readBoardPulse({ mood: 0.02, started_at: tickAgo(10) }, NOW).windowMinutes).toBe(DEFAULT_ENGINE_CONFIG.marketMood.windowMinutes);
  });
});
