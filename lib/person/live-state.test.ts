import { describe, expect, it } from "vitest";

import { bookFromMarket, cents, type TradeQuote } from "@/lib/trading/model";

import { applyTradeQuote, mergeLiveResponse, type LiveState } from "./live-state";
import { RANGES, type SeriesByRange } from "./profile-model";

/**
 * THE PROFILE'S LIVE BOOK (Phase 29e). Two rules the price-moved loop broke:
 * a poll whose only change is the dealer's inventory still moves the book, and
 * an order's quote is applied at once — without a poll sent before it putting
 * the old inventory back.
 */

const series = Object.fromEntries(RANGES.map((range) => [range.key, []])) as unknown as SeriesByRange;

const state: LiveState = {
  series,
  score: 68.6,
  lastTickAt: "2026-09-25T17:00:00.000Z",
  buyPrice: 69.42,
  sellPrice: 68.42,
  spread: 0.5,
  premiumCents: 32,
  marketPrice: 68.92,
  inventoryUnits: 6_455,
  tradingMode: "tradeable",
  haltedUntil: null,
  haltReason: null,
  version: 3,
  updatedAt: 1,
};

const poll = (patch: Record<string, unknown> = {}) => ({
  score: 68.6,
  lastTickAt: "2026-09-25T17:00:00.000Z",
  buyPrice: 69.42,
  sellPrice: 68.42,
  spread: 0.5,
  premiumCents: 32,
  marketPrice: 68.92,
  inventoryUnits: 6_455,
  tradingMode: "tradeable",
  haltedUntil: null,
  haltReason: null,
  ticks: [],
  ...patch,
});

function quote(patch: Record<string, unknown> = {}): TradeQuote {
  const book = bookFromMarket({ score: 68.6, spread: 0.5, premiumCents: 52, inventoryUnits: 10_455, depthUnits: 20_000, premiumCapCents: 800 });
  return {
    ...book,
    personId: "p",
    score: 68.6,
    spread: 0.5,
    marketPrice: 69.12,
    tier: "public_figure",
    tradingMode: "tradeable",
    haltedUntil: null,
    haltReason: null,
    toleranceCents: cents(10),
    asOf: "2026-09-25T17:00:05.000Z",
    ...patch,
  } as unknown as TradeQuote;
}

describe("a poll", () => {
  it("that changes nothing returns the same state, so nothing re-renders", () => {
    expect(mergeLiveResponse(state, poll(), { now: 2, bookIsCurrent: true })).toBe(state);
  });

  it("that changes only the inventory moves the book (it used to be dropped until the score or the premium moved)", () => {
    const next = mergeLiveResponse(state, poll({ inventoryUnits: 6_440 }), { now: 2, bookIsCurrent: true });
    expect(next).not.toBe(state);
    expect(next.inventoryUnits).toBe(6_440);
    expect(next.version).toBe(state.version);
    expect(next.updatedAt).toBe(2);
  });

  it("sent before an order's quote was applied keeps the page's book, and still brings its ticks", () => {
    const stale = poll({ inventoryUnits: 6_455, premiumCents: 32 });
    const applied = applyTradeQuote(state, quote(), 2);
    expect(mergeLiveResponse(applied, stale, { now: 3, bookIsCurrent: false })).toBe(applied);

    const tick = { at: "2026-09-25T17:00:30.000Z", score: 68.7, market: 69.22 };
    const withTick = mergeLiveResponse(applied, { ...stale, lastTickAt: tick.at, ticks: [tick] }, { now: 3, bookIsCurrent: false });
    expect(withTick.version).toBe(applied.version + 1);
    expect(withTick.lastTickAt).toBe(tick.at);
    expect(withTick.inventoryUnits).toBe(10_455);
    expect(withTick.premiumCents).toBe(52);
  });
});

describe("an order's quote", () => {
  it("replaces the book with the one the server read, and leaves the series alone", () => {
    const next = applyTradeQuote(state, quote(), 2);
    expect(next).toMatchObject({ inventoryUnits: 10_455, premiumCents: 52, marketPrice: 69.12, buyPrice: 69.62, sellPrice: 68.62, updatedAt: 2 });
    expect(next.series).toBe(state.series);
    expect(next.version).toBe(state.version);
  });

  it("from a flat market carries no inventory, and the page's figure stands", () => {
    const flat = quote({ inventoryUnits: null, depthUnits: null, premiumCents: 0, buyCents: cents(6910), sellCents: cents(6810), marketPrice: 68.6 });
    expect(applyTradeQuote(state, flat, 2).inventoryUnits).toBe(state.inventoryUnits);
  });

  it("that says what the page already says changes nothing", () => {
    const same = quote({ premiumCents: 32, inventoryUnits: 6_455, marketPrice: 68.92, buyCents: cents(6942), sellCents: cents(6842) });
    expect(applyTradeQuote(state, same, 2)).toBe(state);
  });
});
