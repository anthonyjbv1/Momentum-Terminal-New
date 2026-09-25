import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/config";
import { gravityForce } from "@/lib/engine/forces/gravity";
import { computeSpreads, type SpreadInput } from "@/lib/engine/spread";
import { MARKET_FORCES, SCORE_FORCES } from "@/lib/engine/types";
import { FORCE_DEFINITIONS, FORCE_KEYS, SCORE_FORCE_KEYS, emptyMarketReadings, readMarketReadings, type ForceReading, type MarketReadings } from "@/lib/person/profile-model";
import { premiumCents, stateAfter } from "@/lib/trading/market";

import { FORCE_GROUPS, ForcesPanel, forceDescription, forcesFootnote, forcesInGroup, formatVolume, marketReadingText } from "./forces-panel";

/**
 * THE FORCES PANEL SAYS ONLY WHAT THE CODE DOES (Phase 29c). Every line of
 * copy on it is a claim — which group a force is in, what Gravity pulls
 * towards, what trading moves, what Conviction does to the spread — and each
 * test here reads one claim back against the code that makes it true.
 */

function reading(key: ForceReading["key"], impact: number | null = 0): ForceReading {
  const definition = FORCE_DEFINITIONS[key];
  return { key, label: definition.label, description: definition.description, role: definition.role, impact, direction: "neutral", details: null };
}

const ALL = FORCE_KEYS.map((key) => reading(key));

function trading(buyCents: number, sellCents: number, trades = (buyCents > 0 ? 1 : 0) + (sellCents > 0 ? 1 : 0), windowMinutes = 60): MarketReadings {
  return { ...emptyMarketReadings(), tradingActivity: { buyCents, sellCents, netFlowCents: buyCents - sellCents, trades, windowMinutes } };
}

describe("the two groups", () => {
  it("are 'Moving the score' (Gravity, Signals, Market Mood) and 'Moving the market' (Trading Activity, Conviction)", () => {
    expect(FORCE_GROUPS.map((group) => group.title)).toEqual(["Moving the score", "Moving the market"]);
    expect(forcesInGroup(ALL, "score").map((force) => force.label)).toEqual(["Gravity", "Signals", "Market Mood"]);
    expect(forcesInGroup(ALL, "market").map((force) => force.label)).toEqual(["Trading Activity", "Conviction"]);
  });

  it("match what the Engine adds to the score and what it keeps out of it", () => {
    // The score group is exactly the forces the Engine sums into the score; the market group is exactly the ones it does not.
    expect([...SCORE_FORCE_KEYS]).toEqual(FORCE_KEYS.filter((key) => FORCE_DEFINITIONS[key].role === "score"));
    for (const key of FORCE_KEYS) {
      if (FORCE_DEFINITIONS[key].role === "score") {
        expect(SCORE_FORCES).toContain(key);
        expect(MARKET_FORCES).not.toContain(key);
      } else {
        expect(MARKET_FORCES).toContain(key);
        expect(SCORE_FORCES).not.toContain(key);
      }
    }
  });
});

describe("each row's copy", () => {
  it("is the Phase 29c wording", () => {
    expect(FORCE_DEFINITIONS.gravity.description).toBe("Pull towards their baseline");
    expect(FORCE_DEFINITIONS.market_mood.description).toBe("The tide across everyone we track");
    expect(FORCE_DEFINITIONS.trading_activity.description).toBe("Buy and sell flow · moves the market price");
    expect(FORCE_DEFINITIONS.conviction.description).toBe("Capital committed · tightens the spread");
    // No reader-facing copy calls the baseline a "gravity target".
    for (const key of FORCE_KEYS) expect(FORCE_DEFINITIONS[key].description.toLowerCase()).not.toContain("target");
  });

  it("GRAVITY: pulls the score towards the baseline (the revert target), from either side", () => {
    const config = DEFAULT_ENGINE_CONFIG.gravity;
    expect(gravityForce(50, 55, 1, config).impact).toBeGreaterThan(0);
    expect(gravityForce(60, 55, 1, config).impact).toBeLessThan(0);
    expect(gravityForce(55, 55, 1, config).impact).toBe(0);
    // Towards, never past.
    expect(50 + gravityForce(50, 55, 1_000, config).impact).toBeLessThanOrEqual(55);
  });

  it("TRADING ACTIVITY: buying pushes the market price up and selling pushes it down, on a curved market", () => {
    for (const depthUnits of [20_000, 100_000, 300_000]) {
      for (const inventoryUnits of [-50_000, 0, 1_000, 60_000]) {
        const state = { baseCents: 6_919, inventoryUnits, depthUnits };
        const before = premiumCents(inventoryUnits, depthUnits);
        for (const units of [1, 3_000, 30_000]) {
          const up = premiumCents(stateAfter(units, state, "up").inventoryUnits, depthUnits);
          const down = premiumCents(stateAfter(units, state, "down").inventoryUnits, depthUnits);
          // Never the wrong way. The premium is truncated towards zero to whole cents, so its widest step (the one either
          // side of zero) is two cents of inventory: an order of 2 × depth / 100 units or more always shows.
          expect(up).toBeGreaterThanOrEqual(before);
          expect(down).toBeLessThanOrEqual(before);
          if (units >= (2 * depthUnits) / 100) {
            expect(up).toBeGreaterThan(before);
            expect(down).toBeLessThan(before);
          }
        }
      }
    }
  });

  it("TRADING ACTIVITY on a flat market: the price stays at the score, and the row says so instead", () => {
    const flat = { baseCents: 6_919, inventoryUnits: 0, depthUnits: null };
    expect(premiumCents(stateAfter(3_000, flat, "up").inventoryUnits, null)).toBe(0);
    expect(premiumCents(stateAfter(3_000, flat, "down").inventoryUnits, null)).toBe(0);
    const row = reading("trading_activity");
    expect(forceDescription(row, true)).toBe("Buy and sell flow · moves the market price");
    expect(forceDescription(row, false)).toBe("Buy and sell flow · the market price stays at the score");
    // Every other row reads the same either way.
    for (const key of FORCE_KEYS.filter((k) => k !== "trading_activity")) expect(forceDescription(reading(key), false)).toBe(FORCE_DEFINITIONS[key].description);
  });

  it("CONVICTION: committed capital tightens the spread — never widens it — and does not set it alone", () => {
    const config = DEFAULT_ENGINE_CONFIG.spread;
    const others: SpreadInput[] = Array.from({ length: 14 }, (_, i) => ({
      personId: `other-${i}`,
      openCapitalCents: 2_000_000,
      maxAllocationCents: 50_000_000,
      signalDepth: 3,
      averageConfidence: 0.6,
    }));
    const spreadAt = (openCapitalCents: number, signalDepth = 0, averageConfidence = 0) =>
      computeSpreads([...others, { personId: "p", openCapitalCents, maxAllocationCents: 50_000_000, signalDepth, averageConfidence }], config).get("p")!.spread;

    // More capital committed: the spread never rises.
    let previous = spreadAt(0);
    for (let cents = 0; cents <= 60_000_000; cents += 250_000) {
      const spread = spreadAt(cents);
      expect(spread).toBeLessThanOrEqual(previous + 1e-12);
      previous = spread;
    }
    // And on a thin market it genuinely tightens — the claim is not vacuous.
    expect(spreadAt(1_500_000)).toBeLessThan(spreadAt(0));
    // It does not SET the spread: at the same capital, signal depth and confidence move it too, and it stays in [base, max].
    expect(spreadAt(500_000, 10, 1)).toBeLessThan(spreadAt(500_000, 0, 0));
    for (const cents of [0, 500_000, 5_000_000, 60_000_000]) {
      expect(spreadAt(cents)).toBeGreaterThanOrEqual(config.base);
      expect(spreadAt(cents)).toBeLessThanOrEqual(config.max);
    }
  });

  it("CONVICTION: does not move the market price — the premium reads inventory and depth, nothing else", () => {
    // premiumCents takes no capital argument at all; the market price is the score plus it.
    expect(premiumCents.length).toBe(2);
  });
});

describe("the market readings", () => {
  it("Trading Activity: the buy/sell split and the volume, e.g. '72% buying · $14 traded'", () => {
    expect(marketReadingText(reading("trading_activity"), trading(1_008, 392))).toEqual({ text: "72% buying · $14 traded", quiet: false });
    expect(marketReadingText(reading("trading_activity"), trading(100, 0))).toEqual({ text: "100% buying · $1 traded", quiet: false });
    expect(marketReadingText(reading("trading_activity"), trading(250, 750))).toEqual({ text: "75% selling · $10 traded", quiet: false });
    expect(marketReadingText(reading("trading_activity"), trading(500, 500))).toEqual({ text: "50% buying · $10 traded", quiet: false });
    // One sell among many buys is never rounded away to "100% buying".
    expect(marketReadingText(reading("trading_activity"), trading(99_700, 300)).text).toBe("99% buying · $1,000 traded");
  });

  it("Trading Activity: 'No trades this hour' when nothing traded, and the window in words otherwise", () => {
    expect(marketReadingText(reading("trading_activity"), trading(0, 0, 0))).toEqual({ text: "No trades this hour", quiet: true });
    expect(marketReadingText(reading("trading_activity"), trading(0, 0, 0, 120)).text).toBe("No trades in the last 2 hours");
  });

  it("Trading Activity: read from the same tape the profile loads, buys and sells summed apart", () => {
    const market = readMarketReadings(0, 0, [
      { side: "BUY", amount_cents: 1_000 },
      { side: "SELL", amount_cents: "392" },
      { side: "BUY", amount_cents: 8 },
    ]);
    expect(market.tradingActivity).toMatchObject({ buyCents: 1_008, sellCents: 392, netFlowCents: 616, trades: 3 });
    expect(marketReadingText(reading("trading_activity"), market).text).toBe("72% buying · $14 traded");
  });

  it("volume: whole dollars, with cents only when they carry a small amount", () => {
    expect(formatVolume(1_400)).toBe("$14");
    expect(formatVolume(1_460)).toBe("$15");
    expect(formatVolume(150)).toBe("$1.50");
    expect(formatVolume(100)).toBe("$1");
    expect(formatVolume(1)).toBe("$0.01");
    expect(formatVolume(123_456_789)).toBe("$1,234,568");
  });

  it("Conviction: the share of the allocation cap committed", () => {
    const conviction = (openCapitalCents: number, maxAllocationCents: number) => marketReadingText(reading("conviction"), readMarketReadings(openCapitalCents, maxAllocationCents, []));
    expect(conviction(7_000_000, 9_000_000)).toEqual({ text: "78% of cap committed", quiet: false });
    expect(conviction(0, 9_000_000)).toEqual({ text: "Nothing committed", quiet: true });
    expect(conviction(1, 9_000_000).text).toBe("1% of cap committed");
    expect(conviction(20_000_000, 9_000_000).text).toBe("100% of cap committed");
    expect(conviction(100, 0)).toEqual({ text: "No allocation cap", quiet: true });
  });
});

describe("the footnote", () => {
  it("says what each group's figures are, and what each market force does", () => {
    const [score, market] = forcesFootnote("hour", true);
    expect(score).toBe("Moving the score: the points each force added to the Momentum Score over the last hour. Positive lifts it, negative lowers it.");
    expect(market).toBe(
      "Moving the market: trading never touches the score. The hour’s buying pushes the market price up and selling pushes it down; capital held open tightens the spread.",
    );
    // Conviction is never said to move or set the price.
    expect(market).not.toMatch(/capital[^.;]*(moves|sets)/i);
  });

  it("on a flat market says trading does not move the price", () => {
    const [, market] = forcesFootnote("hour", false);
    expect(market).toContain("does not move the price");
    expect(market).toContain("tightens the spread");
    expect(market).not.toContain("pushes");
  });
});

describe("the panel", () => {
  const render = (curved: boolean, market: MarketReadings) =>
    renderToStaticMarkup(createElement(ForcesPanel, { forces: ALL, market, latestTick: { tickNumber: 1, at: new Date().toISOString() }, curved }));

  it("draws the heading, then each group's subheading above its own rows", () => {
    const html = render(true, trading(1_008, 392));
    const at = (text: string) => html.indexOf(text);
    expect(at("The five forces")).toBeGreaterThanOrEqual(0);
    const order = ["Moving the score", "Gravity", "Signals", "Market Mood", "Moving the market", "Trading Activity", "Conviction"].map(at);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("72% buying · $14 traded");
    expect(html).toContain("Pull towards their baseline");
    // The subheadings replace the old MARKET tag.
    expect(html).not.toMatch(/>\s*Market\s*</);
  });

  it("sets the market readings in the sentence face, in a neutral colour", () => {
    const html = render(true, trading(1_008, 392));
    const span = html.match(/<span class="([^"]*)">72% buying/);
    expect(span).not.toBeNull();
    const classes = span![1].split(" ");
    expect(classes).toContain("tabular-nums");
    expect(classes).not.toContain("num");
    expect(classes.some((name) => name === "text-positive" || name === "text-negative")).toBe(false);
  });

  it("reads 'No trades this hour' on a quiet hour, and the flat copy on a flat market", () => {
    expect(render(true, trading(0, 0, 0))).toContain("No trades this hour");
    const flat = render(false, trading(0, 0, 0));
    expect(flat).toContain("the market price stays at the score");
    expect(flat).not.toContain("moves the market price");
  });
});
