import { describe, expect, it } from "vitest";

import { NO_DEADLINE, deadlineAfter } from "./deadline";

function clock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => void (current += ms) };
}

describe("deadlineAfter", () => {
  it("admits work that can finish before the instant and refuses work that cannot", () => {
    const c = clock();
    const deadline = deadlineAfter(25_000, c.now);
    expect(deadline.at).toBe(1_025_000);
    expect(deadline.remainingMs()).toBe(25_000);

    // A 15-second call can start until exactly 10 seconds in, not after.
    expect(deadline.canStart(15_000)).toBe(true);
    c.advance(10_000);
    expect(deadline.canStart(15_000)).toBe(true);
    c.advance(1);
    expect(deadline.canStart(15_000)).toBe(false);
    // Cheaper work still fits.
    expect(deadline.canStart(1_000)).toBe(true);
    expect(deadline.expired()).toBe(false);
  });

  it("expires, and never reports negative time", () => {
    const c = clock();
    const deadline = deadlineAfter(1_000, c.now);
    c.advance(5_000);
    expect(deadline.expired()).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.canStart(0)).toBe(false);
  });

  it("treats a non-positive budget as already due", () => {
    const c = clock();
    expect(deadlineAfter(0, c.now).expired()).toBe(true);
    expect(deadlineAfter(-5, c.now).expired()).toBe(true);
  });

  it("NO_DEADLINE admits everything", () => {
    expect(NO_DEADLINE.canStart(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(NO_DEADLINE.expired()).toBe(false);
    expect(NO_DEADLINE.remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });
});
