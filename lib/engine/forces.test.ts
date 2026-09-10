import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG as CONFIG } from "./config";
import { convictionForce, convictionImpact } from "./forces/conviction";
import { gravityForce } from "./forces/gravity";
import { computeMood, marketMoodForce } from "./forces/market-mood";
import { scoreSignals, signalImpact, signalsForce, tierMultiplier } from "./forces/signals";
import { tradingActivityForce, windowedNetFlows } from "./forces/trading-activity";
import { inversePairAdjustments } from "./inverse-pairs";
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

  it("sums a person's signals and caps the total", () => {
    const sentiments = new Map([
      ["a", { label: "positive" as const, confidence: 1, direction: 1 as const }],
      ["b", { label: "negative" as const, confidence: 0.5, direction: -1 as const }],
    ]);
    const scored = scoreSignals([signal({ id: "a" }), signal({ id: "b" })], sentiments, CONFIG.signals);
    const force = signalsForce(scored, CONFIG.signals);
    expect(force.impact).toBeCloseTo(1.5 - 0.75);
    expect(force.details.signalCount).toBe(2);

    const many = Array.from({ length: 20 }, (_, i) => signal({ id: `m${i}` }));
    const loud = new Map(many.map((s) => [s.id, { label: "positive" as const, confidence: 1, direction: 1 as const }]));
    const capped = signalsForce(scoreSignals(many, loud, CONFIG.signals), CONFIG.signals);
    expect(capped.impact).toBe(CONFIG.signals.maxAbsImpactPerTick);
    expect(capped.details.capped).toBe(true);
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

  it("yields 0 with no trades", () => {
    const force = tradingActivityForce({ ...base, events: [] });
    expect(force.impact).toBe(0);
    expect(force.details.reason).toBe("no variance in baseline");
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

  it("fires only beyond ±1.5σ of the baseline, weighted 0.25 and dampened when unconfirmed", () => {
    const burst: TradeEvent[] = [{ personId: "p", side: "BUY", amountCents: 900_000, createdAt: new Date(NOW.getTime() - 5_000) }];
    const confirmed = tradingActivityForce({ ...base, events: burst });
    expect(confirmed.details.fired).toBe(true);
    // flowScore = 900k / 9M = 0.1; the baseline mean is that one window over 1440, so the deviation is a hair under 0.1.
    expect(confirmed.impact).toBeCloseTo(0.1 * 0.25, 3);
    const unconfirmed = tradingActivityForce({ ...base, events: burst, confirmedBySignals: false });
    expect(unconfirmed.impact).toBeCloseTo(0.1 * 0.25 * 0.4, 3);

    // Steady identical flow in every window is never an anomaly.
    const steady: TradeEvent[] = Array.from({ length: 1440 }, (_, i) => ({
      personId: "p",
      side: "BUY",
      amountCents: 1000,
      createdAt: new Date(NOW.getTime() - i * 60_000 - 1_000),
    }));
    expect(tradingActivityForce({ ...base, events: steady }).impact).toBe(0);
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

    // A lull (no Buys in the current window while every other window had them) reads NEGATIVE even though flow never went below zero.
    const lull = tradingActivityForce({ ...base, events: inflow(true) });
    expect(lull.details.fired).toBe(true);
    expect(lull.impact).toBeLessThan(0);
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
