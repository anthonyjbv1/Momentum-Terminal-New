import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { applyTradeQuote, mergeLiveResponse, type LiveState } from "@/lib/person/live-state";
import { RANGES, type SeriesByRange } from "@/lib/person/profile-model";

import type { OrderSide } from "./direction";
import { capInventoryUnits } from "./market";
import { bookFromMarket, cents, previewMarketOrder, previewMarketSpend, sharesToUnits, toOrderResult, toTradeQuote, type OrderResult, type TradeBook, type TradeQuote } from "./model";

/**
 * BACK-TO-BACK ORDERS AT MRBEAST'S DEMO DEPTH (Phase 29e), on a real Postgres
 * with the migrations applied verbatim, through the same functions the page
 * and the sheet run: the page's live state (applyTradeQuote,
 * mergeLiveResponse), the book the sheet is handed (bookFromMarket), the
 * preview it shows and sends (previewMarketOrder / previewMarketSpend), and
 * the order result it reads (toOrderResult).
 *
 * The loop the demo hit: at 20 shares a point, one 4-share order moves the
 * average 20¢ — twice the 10¢ tolerance. The page did not take the book the
 * fill came back with, so the next order was priced on the book from before
 * the first and refused, and the refusal's re-quote sent the same stale
 * price again. The first case below reproduces that; the rest hold the fix:
 * every order priced on the book the last answer carried fills at exactly
 * the average previewed, and a refusal is answered in one tap at the
 * server's own figure.
 */

let database: TestDatabase;
let mrbeast: string;
const DEPTH = 20_000; // MrBeast's demo override: 20 shares a point
const TOLERANCE = 10;

async function createUser(email: string, balanceCents = 100_000_000): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  await database.rows("insert into public.transactions (user_id, type, amount_cents) values ($1, 'DEPOSIT', $2)", [row.id, balanceCents]);
  await database.rows("update public.users set wallet_balance_cents = wallet_balance_cents + $2, buying_power_cents = buying_power_cents + $2 where id = $1", [row.id, balanceCents]);
  return row.id;
}

async function balance(userId: string): Promise<number> {
  const [row] = await database.rows<{ b: string }>("select wallet_balance_cents::text as b from public.users where id = $1", [userId]);
  return Number(row.b);
}

/** What the page is rendered with: trade_quote(), as the profile reads it. */
async function serverQuote(): Promise<TradeQuote> {
  await database.actAs(null);
  const [row] = await database.rows<{ q: unknown }>("select public.trade_quote($1::uuid) as q", [mrbeast]);
  const quote = toTradeQuote(row.q, mrbeast);
  if (!quote) throw new Error("no quote");
  return quote;
}

/** place_order() exactly as the route calls it, read the way the sheet reads it. */
async function order(userId: string, side: OrderSide, request: { shares: number } | { spendCents: number }, quotedPriceCents: number): Promise<OrderResult> {
  await database.actAs(userId);
  const [row] =
    "shares" in request
      ? await database.rows<{ r: unknown }>("select public.place_order($1::uuid, $2, $3::bigint, $4::bigint, 'test', null::bigint, 'milli') as r", [mrbeast, side, sharesToUnits(request.shares), quotedPriceCents])
      : await database.rows<{ r: unknown }>("select public.place_order($1::uuid, $2, null::bigint, $3::bigint, 'test', $4::bigint, 'milli') as r", [mrbeast, side, quotedPriceCents, request.spendCents]);
  return toOrderResult(row.r, mrbeast);
}

function emptySeries(): SeriesByRange {
  return Object.fromEntries(RANGES.map((range) => [range.key, []])) as unknown as SeriesByRange;
}

/** The page's state as the profile first renders it, from the server's quote. */
function pageFrom(quote: TradeQuote): LiveState {
  const blank: LiveState = {
    series: emptySeries(),
    score: 0,
    lastTickAt: null,
    buyPrice: null,
    sellPrice: null,
    spread: 0,
    premiumCents: 0,
    marketPrice: 0,
    inventoryUnits: 0,
    tradingMode: "tradeable",
    haltedUntil: null,
    haltReason: null,
    version: 0,
    updatedAt: null,
  };
  return applyTradeQuote(blank, quote, 0);
}

/** ScorePanel's book: the live state, with depth and cap as the server resolved them. */
function pageBook(state: LiveState, quote: TradeQuote): TradeBook {
  return bookFromMarket({ score: state.score, spread: state.spread, premiumCents: state.premiumCents, inventoryUnits: state.inventoryUnits, depthUnits: quote.depthUnits, premiumCapCents: quote.premiumCapCents });
}

async function resetMarket(inventoryUnits = 0): Promise<void> {
  await database.rows("update public.people set market_inventory_units = $1, premium_cents = public.market_premium_cents($1, $2) where id = $3", [inventoryUnits, DEPTH, mrbeast]);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const [row] = await database.rows<{ id: string }>("select id from public.people where slug = 'mrbeast'");
  mrbeast = row.id;
  await database.rows("update public.people set current_score = 68.6, spread = 0.5, depth_units_override = $2 where id = $1", [mrbeast, DEPTH]);
  // The refusals under test are the price's; every other lever is kept out of the way.
  await database.rows("update public.platform_settings set close_cooldown_seconds = 0, price_tolerance_cents = $1 where id", [TOLERANCE]);
  await database.rows("update public.market_tier_settings set min_hold_seconds = 0, breaker_premium_cents = 1000000 where tier = 'public_figure'");
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe("the loop, reproduced", () => {
  it("a second order priced on the book from before the first is refused, 20¢ short", async () => {
    await resetMarket();
    const viewer = await createUser("loop@example.com");
    const quote = await serverQuote();
    expect(quote.depthUnits).toBe(DEPTH);
    const before = pageBook(pageFrom(quote), quote);

    const first = previewMarketOrder("BUY", 4, before, cents(await balance(viewer)));
    const filled = await order(viewer, "BUY", { shares: 4 }, first.priceCents);
    expect(filled.ok).toBe(true);

    // The old page: nothing applied, so the same book prices the same order the same way.
    const stale = previewMarketOrder("BUY", 4, before, cents(await balance(viewer)));
    const refused = await order(viewer, "BUY", { shares: 4 }, stale.priceCents);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("price_moved");
    const moved = Number(refused.extra.fill_price_cents) - stale.priceCents;
    expect(moved).toBeGreaterThanOrEqual(19);
    expect(moved).toBeLessThanOrEqual(21);
    expect(moved).toBeGreaterThan(TOLERANCE);
  });
});

describe("with every answer's book applied", () => {
  let viewer: string;
  let quote: TradeQuote;
  let page: LiveState;

  beforeAll(async () => {
    await resetMarket();
    viewer = await createUser("back-to-back@example.com");
    quote = await serverQuote();
    page = pageFrom(quote);
  });

  it("five back-to-back buys of 4 shares all fill, each at exactly the average previewed, stepping 20¢", async () => {
    const averages: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const preview = previewMarketOrder("BUY", 4, pageBook(page, quote), cents(await balance(viewer)));
      const result = await order(viewer, "BUY", { shares: 4 }, preview.priceCents);
      if (!result.ok) throw new Error(`buy ${i + 1} refused: ${result.code} ${result.message}`);
      expect(result.order.fillPriceCents).toBe(preview.priceCents);
      expect(result.order.grossCents).toBe(preview.grossCents);
      expect(result.quote).not.toBeNull();
      // ScorePanel.onFilled: the fill's quote goes straight into the page.
      page = applyTradeQuote(page, result.quote as TradeQuote, i);
      averages.push(result.order.fillPriceCents);
    }
    const steps = averages.slice(1).map((average, index) => average - averages[index]);
    for (const step of steps) expect(Math.abs(step - 20)).toBeLessThanOrEqual(1);
  });

  it("and five back-to-back sells back down, the same way", async () => {
    for (let i = 0; i < 5; i += 1) {
      const preview = previewMarketOrder("SELL", 4, pageBook(page, quote), cents(await balance(viewer)));
      const result = await order(viewer, "SELL", { shares: 4 }, preview.priceCents);
      if (!result.ok) throw new Error(`sell ${i + 1} refused: ${result.code} ${result.message}`);
      expect(result.order.fillPriceCents).toBe(preview.priceCents);
      expect(result.order.grossCents).toBe(preview.grossCents);
      page = applyTradeQuote(page, result.quote as TradeQuote, 10 + i);
    }
    expect(page.inventoryUnits).toBe(0);
  });

  it("a poll sent before a fill was applied does not put the old inventory back; one sent after is taken whole", async () => {
    const beforeFill = await serverQuote();
    const preview = previewMarketOrder("BUY", 4, pageBook(page, quote), cents(await balance(viewer)));
    const result = await order(viewer, "BUY", { shares: 4 }, preview.priceCents);
    if (!result.ok) throw new Error(result.code);
    page = applyTradeQuote(page, result.quote as TradeQuote, 20);
    const stalePoll = { score: beforeFill.score, spread: beforeFill.spread, premiumCents: beforeFill.premiumCents, marketPrice: beforeFill.marketPrice, inventoryUnits: beforeFill.inventoryUnits ?? 0, ticks: [] };
    expect(mergeLiveResponse(page, stalePoll, { now: 21, bookIsCurrent: false })).toBe(page);

    const after = await serverQuote();
    const freshPoll = { score: after.score, spread: after.spread, premiumCents: after.premiumCents, marketPrice: after.marketPrice, inventoryUnits: after.inventoryUnits ?? 0, ticks: [] };
    const merged = mergeLiveResponse(page, freshPoll, { now: 22, bookIsCurrent: true });
    expect(merged.inventoryUnits).toBe(after.inventoryUnits);
    // And the next order, priced on it, fills.
    const next = previewMarketOrder("BUY", 4, pageBook(merged, quote), cents(await balance(viewer)));
    expect((await order(viewer, "BUY", { shares: 4 }, next.priceCents)).ok).toBe(true);
  });
});

describe("a refusal, then one tap", () => {
  it("Shares: the refusal's book prices the order at the server's average, and one tap at that average fills", async () => {
    await resetMarket();
    const viewer = await createUser("one-tap@example.com");
    const other = await createUser("other-trader@example.com");
    const quote = await serverQuote();
    const page = pageFrom(quote);

    // The viewer reviews; another trader's 4 shares land before the confirm: a genuine move.
    const reviewed = previewMarketOrder("BUY", 4, pageBook(page, quote), cents(await balance(viewer)));
    const theirs = previewMarketOrder("BUY", 4, pageBook(page, quote), cents(await balance(other)));
    expect((await order(other, "BUY", { shares: 4 }, theirs.priceCents)).ok).toBe(true);

    const refused = await order(viewer, "BUY", { shares: 4 }, reviewed.priceCents);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.code).toBe("price_moved");
    const serverAverage = cents(Number(refused.extra.fill_price_cents));
    expect(refused.extra.quoted_price_cents).toBe(reviewed.priceCents);

    // The sheet prices on the refusal's book at once: "Change order" and the summary beside the one-tap agree with the server.
    expect(refused.quote).not.toBeNull();
    const served = refused.quote as TradeQuote;
    const repriced = previewMarketOrder("BUY", 4, served, cents(await balance(viewer)));
    expect(repriced.priceCents).toBe(serverAverage);

    // One tap: the same order at the server's average.
    const filled = await order(viewer, "BUY", { shares: 4 }, serverAverage);
    if (!filled.ok) throw new Error(`one tap refused: ${filled.code}`);
    expect(filled.order.fillPriceCents).toBe(serverAverage);
    expect(filled.order.grossCents).toBe(repriced.grossCents);
  });

  it("Dollars: the same order — the same amount — at the server's average fills, for the quantity the server resolved", async () => {
    await resetMarket();
    const viewer = await createUser("one-tap-dollars@example.com");
    const other = await createUser("other-dollars@example.com");
    const quote = await serverQuote();
    const book = pageBook(pageFrom(quote), quote);
    const spend = cents(20_000); // about 2.9 shares: under the 4-share maximum at this depth

    const reviewed = previewMarketSpend("BUY", spend, book, cents(await balance(viewer)));
    expect((await order(other, "BUY", { shares: 4 }, previewMarketOrder("BUY", 4, book, cents(await balance(other))).priceCents)).ok).toBe(true);

    const refused = await order(viewer, "BUY", { spendCents: spend }, reviewed.priceCents);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.code).toBe("price_moved");
    const repriced = previewMarketSpend("BUY", spend, refused.quote as TradeQuote, cents(await balance(viewer)));
    expect(repriced.priceCents).toBe(Number(refused.extra.fill_price_cents));
    expect(repriced.units).toBe(Number(refused.extra.units));

    const filled = await order(viewer, "BUY", { spendCents: spend }, cents(Number(refused.extra.fill_price_cents)));
    if (!filled.ok) throw new Error(`one tap refused: ${filled.code}`);
    expect(filled.order.fillPriceCents).toBe(Number(refused.extra.fill_price_cents));
    expect(filled.order.grossCents).toBeLessThanOrEqual(spend);
  });
});

describe("decay between review and confirm", () => {
  async function decayOneTick(tick: number): Promise<void> {
    await database.rows("select public.apply_market_decay(now(), $1)", [tick]);
  }

  it("a tick's decay moves a 4-share average by a cent or two at most, inside the tolerance: the reviewed price still fills", async () => {
    // A heavy book, half way to the cap, where decay is largest in cents.
    await resetMarket(80_000);
    const viewer = await createUser("decay@example.com");
    const quote = await serverQuote();
    const page = pageFrom(quote);
    const reviewed = previewMarketOrder("BUY", 4, pageBook(page, quote), cents(await balance(viewer)));

    await decayOneTick(9_001);
    const after = await serverQuote();
    expect(after.inventoryUnits).toBeLessThan(80_000);

    const filled = await order(viewer, "BUY", { shares: 4 }, reviewed.priceCents);
    if (!filled.ok) throw new Error(`refused after decay: ${filled.code}`);
    expect(reviewed.priceCents - filled.order.fillPriceCents).toBeGreaterThanOrEqual(0);
    expect(reviewed.priceCents - filled.order.fillPriceCents).toBeLessThanOrEqual(2);
  });

  it("at the premium cap, where one step of decay is largest, a sell reviewed before the tick still fills inside the tolerance", async () => {
    const cap = capInventoryUnits(800, DEPTH);
    await resetMarket(cap);
    const viewer = await createUser("decay-cap@example.com");
    const quote = await serverQuote();
    // Something to sell: a lot bought just under the cap, then the market put back at it.
    await resetMarket(cap - 4_000);
    const bought = await order(viewer, "BUY", { shares: 4 }, previewMarketOrder("BUY", 4, await serverQuote(), cents(await balance(viewer))).priceCents);
    expect(bought.ok).toBe(true);
    await resetMarket(cap);

    const page = pageFrom(await serverQuote());
    const reviewed = previewMarketOrder("SELL", 4, pageBook(page, quote), cents(await balance(viewer)));
    await decayOneTick(9_002);
    const filled = await order(viewer, "SELL", { shares: 4 }, reviewed.priceCents);
    if (!filled.ok) throw new Error(`refused after decay: ${filled.code}`);
    const drift = reviewed.priceCents - filled.order.fillPriceCents;
    expect(drift).toBeGreaterThanOrEqual(0);
    expect(drift).toBeLessThanOrEqual(2);
    expect(drift).toBeLessThan(TOLERANCE);
  });

  it("and the poll after the tick moves the page's book to the server's, so the confirm step re-arms at exactly the server's average", async () => {
    await resetMarket(60_000);
    const viewer = await createUser("decay-poll@example.com");
    const quote = await serverQuote();
    let page = pageFrom(quote);
    const reviewed = previewMarketOrder("BUY", 4, pageBook(page, quote), cents(await balance(viewer)));

    await decayOneTick(9_003);
    const after = await serverQuote();
    page = mergeLiveResponse(
      page,
      { score: after.score, spread: after.spread, premiumCents: after.premiumCents, marketPrice: after.marketPrice, inventoryUnits: after.inventoryUnits ?? 0, ticks: [] },
      { now: 1, bookIsCurrent: true },
    );
    // An inventory-only change still reaches the page (before Phase 29e it was dropped).
    expect(page.inventoryUnits).toBe(after.inventoryUnits);
    const rearmed = previewMarketOrder("BUY", 4, pageBook(page, quote), cents(await balance(viewer)));
    const filled = await order(viewer, "BUY", { shares: 4 }, rearmed.priceCents);
    if (!filled.ok) throw new Error(filled.code);
    expect(filled.order.fillPriceCents).toBe(rearmed.priceCents);
    expect(rearmed.priceCents).toBeLessThanOrEqual(reviewed.priceCents);
  });
});
