import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { formatCents } from "@/lib/money";
import { quoteFromScore } from "@/lib/trading/model";

import { Money } from "./money";
import * as moneyModule from "./money";
import { TradeQuote } from "./trade-quote";

/**
 * ONE PRICE, ONE FORMAT, EVERYWHERE YOU TRADE (Phase 26).
 *
 * The defect this pins down: the Buy pill said "Buy 56.7" and the sheet it
 * opened charged $56.64. Same quote, two units, two precisions, one tap
 * apart — so the price appeared to change between deciding and paying.
 *
 * The four places one quote is shown between the tap and the ledger are the
 * PILL, the sheet's QUOTE CELL, the summary's PRICE PER SHARE, and the
 * FILL PRICE the database records. This walks a real quote through all
 * four, the last one through place_order() on a real Postgres with the
 * migrations applied verbatim, and requires them to agree to the cent.
 *
 * The last test is the one that keeps it true: a source scan for a second
 * way to format a price. `pointsText` was deleted in Phase 26 rather than
 * left unused, because a second formatter in reach is how this comes back.
 */

let database: TestDatabase;
const people = new Map<string, string>();

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  await database.rows("update public.platform_settings set close_cooldown_seconds = 0, updated_at = now() where id");
  // A flat market (Phase 29): with the premium off, the one price is the
  // score's price exactly, which is what this proof is about.
  await database.exec("update public.market_tier_settings set pricing_mode = 'flat', min_hold_seconds = 0");
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("one quote, four readings", () => {
  it("the pill, the sheet's price per share and the recorded fill price are the same cent", async () => {
    // A score with real fractions behind it: 56.6449 points at a 0.5 spread
    // is 5714.49 cents before rounding, which is exactly where a second
    // rounding path would drift.
    const score = 56.6449;
    const spread = 0.5;
    const quote = quoteFromScore(score, spread);
    expect(quote.buyCents).toBe(5714);

    // 1. THE PILL. The score panel hands this quote to the trade bar.
    const pill = renderToStaticMarkup(createElement(TradeQuote, { label: "Buy", cents: quote.buyCents }));
    const pillPrice = formatCents(quote.buyCents);
    expect(pill).toContain(pillPrice);
    expect(pill).not.toMatch(/57\.1\b/); // never the points reading

    // 2 + 3. THE SHEET'S QUOTE CELL AND ITS PRICE PER SHARE. Both are the
    // same `cents` prop through the same formatter; Money is what the
    // summary row renders, and the quote cell calls formatCents directly.
    const perShare = renderToStaticMarkup(createElement(Money, { cents: quote.buyCents, face: "text" }));
    expect(perShare).toContain(pillPrice);

    // 4. THE LEDGER. place_order re-reads the quote from the same score and
    // spread the page was showing, and fills at its own reading.
    const slug = [...people.keys()].sort()[0];
    const personId = people.get(slug);
    await database.rows("update public.people set current_score = $1, spread = $2 where id = $3", [score, spread, personId]);
    const [user] = await database.rows<{ id: string }>("insert into auth.users (email) values ('one-price@example.test') returning id");
    await database.actAs(user.id);
    const [row] = await database.rows<{ r: { ok: boolean; order?: { fill_price_cents: number | string } } }>(
      "select public.place_order($1::uuid, 'BUY', 1::bigint, $2::bigint, 'test') as r",
      [personId, quote.buyCents],
    );
    expect(row.r.ok).toBe(true);
    const fillPriceCents = Number(row.r.order?.fill_price_cents);

    // The four values, to the cent.
    expect([pillPrice, formatCents(quote.buyCents), formatCents(quote.buyCents), formatCents(fillPriceCents)]).toEqual([
      "$57.14",
      "$57.14",
      "$57.14",
      "$57.14",
    ]);
    expect(fillPriceCents).toBe(quote.buyCents);
  });

  it("has no second formatter for a tradeable price", async () => {
    expect("pointsText" in moneyModule).toBe(false);

    const { readFileSync } = await import("node:fs");
    const sources = ["components/trade/trade-quote.tsx", "components/trade/trade-sheet.tsx", "components/trade/position-card.tsx", "components/portfolio/positions-list.tsx"];
    for (const file of sources) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      // A price divided by a hundred and printed at one decimal is the
      // points reading; there is no legitimate use of it on a trading
      // surface any more.
      expect(`${file}: ${/\/\s*100\)\.toFixed\(1\)/.test(source)}`).toBe(`${file}: false`);
      expect(`${file}: ${source.includes("pointsText")}`).toBe(`${file}: false`);
    }
  });
});
