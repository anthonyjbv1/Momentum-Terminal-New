import { describe, expect, it } from "vitest";

import { rebaselineStatus } from "./rebaseline";

const RSS = (extra: Record<string, unknown>) => ({
  name: "rss",
  config: { metrics: { news_volume_24h: { polarity: 1, delta: "level", baseline_window_hours: 336, sd_floor: 0.5, scale: 0.7, ...extra } } },
});

describe("rebaselineStatus", () => {
  it("says nothing for a source without a cut, and lists a cut with the date min_samples is due back to 24", () => {
    expect(rebaselineStatus([RSS({ min_samples: 24 })], new Date("2026-10-10T00:00:00Z"))).toEqual({ metrics: [], warnings: [] });
    const held = rebaselineStatus([RSS({ min_samples: 672, baseline_since: "2026-10-09T12:00:00Z" })], new Date("2026-10-10T00:00:00Z"));
    expect(held.metrics).toEqual([{ source: "rss", metric: "news_volume_24h", baselineSince: "2026-10-09T12:00:00.000Z", minSamples: 672, restoreMinSamplesAt: "2026-10-16T12:00:00.000Z", restored: false }]);
    expect(held.warnings).toEqual(["rss.news_volume_24h: baseline cut at 2026-10-09T12:00:00.000Z, min_samples 672 until 2026-10-16T12:00:00.000Z, then back to 24"]);
  });

  it("raises the warning once the week is up and min_samples is still held, and stands down once it is back", () => {
    const due = rebaselineStatus([RSS({ min_samples: 672, baseline_since: "2026-10-09T12:00:00Z" })], new Date("2026-10-16T12:00:00Z"));
    expect(due.warnings).toEqual(["rss.news_volume_24h: min_samples is still 672; the baseline cut of 2026-10-09T12:00:00.000Z is 7 days old, set min_samples back to 24"]);
    const restored = rebaselineStatus([RSS({ min_samples: 24, baseline_since: "2026-10-09T12:00:00Z" })], new Date("2026-10-17T00:00:00Z"));
    expect(restored.metrics[0].restored).toBe(true);
    expect(restored.warnings).toEqual([]);
  });
});
