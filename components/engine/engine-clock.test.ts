import { describe, expect, it } from "vitest";

import { TICK_SECONDS, formatCountdown, msUntilNextTick, secondsUntilNextTick } from "./engine-clock";

describe("engine clock", () => {
  it("counts down from 30 to 1 across a cycle aligned to wall-clock multiples of 30 s", () => {
    const boundary = 1_800_000_000_000; // divisible by 30 000
    expect(secondsUntilNextTick(boundary)).toBe(TICK_SECONDS);
    expect(secondsUntilNextTick(boundary + 999)).toBe(TICK_SECONDS);
    expect(secondsUntilNextTick(boundary + 1_000)).toBe(29);
    expect(secondsUntilNextTick(boundary + 29_000)).toBe(1);
    expect(secondsUntilNextTick(boundary + 29_999)).toBe(1);
    expect(secondsUntilNextTick(boundary + 30_000)).toBe(TICK_SECONDS);
  });

  it("ticks land on :00 and :30 of every minute", () => {
    const minute = Date.UTC(2026, 8, 7, 12, 34, 0);
    expect(secondsUntilNextTick(minute)).toBe(30);
    expect(secondsUntilNextTick(minute + 30_000)).toBe(30);
    expect(secondsUntilNextTick(minute + 45_000)).toBe(15);
  });

  it("gives millisecond precision for smooth progress", () => {
    const boundary = 1_800_000_000_000;
    expect(msUntilNextTick(boundary)).toBe(30_000);
    expect(msUntilNextTick(boundary + 12_345)).toBe(17_655);
  });

  it("formats as m:ss", () => {
    expect(formatCountdown(30)).toBe("0:30");
    expect(formatCountdown(7)).toBe("0:07");
    expect(formatCountdown(90)).toBe("1:30");
  });
});
