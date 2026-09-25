import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmSummary, FilledView, PreviewList, QuoteBlock } from "@/components/trade/trade-sheet";

import type { OrderSide } from "./direction";
import { EMPTY_POSITION, UNITS_PER_SHARE, bookFromMarket, bookSide, cents, previewMarketOrder, previewMarketSpend, sharesText, type OrderPreview, type TradeBook } from "./model";
import { PREVIEW_LABELS, confirmBreakdown, confirmHeadline, dollarsLine, filledDetail, filledHeadline, quoteBefore, spreadNote, toleranceNote, walks } from "./sheet-copy";

/**
 * EVERY SENTENCE IN THE TRADE SHEET THAT STATES A PRICE AGREES WITH THE
 * NUMBERS BESIDE IT (Phase 29b).
 *
 * The defect: "Each quote is the first share's price" under "Buy at $73.40"
 * while the confirm step said "First share $73.41". Both figures were right —
 * the quote carries the premium truncated to the cent, the curve's first
 * thousandth of a share does not — and the sentence joining them was wrong.
 *
 * Every dollar figure in every sentence is read back out of the text and
 * compared with the figure it describes, over thousands of seeded random
 * books (flat and curved, inventory either side of zero) and orders (both
 * sides, both modes). The one inequality that is only true to a cent is the
 * quote against the average: the quote's premium is truncated toward zero,
 * so a tiny order can average one cent the other side of it. That is stated,
 * and it is exactly why the quote is called "the price before your order"
 * rather than the first share's price.
 */

const SEEDS = 3_000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

/** Every "$1,234.56" in a sentence, in order, as integer cents. */
function dollars(text: string): number[] {
  return [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map((match) => Math.round(Number(match[1].replace(/,/g, "")) * 100));
}

/**
 * A book the market could actually be in: a score in the board's range, the
 * premium inside the tiers' caps (±8 points), and — in randomShares — an
 * order no larger than the largest the tiers accept (a fifth of the depth).
 */
function randomBook(random: () => number): { book: TradeBook; curved: boolean } {
  const score = Math.round((20 + random() * 75) * 10_000) / 10_000;
  const spread = pick(random, [0.25, 0.5, 1]);
  const depthUnits = pick(random, [null, 100_000, 300_000, 50_000 + Math.floor(random() * 500_000)]);
  // Inventory either side of zero, up to ±6 points of premium.
  const inventoryUnits = depthUnits === null ? 0 : Math.round((random() * 2 - 1) * depthUnits * 6);
  const premiumCents = depthUnits === null ? 0 : Math.trunc((inventoryUnits * 100) / depthUnits);
  const book = bookFromMarket({ score, spread, premiumCents, inventoryUnits, depthUnits, premiumCapCents: 800 });
  return { book, curved: book.depthUnits !== null && book.inventoryUnits !== null };
}

function randomShares(random: () => number, book: TradeBook): number {
  const largest = book.depthUnits === null ? 300_000 : Math.floor(book.depthUnits / 5);
  const kind = random();
  if (kind < 0.2) return (1 + Math.floor(random() * 999)) / UNITS_PER_SHARE; // under a share
  return Math.max(1, Math.floor(random() * largest)) / UNITS_PER_SHARE;
}

/** The inequalities a sentence's figures must satisfy against each other. */
function expectOrdered(side: OrderSide, before: number, average: number, last: number) {
  if (side === "BUY") {
    expect(average).toBeGreaterThanOrEqual(before - 1);
    expect(average).toBeLessThanOrEqual(last);
  } else {
    expect(average).toBeLessThanOrEqual(before + 1);
    expect(average).toBeGreaterThanOrEqual(last);
  }
}

/** units × average is the total to within the average's half-cent rounding per share and the final cent. */
function expectTotalMatchesAverage(preview: OrderPreview) {
  const drift = Math.abs(preview.units * preview.priceCents - preview.grossCents * UNITS_PER_SHARE);
  expect(drift).toBeLessThanOrEqual(preview.units / 2 + UNITS_PER_SHARE);
}

describe("the sheet's price sentences agree with the figures beside them", () => {
  it("the spread note names Buy − Sell, and calls the quote the price before your order", () => {
    const random = rng(1);
    for (let i = 0; i < SEEDS; i += 1) {
      const { book, curved } = randomBook(random);
      const note = spreadNote(book, curved);
      expect(dollars(note)).toEqual([book.buyCents - book.sellCents]);
      expect(note).not.toMatch(/first share/i);
      if (curved) expect(note).toContain("Each quote is the price before your order.");
    }
  });

  it("the confirm headline and breakdown: the average, the price before the order, the last share and the total", () => {
    const random = rng(2);
    for (let i = 0; i < SEEDS; i += 1) {
      const { book, curved } = randomBook(random);
      const side = pick(random, ["BUY", "SELL"] as const);
      const preview = previewMarketOrder(side, randomShares(random, book), book, cents(1_000_000_000));
      if (preview.units <= 0) continue;
      const context = `seed ${i} ${side} ${preview.units}u on ${JSON.stringify(book)}`;

      const headline = confirmHeadline(side, preview, "MrBeast", curved);
      expect(dollars(headline), context).toEqual([preview.priceCents]);
      expect(headline.includes("an average of"), context).toBe(walks(preview, curved));
      expect(headline).toContain(sharesText(preview.shares));

      const breakdown = confirmBreakdown(side, preview, book, curved);
      if (walks(preview, curved)) {
        const [before, last, total] = dollars(breakdown);
        expect(before, context).toBe(quoteBefore(book, side));
        expect(last, context).toBe(preview.worstCents);
        expect(total, context).toBe(preview.grossCents);
        expect(breakdown).toMatch(/^Before your order \$.* · last share \$.* · total \$/);
        expectOrdered(side, before, preview.priceCents, last);
      } else {
        const [price, total] = dollars(breakdown);
        expect(price, context).toBe(preview.priceCents);
        expect(total, context).toBe(preview.grossCents);
        expect(breakdown.startsWith(`${sharesText(preview.shares)} × `)).toBe(true);
        // "=" only when shares × price is the total to the cent.
        const exact = preview.units * preview.priceCents === preview.grossCents * UNITS_PER_SHARE;
        expect(breakdown.includes(" = "), context).toBe(exact);
        expect(breakdown.includes(" ≈ "), context).toBe(!exact);
      }
      expectTotalMatchesAverage(preview);
      expect(breakdown).not.toMatch(/first share/i);
    }
  });

  it("the Dollars line: the amount, the average, and what stays in the balance", () => {
    const random = rng(3);
    for (let i = 0; i < SEEDS; i += 1) {
      const { book, curved } = randomBook(random);
      const side = pick(random, ["BUY", "SELL"] as const);
      const spend = cents(100 + Math.floor(random() * 500_000));
      const preview = previewMarketSpend(side, spend, book, cents(1_000_000_000));
      // Larger than any tier accepts: the server refuses it before pricing a sentence.
      if (preview.units <= 0 || (book.depthUnits !== null && preview.units > book.depthUnits / 5)) continue;
      const line = dollarsLine(side, spend, preview, curved);
      const figures = dollars(line);
      expect(figures[0]).toBe(spend);
      expect(figures[1]).toBe(preview.priceCents);
      if (side === "BUY") {
        expect(preview.grossCents).toBeLessThanOrEqual(spend);
        expect(figures.slice(2)).toEqual(preview.grossCents < spend ? [spend - preview.grossCents] : []);
      } else {
        expect(figures).toHaveLength(2);
      }
      expect(line.includes("an average of")).toBe(walks(preview, curved));
      expectTotalMatchesAverage(preview);
    }
  });

  it("after the fill: the server's average, and where its walk began and ended", () => {
    const random = rng(4);
    for (let i = 0; i < SEEDS; i += 1) {
      const { book } = randomBook(random);
      const side = pick(random, ["BUY", "SELL"] as const);
      const preview = previewMarketOrder(side, randomShares(random, book), book, cents(1_000_000_000));
      if (preview.units <= 0) continue;
      // The order place_order() returns for this preview: its base (premium excluded) and the premium before.
      const flat = book.depthUnits === null;
      const order = {
        units: preview.shares,
        fillPriceCents: preview.priceCents,
        worstFillCents: preview.worstCents,
        baseCents: cents(bookSide(book, side).baseCents),
        premiumBeforeCents: flat ? 0 : book.premiumCents,
      };
      expect(dollars(filledHeadline(side, order, "MrBeast"))).toEqual([preview.priceCents]);
      const detail = filledDetail(side, order);
      if (order.worstFillCents === order.fillPriceCents) {
        expect(dollars(detail)).toEqual([]);
      } else {
        const [before, last] = dollars(detail);
        expect(before).toBe(quoteBefore(book, side));
        expect(last).toBe(preview.worstCents);
      }
      expect(detail).not.toMatch(/first share/i);
    }
  });

  it("a Dollars-mode Sell larger than any sell could return does not throw: the search stops at the peak (Phase 29b)", () => {
    const book = bookFromMarket({ score: 68.87, spread: 0.5, premiumCents: 403, inventoryUnits: 1_210_000, depthUnits: 300_000, premiumCapCents: 800 });
    for (const amount of [1_000_000, 50_000_000, 999_999_999]) {
      const preview = previewMarketSpend("SELL", cents(amount), book, cents(0));
      expect(preview.units).toBeGreaterThan(0);
      expect(preview.grossCents).toBeLessThanOrEqual(amount);
      expect(preview.worstCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("the tolerance note names the band", () => {
    expect(dollars(toleranceNote("BUY", true, cents(10)))).toEqual([10]);
    expect(toleranceNote("SELL", false, cents(25))).toContain("Sell quote");
  });
});

describe("the rendered sheet says the same", () => {
  // A curved book with a truncated premium: the case the old sentence got wrong.
  const book = bookFromMarket({ score: 68.87, spread: 0.5, premiumCents: 403, inventoryUnits: 1_210_000, depthUnits: 300_000, premiumCapCents: 800 });
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&rsquo;|’/g, "’").replace(/\s+/g, " ").trim();

  it("QuoteBlock: the quotes, and the note under them", () => {
    const html = text(renderToStaticMarkup(createElement(QuoteBlock, { side: "BUY", book, marketPrice: 72.9, curved: true })));
    expect(html).toContain("$73.40");
    expect(html).toContain(spreadNote(book, true));
    expect(html).not.toMatch(/first share/i);
    // Display-only: no market price line.
    const scoreOnly = text(renderToStaticMarkup(createElement(QuoteBlock, { side: "SELL", book, marketPrice: 72.9, curved: true, scoreOnly: true })));
    expect(scoreOnly).not.toContain("Market price");
  });

  it("ConfirmSummary and PreviewList: the same average, last share and total in the sentence and in the rows", () => {
    const preview = previewMarketOrder("BUY", 60, book, cents(1_000_000));
    expect(walks(preview, true)).toBe(true);
    const summary = text(renderToStaticMarkup(createElement(ConfirmSummary, { side: "BUY", preview, book, curved: true, personName: "MrBeast", spendCents: null, toleranceCents: cents(10) })));
    expect(summary).toContain(confirmHeadline("BUY", preview, "MrBeast", true));
    expect(summary).toContain(confirmBreakdown("BUY", preview, book, true));

    const list = text(renderToStaticMarkup(createElement(PreviewList, { side: "BUY", preview, book, curved: true, position: { personId: "p", ...EMPTY_POSITION } })));
    const row = (label: string) => {
      const at = list.indexOf(label);
      expect(at, label).toBeGreaterThanOrEqual(0);
      return dollars(list.slice(at + label.length))[0];
    };
    expect(row(PREVIEW_LABELS.average)).toBe(preview.priceCents);
    expect(row(PREVIEW_LABELS.lastShare)).toBe(preview.worstCents);
    expect(row(PREVIEW_LABELS.cost)).toBe(preview.grossCents);
    expect(row(PREVIEW_LABELS.balanceAfter)).toBe(1_000_000 - preview.grossCents);
    expect(list).not.toMatch(/worst fill/);
    // The sentence's figures are the rows' figures.
    expect(dollars(confirmBreakdown("BUY", preview, book, true))).toEqual([book.buyCents, row(PREVIEW_LABELS.lastShare), row(PREVIEW_LABELS.cost)]);
  });

  it("FilledView on a display-only index shows no market price", () => {
    const result = {
      ok: true as const,
      order: {
        id: "o",
        personId: "p",
        side: "SELL" as const,
        units: 1,
        fillPriceCents: cents(6837),
        grossCents: cents(6837),
        openedUnits: 0,
        openedDirection: null,
        positionId: null,
        costCents: cents(0),
        closedUnits: 1,
        proceedsCents: cents(6837),
        realizedPnlCents: cents(12),
        fills: [],
        createdAt: null,
        baseCents: cents(6837),
        worstFillCents: cents(6837),
        impactCents: 0,
        premiumBeforeCents: 0,
        premiumAfterCents: 0,
      },
      balanceCents: cents(1_000_000),
      position: { personId: "p", ...EMPTY_POSITION },
      quote: null,
    };
    const html = text(renderToStaticMarkup(createElement(FilledView, { result, side: "SELL", personName: "Anthony Baptiste", scoreOnly: true })));
    expect(html).toContain("Sold 1 share of Anthony Baptiste at $68.37 each.");
    expect(html).not.toContain("Market price");
  });

  it("no sentence in the sheet's source calls a quote the first share's price", () => {
    const source = readFileSync(join(__dirname, "..", "..", "components", "trade", "trade-sheet.tsx"), "utf8");
    expect(source).not.toMatch(/first share[’']s price|First share \{/);
    expect(source).not.toMatch(/Last share fills at/);
  });
});
