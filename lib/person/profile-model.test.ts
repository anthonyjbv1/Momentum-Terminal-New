import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/config";

import {
  CONVICTION_BANDS,
  FORCES_WINDOW_MINUTES,
  FORCE_IMPACT_DECIMALS,
  STATE_RULE,
  convictionLevel,
  defaultRange,
  deriveState,
  emptySeries,
  forcesWindowLabel,
  formatSigned,
  formatSignedPercent,
  formatTrackedSince,
  isValidSlug,
  mergeSignals,
  periodChange,
  rangeAvailable,
  readForces,
  signalIdOf,
  tickCount,
  toSeries,
  type SeriesPoint,
} from "./profile-model";

/** A series of `count` slices, one tick each, moving linearly from `from` to `to`. */
function line(from: number, to: number, count: number, samplesEach = 1): SeriesPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const score = count === 1 ? from : from + ((to - from) * index) / (count - 1);
    return { at: new Date(Date.UTC(2026, 8, 8, 0, index)).toISOString(), score, open: score, samples: samplesEach };
  });
}

describe("toSeries", () => {
  it("coerces numeric strings, keeps slices in time order and falls back open to score", () => {
    const series = toSeries([
      { bucket_at: "2026-09-08T10:05:00Z", score: "51.2", open: "50.9", samples: "10" },
      { bucket_at: "2026-09-08T10:00:00Z", score: 50.5, open: null, samples: 1 },
    ]);
    expect(series).toEqual([
      { at: "2026-09-08T10:00:00Z", score: 50.5, open: 50.5, samples: 1 },
      { at: "2026-09-08T10:05:00Z", score: 51.2, open: 50.9, samples: 10 },
    ]);
    expect(tickCount(series)).toBe(11);
  });

  it("drops rows without a usable score", () => {
    expect(toSeries([{ bucket_at: "2026-09-08T10:00:00Z", score: "nope", open: null, samples: 1 }])).toEqual([]);
  });
});

describe("ranges", () => {
  it("needs two slices to draw, and opens on the shortest drawable range", () => {
    expect(rangeAvailable([])).toBe(false);
    expect(rangeAvailable(line(50, 50, 1))).toBe(false);
    expect(rangeAvailable(line(50, 51, 2))).toBe(true);

    const series = emptySeries();
    expect(defaultRange(series)).toBeNull();
    series["7d"] = line(50, 52, 3);
    expect(defaultRange(series)).toBe("7d");
    series["1h"] = line(50, 51, 5);
    expect(defaultRange(series)).toBe("1h");
  });
});

describe("periodChange", () => {
  it("is null with fewer than two ticks — one reading is not a change", () => {
    expect(periodChange([])).toBeNull();
    expect(periodChange(line(50, 50, 1))).toBeNull();
  });

  it("measures first tick to last tick using each slice's open and close", () => {
    const series: SeriesPoint[] = [
      { at: "2026-09-08T10:00:00Z", score: 50.4, open: 50.0, samples: 10 },
      { at: "2026-09-08T10:10:00Z", score: 51.0, open: 50.5, samples: 10 },
    ];
    const change = periodChange(series);
    expect(change).toMatchObject({ change: 1.0, percent: 2.0, direction: "heating", ticks: 20 });
    expect(change?.from).toBe("2026-09-08T10:00:00Z");
    expect(change?.to).toBe("2026-09-08T10:10:00Z");
  });

  it("works from a single slice that holds several ticks", () => {
    const change = periodChange([{ at: "2026-09-08T10:00:00Z", score: 49.0, open: 50.0, samples: 3 }]);
    expect(change).toMatchObject({ change: -1.0, percent: -2.0, direction: "cooling" });
  });
});

describe("deriveState — the STATE threshold", () => {
  it("is documented as 24h, ten ticks, one point", () => {
    expect(STATE_RULE).toEqual({ range: "24h", minTicks: 10, threshold: 1.0 });
  });

  it("is STABLE with no history at all", () => {
    expect(deriveState([])).toEqual({ state: "stable", change: null, ticks: 0, qualified: false });
  });

  it("stays STABLE below ten ticks however far the score moved", () => {
    expect(deriveState(line(50, 60, 9))).toMatchObject({ state: "stable", change: 10, ticks: 9, qualified: false });
  });

  it("reads HEATING at exactly the threshold with exactly enough ticks", () => {
    expect(deriveState(line(50, 51, 10))).toMatchObject({ state: "heating", ticks: 10, qualified: true });
    expect(deriveState(line(50, 51, 10)).change).toBeCloseTo(1.0);
  });

  it("reads COOLING at minus the threshold, and STABLE just inside it", () => {
    expect(deriveState(line(50, 49, 10)).state).toBe("cooling");
    expect(deriveState(line(50, 50.99, 10)).state).toBe("stable");
    expect(deriveState(line(50, 49.01, 10)).state).toBe("stable");
  });

  it("counts ticks, not slices, so dense slices qualify", () => {
    expect(deriveState(line(50, 52, 2, 5))).toMatchObject({ state: "heating", ticks: 10, qualified: true });
  });
});

describe("readForces", () => {
  // The window read: force and impact for every tick inside it.
  const window = [
    { force: "gravity", impact: "0.37" },
    { force: "gravity", impact: 0.21 },
    { force: "signals", impact: -1.2 },
    { force: "inverse_pair", impact: 0.3 },
  ];
  // The latest tick's rows, read only for the working each force recorded.
  const latest = [
    { force: "gravity", impact: "0.21", tick_number: 12, details: { decayed: 50.37 } },
    { force: "signals", impact: -1.2, tick_number: 12, details: null },
    { force: "conviction", impact: 0.1, tick_number: 11, details: { concentration: 0.7 } },
  ];

  it("is entirely idle (null) before the first tick", () => {
    const forces = readForces(window, latest, null);
    expect(forces.map((force) => force.key)).toEqual(["gravity", "signals", "market_mood", "conviction", "trading_activity"]);
    expect(forces.every((force) => force.impact === null && force.direction === "neutral")).toBe(true);
  });

  it("SUMS the window, with 0 for forces that wrote nothing in it", () => {
    const forces = readForces(window, latest, 12);
    const byKey = Object.fromEntries(forces.map((force) => [force.key, force]));
    // Two ticks of Gravity: what it moved the score by across the window, not
    // either tick on its own.
    expect(byKey.gravity).toMatchObject({ impact: 0.58, direction: "heating", details: { decayed: 50.37 } });
    expect(byKey.signals).toMatchObject({ impact: -1.2, direction: "cooling" });
    expect(byKey.market_mood).toMatchObject({ impact: 0, direction: "neutral" });
    // Conviction wrote nothing in the window, and its row from tick 11 is not
    // the latest tick's working either.
    expect(byKey.conviction).toMatchObject({ impact: 0, details: null });
    expect(byKey.trading_activity).toMatchObject({ impact: 0, direction: "neutral" });
    expect(forces.some((force) => (force.key as string) === "inverse_pair")).toBe(false);
  });

  it("a window of per-tick crumbs adds up to a figure that renders", () => {
    // The Phase 21 case, in the shape the board actually produces: Gravity
    // contributes about 0.005 points a tick and Market Mood 0.0006, 120 times
    // an hour. A single tick of either says nothing at two decimals — Market
    // Mood is 0.00 forever, Gravity flickers between 0.00 and the rounding
    // grain — and the hour is a number.
    const read = (rows: Array<{ force: string; impact: number }>, key: string) =>
      readForces(rows, [], 9).find((force) => force.key === key)!;

    expect(formatSigned(read([{ force: "market_mood", impact: -0.00062 }], "market_mood").impact ?? 0, FORCE_IMPACT_DECIMALS)).toBe("0.00");
    expect(formatSigned(read([{ force: "gravity", impact: -0.00504 }], "gravity").impact ?? 0, FORCE_IMPACT_DECIMALS)).toBe("−0.01");

    const gravity = read(Array.from({ length: 120 }, () => ({ force: "gravity", impact: -0.00504 })), "gravity");
    const mood = read(Array.from({ length: 120 }, () => ({ force: "market_mood", impact: -0.00062 })), "market_mood");
    expect(gravity.impact).toBeCloseTo(-0.6048, 4);
    expect(gravity.direction).toBe("cooling");
    expect(formatSigned(gravity.impact ?? 0, FORCE_IMPACT_DECIMALS)).toBe("−0.60");
    expect(formatSigned(mood.impact ?? 0, FORCE_IMPACT_DECIMALS)).toBe("−0.07");
  });

  it("colours even tiny impacts by their sign, once they round to something", () => {
    expect(readForces([{ force: "market_mood", impact: 0.01 }], [], 1).find((force) => force.key === "market_mood")?.direction).toBe("heating");
  });

  it("the caption's words follow the window's number", () => {
    // The panel says "over the last {forcesWindowLabel(FORCES_WINDOW_MINUTES)}",
    // so changing the constant changes the sentence and the two cannot disagree.
    expect(FORCES_WINDOW_MINUTES).toBe(60);
    expect(forcesWindowLabel(FORCES_WINDOW_MINUTES)).toBe("hour");
    expect(forcesWindowLabel(180)).toBe("3 hours");
    expect(forcesWindowLabel(30)).toBe("30 minutes");
  });

  it("the window matches the span Market Mood is measured over", () => {
    // Phase 19+ made Market Mood a trailing-window reading; Phase 21 makes the
    // panel's Market Mood row describe that same hour rather than one tick of it.
    expect(FORCES_WINDOW_MINUTES).toBe(DEFAULT_ENGINE_CONFIG.marketMood.windowMinutes);
  });
});

describe("convictionLevel", () => {
  it("mirrors the Engine's conviction bands", () => {
    expect(CONVICTION_BANDS.lowUpTo).toBe(DEFAULT_ENGINE_CONFIG.conviction.neutralUpTo);
    expect(CONVICTION_BANDS.moderateUpTo).toBe(DEFAULT_ENGINE_CONFIG.conviction.positiveUpTo);
  });

  const reading = (impact: number | null, concentration?: number) => ({
    key: "conviction" as const,
    label: "Conviction",
    description: "",
    impact,
    direction: "neutral" as const,
    details: concentration === undefined ? null : { concentration },
  });

  it("is unknown before the first tick and LOW when the force did nothing", () => {
    expect(convictionLevel(undefined)).toBeNull();
    expect(convictionLevel(reading(null))).toBeNull();
    expect(convictionLevel(reading(0))).toBe("low");
  });

  it("uses the recorded concentration when the Engine wrote one", () => {
    expect(convictionLevel(reading(0.05, 0.6))).toBe("low");
    expect(convictionLevel(reading(0.05, 0.61))).toBe("moderate");
    expect(convictionLevel(reading(0.15, 0.85))).toBe("moderate");
    expect(convictionLevel(reading(-0.05, 0.86))).toBe("high");
  });

  it("falls back to the sign of the impact", () => {
    expect(convictionLevel(reading(0.1))).toBe("moderate");
    expect(convictionLevel(reading(-0.1))).toBe("high");
  });
});

describe("mergeSignals", () => {
  it("interleaves signals and narratives newest first with their impacts", () => {
    const items = mergeSignals(
      [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          headline: "Drake announces tour",
          occurred_at: "2026-09-08T10:00:00Z",
          impact_score: "1.4",
          sentiment_label: "positive",
          sentiment_confidence: "0.82",
          processed: true,
          data_sources: { display_name: "YouTube" },
        },
      ],
      [{ id: "n1", text: "Tour news lifted the score.", created_at: "2026-09-08T10:00:30Z", score_before: "50.0", score_after: "51.4" }],
    );
    expect(items.map((item) => item.kind)).toEqual(["narrative", "signal"]);
    expect(items[0]).toMatchObject({ source: "The Engine", impact: 1.4, scoreBefore: 50, scoreAfter: 51.4 });
    expect(items[1]).toMatchObject({ source: "YouTube", impact: 1.4, sentiment: { label: "positive", confidence: 0.82 }, processed: true });
    expect(items[0].impact).toBeCloseTo(1.4);
    expect(signalIdOf(items[1])).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(signalIdOf(items[0])).toBeNull();
  });

  it("is empty when there is nothing, not a placeholder", () => {
    expect(mergeSignals([], [])).toEqual([]);
  });
});

describe("slugs and formatting", () => {
  it("accepts the seeded slug shape and rejects anything else before it hits the database", () => {
    expect(isValidSlug("kendrick-lamar")).toBe(true);
    expect(isValidSlug("mrbeast")).toBe(true);
    expect(isValidSlug("Drake")).toBe(false);
    expect(isValidSlug("drake-")).toBe(false);
    expect(isValidSlug("a b")).toBe(false);
    expect(isValidSlug("x".repeat(81))).toBe(false);
  });

  it("formats the dossier's numbers with real signs", () => {
    expect(formatTrackedSince("2026-09-05T20:57:26.380042+00:00")).toBe("Sep 5, 2026");
    expect(formatTrackedSince("not a date")).toBe("—");
    expect(formatSigned(1.234)).toBe("+1.2");
    expect(formatSigned(-0.4)).toBe("−0.4");
    expect(formatSigned(0)).toBe("0.0");
    expect(formatSigned(-0.01)).toBe("0.0");
    expect(formatSignedPercent(2.345)).toBe("+2.3%");
    expect(formatSignedPercent(-0.04)).toBe("−0.04%");
  });
});
