import { describe, expect, it } from "vitest";

import { availabilityNote, closesNote, untilLabel } from "./trade-bar";

/** The trade bar's short lines (Phase 29b). */
describe("the trade bar's status line", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");

  it("says a halt in three words and a number: Halted · N min left", () => {
    expect(availabilityNote({ state: "halted", until: "2026-09-25T12:12:00Z", reason: "The premium moved 3.01 points in 10 minutes." }, now)).toBe("Halted · 12 min left");
    expect(availabilityNote({ state: "halted", until: "2026-09-25T12:00:20Z", reason: null }, now)).toBe("Halted · <1 min left");
    expect(availabilityNote({ state: "halted", until: "2026-09-25T14:00:00Z", reason: null }, now)).toBe("Halted · 2 h left");
  });

  it("reads the page's clock, not the wall clock, so the server and the first client render agree", () => {
    const until = "2026-09-25T12:30:00Z";
    expect(untilLabel(until, now)).toBe("30 min");
    expect(untilLabel(until, now + 10 * 60_000)).toBe("20 min");
  });

  it("the other states, and nothing when the market is open", () => {
    expect(availabilityNote({ state: "paused" }, now)).toBe("Trading paused");
    expect(availabilityNote({ state: "display_only" }, now)).toBe("Display-only · closing only");
    expect(availabilityNote({ state: "tradeable" }, now)).toBeNull();
  });
});

describe("Closes up to X", () => {
  it("is not shown when X is the holding the status line already states", () => {
    expect(closesNote(3, 3)).toBeNull();
    expect(closesNote(1.451, 1.451)).toBeNull();
  });

  it("is shown when the closable amount differs from the holding", () => {
    expect(closesNote(3, 2)).toBe("Closes up to 2 shares");
    expect(closesNote(3, 1)).toBe("Closes up to 1 share");
  });

  it("is not shown with nothing closable", () => {
    expect(closesNote(3, 0)).toBeNull();
  });
});
