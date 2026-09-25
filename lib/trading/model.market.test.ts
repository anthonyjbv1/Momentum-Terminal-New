import { describe, expect, it } from "vitest";

import { fingerprintFor } from "./fingerprint";
import { buyCostCents, marginalCents, sellProceedsCents } from "./market";
import {
  ORDER_REJECTION_CODES,
  affordableUnits,
  bookSide,
  cents,
  flatBook,
  pointsToCents,
  previewMarketOrder,
  previewMarketSpend,
  previewOrder,
  previewSpend,
  quoteFromScore,
  toOrderResult,
  toTradeQuote,
  walkPreview,
  type TradeBook,
} from "./model";

/**
 * THE INTERFACE'S ARITHMETIC (Phase 29): what the sheet shows is what the
 * server charges. lib/trading/market.db.test.ts holds the TS mirror against
 * the SQL over thousands of inputs; this file holds the previews and the
 * parsers against that mirror and against the deploy-day book.
 */

/** The book the migration left every public figure on: score 50.00, spread 0.50, no inventory, depth 300,000. */
const DEPLOY_BOOK: TradeBook = {
  buyCents: cents(5050),
  sellCents: cents(4950),
  baseBuyCents: cents(5050),
  baseSellCents: cents(4950),
  premiumCents: 0,
  inventoryUnits: 0,
  depthUnits: 300_000,
  premiumCapCents: 800,
};

describe("quotes with a premium", () => {
  it("adds the whole-cent premium after the rounding, exactly as the generated columns do", () => {
    expect(quoteFromScore(50, 0.5)).toEqual({ buyCents: 5050, sellCents: 4950 });
    expect(quoteFromScore(50, 0.5, 400)).toEqual({ buyCents: 5450, sellCents: 5350 });
    expect(quoteFromScore(50.1234, 0.5, -37)).toEqual({ buyCents: pointsToCents(50.6234) - 37, sellCents: pointsToCents(49.6234) - 37 });
  });

  it("reads a Phase 29 quote in full, and an older one as a flat market at the score", () => {
    const quote = toTradeQuote(
      {
        person_id: "p",
        score: "50.0000",
        spread: "0.5000",
        buy_cents: 5453,
        sell_cents: 5353,
        base_buy_cents: 5050,
        base_sell_cents: 4950,
        premium_cents: 403,
        market_price: "54.0300",
        inventory_units: "1210000",
        depth_units: 300000,
        premium_cap_cents: 800,
        tier: "public_figure",
        trading_mode: "tradeable",
        halted_until: null,
        halt_reason: null,
        tolerance_cents: 10,
        as_of: "2026-09-25T12:00:00Z",
      },
      "p",
    );
    expect(quote).toMatchObject({ buyCents: 5453, sellCents: 5353, baseBuyCents: 5050, baseSellCents: 4950, premiumCents: 403, marketPrice: 54.03, inventoryUnits: 1_210_000, depthUnits: 300_000, premiumCapCents: 800, tier: "public_figure", tradingMode: "tradeable", haltedUntil: null });

    const legacy = toTradeQuote({ person_id: "p", score: 50, spread: 0.5, buy_cents: 5050, sell_cents: 4950, tolerance_cents: 10 }, "p");
    expect(legacy).toMatchObject({ premiumCents: 0, marketPrice: 50, baseBuyCents: 5050, baseSellCents: 4950, inventoryUnits: null, depthUnits: null, tier: "public_figure", tradingMode: "tradeable" });

    const halted = toTradeQuote({ buy_cents: 1, sell_cents: 1, tier: "private_individual", trading_mode: "display_only", halted_until: "2026-09-25T13:00:00Z", halt_reason: "The premium moved 3.01 points in 10 minutes." }, "p");
    expect(halted).toMatchObject({ tier: "private_individual", tradingMode: "display_only", haltedUntil: "2026-09-25T13:00:00Z", haltReason: "The premium moved 3.01 points in 10 minutes." });
  });

  it("names every refusal place_order() can return", () => {
    for (const code of ["frozen", "identity_required", "excluded", "halted", "paused", "display_only", "order_too_large", "exposure_cap", "premium_cap", "price_moved", "below_minimum", "cooldown"]) {
      expect(ORDER_REJECTION_CODES).toContain(code);
    }
  });
});

describe("the book's sides", () => {
  it("walks from the BASE price when the book is known, and flat from the quote when it is not", () => {
    expect(bookSide(DEPLOY_BOOK, "BUY")).toEqual({ baseCents: 5050, inventoryUnits: 0, depthUnits: 300_000 });
    expect(bookSide(DEPLOY_BOOK, "SELL")).toEqual({ baseCents: 4950, inventoryUnits: 0, depthUnits: 300_000 });
    const unknown = flatBook(cents(5453), cents(5353), 403);
    expect(unknown).toMatchObject({ baseBuyCents: 5050, baseSellCents: 4950, inventoryUnits: null, depthUnits: null });
    expect(bookSide(unknown, "BUY")).toEqual({ baseCents: 5453, inventoryUnits: 0, depthUnits: null });
  });
});

describe("previews on the curve", () => {
  it("prices a ten-share buy on the deploy book the way the server does: gross 505.17, average 50.52, worst 50.54, premium 3¢", () => {
    const preview = previewMarketOrder("BUY", 10, DEPLOY_BOOK, cents(1_000_000));
    expect(preview.units).toBe(10_000);
    expect(preview.grossCents).toBe(50_517);
    expect(preview.priceCents).toBe(5052);
    expect(preview.quoteCents).toBe(5050);
    expect(preview.worstCents).toBe(5054);
    expect(preview.premiumAfterCents).toBe(3);
    expect(preview.impactCents).toBeCloseTo(16.666666667, 6);
    expect(preview.balanceAfterCents).toBe(1_000_000 - 50_517);
    expect(preview.belowMinimum).toBe(false);
    // The same figures straight from the mirror.
    expect(buyCostCents(10_000, bookSide(DEPLOY_BOOK, "BUY"))).toBe(50_517);
    expect(marginalCents({ ...bookSide(DEPLOY_BOOK, "BUY"), inventoryUnits: 10_000 }, "ceil")).toBe(5054);
  });

  it("resolves a Dollars-mode amount to the largest quantity whose walk fits, never more", () => {
    const exact = previewMarketSpend("BUY", cents(50_517), DEPLOY_BOOK, cents(1_000_000));
    expect(exact.units).toBe(10_000);
    expect(exact.grossCents).toBe(50_517);
    const short = previewMarketSpend("BUY", cents(50_516), DEPLOY_BOOK, cents(1_000_000));
    expect(short.units).toBe(9_999);
    expect(short.grossCents).toBeLessThanOrEqual(50_516);
    expect(previewMarketSpend("BUY", cents(99), DEPLOY_BOOK, cents(1_000_000)).belowMinimum).toBe(true);
  });

  it("a round trip against an unchanged book costs the spread and the two roundings, and nothing else", () => {
    const buy = walkPreview("BUY", 10_000, DEPLOY_BOOK);
    const after: TradeBook = { ...DEPLOY_BOOK, inventoryUnits: 10_000, premiumCents: 3, buyCents: cents(5053), sellCents: cents(4953) };
    const sell = walkPreview("SELL", 10_000, after);
    expect(buy.grossCents).toBe(50_517);
    expect(sell.grossCents).toBe(49_516);
    expect(buy.grossCents - sell.grossCents).toBe(1001);
    expect(sell.premiumAfterCents).toBe(0);
    expect(sellProceedsCents(10_000, bookSide(after, "SELL"))).toBe(49_516);
  });

  it("prices a sell below the data: the premium goes negative and the worst fill is the lowest", () => {
    const sell = previewMarketOrder("SELL", 30, DEPLOY_BOOK, cents(0));
    expect(sell.grossCents).toBe(sellProceedsCents(30_000, bookSide(DEPLOY_BOOK, "SELL")));
    expect(sell.premiumAfterCents).toBe(-10);
    expect(sell.worstCents).toBeLessThan(sell.priceCents);
    expect(sell.priceCents).toBeLessThan(sell.quoteCents);
  });

  it("keeps the flat-market previews exactly as Phase 27 defined them", () => {
    expect(previewOrder("BUY", 3, cents(5050), cents(1_000_000)).grossCents).toBe(15_150);
    expect(previewOrder("SELL", 0.333, cents(4950), cents(0)).grossCents).toBe(Math.floor((333 * 4950) / 1000));
    expect(previewOrder("BUY", 3, cents(5050), cents(1_000_000)).affordableShares).toBe(affordableUnits(1_000_000, 5050) / 1000);
    const spend = previewSpend("BUY", cents(1_000), cents(5050), cents(1_000_000));
    expect(spend.units).toBe(affordableUnits(1_000, 5050));
    expect(spend.priceCents).toBe(5050);
    expect(spend.worstCents).toBe(5050);
    expect(spend.impactCents).toBe(0);
  });
});

describe("the fill's walk", () => {
  it("reads the base, the worst fill, the impact and the premium either side, and falls back to the price for an older order", () => {
    const result = toOrderResult(
      {
        ok: true,
        order: {
          id: "o",
          side: "BUY",
          units: 10000,
          units_per_share: 1000,
          fill_price_cents: 5052,
          gross_cents: 50517,
          base_price_cents: 5050,
          worst_fill_cents: 5054,
          impact_cents: "16.666666667",
          premium_before_cents: 0,
          premium_after_cents: 3,
          opened_units: 10000,
          opened_direction: "HIGH",
          cost_cents: 50517,
          closed_units: 0,
          proceeds_cents: 0,
          realized_pnl_cents: 0,
          fills: [],
        },
        balance_cents: 949483,
        position: null,
        quote: { buy_cents: 5053, sell_cents: 4953, premium_cents: 3, market_price: 50.03 },
      },
      "p",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toMatchObject({ units: 10, fillPriceCents: 5052, baseCents: 5050, worstFillCents: 5054, premiumBeforeCents: 0, premiumAfterCents: 3 });
    expect(result.order.impactCents).toBeCloseTo(16.666666667, 6);
    expect(result.quote).toMatchObject({ premiumCents: 3, marketPrice: 50.03 });

    const legacy = toOrderResult({ ok: true, order: { id: "o", side: "SELL", units: 2, fill_price_cents: 4950, gross_cents: 9900, fills: [] }, balance_cents: 1, position: null, quote: null }, "p");
    if (!legacy.ok) throw new Error("expected a fill");
    expect(legacy.order).toMatchObject({ baseCents: 4950, worstFillCents: 4950, impactCents: 0, premiumBeforeCents: 0, premiumAfterCents: 0 });
  });
});

describe("the fingerprint", () => {
  it("is a salted hash of the first hop and the agent, null without a salt or without both inputs, and never the inputs themselves", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "Test/1.0" });
    const hash = fingerprintFor(headers, "salt");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("203.0.113.9");
    expect(fingerprintFor(headers, null)).toBeNull();
    expect(fingerprintFor(new Headers(), "salt")).toBeNull();
    // The same connection from another salt is a different hash: rotating the salt breaks continuity on purpose.
    expect(fingerprintFor(headers, "other")).not.toBe(hash);
    // The first hop decides, not the proxy chain.
    expect(fingerprintFor(new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "Test/1.0" }), "salt")).toBe(hash);
    expect(fingerprintFor(new Headers({ "x-real-ip": "203.0.113.9", "user-agent": "Test/1.0" }), "salt")).toBe(hash);
  });
});
