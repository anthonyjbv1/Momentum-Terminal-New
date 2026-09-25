import type { TradeQuote } from "@/lib/trading/model";

import { foldTicksIntoRanges, type LiveTick } from "./live-series";
import type { SeriesByRange, TradingMode } from "./profile-model";

/**
 * THE PROFILE'S LIVE MARKET STATE, and the two ways it moves (Phase 29e).
 *
 *   a poll     /api/person/[slug]/live, a little after every 30-second tick
 *   an order   the quote place_order() returns with every fill AND every
 *              refusal: the book as the server read it for that order
 *
 * Before Phase 29e only the first existed, and it ignored an answer whose
 * only change was the dealer's inventory. So after a fill the page kept
 * pricing the NEXT order on the book from before it until the next tick —
 * up to 30 seconds — and at MrBeast's demo depth (20 shares a point) one
 * 4-share buy moves the average 20¢, twice the 10¢ tolerance: every
 * following order came back "The price moved", and the refusal's re-quote
 * sent the same stale price again. Now the order's own quote is applied the
 * moment it arrives, and a poll changes the state whenever ANY part of the
 * book changed.
 *
 * WHICH IS NEWER. A poll sent before an order's answer was applied may have
 * read the market before that order, and must not put the old inventory
 * back. The hook numbers every poll and every applied quote in one sequence;
 * a poll numbered below the latest applied quote still brings its ticks (the
 * chart), but not its book. A poll sent after the quote was applied read the
 * market after the order committed, and is taken whole.
 */

export interface LiveState {
  series: SeriesByRange;
  score: number;
  lastTickAt: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  spread: number;
  /** The premium in cents per share, and the market price in points (score + premium). */
  premiumCents: number;
  marketPrice: number;
  inventoryUnits: number;
  tradingMode: TradingMode;
  haltedUntil: string | null;
  haltReason: string | null;
  /** Increments whenever new ticks arrive. */
  version: number;
  /** When the state last changed, for relative ages. */
  updatedAt: number | null;
}

export interface LiveResponse {
  score: number;
  lastTickAt: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  spread: number;
  premiumCents: number;
  marketPrice: number;
  inventoryUnits: number;
  tradingMode: string;
  haltedUntil: string | null;
  haltReason: string | null;
  ticks: LiveTick[];
}

export function toTradingMode(value: unknown, fallback: TradingMode): TradingMode {
  return value === "display_only" || value === "paused" || value === "tradeable" ? value : fallback;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Every field a preview is priced from, or the market's state is read from. */
const BOOK_FIELDS = ["score", "spread", "premiumCents", "marketPrice", "inventoryUnits", "buyPrice", "sellPrice", "tradingMode", "haltedUntil", "haltReason", "lastTickAt"] as const;

function sameBook(a: LiveState, b: LiveState): boolean {
  return BOOK_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * One poll's answer folded into the state. `bookIsCurrent` is false for a
 * poll sent before the latest order's quote was applied: its ticks still
 * land, its book does not. Returns `previous` itself when nothing changed, so
 * React skips the render.
 */
export function mergeLiveResponse(previous: LiveState, body: Partial<LiveResponse>, { now, bookIsCurrent }: { now: number; bookIsCurrent: boolean }): LiveState {
  const ticks = Array.isArray(body.ticks) ? body.ticks : [];
  const series = ticks.length > 0 ? foldTicksIntoRanges(previous.series, ticks, now) : previous.series;
  const version = previous.version + (ticks.length > 0 ? 1 : 0);

  if (!bookIsCurrent) {
    if (ticks.length === 0) return previous;
    return { ...previous, series, lastTickAt: body.lastTickAt ?? previous.lastTickAt, version, updatedAt: now };
  }

  const score = finite(body.score);
  const premium = finite(body.premiumCents);
  const inventory = finite(body.inventoryUnits);
  const haltedUntil = typeof body.haltedUntil === "string" ? body.haltedUntil : body.haltedUntil === null ? null : undefined;
  const next: LiveState = {
    series,
    score: score ?? previous.score,
    lastTickAt: body.lastTickAt ?? previous.lastTickAt,
    buyPrice: typeof body.buyPrice === "number" ? body.buyPrice : previous.buyPrice,
    sellPrice: typeof body.sellPrice === "number" ? body.sellPrice : previous.sellPrice,
    spread: finite(body.spread) ?? previous.spread,
    premiumCents: premium === null ? previous.premiumCents : Math.trunc(premium),
    marketPrice: finite(body.marketPrice) ?? previous.marketPrice,
    inventoryUnits: inventory === null ? previous.inventoryUnits : Math.trunc(inventory),
    tradingMode: toTradingMode(body.tradingMode, previous.tradingMode),
    haltedUntil: haltedUntil === undefined ? previous.haltedUntil : haltedUntil,
    haltReason: haltedUntil === undefined ? previous.haltReason : typeof body.haltReason === "string" ? body.haltReason : null,
    version,
    updatedAt: now,
  };
  if (ticks.length === 0 && sameBook(previous, next)) return previous;
  return next;
}

/**
 * An order's quote applied to the state: the book exactly as place_order()
 * read it, after the order on a fill and before it on a refusal. The series
 * is untouched (an order is not a tick). A flat market's quote carries no
 * inventory, and the page's figure stands.
 */
export function applyTradeQuote(previous: LiveState, quote: TradeQuote, now: number): LiveState {
  const next: LiveState = {
    ...previous,
    score: quote.score,
    spread: quote.spread,
    premiumCents: quote.premiumCents,
    marketPrice: quote.marketPrice,
    inventoryUnits: quote.inventoryUnits ?? previous.inventoryUnits,
    buyPrice: quote.buyCents / 100,
    sellPrice: quote.sellCents / 100,
    tradingMode: quote.tradingMode,
    haltedUntil: quote.haltedUntil,
    haltReason: quote.haltReason,
    updatedAt: now,
  };
  return sameBook(previous, next) ? previous : next;
}
