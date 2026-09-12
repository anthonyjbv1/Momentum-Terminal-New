import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG as CONFIG } from "./config";
import { convictionForce, convictionImpact } from "./forces/conviction";
import { gravityForce } from "./forces/gravity";
import { computeMood, marketMoodForce } from "./forces/market-mood";
import { scoreSignals, signalImpact, signalsForce, tierMultiplier } from "./forces/signals";
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

  it("impact = baseImpact * tier * confidence * direction", () => {
    expect(signalImpact(signal({ sourceTier: 1 }), { label: "positive", confidence: 0.8, direction: 1 }, CONFIG.signals)).toBeCloseTo(1.5 * 1.5 * 0.8);
    expect(signalImpact(signal({ sourceTier: 3 }), { label: "negative", confidence: 0.5, direction: -1 }, CONFIG.signals)).toBeCloseTo(-1.5 * 0.5 * 0.5);
    expect(signalImpact(signal(), { label: "neutral", confidence: 0, direction: 0 }, CONFIG.signals)).toBe(0);
  });

  it("combines a person's signals sub-linearly and caps the total", () => {
    expect(CONFIG.signals.volumeExponent).toBe(0.5);
    const sentiments = new Map([
      ["a", { label: "positive" as const, confidence: 1, direction: 1 as const }],
      ["b", { label: "negative" as const, confidence: 0.5, direction: -1 as const }],
    ]);
    const scored = scoreSignals([signal({ id: "a" }), signal({ id: "b", sourceName: "rss" })], sentiments, CONFIG.signals);
    const force = signalsForce(scored, CONFIG.signals);
    expect(force.details.rawImpact).toBeCloseTo(1.5 - 0.75);
    expect(force.details.volumeDivisor).toBeCloseTo(Math.SQRT2);
    expect(force.impact).toBeCloseTo((1.5 - 0.75) / Math.SQRT2);
    expect(force.details.signalCount).toBe(2);
    expect(force.details.countedSignals).toBe(2);

    // Twenty tier-1 sources all positive at full confidence: 45 / sqrt(20) = 10.06, capped at 10.
    const many = Array.from({ length: 20 }, (_, i) => signal({ id: `m${i}`, sourceName: `source-${i}`, sourceTier: 1 }));
    const loud = new Map(many.map((s) => [s.id, { label: "positive" as const, confidence: 1, direction: 1 as const }]));
    const capped = signalsForce(scoreSignals(many, loud, CONFIG.signals), CONFIG.signals);
    expect(capped.details.normalizedImpact).toBeCloseTo(45 / Math.sqrt(20));
    expect(capped.impact).toBe(CONFIG.signals.maxAbsImpactPerTick);
    expect(capped.details.capped).toBe(true);
  });

  it("PER-PERSON VOLUME NORMALISATION: a flood from one source cannot outvote one strong signal", () => {
    expect(CONFIG.signals.maxPerSourcePerTick).toBe(3);
    const positive = { label: "positive" as const, confidence: 1, direction: 1 as const };
    // Twelve comments (tier 4: 0.45 each) in one tick.
    const comments = Array.from({ length: 12 }, (_, i) => signal({ id: `c${i}`, sourceName: "youtube_comments", sourceTier: 4 }));
    const flood = signalsForce(scoreSignals(comments, new Map(comments.map((s) => [s.id, positive])), CONFIG.signals), CONFIG.signals);
    expect(flood.details.countedSignals).toBe(3);
    expect(flood.details.droppedBySourceCap).toBe(9);
    expect(flood.impact).toBeCloseTo((3 * 0.45) / Math.sqrt(3));
    // One tier-1 metric signal at full confidence: 2.25.
    const one = signalsForce(scoreSignals([signal({ id: "m", sourceName: "spotify", sourceTier: 1 })], new Map([["m", positive]]), CONFIG.signals), CONFIG.signals);
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
    const kept = signalsForce(scoreSignals(mixed, mixedSentiments, CONFIG.signals), CONFIG.signals);
    const counted = (kept.details.signals as Array<{ id: string; counted: boolean }>).filter((s) => s.counted).map((s) => s.id);
    expect(counted.sort()).toEqual(["strong", "w2", "w3"]);
    // Neutral signals never dilute the sum.
    const neutral = { label: "neutral" as const, confidence: 0, direction: 0 as const };
    const withNeutral = signalsForce(
      scoreSignals(
        [signal({ id: "m", sourceName: "spotify", sourceTier: 1 }), signal({ id: "n1" }), signal({ id: "n2" })],
        new Map<string, SentimentResult>([["m", positive], ["n1", neutral], ["n2", neutral]]),
        CONFIG.signals,
      ),
      CONFIG.signals,
    );
    expect(withNeutral.impact).toBeCloseTo(2.25);
    expect(withNeutral.details.countedSignals).toBe(1);
  });
});

describe("Market Mood", () => {
  it("is zero when nobody had signals", () => {
    expect(computeMood([0, 0, 0])).toBe(0);
    expect(marketMoodForce("a", 0, [0, 0, 0], CONFIG.marketMood).impact).toBe(0);
  });

  it("applies a fraction of the others' average movement, excluding the person's own signals", () => {
    const impacts = [1.2, 0, 0];
    expect(computeMood(impacts)).toBeCloseTo(0.4);
    expect(marketMoodForce("mover", 1.2, impacts, CONFIG.marketMood).impact).toBe(0); // its own news does not feed back
    expect(marketMoodForce("other", 0, impacts, CONFIG.marketMood).impact).toBeCloseTo(0.25 * 0.6); // others' mean is 0.6
  });

  it("honours per-person sensitivity and brakes", () => {
    const config = { ...CONFIG.marketMood, sensitivityBySlug: { calm: 0.5, wild: 3 } };
    expect(marketMoodForce("calm", 0, [1.2, 0, 0], config).impact).toBeCloseTo(0.25 * 0.5 * 0.6);
    // wild: 0.25 * 3 * min(mood, maxAbsMood) would be 0.45 -> stays under maxAbsImpact; a huge mood is clamped
    expect(marketMoodForce("wild", 0, [40, 0, 0], config).impact).toBe(config.maxAbsImpact);
    expect(marketMoodForce("other", 0, [-40, 0, 0], config).impact).toBeCloseTo(-0.25 * 2.0); // mood clamped to -2
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
