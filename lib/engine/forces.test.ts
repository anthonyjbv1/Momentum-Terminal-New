import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG as CONFIG } from "./config";
import { convictionForce, convictionImpact } from "./forces/conviction";
import { gravityForce } from "./forces/gravity";
import { EMPTY_MOOD_WINDOW_HISTORY, foldTickIntoWindow, marketMoodForce, windowedMood, type MoodWindow } from "./forces/market-mood";
import { foldMetricMoments, freshnessWeight, isExpiredSignal, scoreSignals, signalFreshness, signalImpact, signalsForce, tierMultiplier } from "./forces/signals";
import { tradingActivityForce, windowedNetFlows } from "./forces/trading-activity";
import { inversePairAdjustments } from "./inverse-pairs";
import type { SentimentResult } from "./sentiment/types";
import type { EngineSignal, TradeEvent } from "./types";

const NOW = new Date("2026-09-07T12:00:00.000Z");

function signal(overrides: Partial<EngineSignal> = {}): EngineSignal {
  return {
    id: "s1",
    personId: "p1",
    headline: "x",
    rawPayload: null,
    sourceName: "youtube",
    sourceTier: 2,
    occurredAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

describe("Gravity", () => {
  it("decays toward the revert target: target + (score - target) * e^(-λΔh)", () => {
    const oneHour = gravityForce(50, 68, 1, CONFIG.gravity);
    expect(oneHour.impact).toBeCloseTo(18 * (1 - Math.exp(-0.35)), 6); // +5.315
    const oneTick = gravityForce(50, 68, 30 / 3600, CONFIG.gravity);
    expect(oneTick.impact).toBeCloseTo(0.05242, 4);
    expect(oneTick.impact).toBeGreaterThan(0);
  });

  it("pulls down when above target and does nothing at target or with no time", () => {
    expect(gravityForce(80, 55, 1, CONFIG.gravity).impact).toBeLessThan(0);
    expect(gravityForce(55, 55, 1, CONFIG.gravity).impact).toBe(0);
    expect(gravityForce(50, 68, 0, CONFIG.gravity).impact).toBe(0);
  });
});

describe("Signals", () => {
  it("maps tiers to multipliers", () => {
    expect([1, 2, 3, 4, 5, 9].map((t) => tierMultiplier(t, CONFIG.signals))).toEqual([1.5, 1.0, 0.5, 0.3, 0.3, 0.3]);
  });

  it("impact = baseImpact * tier * confidence * direction (× freshness, 1 for a signal of this instant)", () => {
    expect(signalImpact(signal({ sourceTier: 1 }), { label: "positive", confidence: 0.8, direction: 1 }, CONFIG.signals, NOW)).toBeCloseTo(1.5 * 1.5 * 0.8);
    expect(signalImpact(signal({ sourceTier: 3 }), { label: "negative", confidence: 0.5, direction: -1 }, CONFIG.signals, NOW)).toBeCloseTo(-1.5 * 0.5 * 0.5);
    expect(signalImpact(signal(), { label: "neutral", confidence: 0, direction: 0 }, CONFIG.signals, NOW)).toBe(0);
  });

  it("combines a person's signals sub-linearly and caps the total", () => {
    expect(CONFIG.signals.volumeExponent).toBe(0.5);
    const sentiments = new Map([
      ["a", { label: "positive" as const, confidence: 1, direction: 1 as const }],
      ["b", { label: "negative" as const, confidence: 0.5, direction: -1 as const }],
    ]);
    const scored = scoreSignals([signal({ id: "a" }), signal({ id: "b", sourceName: "rss" })], sentiments, CONFIG.signals, NOW);
    const force = signalsForce(scored, CONFIG.signals);
    expect(force.details.rawImpact).toBeCloseTo(1.5 - 0.75);
    expect(force.details.volumeDivisor).toBeCloseTo(Math.SQRT2);
    expect(force.impact).toBeCloseTo((1.5 - 0.75) / Math.SQRT2);
    expect(force.details.signalCount).toBe(2);
    expect(force.details.countedSignals).toBe(2);

    // Twenty tier-1 sources all positive at full confidence: 45 / sqrt(20) = 10.06, capped at 10.
    const many = Array.from({ length: 20 }, (_, i) => signal({ id: `m${i}`, sourceName: `source-${i}`, sourceTier: 1 }));
    const loud = new Map(many.map((s) => [s.id, { label: "positive" as const, confidence: 1, direction: 1 as const }]));
    const capped = signalsForce(scoreSignals(many, loud, CONFIG.signals, NOW), CONFIG.signals);
    expect(capped.details.normalizedImpact).toBeCloseTo(45 / Math.sqrt(20));
    expect(capped.impact).toBe(CONFIG.signals.maxAbsImpactPerTick);
    expect(capped.details.capped).toBe(true);
  });

  it("PER-PERSON VOLUME NORMALISATION: a flood from one source cannot outvote one strong signal", () => {
    expect(CONFIG.signals.maxPerSourcePerTick).toBe(3);
    const positive = { label: "positive" as const, confidence: 1, direction: 1 as const };
    // Twelve comments (tier 4: 0.45 each) in one tick.
    const comments = Array.from({ length: 12 }, (_, i) => signal({ id: `c${i}`, sourceName: "youtube_comments", sourceTier: 4 }));
    const flood = signalsForce(scoreSignals(comments, new Map(comments.map((s) => [s.id, positive])), CONFIG.signals, NOW), CONFIG.signals);
    expect(flood.details.countedSignals).toBe(3);
    expect(flood.details.droppedBySourceCap).toBe(9);
    expect(flood.impact).toBeCloseTo((3 * 0.45) / Math.sqrt(3));
    // One tier-1 metric signal at full confidence: 2.25.
    const one = signalsForce(scoreSignals([signal({ id: "m", sourceName: "spotify", sourceTier: 1 })], new Map([["m", positive]]), CONFIG.signals, NOW), CONFIG.signals);
    expect(one.impact).toBeCloseTo(2.25);
    expect(flood.impact).toBeLessThan(one.impact);
    // The strongest are the ones kept, and the details say which counted.
    const mixed = [signal({ id: "w1", sourceName: "rss" }), signal({ id: "w2", sourceName: "rss" }), signal({ id: "w3", sourceName: "rss" }), signal({ id: "strong", sourceName: "rss" })];
    const mixedSentiments = new Map<string, { label: "positive"; confidence: number; direction: 1 }>([
      ["w1", { label: "positive", confidence: 0.2, direction: 1 }],
      ["w2", { label: "positive", confidence: 0.3, direction: 1 }],
      ["w3", { label: "positive", confidence: 0.4, direction: 1 }],
      ["strong", { label: "positive", confidence: 1, direction: 1 }],
    ]);
    const kept = signalsForce(scoreSignals(mixed, mixedSentiments, CONFIG.signals, NOW), CONFIG.signals);
    const counted = (kept.details.signals as Array<{ id: string; counted: boolean }>).filter((s) => s.counted).map((s) => s.id);
    expect(counted.sort()).toEqual(["strong", "w2", "w3"]);
    // Neutral signals never dilute the sum.
    const neutral = { label: "neutral" as const, confidence: 0, direction: 0 as const };
    const withNeutral = signalsForce(
      scoreSignals(
        [signal({ id: "m", sourceName: "spotify", sourceTier: 1 }), signal({ id: "n1" }), signal({ id: "n2" })],
        new Map<string, SentimentResult>([["m", positive], ["n1", neutral], ["n2", neutral]]),
        CONFIG.signals,
        NOW,
      ),
      CONFIG.signals,
    );
    expect(withNeutral.impact).toBeCloseTo(2.25);
    expect(withNeutral.details.countedSignals).toBe(1);
  });
});

describe("Signals — the person's volume weight (Phase 15)", () => {
  const positive = { label: "positive" as const, confidence: 0.8, direction: 1 as const };

  it("multiplies an event signal's impact by the person's weight, and never a metric signal's", () => {
    expect(signalImpact(signal(), positive, CONFIG.signals, NOW, 0.5)).toBeCloseTo(1.2 * 0.5);
    expect(signalImpact(signal(), positive, CONFIG.signals, NOW, 2)).toBeCloseTo(2.4);
    expect(signalImpact(signal(), positive, CONFIG.signals, NOW)).toBeCloseTo(1.2);
    const metric = signal({ rawPayload: { kind: "metric", metric: "subscriber_count", polarity: 1, sigma: 2, scale: 1 } });
    expect(signalImpact(metric, positive, CONFIG.signals, NOW, 0.1)).toBeCloseTo(1.2);
    const scored = scoreSignals([signal({ id: "e" }), { ...metric, id: "m" }], new Map([["e", positive], ["m", positive]]), CONFIG.signals, NOW, 0.25);
    expect(scored.map((s) => [s.signal.id, s.impact, s.volumeWeight])).toEqual([
      ["e", expect.closeTo(0.3, 6), 0.25],
      ["m", expect.closeTo(1.2, 6), 1],
    ]);
  });

  it("never weights a prescored live moment (Phase 16): the platform's own sampling of a session is not coverage, but it IS aged", () => {
    const moment = signal({ rawPayload: { kind: "live_moment", moment: "audience_surge", direction: 1, confidence: 0.5 }, sourceName: "twitch" });
    expect(signalImpact(moment, positive, CONFIG.signals, NOW, 0.1)).toBeCloseTo(1.2);
    const dayOld = { ...moment, occurredAt: new Date(NOW.getTime() - 24 * 3_600_000) };
    expect(signalImpact(dayOld, positive, CONFIG.signals, NOW, 0.1)).toBeCloseTo(0.6);
    expect(isExpiredSignal({ ...moment, occurredAt: new Date(NOW.getTime() - 8 * 24 * 3_600_000) }, NOW, CONFIG.signals)).toBe(true);
  });

  it("never weights a comment digest (Phase 18+): it is out of the denominator, so it must not draw on the weight either", () => {
    // Its rate is the poll cadence and YouTube's like ranking, so a person with
    // little news would otherwise have their own viewers' chatter amplified.
    const digest = signal({ rawPayload: { kind: "comment_digest", sampled: 10, positive: 6, negative: 1 }, sourceName: "youtube_comments" });
    expect(signalImpact(digest, positive, CONFIG.signals, NOW, 2)).toBeCloseTo(1.2);
    expect(signalImpact(digest, positive, CONFIG.signals, NOW, 0.1)).toBeCloseTo(1.2);
    // An article in the same tick still carries it.
    expect(signalImpact(signal(), positive, CONFIG.signals, NOW, 2)).toBeCloseTo(2.4);
    const scored = scoreSignals([signal({ id: "a" }), { ...digest, id: "d" }], new Map([["a", positive], ["d", positive]]), CONFIG.signals, NOW, 2);
    expect(scored.map((s) => [s.signal.id, s.volumeWeight])).toEqual([["a", 2], ["d", 1]]);
  });

  it("carries the weight and the baseline into the force's details, and the force is what it was at weight 1", () => {
    const scored = scoreSignals([signal({ id: "a" })], new Map([["a", positive]]), CONFIG.signals, NOW);
    const plain = signalsForce(scored, CONFIG.signals);
    expect(plain.impact).toBeCloseTo(1.2);
    expect(plain.details).toMatchObject({ volumeWeight: 1, volume: null });
    const reading = { samples: 7, minSamples: 7, sufficient: true, mean: 40, sd: 0, sdFloor: 2, sdApplied: 2, deviation: 0, sigma: 0, threshold: 1, band: "inside" as const, atBaseline: true };
    const weighted = signalsForce(scoreSignals([signal({ id: "a" })], new Map([["a", positive]]), CONFIG.signals, NOW, 0.5), CONFIG.signals, { weight: 0.5, reading, current: 40 });
    expect(weighted.impact).toBeCloseTo(0.6);
    expect(weighted.details).toMatchObject({ volumeWeight: 0.5, volume: { weight: 0.5, sufficient: true, samples: 7, meanPerDay: 40, sigma: 0 } });
    expect((weighted.details.signals as Array<{ volumeWeight: number }>)[0].volumeWeight).toBe(0.5);
  });
});

describe("Signals — freshness (Phase 12)", () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const positive = { label: "positive" as const, confidence: 0.8, direction: 1 as const };

  it("the curve: 1 now, halving every 24 h, exactly zero at and past 7 days, never negative-aged", () => {
    expect(CONFIG.signals.freshnessHalfLifeHours).toBe(24);
    expect(CONFIG.signals.freshnessMaxAgeHours).toBe(168);
    expect(freshnessWeight(0, CONFIG.signals)).toBe(1);
    expect(freshnessWeight(24, CONFIG.signals)).toBeCloseTo(0.5);
    expect(freshnessWeight(48, CONFIG.signals)).toBeCloseTo(0.25);
    expect(freshnessWeight(72, CONFIG.signals)).toBeCloseTo(0.125);
    expect(freshnessWeight(167.9, CONFIG.signals)).toBeGreaterThan(0);
    expect(freshnessWeight(168, CONFIG.signals)).toBe(0);
    expect(freshnessWeight(10_000, CONFIG.signals)).toBe(0);
    // A clock that says the signal has not happened yet: full weight, not more.
    expect(freshnessWeight(-5, CONFIG.signals)).toBe(1);
    expect(freshnessWeight(Number.NaN, CONFIG.signals)).toBe(1);
  });

  it("weights an event signal's impact by its age: a day-old headline moves half as much, a three-day-old an eighth", () => {
    expect(signalImpact(signal({ occurredAt: hoursAgo(24) }), positive, CONFIG.signals, NOW)).toBeCloseTo(1.5 * 1.0 * 0.8 * 0.5);
    expect(signalImpact(signal({ occurredAt: hoursAgo(72) }), positive, CONFIG.signals, NOW)).toBeCloseTo(1.5 * 1.0 * 0.8 * 0.125);
    expect(signalImpact(signal({ occurredAt: hoursAgo(24 * 8) }), positive, CONFIG.signals, NOW)).toBe(0);
  });

  it("NEVER ages a metric signal: its own baseline window says what is stale for it", () => {
    const metric = signal({ occurredAt: hoursAgo(24 * 5), rawPayload: { kind: "metric", metric: "subscriber_count", polarity: 1, sigma: 2, scale: 1 } });
    expect(signalFreshness(metric, NOW, CONFIG.signals)).toEqual({ ageHours: 120, weight: 1 });
    expect(signalImpact(metric, positive, CONFIG.signals, NOW)).toBeCloseTo(1.5 * 1.0 * 0.8);
    expect(isExpiredSignal(metric, NOW, CONFIG.signals)).toBe(false);
    // The same age on an article: expired.
    expect(isExpiredSignal(signal({ occurredAt: hoursAgo(24 * 8) }), NOW, CONFIG.signals)).toBe(true);
    expect(isExpiredSignal(signal({ occurredAt: hoursAgo(24 * 5) }), NOW, CONFIG.signals)).toBe(false);
  });

  it("carries age and weight into the scored signal and the force's audit trail, and the source cap prefers the fresh strong one", () => {
    const scored = scoreSignals(
      [signal({ id: "fresh", sourceName: "rss" }), signal({ id: "stale", sourceName: "rss", occurredAt: hoursAgo(48) })],
      new Map([
        ["fresh", positive],
        ["stale", positive],
      ]),
      CONFIG.signals,
      NOW,
    );
    expect(scored[0]).toMatchObject({ ageHours: 0, freshness: 1 });
    expect(scored[0].impact).toBeCloseTo(1.2);
    expect(scored[1]).toMatchObject({ ageHours: 48, freshness: 0.25 });
    expect(scored[1].impact).toBeCloseTo(0.3);
    const force = signalsForce(scored, CONFIG.signals);
    expect(force.details.freshnessHalfLifeHours).toBe(24);
    const audit = force.details.signals as Array<{ id: string; ageHours: number; freshness: number; counted: boolean }>;
    expect(audit.find((s) => s.id === "stale")).toMatchObject({ ageHours: 48, freshness: 0.25, counted: true });
    // Four stale-to-fresh signals from one source at one confidence: the cap of three keeps the freshest.
    const four = [0, 12, 24, 36].map((h) => signal({ id: `h${h}`, sourceName: "rss", occurredAt: hoursAgo(h) }));
    const capped = signalsForce(scoreSignals(four, new Map(four.map((s) => [s.id, positive])), CONFIG.signals, NOW), CONFIG.signals);
    const counted = (capped.details.signals as Array<{ id: string; counted: boolean }>).filter((s) => s.counted).map((s) => s.id);
    expect(counted.sort()).toEqual(["h0", "h12", "h24"]);
  });

  it("does not touch Gravity: staleness in the score is Gravity's, staleness in the queue is this", () => {
    // No second score-decay mechanism: the only decay of a score is λ = 0.35/h toward the target, unchanged.
    expect(CONFIG.gravity).toEqual({ lambdaPerHour: 0.35 });
    expect(gravityForce(50, 68, 1, CONFIG.gravity).impact).toBeCloseTo(18 * (1 - Math.exp(-0.35)), 6);
  });
});

describe("Signals — one moment, one reading (Phase 13+)", () => {
  const GAME = new Date("2026-09-15T20:00:00.000Z");
  const metric = (id: string, key: string, polarity: 1 | -1, overrides: Partial<EngineSignal> = {}) =>
    signal({ id, sourceName: "apisports", sourceTier: 2, occurredAt: GAME, rawPayload: { kind: "metric", metric: key, polarity, sigma: 2, scale: 1 }, ...overrides });
  /** Mahomes, Week 1: 184 yards (a little under form), 50.2 rating (well under), 1 interception (over). */
  const line = [metric("yards", "game_passing_yards", 1), metric("rating", "game_rating", 1), metric("picks", "game_interceptions", -1)];
  const lineSentiments = new Map<string, SentimentResult>([
    ["yards", { label: "positive", confidence: 0.6, direction: 1 }], // +0.9
    ["rating", { label: "negative", confidence: 0.9, direction: -1 }], // −1.35
    ["picks", { label: "negative", confidence: 0.5, direction: -1 }], // −0.75
  ]);

  it("is on by default", () => {
    expect(CONFIG.signals.oneReadingPerMetricMoment).toBe(true);
  });

  it("folds one game's three figures into ONE reading carrying the MEAN of their impacts, the strongest standing for it", () => {
    const scored = scoreSignals(line, lineSentiments, CONFIG.signals, NOW);
    const { folded, moments, foldedInto } = foldMetricMoments(scored);
    expect(folded).toHaveLength(1);
    expect(folded[0].signal.id).toBe("rating");
    expect(folded[0].impact).toBeCloseTo((0.9 - 1.35 - 0.75) / 3); // −0.4: a mixed line reads mixed
    expect(moments).toEqual([{ source: "apisports", at: GAME.toISOString(), representative: "rating", members: ["rating", "yards", "picks"], impact: expect.closeTo(-0.4, 6) }]);
    expect([...foldedInto.entries()]).toEqual([
      ["yards", "rating"],
      ["picks", "rating"],
    ]);

    const force = signalsForce(scored, CONFIG.signals);
    expect(force.details.countedSignals).toBe(1);
    expect(force.details.foldedIntoMoments).toBe(2);
    expect(force.details.volumeDivisor).toBe(1);
    expect(force.impact).toBeCloseTo(-0.4);
    const audit = force.details.signals as Array<{ id: string; counted: boolean; foldedInto?: string; momentImpact?: number; impact: number }>;
    expect(audit.find((s) => s.id === "rating")).toMatchObject({ counted: true, momentImpact: expect.closeTo(-0.4, 6), impact: expect.closeTo(-1.35, 6) });
    expect(audit.find((s) => s.id === "yards")).toMatchObject({ counted: false, foldedInto: "rating" });
    expect(audit.find((s) => s.id === "picks")).toMatchObject({ counted: false, foldedInto: "rating" });
  });

  it("without the fold the same game took three cap slots and read as √3 of one reading — the busier week that was not", () => {
    const three = [metric("a", "game_passing_yards", 1), metric("b", "game_rating", 1), metric("c", "game_interceptions", -1)];
    const same = new Map<string, SentimentResult>(three.map((s) => [s.id, { label: "positive", confidence: 0.8, direction: 1 }]));
    const scored = scoreSignals(three, same, CONFIG.signals, NOW);
    const old = signalsForce(scored, { ...CONFIG.signals, oneReadingPerMetricMoment: false });
    expect(old.details.countedSignals).toBe(3);
    expect(old.details.metricMoments).toEqual([]);
    expect(old.impact).toBeCloseTo((3 * 1.2) / Math.sqrt(3)); // √3 × 1.2
    const folded = signalsForce(scored, CONFIG.signals);
    expect(folded.details.countedSignals).toBe(1);
    expect(folded.impact).toBeCloseTo(1.2); // one reading of one game
    // And the fold leaves a cap slot for the game's event: the "busy week" was one game.
    expect(CONFIG.signals.maxPerSourcePerTick).toBe(3);
  });

  it("never folds the game's EVENT into its stat line: a poor line in a commanding win stays two readings that partly cancel", () => {
    const win = signal({ id: "result", sourceName: "apisports", sourceTier: 2, occurredAt: GAME, rawPayload: { kind: "game_result", game_id: "21528", home_score: 31, away_score: 10 } });
    const sentiments = new Map(lineSentiments);
    sentiments.set("result", { label: "positive", confidence: 0.9, direction: 1 }); // +1.35
    const force = signalsForce(scoreSignals([win, ...line], sentiments, CONFIG.signals, NOW), CONFIG.signals);
    expect(force.details.countedSignals).toBe(2);
    expect(force.details.rawImpact).toBeCloseTo(1.35 - 0.4);
    expect(force.impact).toBeCloseTo((1.35 - 0.4) / Math.SQRT2);
    const counted = (force.details.signals as Array<{ id: string; counted: boolean }>).filter((s) => s.counted).map((s) => s.id);
    expect(counted.sort()).toEqual(["rating", "result"]);
  });

  it("folds by source AND moment: two games are two readings, and another source's metric at the same instant is its own", () => {
    const week2 = new Date("2026-09-21T20:00:00.000Z");
    const signals = [
      metric("y1", "game_passing_yards", 1),
      metric("r1", "game_rating", 1),
      metric("y2", "game_passing_yards", 1, { occurredAt: week2 }),
      metric("r2", "game_rating", 1, { occurredAt: week2 }),
      metric("subs", "subscriber_count", 1, { sourceName: "youtube" }),
    ];
    const positive = { label: "positive" as const, confidence: 0.8, direction: 1 as const };
    const { folded, moments } = foldMetricMoments(scoreSignals(signals, new Map(signals.map((s) => [s.id, positive])), CONFIG.signals, NOW));
    expect(folded.map((s) => s.signal.id).sort()).toEqual(["r1", "r2", "subs"]);
    expect(moments.map((m) => [m.source, m.at, m.members])).toEqual([
      ["apisports", GAME.toISOString(), ["r1", "y1"]],
      ["apisports", week2.toISOString(), ["r2", "y2"]],
    ]);
  });

  it("leaves a neutral figure out of the mean, and a lone metric or a lone-plus-neutral pair untouched", () => {
    const sentiments = new Map<string, SentimentResult>([
      ["yards", { label: "neutral", confidence: 0, direction: 0 }], // inside the band: 0
      ["rating", { label: "negative", confidence: 0.9, direction: -1 }],
      ["picks", { label: "negative", confidence: 0.5, direction: -1 }],
    ]);
    const { folded, moments } = foldMetricMoments(scoreSignals(line, sentiments, CONFIG.signals, NOW));
    expect(moments[0].members).toEqual(["rating", "picks"]);
    expect(moments[0].impact).toBeCloseTo((-1.35 - 0.75) / 2);
    // The neutral one passes through (impact 0, never counted); the fold did not divide by three.
    expect(folded.map((s) => s.signal.id).sort()).toEqual(["rating", "yards"]);
    const alone = foldMetricMoments(scoreSignals([line[1]], sentiments, CONFIG.signals, NOW));
    expect(alone.moments).toEqual([]);
    expect(alone.folded[0].impact).toBeCloseTo(-1.35);
  });

  it("happens before the source cap, so the fold and the cap compose: four moments of one source keep three", () => {
    const moments = [0, 1, 2, 3].map((week) => {
      const at = new Date(GAME.getTime() + week * 7 * 24 * 3_600_000);
      return [metric(`y${week}`, "game_passing_yards", 1, { occurredAt: at }), metric(`r${week}`, "game_rating", 1, { occurredAt: at })];
    });
    const signals = moments.flat();
    const sentiments = new Map<string, SentimentResult>(signals.map((s, i) => [s.id, { label: "positive", confidence: 0.2 + i * 0.1, direction: 1 }]));
    const force = signalsForce(scoreSignals(signals, sentiments, CONFIG.signals, NOW), CONFIG.signals);
    expect((force.details.metricMoments as unknown[]).length).toBe(4);
    expect(force.details.foldedIntoMoments).toBe(4);
    expect(force.details.countedSignals).toBe(3);
    expect(force.details.droppedBySourceCap).toBe(1);
  });
});

describe("Market Mood", () => {
  const HALF_MINUTE = 30 / 3600;
  /** One tick's worth of board movement, folded in as the tick does it. */
  const oneReading = (impacts: Record<string, number>, people = 3) => foldTickIntoWindow(EMPTY_MOOD_WINDOW_HISTORY, new Map(Object.entries(impacts)), people);
  const impactOf = (personId: string, window: MoodWindow, config = CONFIG.marketMood, deltaHours = HALF_MINUTE) =>
    marketMoodForce({ personId, personSlug: personId, window, deltaHours, config }).impact;

  it("is zero when nobody had signals: a tick that moved nobody is not a reading of the tide", () => {
    const window = oneReading({ a: 0, b: 0, c: 0 });
    expect(window.readings).toBe(0);
    expect(windowedMood(window)).toBe(0);
    expect(impactOf("a", window)).toBe(0);
  });

  it("reads the board's movement over the window's readings, excluding the person's own", () => {
    const window = oneReading({ mover: 1.2, other: 0, third: 0 });
    expect(windowedMood(window)).toBeCloseTo(0.4); // 1.2 across three people
    expect(impactOf("mover", window)).toBe(0); // its own news does not feed back
    expect(impactOf("other", window)).toBeCloseTo(1.41 * HALF_MINUTE * 0.6); // the others' mean is 0.6
  });

  it("holds the tide for the window: a quiet tick after a burst leaves the mood where it was", () => {
    const burst = oneReading({ mover: 1.2, other: 0, third: 0 });
    const quiet = foldTickIntoWindow({ totalImpact: burst.totalImpact, totalByPerson: burst.totalByPerson, readings: burst.readings }, new Map(), 3);
    expect(quiet.readings).toBe(1);
    expect(windowedMood(quiet)).toBeCloseTo(windowedMood(burst));
    expect(impactOf("other", quiet)).toBeCloseTo(impactOf("other", burst));
  });

  it("averages the readings rather than summing them, so the scale stays the scale of one burst", () => {
    const first = oneReading({ mover: 1.2, other: 0, third: 0 });
    const second = foldTickIntoWindow(first, new Map([["other", 1.2]]), 3);
    expect(second.readings).toBe(2);
    expect(windowedMood(second)).toBeCloseTo(0.4); // 2.4 across three people over two readings
  });

  it("is time-normalised like Gravity: twice the elapsed time, twice the movement, and no time, no movement", () => {
    const window = oneReading({ mover: 1.2, other: 0, third: 0 });
    expect(impactOf("other", window, CONFIG.marketMood, 2 * HALF_MINUTE)).toBeCloseTo(2 * impactOf("other", window));
    expect(impactOf("other", window, CONFIG.marketMood, 6 / 60)).toBeCloseTo(1.41 * 0.1 * 0.6); // six minutes of it
    expect(impactOf("other", window, CONFIG.marketMood, 0)).toBe(0);
    // A tick interval half as long moves a score half as far, so the cadence
    // cannot re-level the board on its own: this is the point of the rate.
    expect(impactOf("other", window, CONFIG.marketMood, HALF_MINUTE / 2)).toBeCloseTo(impactOf("other", window) / 2);
  });

  it("honours per-person sensitivity and both brakes", () => {
    const config = { ...CONFIG.marketMood, sensitivityBySlug: { calm: 0.5, wild: 3 } };
    const window = oneReading({ mover: 1.2, calm: 0, wild: 0 });
    expect(impactOf("calm", window, config)).toBeCloseTo(1.41 * 0.5 * HALF_MINUTE * 0.6);
    // The mood itself is clamped to maxAbsMood before the rate is applied.
    const huge = oneReading({ mover: 40, calm: 0, wild: 0 });
    expect(impactOf("calm", huge, config)).toBeCloseTo(1.41 * 0.5 * HALF_MINUTE * config.maxAbsMood);
    // And the impact is clamped in its own right: an hour at triple sensitivity would be 8.46 points.
    expect(impactOf("wild", huge, config, 1)).toBe(config.maxAbsImpact);
    const cold = oneReading({ mover: -40, calm: 0, wild: 0 });
    expect(impactOf("calm", cold, config, 1)).toBe(-config.maxAbsImpact); // -1.41 before the clamp
    expect(impactOf("calm", cold, config)).toBeCloseTo(-1.41 * 0.5 * HALF_MINUTE * config.maxAbsMood); // a tick's worth is far under it
  });

  it("carries its working: the board mood, the window and the rate that produced the impact", () => {
    const window = oneReading({ mover: 1.2, other: 0, third: 0 });
    const entry = marketMoodForce({ personId: "other", personSlug: "other", window, deltaHours: HALF_MINUTE, config: CONFIG.marketMood });
    expect(entry.force).toBe("market_mood");
    expect(entry.details).toMatchObject({ moodExcludingSelf: 0.6, ratePerHour: 1.41, windowMinutes: 60, readings: 1, deltaHours: HALF_MINUTE, sensitivity: 1 });
    expect(entry.details.mood as number).toBeCloseTo(0.4);
  });
});

describe("Conviction", () => {
  it("follows the piecewise ramp", () => {
    expect(convictionImpact(0, CONFIG.conviction)).toBe(0);
    expect(convictionImpact(0.5, CONFIG.conviction)).toBe(0);
    expect(convictionImpact(0.6, CONFIG.conviction)).toBe(0);
    expect(convictionImpact(0.725, CONFIG.conviction)).toBeCloseTo(0.1);
    expect(convictionImpact(0.85, CONFIG.conviction)).toBeCloseTo(0.15);
    expect(convictionImpact(0.925, CONFIG.conviction)).toBeCloseTo(-0.1);
    expect(convictionImpact(1.0, CONFIG.conviction)).toBeCloseTo(-0.15);
    expect(convictionImpact(1.5, CONFIG.conviction)).toBe(-0.3);
  });

  it("yields 0 with no open positions", () => {
    const force = convictionForce(0, 9_000_000, CONFIG.conviction);
    expect(force.impact).toBe(0);
    expect(force.details.concentration).toBe(0);
  });
});

describe("Trading Activity", () => {
  const base = { now: NOW, maxAllocationCents: 9_000_000, concentration: 0.5, confirmedBySignals: true, config: CONFIG.tradingActivity };

  /** One Buy in each of the last `windows` one-minute windows, `cents` each (the current window can differ). */
  const steadyBuys = (windows: number, cents: number, currentCents = cents): TradeEvent[] =>
    Array.from({ length: windows }, (_, i) => ({
      personId: "p",
      side: "BUY" as const,
      amountCents: i === 0 ? currentCents : cents,
      createdAt: new Date(NOW.getTime() - i * 60_000 - 1_000),
    }));

  it("yields 0 with no trades, reporting an insufficient baseline", () => {
    const force = tradingActivityForce({ ...base, events: [] });
    expect(force.impact).toBe(0);
    expect(force.details.reason).toBe("insufficient baseline");
    expect(force.details.populatedWindows).toBe(0);
  });

  it("MINIMUM-SAMPLE GUARD: below minPopulatedWindows even a huge burst reads 0", () => {
    expect(CONFIG.tradingActivity.minPopulatedWindows).toBe(30);
    const thin = steadyBuys(29, 90_000, 900_000);
    const force = tradingActivityForce({ ...base, events: thin });
    expect(force.impact).toBe(0);
    expect(force.details.reason).toBe("insufficient baseline");
    expect(force.details.populatedWindows).toBe(29);

    const enough = tradingActivityForce({ ...base, events: steadyBuys(30, 90_000, 900_000) });
    expect(enough.details.reason).toBeUndefined();
    expect(enough.impact).toBeGreaterThan(0);
  });

  it("SD FLOOR: a quiet baseline never turns a small deviation into a many-sigma event", () => {
    expect(CONFIG.tradingActivity.sdFloor).toBe(0.01);
    // Thirty tiny identical trades: the raw sd is ~0, so without the floor a $90 blip would be "outside".
    const quiet = steadyBuys(30, 1, 9_000);
    const force = tradingActivityForce({ ...base, events: quiet });
    expect(Number(force.details.baselineSd)).toBeLessThan(0.0001);
    expect(force.details.sdApplied).toBe(0.01);
    expect(force.details.band).toBe("inside");
    expect(force.details.fired).toBe(false);
  });

  it("DEADBAND at 1.0σ: inside the band the force reads a small signed value, never idle", () => {
    expect(CONFIG.tradingActivity.thresholdStdDevs).toBe(1.0);
    expect(CONFIG.tradingActivity.inBandScale).toBe(0.25);
    expect(CONFIG.tradingActivity.inBandMinImpact).toBe(0.01);
    // Normal trading: every window buys $900, this one buys $950.
    const normal = tradingActivityForce({ ...base, events: steadyBuys(1440, 90_000, 95_000) });
    expect(normal.details.band).toBe("inside");
    expect(normal.impact).toBe(0.01);
    // A quiet minute on an active day reads alive too, on the other side.
    const lull = tradingActivityForce({ ...base, events: steadyBuys(1440, 90_000, 0).filter((e) => e.amountCents > 0) });
    expect(lull.details.band).toBe("inside");
    expect(lull.impact).toBe(-0.01);
    // Flow exactly at the baseline has no direction to report.
    const flat = tradingActivityForce({ ...base, events: steadyBuys(1440, 90_000) });
    expect(flat.impact).toBe(0);
    expect(flat.details.reason).toBe("flow at baseline");
  });

  it("is gated below the concentration threshold", () => {
    const force = tradingActivityForce({ ...base, concentration: 0.05, events: [] });
    expect(force.impact).toBe(0);
    expect(force.details.gated).toBe(true);
  });

  it("buckets net flow into windows with zeros included", () => {
    const events: TradeEvent[] = [
      { personId: "p", side: "BUY", amountCents: 100, createdAt: new Date(NOW.getTime() - 10_000) },
      { personId: "p", side: "SELL", amountCents: 30, createdAt: new Date(NOW.getTime() - 20_000) },
      { personId: "p", side: "BUY", amountCents: 5, createdAt: new Date(NOW.getTime() - 3 * 3600_000) },
    ];
    const flows = windowedNetFlows(events, NOW, CONFIG.tradingActivity);
    expect(flows).toHaveLength(1440);
    expect(flows[1439]).toBe(70);
    expect(flows.reduce((s, v) => s + v, 0)).toBe(75);
  });

  it("fires beyond 1.0σ of the baseline, weighted 0.25 and dampened when unconfirmed", () => {
    // A day of $900 Buys every minute, then a $9,000 minute: flowScore 0.1 against a mean of 0.01.
    const burst = steadyBuys(1440, 90_000, 900_000);
    const confirmed = tradingActivityForce({ ...base, events: burst });
    expect(confirmed.details.band).toBe("outside");
    expect(confirmed.details.fired).toBe(true);
    const deviation = Number(confirmed.details.deviation);
    expect(deviation).toBeCloseTo(0.1 - Number(confirmed.details.baselineMean), 9);
    expect(confirmed.impact).toBeCloseTo(deviation * 0.25, 9);
    // Unconfirmed: dampened to 0.4×, but never below the in-band floor, the smallest magnitude the force reports.
    const unconfirmed = tradingActivityForce({ ...base, events: burst, confirmedBySignals: false });
    expect(unconfirmed.impact).toBeCloseTo(Math.max(deviation * 0.25 * 0.4, CONFIG.tradingActivity.inBandMinImpact), 9);

    // Steady identical flow in every window is never an anomaly.
    expect(tradingActivityForce({ ...base, events: steadyBuys(1440, 1000) }).impact).toBe(0);
  });

  it("measures against the rolling baseline, so long-only flow is not a permanent lift", () => {
    // Long-only: every window sees +90k of Buys (1% of the cap), nothing is ever sold.
    const inflow = (skipCurrent: boolean, currentCents = 90_000): TradeEvent[] =>
      Array.from({ length: 1440 }, (_, i) => ({
        personId: "p",
        side: "BUY" as const,
        amountCents: i === 0 ? currentCents : 90_000,
        createdAt: new Date(NOW.getTime() - i * 60_000 - 1_000),
      })).filter((event, i) => !(skipCurrent && i === 0));

    // Identical inflow every window: the baseline absorbs it and the force is 0, not +0.0025 forever.
    expect(tradingActivityForce({ ...base, events: inflow(false) }).impact).toBe(0);

    // A burst above the baseline reads positive by the EXCESS over normal flow, not by the whole flow.
    const burst = tradingActivityForce({ ...base, events: inflow(false, 900_000) });
    expect(burst.details.fired).toBe(true);
    expect(burst.impact).toBeGreaterThan(0);
    expect(burst.impact).toBeLessThan(0.1 * 0.25);
    expect(burst.details.deviation).toBeCloseTo(0.1 - Number(burst.details.baselineMean), 6);

    // A lull (no Buys in the current window while every other window had them) reads NEGATIVE even
    // though flow never went below zero. Under the sd floor a $900 lull sits inside the band, so it is
    // the small in-band value, still on the right side.
    const lull = tradingActivityForce({ ...base, events: inflow(true) });
    expect(lull.details.band).toBe("inside");
    expect(lull.impact).toBe(-0.01);
    expect(lull.details.netFlowCents).toBe(0);
  });

  it("is the same arithmetic when shorting is enabled and flow goes negative", () => {
    // Two-sided: steady alternation of Buys and Sells, then a window of heavy selling.
    const twoSided: TradeEvent[] = Array.from({ length: 1440 }, (_, i) => ({
      personId: "p",
      side: i % 2 === 0 ? ("BUY" as const) : ("SELL" as const),
      amountCents: i === 0 ? 1_000_000 : 90_000,
      createdAt: new Date(NOW.getTime() - i * 60_000 - 1_000),
    }));
    twoSided[0] = { ...twoSided[0], side: "SELL" };
    const dump = tradingActivityForce({ ...base, events: twoSided });
    expect(dump.details.fired).toBe(true);
    expect(dump.impact).toBeLessThan(0);
    expect(dump.details.baselineHours).toBe(CONFIG.tradingActivity.baselineHours);
  });
});

describe("Inverse pairs", () => {
  it("applies -(impact * dampening) in both directions and skips silent partners", () => {
    const pairs = [{ id: "pair", person_a_id: "drake", person_b_id: "kendrick", dampening: 0.4 }];
    const adjustments = inversePairAdjustments(pairs, new Map([["drake", 1.2]]), CONFIG.inversePairs);
    expect(adjustments.get("kendrick")?.[0].impact).toBeCloseTo(-0.48);
    expect(adjustments.get("drake")).toBeUndefined();

    const both = inversePairAdjustments(pairs, new Map([["drake", 1], ["kendrick", -0.5]]), CONFIG.inversePairs);
    expect(both.get("kendrick")?.[0].impact).toBeCloseTo(-0.4);
    expect(both.get("drake")?.[0].impact).toBeCloseTo(0.2);
  });
});
