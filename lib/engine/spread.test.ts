import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG as CONFIG } from "./config";
import { buySellPrices, computeSpreads, lmsrMarginalPrices } from "./spread";

const people = ["a", "b", "c", "d"];
const MAX = 9_000_000;

function inputs(capital: Record<string, number> = {}, activity: Record<string, { depth: number; confidence: number }> = {}) {
  return people.map((id) => ({
    personId: id,
    openCapitalCents: capital[id] ?? 0,
    maxAllocationCents: MAX,
    signalDepth: activity[id]?.depth ?? 0,
    averageConfidence: activity[id]?.confidence ?? 0,
  }));
}

describe("LMSR spread", () => {
  it("collapses to the base spread with no positions and no volume", () => {
    const spreads = computeSpreads(inputs(), CONFIG.spread);
    for (const id of people) {
      expect(spreads.get(id)?.spread).toBe(0.5);
      expect(spreads.get(id)?.thinness).toBe(0);
    }
    expect(buySellPrices(50, 0.5)).toEqual({ buyPrice: 50.5, sellPrice: 49.5 });
  });

  it("uses uniform marginal prices when the market is empty", () => {
    const prices = lmsrMarginalPrices(new Map(people.map((id) => [id, 0])), 5000);
    for (const id of people) expect(prices.get(id)).toBeCloseTo(0.25);
  });

  it("widens thin markets and keeps the concentrated one at base", () => {
    const spreads = computeSpreads(inputs({ a: 1_500_000 }), CONFIG.spread); // $15k on a, nothing elsewhere
    expect(spreads.get("a")?.spread).toBe(0.5);
    for (const id of ["b", "c", "d"]) {
      const s = spreads.get(id)!;
      expect(s.spread).toBeGreaterThan(0.5);
      expect(s.spread).toBeLessThanOrEqual(1.5);
      expect(s.thinness).toBeGreaterThan(0);
    }
  });

  it("tightens with signal depth and confidence, and never leaves [base, max]", () => {
    const quiet = computeSpreads(inputs({ a: 1_500_000 }), CONFIG.spread).get("b")!.spread;
    const busy = computeSpreads(inputs({ a: 1_500_000 }, { b: { depth: 10, confidence: 0.9 } }), CONFIG.spread).get("b")!.spread;
    expect(busy).toBeLessThan(quiet);
    expect(busy).toBeGreaterThanOrEqual(0.5);

    const extreme = computeSpreads(inputs({ a: 90_000_000_000 }), CONFIG.spread);
    for (const id of ["b", "c", "d"]) expect(extreme.get(id)?.spread).toBeCloseTo(1.5, 5);
  });
});
