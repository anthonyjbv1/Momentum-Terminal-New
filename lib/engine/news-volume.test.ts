import { describe, expect, it } from "vitest";

import replay from "@/lib/engine/__fixtures__/news-volume-replay-20261002.json";

import { DEFAULT_ENGINE_CONFIG, describeEngineOverrides, engineConfigFromEnv, withEngineConfig } from "./config";
import { EMPTY_DAY, dayStateFromSignals, readNewsVolume, storyBalance, storiesInWindow, tuneNewsVolume, utcDay, type NewsVolumeDayState, type WindowStory } from "./news-volume";
import type { Json } from "@/types/database";

import type { ScoredSignal } from "./types";

/**
 * THE NEWS-VOLUME TUNE (variant C), held to the replay that chose it.
 *
 * The fixture is the 2026-10-02 re-run of the replay over 09-28 00:00 to
 * 10-02 11:13 UTC: every news_volume_24h firing with the person's signed
 * article stories in its 24-hour window (stored impact and scorer
 * confidence), and the re-run's C column per person-day. The rule here must
 * reproduce that column exactly, firing by firing, because the column is
 * what was reviewed and chosen.
 */

const CONFIG = DEFAULT_ENGINE_CONFIG.newsVolume;
const ON = { ...CONFIG, enabled: true };

interface FixtureFiring {
  at: string;
  sigma: number;
  live: number;
  stories: Array<{ occurredAt: string; impact: number; confidence: number }>;
}
interface FixturePersonDay {
  slug: string;
  day: string;
  expectedC: number;
  firings: FixtureFiring[];
}

const personDays = (replay as { personDays: FixturePersonDay[] }).personDays;

const at = (stamp: string) => new Date(`${stamp.replace(" ", "T")}:00.000Z`);
const stories = (firing: FixtureFiring): WindowStory[] => firing.stories.map((s) => ({ occurredAt: at(s.occurredAt), impact: s.impact, confidence: s.confidence }));

/** Runs a day's firings in time order through the running-peak rule; returns the day's state and every detail. */
function runDay(day: FixturePersonDay) {
  let state: NewsVolumeDayState | null = null;
  const details = [];
  for (const firing of day.firings) {
    const read = readNewsVolume({ sigma: firing.sigma, at: at(firing.at), stories: stories(firing) }, state, ON);
    state = read.day;
    details.push(read.detail);
  }
  return { state: state!, details };
}

/** The day's peak as the rule reads it: the newest firing at the day's largest sigma (a tie re-reads). */
function peakOf(day: FixturePersonDay): FixtureFiring {
  return day.firings.reduce((best, firing) => (firing.sigma >= best.sigma ? firing : best), day.firings[0]);
}

describe("the news-volume tune reproduces the 10-02 re-run's C column", () => {
  it("covers the thirteen person-days of the window with all seventy-seven firings", () => {
    expect(personDays).toHaveLength(13);
    expect(personDays.reduce((n, day) => n + day.firings.length, 0)).toBe(77);
  });

  it.each(personDays.map((day) => [day.slug, day.day, day.expectedC, day] as const))("%s %s reads %s", (_slug, _day, expectedC, day) => {
    // Run live, as a running peak: the sum of the deltas is the day's total.
    const { state, details } = runDay(day);
    const total = details.reduce((sum, detail) => sum + detail.delta, 0);
    expect(total).toBeCloseTo(expectedC, 3);
    expect(state.applied).toBeCloseTo(expectedC, 3);
    // And the day's total is exactly the peak firing's own reading.
    const peak = peakOf(day);
    const alone = readNewsVolume({ sigma: peak.sigma, at: at(peak.at), stories: stories(peak) }, null, ON);
    expect(alone.detail.reading).toBeCloseTo(expectedC, 3);
    // A lull never takes the peak; a surge day ends at its largest sigma.
    if (peak.sigma > 0) expect(state.peakSigma).toBe(peak.sigma);
    else expect(state.peakSigma).toBe(Number.NEGATIVE_INFINITY);
    // Nothing a day gives is ever past the ceiling, either way.
    expect(Math.abs(state.applied)).toBeLessThanOrEqual(CONFIG.ceilingPoints + 1e-9);
  });

  it("Kai Cenat 10-01 is negative: eight allegation stories against two, where the live metric added +6.06", () => {
    const day = personDays.find((d) => d.slug === "kai-cenat" && d.day === "2026-10-01")!;
    const { state, details } = runDay(day);
    expect(day.firings.reduce((sum, f) => sum + f.live, 0)).toBeCloseTo(6.062, 2);
    expect(state.applied).toBeCloseTo(-0.606, 3);
    const peak = details[details.length - 1];
    expect(peak.sigma).toBe(3.62);
    expect(peak.balance).toBeCloseTo(-0.57, 2);
    expect(peak.signedStories).toBe(10);
    expect(peak.zeroBecause).toBeNull();
  });

  it("Mahomes 09-28 stays positive and sits on the ceiling: 25 stories to 3, uncapped 2.16 points", () => {
    const day = personDays.find((d) => d.slug === "patrick-mahomes" && d.day === "2026-09-28")!;
    const { state } = runDay(day);
    expect(state.applied).toBe(CONFIG.ceilingPoints);
    const peak = peakOf(day);
    const uncapped = readNewsVolume({ sigma: peak.sigma, at: at(peak.at), stories: stories(peak) }, null, { ...ON, ceilingPoints: 100 });
    expect(uncapped.detail.reading).toBeCloseTo(2.161, 3);
    expect(uncapped.detail.balance).toBeCloseTo(0.75, 2);
  });

  it("Jensen Huang reads 0 on all four days: three in the dead zone, one a lull", () => {
    const days = personDays.filter((d) => d.slug === "jensen-huang");
    expect(days.map((d) => d.day)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-02"]);
    for (const day of days) {
      const { state, details } = runDay(day);
      expect(state.applied).toBe(0);
      const peak = details.find((detail) => detail.sigma === peakOf(day).sigma)!;
      expect(peak.zeroBecause).toBe(day.day === "2026-10-02" ? "lull" : "dead_zone");
      if (day.day !== "2026-10-02") expect(Math.abs(peak.balance)).toBeLessThan(CONFIG.deadZone);
    }
    // The lull: a count two sigma BELOW the baseline, five signed stories leaning −0.72, and still nothing.
    const lull = personDays.find((d) => d.slug === "jensen-huang" && d.day === "2026-10-02")!;
    expect(lull.firings.every((f) => f.sigma < 0)).toBe(true);
    expect(lull.firings.reduce((sum, f) => sum + f.live, 0)).toBeCloseTo(-0.702, 2);
  });

  it("Bezos 09-29 and 09-30 read 0 for want of three signed stories; 10-01 reads +0.271 on exactly three", () => {
    const by = (day: string) => personDays.find((d) => d.slug === "jeff-bezos" && d.day === day)!;
    for (const day of ["2026-09-29", "2026-09-30"]) {
      const { state, details } = runDay(by(day));
      expect(state.applied).toBe(0);
      // The day's peak is the newest firing at its largest sigma (a tie re-reads): two signed stories among nine to twelve.
      const peak = [...details].reverse().find((d) => d.sigma === peakOf(by(day)).sigma)!;
      expect(peak.zeroBecause).toBe("too_few_signed");
      expect(peak.signedStories).toBeLessThan(CONFIG.minSignedStories);
    }
    const { state, details } = runDay(by("2026-10-01"));
    expect(state.applied).toBeCloseTo(0.271, 3);
    expect(details.find((d) => d.delta !== 0)?.signedStories).toBe(3);
  });

  it("Drake 10-01 reads +0.698, under the ceiling, from the day's fourth firing", () => {
    const day = personDays.find((d) => d.slug === "drake" && d.day === "2026-10-01")!;
    const { state, details } = runDay(day);
    expect(state.applied).toBeCloseTo(0.698, 3);
    expect(details.map((d) => d.delta !== 0)).toEqual([true, false, true, false]);
  });
});

describe("the rule, piece by piece", () => {
  const T = new Date("2026-10-02T12:00:00.000Z");
  const story = (hoursAgo: number, impact: number, confidence = 0.7): WindowStory => ({ occurredAt: new Date(T.getTime() - hoursAgo * 3600 * 1000), impact, confidence });
  const three = [story(1, -0.4), story(2, -0.3), story(3, -0.2)];

  it("the balance is the confidence-weighted vote of the signed stories; neutral stories carry nothing", () => {
    expect(storyBalance([story(1, 0.5, 0.9), story(2, -0.1, 0.3), story(3, 0, 1)])).toEqual({ balance: (0.9 - 0.3) / 1.2, signedImpact: 0.4, signedStories: 2 });
    expect(storyBalance([])).toEqual({ balance: 0, signedImpact: 0, signedStories: 0 });
  });

  it("the window is the 24 hours up to the firing, exclusive at the far end", () => {
    const inside = story(23.99, -0.1);
    const edge = story(24, -0.1);
    const after = { ...story(0, 0.2), occurredAt: new Date(T.getTime() + 1) };
    expect(storiesInWindow([inside, edge, story(0, 0.2), after], T, 24)).toEqual([inside, story(0, 0.2)]);
  });

  it("a lull contributes nothing however the stories lean", () => {
    const { detail, day } = readNewsVolume({ sigma: -2.5, at: T, stories: three }, null, ON);
    expect(detail).toMatchObject({ reading: 0, delta: 0, zeroBecause: "lull", multiplier: 0 });
    expect(day.peakSigma).toBe(Number.NEGATIVE_INFINITY);
  });

  it("at the threshold the surge adds nothing, and it still takes the day's peak", () => {
    const { detail, day } = readNewsVolume({ sigma: 2, at: T, stories: three }, null, ON);
    expect(detail).toMatchObject({ reading: 0, delta: 0, zeroBecause: "at_threshold", multiplier: 1 });
    expect(day).toEqual({ day: "2026-10-02", peakSigma: 2, applied: 0 });
  });

  it("the multiplier is sigma over the threshold, at most 2; the reading is (multiplier − 1) × the signed impact, signed by the balance", () => {
    const { detail } = readNewsVolume({ sigma: 3, at: T, stories: three }, null, ON);
    expect(detail.multiplier).toBe(1.5);
    expect(detail.reading).toBeCloseTo(-0.5 * 0.9, 9);
    const doubled = readNewsVolume({ sigma: 9, at: T, stories: three }, null, { ...ON, ceilingPoints: 100 });
    expect(doubled.detail.multiplier).toBe(2);
    expect(doubled.detail.reading).toBeCloseTo(-0.9, 9);
  });

  it("the ceiling caps the reading either way", () => {
    const big = [story(1, 2, 0.9), story(2, 1.5, 0.9), story(3, 1, 0.9)];
    expect(readNewsVolume({ sigma: 4, at: T, stories: big }, null, ON).detail.reading).toBe(0.75);
    expect(readNewsVolume({ sigma: 4, at: T, stories: big.map((s) => ({ ...s, impact: -s.impact })) }, null, ON).detail.reading).toBe(-0.75);
  });

  it("peak-only: a later firing moves the day only when its sigma reaches the peak, and then by the difference; a tie re-reads", () => {
    const first = readNewsVolume({ sigma: 3, at: T, stories: three }, null, ON);
    expect(first.detail.delta).toBeCloseTo(-0.45, 9);
    const lower = readNewsVolume({ sigma: 2.5, at: new Date(T.getTime() + 60_000), stories: three }, first.day, ON);
    expect(lower.detail).toMatchObject({ delta: 0, zeroBecause: "not_the_peak" });
    expect(lower.day).toEqual(first.day);
    // The same sigma again, with one more story in the window: the day is re-read at the newer window.
    const tie = readNewsVolume({ sigma: 3, at: new Date(T.getTime() + 90_000), stories: [...three, story(0.1, -0.1)] }, lower.day, ON);
    expect(tie.detail.reading).toBeCloseTo(-0.5, 9);
    expect(tie.detail.delta).toBeCloseTo(-0.05, 9);
    expect(tie.day.day).toBe("2026-10-02");
    expect(tie.day.peakSigma).toBe(3);
    expect(tie.day.applied).toBeCloseTo(-0.5, 9);
    // A higher sigma with the coverage now leaning the other way swings the day to its own reading.
    const flipped = [story(0.5, 0.6, 0.9), story(0.6, 0.5, 0.9), story(0.7, 0.4, 0.9), ...three.map((s) => ({ ...s, confidence: 0.3 })), story(0.1, -0.1, 0.3)];
    const higher = readNewsVolume({ sigma: 4, at: new Date(T.getTime() + 120_000), stories: flipped }, tie.day, ON);
    expect(higher.detail.balance).toBeCloseTo((2.7 - 1.2) / 3.9, 9);
    expect(higher.detail.reading).toBeCloseTo(Math.min(0.75, 1 * (1.5 - 1.0)), 9);
    expect(higher.detail.delta).toBeCloseTo(0.5 - -0.5, 9);
    expect(higher.day.peakSigma).toBe(4);
    expect(higher.day.applied).toBeCloseTo(0.5, 9);
  });

  it("a new UTC day starts from nothing", () => {
    const yesterday: NewsVolumeDayState = { day: "2026-10-01", peakSigma: 5, applied: 0.75 };
    const { detail, day } = readNewsVolume({ sigma: 3, at: T, stories: three }, yesterday, ON);
    expect(detail.dayBefore).toEqual({ peakSigma: null, applied: 0 });
    expect(detail.delta).toBeCloseTo(-0.45, 9);
    expect(day.day).toBe("2026-10-02");
    expect(utcDay(new Date("2026-10-01T23:59:59.999Z"))).toBe("2026-10-01");
    expect(EMPTY_DAY).toEqual({ peakSigma: Number.NEGATIVE_INFINITY, applied: 0 });
  });

  it("the day's state is read back from the day's processed firings: the largest sigma and the impacts summed", () => {
    const rows = [
      { sigma: 2.5, impact: -0.3, occurredAt: new Date("2026-10-02T08:00:00Z") },
      { sigma: 3.1, impact: -0.2, occurredAt: new Date("2026-10-02T10:00:00Z") },
      { sigma: 2.0, impact: 0, occurredAt: new Date("2026-10-02T11:00:00Z") },
      { sigma: 4, impact: 0.75, occurredAt: new Date("2026-10-01T23:00:00Z") },
    ];
    expect(dayStateFromSignals(rows, T)).toEqual({ day: "2026-10-02", peakSigma: 3.1, applied: -0.5 });
    expect(dayStateFromSignals([], T)).toBeNull();
    expect(dayStateFromSignals([{ sigma: null, impact: 0.2, occurredAt: T }], T)).toBeNull();
  });

  it("tuneNewsVolume replaces only news-volume firings, counts this tick's own articles in the window, and leaves everything else as scored", () => {
    const base = { ageHours: 0, freshness: 1, volumeWeight: 1 };
    const sig = (id: string, rawPayload: Json, impact: number, direction: -1 | 0 | 1, confidence: number, minutesAgo = 0): ScoredSignal => ({
      signal: { id, personId: "p", headline: id, rawPayload, sourceName: "rss", sourceTier: 3, occurredAt: new Date(T.getTime() - minutesAgo * 60_000), createdAt: T },
      sentiment: { label: direction < 0 ? "negative" : direction > 0 ? "positive" : "neutral", confidence, direction },
      impact,
      ...base,
    });
    const metric = (id: string, sigma: number, minutesAgo: number) => sig(id, { kind: "metric", metric: "news_volume_24h", sigma, polarity: 1, scale: 0.7 }, 0.5, 1, 0.5, minutesAgo);
    const scored = [
      sig("a1", { kind: "article" }, -0.4, -1, 0.8, 30),
      metric("m-late", 3.5, 5),
      sig("a2", { kind: "article" }, -0.3, -1, 0.7, 20),
      metric("m-early", 2.5, 10),
      sig("other", { kind: "metric", metric: "view_count", sigma: 3, polarity: 1, scale: 1 }, 0.4, 1, 0.5),
    ];
    const loaded = { stories: [story(5, -0.2, 0.6)], today: null };
    const tuned = tuneNewsVolume(scored, loaded, ON);
    expect(tuned.map((s) => s.signal.id)).toEqual(scored.map((s) => s.signal.id));
    expect(tuned[0]).toBe(scored[0]);
    expect(tuned[2]).toBe(scored[2]);
    expect(tuned[4]).toBe(scored[4]);
    // Three signed stories (one loaded, two from this tick), balance −1, signed impact −0.9.
    const early = tuned[3];
    expect(early.newsVolume).toMatchObject({ sigma: 2.5, signedStories: 3, balance: -1, multiplier: 1.25, zeroBecause: null });
    expect(early.impact).toBeCloseTo(-0.25 * 0.9, 9);
    // The later, larger firing in the same tick moves the day on by the difference.
    const late = tuned[1];
    expect(late.newsVolume?.reading).toBeCloseTo(-0.75 * 0.9, 9);
    expect(late.impact).toBeCloseTo(-0.75 * 0.9 - -0.25 * 0.9, 9);
    expect(late.newsVolume?.dayBefore.peakSigma).toBe(2.5);
    expect(late.newsVolume?.dayBefore.applied).toBeCloseTo(-0.225, 9);
    // Without any firing in the tick nothing is touched.
    expect(tuneNewsVolume([scored[0]], loaded, ON)).toEqual([scored[0]]);
  });
});

describe("the switch", () => {
  it("ships off, and only the exact string \"true\" turns it on", () => {
    expect(DEFAULT_ENGINE_CONFIG.newsVolume).toEqual({ enabled: false, metric: "news_volume_24h", windowHours: 24, thresholdSigma: 2, maxMultiplier: 2, deadZone: 0.25, minSignedStories: 3, ceilingPoints: 0.75 });
    for (const raw of [undefined, "", "TRUE", "1", "yes", " false "]) {
      expect(engineConfigFromEnv({ newsVolumeTuneEnabled: raw }).newsVolume.enabled).toBe(false);
    }
    const on = engineConfigFromEnv({ newsVolumeTuneEnabled: " true " });
    expect(on.newsVolume).toEqual({ ...DEFAULT_ENGINE_CONFIG.newsVolume, enabled: true });
    expect(describeEngineOverrides(on)).toContain("newsVolume.enabled = true (default false)");
    expect(describeEngineOverrides(withEngineConfig({}))).not.toContain("newsVolume.enabled = true (default false)");
  });
});
