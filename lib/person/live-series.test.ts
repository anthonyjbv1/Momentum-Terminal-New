import { describe, expect, it } from "vitest";

import { TICK_SECONDS } from "@/components/engine/engine-clock";

import { LIVE_TICK_MS, MAX_LIVE_POINTS, foldTicks, foldTicksIntoRanges, latestTickAt, sliceMs } from "./live-series";
import { RANGES, emptySeries, type SeriesPoint } from "./profile-model";

const range = (key: string) => RANGES.find((definition) => definition.key === key)!;
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const tick = (offsetMs: number, score: number) => ({ at: iso(NOW + offsetMs), score });

function history(count: number, stepMs: number, endAt = NOW): SeriesPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const at = endAt - (count - 1 - index) * stepMs;
    return { at: iso(at), score: 50, open: 50, samples: Math.max(1, Math.round(stepMs / LIVE_TICK_MS)) };
  });
}

describe("live series", () => {
  it("keeps the Engine's cadence in one place", () => {
    expect(LIVE_TICK_MS).toBe(TICK_SECONDS * 1000);
    expect(sliceMs(range("1h"), [])).toBe(LIVE_TICK_MS);
    expect(sliceMs(range("24h"), [])).toBe(600_000);
    expect(sliceMs(range("all"), [])).toBe(LIVE_TICK_MS);
  });

  it("appends a tick as a new point on the 1H range and slides the window", () => {
    // 120 ticks span 59.5 minutes; one more fills the hour exactly (the window is inclusive, like the database's).
    const series = history(120, LIVE_TICK_MS);
    const next = foldTicks(series, [tick(LIVE_TICK_MS, 50.4)], range("1h"), NOW + LIVE_TICK_MS);
    expect(next).toHaveLength(121);
    expect(next[next.length - 1]).toEqual({ at: iso(NOW + LIVE_TICK_MS), score: 50.4, open: 50.4, samples: 1 });

    // From here on every tick pushes the oldest point out of the hour: the window is bounded.
    const after = foldTicks(next, [tick(2 * LIVE_TICK_MS, 50.5)], range("1h"), NOW + 2 * LIVE_TICK_MS);
    expect(after).toHaveLength(121);
    expect(after[0].at).toBe(series[1].at);
    expect(after[after.length - 1].score).toBe(50.5);
  });

  it("revises the last slice on the 24H range until a new slice is due", () => {
    const series = history(3, 600_000);
    const revised = foldTicks(series, [tick(LIVE_TICK_MS, 50.7)], range("24h"), NOW + LIVE_TICK_MS);
    expect(revised).toHaveLength(3);
    expect(revised[2]).toMatchObject({ score: 50.7, open: 50, samples: 21, at: iso(NOW + LIVE_TICK_MS) });

    const newSlice = foldTicks(revised, [tick(600_000 + LIVE_TICK_MS, 51.2)], range("24h"), NOW + 600_000 + LIVE_TICK_MS);
    expect(newSlice).toHaveLength(4);
    expect(newSlice[3]).toEqual({ at: iso(NOW + 600_000 + LIVE_TICK_MS), score: 51.2, open: 51.2, samples: 1 });
  });

  it("ignores ticks it already has, and bad ticks", () => {
    const series = history(5, LIVE_TICK_MS);
    expect(foldTicks(series, [tick(0, 99), tick(-LIVE_TICK_MS, 99)], range("1h"), NOW)).toEqual(series);
    expect(foldTicks(series, [{ at: "nope", score: 1 }, { at: iso(NOW + 1), score: Number.NaN }], range("1h"), NOW)).toEqual(series);
  });

  it("never grows past the cap", () => {
    const series = history(MAX_LIVE_POINTS, LIVE_TICK_MS);
    const burst = Array.from({ length: 30 }, (_, index) => tick((index + 1) * LIVE_TICK_MS, 50));
    const next = foldTicks(series, burst, range("all"), NOW + 30 * LIVE_TICK_MS);
    expect(next).toHaveLength(MAX_LIVE_POINTS);
    expect(next[next.length - 1].at).toBe(iso(NOW + 30 * LIVE_TICK_MS));
  });

  it("starts a series from nothing once the first ticks land", () => {
    const series = emptySeries();
    const once = foldTicksIntoRanges(series, [tick(0, 50)], NOW);
    expect(once["1h"]).toHaveLength(1);
    expect(once.all).toHaveLength(1);
    const twice = foldTicksIntoRanges(once, [tick(LIVE_TICK_MS, 50.1)], NOW + LIVE_TICK_MS);
    expect(twice["1h"]).toHaveLength(2);
    expect(twice["24h"]).toHaveLength(1); // ten-minute slice: the second tick revises the first
    expect(latestTickAt(twice)).toBe(iso(NOW + LIVE_TICK_MS));
    expect(foldTicksIntoRanges(twice, [], NOW)).toBe(twice);
  });
});
