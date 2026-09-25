import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buyCostCents, sellProceedsCents } from "./market";
import { bookFromMarket } from "./model";

/**
 * WHAT A ROUND TRIP COSTS (Phase 29d). The explainer used to say a round trip
 * against an unchanged market "costs exactly the spread and nothing more". It
 * does not: the buy rounds UP to the cent and the sell rounds DOWN, so the
 * two roundings are left over once the walks cancel. The page now says "the
 * spread, plus at most a cent of rounding (the spread on a fraction of a share
 * is counted up to the whole cent)", and this file pins that bound.
 *
 * With B and S the base Buy and Sell prices in cents, X = u(2I+u)/(20D) the
 * walk (the same for the buy from I and the sell back from I+u), and
 * Δ = B − S the quoted spread:
 *
 *   cost = ceil(u·B/1000 + X) − floor(u·S/1000 + X)
 *
 * which is at least u·Δ/1000 and less than u·Δ/1000 + 2, and is a whole
 * number of cents: so it is ceil(u·Δ/1000) or one cent more. For whole
 * shares u·Δ/1000 is itself whole and the cost is the spread or the spread
 * plus one cent. For a fraction of a share the exact spread is a fraction of a
 * cent, which is why the sentence counts it up to the whole cent — against the
 * unrounded figure the gap can reach just under two cents, and a case below
 * shows it.
 */

/** A small deterministic generator, so a failure names its case. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Case {
  score: number;
  spread: number;
  inventory: number;
  depth: number | null;
  units: number;
}

function roundTrip({ score, spread, inventory, depth, units }: Case) {
  const book = bookFromMarket({ score, spread, premiumCents: 0, inventoryUnits: inventory, depthUnits: depth, premiumCapCents: null });
  const bought = buyCostCents(units, { baseCents: book.baseBuyCents, inventoryUnits: inventory, depthUnits: depth });
  const sold = sellProceedsCents(units, { baseCents: book.baseSellCents, inventoryUnits: depth === null ? inventory : inventory + units, depthUnits: depth });
  const delta = book.baseBuyCents - book.baseSellCents;
  // ceil(u·Δ / 1000) in integers.
  const spreadCents = Math.ceil((units * delta) / 1000);
  return { cost: bought - sold, spreadCents, exactSpread: (units * delta) / 1000 };
}

describe("a round trip against an unchanged market", () => {
  it("costs the spread, counted up to the whole cent, plus at most one cent — across thousands of books and orders", () => {
    const random = generator(29_4);
    for (let i = 0; i < 20_000; i += 1) {
      const c: Case = {
        score: Math.round((20 + random() * 60) * 10_000) / 10_000,
        spread: [0.5, 0.5029, 0.75, 1.5][Math.floor(random() * 4)],
        inventory: Math.floor((random() - 0.5) * 2_000_000),
        depth: random() < 0.1 ? null : [20_000, 100_000, 300_000][Math.floor(random() * 3)],
        units: 1 + Math.floor(random() * (random() < 0.5 ? 4_000 : 60_000)),
      };
      const { cost, spreadCents, exactSpread } = roundTrip(c);
      const extra = cost - spreadCents;
      if (extra < 0 || extra > 1) throw new Error(`case ${JSON.stringify(c)}: cost ${cost}, spread ${spreadCents}`);
      expect(cost).toBeGreaterThanOrEqual(exactSpread);
      expect(cost).toBeLessThan(exactSpread + 2);
    }
  });

  it("on whole shares costs the spread or the spread plus one cent, exactly", () => {
    for (const units of [1_000, 2_000, 7_000, 60_000]) {
      for (const inventory of [-60_000, -1, 0, 1, 7_217, 60_000]) {
        for (const depth of [20_000, 300_000]) {
          const { cost, exactSpread } = roundTrip({ score: 68.5982, spread: 0.5, inventory, depth, units });
          expect(Number.isInteger(exactSpread)).toBe(true);
          expect([exactSpread, exactSpread + 1]).toContain(cost);
        }
      }
    }
    // The pinned production case (market.db.test.ts): ten shares at $50.50 / $49.50 on a 300-share depth, 1,001 cents.
    expect(roundTrip({ score: 50, spread: 0.5, inventory: 0, depth: 300_000, units: 10_000 }).cost).toBe(1_001);
  });

  it("can sit nearly two cents over the UNROUNDED spread on a fraction of a share, which is why the page counts the spread up to the cent", () => {
    let worst = 0;
    for (let units = 1; units <= 999; units += 1) {
      for (const inventory of [0, 1, 7, 333, 4_999]) {
        const { cost, exactSpread, spreadCents } = roundTrip({ score: 68.5982, spread: 0.5, inventory, depth: 20_000, units });
        worst = Math.max(worst, cost - exactSpread);
        expect(cost - spreadCents).toBeLessThanOrEqual(1);
      }
    }
    expect(worst).toBeGreaterThan(1);
    expect(worst).toBeLessThan(2);
  });

  it("is what the explainer says", () => {
    const page = readFileSync(join(__dirname, "..", "..", "app", "(public)", "how-the-price-works", "page.tsx"), "utf8").replace(/\s+/g, " ");
    expect(page).toContain("costs the spread, plus at most a cent of rounding (the spread on a fraction of a share is counted up to the whole cent)");
    expect(page).not.toMatch(/exactly the spread and nothing more/);
  });
});
