import { describe, expect, it } from "vitest";

import { sparklinePath } from "@/components/home/sparkline";

import { relativeTime } from "./relative-time";

describe("sparklinePath", () => {
  it("needs at least two usable points", () => {
    expect(sparklinePath([])).toBeNull();
    expect(sparklinePath([50])).toBeNull();
    expect(sparklinePath([50, Number.NaN])).toBeNull();
    expect(sparklinePath([50, 51])).not.toBeNull();
  });

  it("spans the box, low score at the bottom and high at the top", () => {
    const path = sparklinePath([40, 60], 100, 24, 2);
    // Two points: left edge at the low value, right edge at the high value.
    expect(path).toBe("M0.00,22.00 L100.00,2.00");
  });

  it("puts a flat series on the centre line rather than dividing by zero", () => {
    expect(sparklinePath([50, 50, 50], 100, 24, 2)).toBe("M0.00,12.00 L50.00,12.00 L100.00,12.00");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");

  it("reads as a compact age", () => {
    expect(relativeTime("2026-09-08T11:59:40Z", now)).toBe("now");
    expect(relativeTime("2026-09-08T11:57:00Z", now)).toBe("3m");
    expect(relativeTime("2026-09-08T10:00:00Z", now)).toBe("2h");
    expect(relativeTime("2026-09-03T12:00:00Z", now)).toBe("5d");
  });

  it("survives a clock skew or an unparseable stamp", () => {
    expect(relativeTime("2026-09-08T12:00:30Z", now)).toBe("now");
    expect(relativeTime("not a date", now)).toBe("");
  });
});
