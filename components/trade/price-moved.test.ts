import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cents, type OrderResult } from "@/lib/trading/model";
import { priceMovedBody, requoteLabel } from "@/lib/trading/sheet-copy";

import { RejectedView } from "./trade-sheet";

/**
 * "THE PRICE MOVED" (Phase 29e): one heading, one sentence, one action.
 *
 * The refusal used to say "The price moved" twice (the heading, then the
 * server's own message beginning with the same words), and its way out — a
 * "Review at $X" button in the scrolling body, under the pinned footer on a
 * short window — sent the reader back to a confirm step that priced the order
 * on the same stale book and sent the same stale price. Now the body says what
 * moved and the footer carries the action: "Buy at $70.41", the server's own
 * new average, confirmed in one tap. back-to-back.db.test.ts proves the tap
 * fills; this file holds the words and where the action lives.
 */

const sheet = readFileSync(join(__dirname, "trade-sheet.tsx"), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "’").replace(/\s+/g, " ").trim();

const refusal = (side: "BUY" | "SELL", fill: number, quoted: number): Extract<OrderResult, { ok: false }> => ({
  ok: false,
  code: "price_moved",
  message: `The price moved. ${side === "BUY" ? "Buy" : "Sell"} now fills at an average of $${(fill / 100).toFixed(2)} per share, not $${(quoted / 100).toFixed(2)}.`,
  quote: null,
  extra: { fill_price_cents: fill, quoted_price_cents: quoted, units: 4000 },
});

describe("the words", () => {
  it("the body is the sentence asked for, to the character", () => {
    expect(priceMovedBody("BUY", cents(7041), cents(7021))).toBe("Buy now fills at an average of $70.41 a share, not $70.21. Nothing was placed.");
    expect(priceMovedBody("SELL", cents(6921), cents(6941))).toBe("Sell now fills at an average of $69.21 a share, not $69.41. Nothing was placed.");
  });

  it("the action names the side and the server's new average", () => {
    expect(requoteLabel("BUY", cents(7041))).toBe("Buy at $70.41");
    expect(requoteLabel("SELL", cents(6921))).toBe("Sell at $69.21");
  });
});

describe("the refused view", () => {
  it("says 'The price moved' once, then the sentence, and carries no button of its own", () => {
    const summary = createElement("dl", null, "summary");
    const html = renderToStaticMarkup(createElement(RejectedView, { result: refusal("BUY", 7041, 7021), side: "BUY", requoteCents: cents(7041), summary, onShares: () => {} }));
    const words = text(html);
    expect(words.match(/The price moved/g)).toHaveLength(1);
    expect(words).toContain("Buy now fills at an average of $70.41 a share, not $70.21. Nothing was placed.");
    // Nothing was placed is said once, inside the sentence.
    expect(words.match(/Nothing was placed/g)).toHaveLength(1);
    // The action is the footer's; the body has none.
    expect(html).not.toContain("<button");
    // Beside the sentence: the summary of the order the one tap sends.
    expect(words).toContain("summary");
  });

  it("any other refusal keeps the server's sentence and its own 'Nothing was placed.'", () => {
    const result: Extract<OrderResult, { ok: false }> = { ok: false, code: "daily_limit", message: "You have reached today’s limit.", quote: null, extra: {} };
    const words = text(renderToStaticMarkup(createElement(RejectedView, { result, side: "BUY", requoteCents: null, summary: null, onShares: () => {} })));
    expect(words).toContain("Daily limit reached");
    expect(words).toContain("You have reached today’s limit.");
    expect(words).toContain("Nothing was placed.");
  });
});

describe("where the action lives", () => {
  const footerStart = sheet.indexOf("const footer = ((): React.ReactNode => {");
  const footerEnd = sheet.indexOf("})();", footerStart);
  const footer = sheet.slice(footerStart, footerEnd);

  it("the one-tap re-confirm is in the pinned footer, and sends the server's average, not the preview's", () => {
    expect(footerStart).toBeGreaterThan(0);
    expect(sheet.match(/requoteLabel\(/g)).toHaveLength(1);
    expect(footer).toContain("requoteLabel(side, requote)");
    expect(footer).toContain("submit(requote)");
    // requote is the refusal's fill_price_cents.
    expect(sheet).toMatch(/result\.code === "price_moved" && typeof result\.extra\.fill_price_cents === "number"[^;]*\? cents\(result\.extra\.fill_price_cents\)/);
  });

  it("offers Change order beside it, and nothing else: no in-body re-quote, no 'Review at'", () => {
    const branch = footer.slice(footer.indexOf("requote !== null"), footer.indexOf("if (step === \"result\" && result && !result.ok)"));
    expect(branch.match(/<Button/g)).toHaveLength(2);
    expect(branch).toContain("Change order");
    expect(branch).toContain("onClick={reopenCompose}");
    expect(sheet).not.toContain("Review at");
    expect(sheet).not.toContain("onRequote");
  });

  it("a refusal's quote becomes the book the sheet prices on, and goes to the page", () => {
    const submit = sheet.slice(sheet.indexOf("const submit = async"), sheet.indexOf("// A price_moved refusal's one action"));
    expect(submit).toContain("setServed(outcome.quote)");
    expect(submit).toContain("onQuote?.(outcome.quote)");
    expect(sheet).toContain("const book: TradeBook = served ?? pageBook;");
  });
});

describe("the page applies every answer's book", () => {
  const panel = readFileSync(join(__dirname, "..", "person", "score-panel.tsx"), "utf8");

  it("the fill's quote, the refusal's quote, and a fresh read when the sheet opens", () => {
    expect(panel).toContain("if (result.quote) applyQuote(result.quote);");
    expect(panel).toContain("onQuote={applyQuote}");
    expect(panel).toMatch(/const openSheet = useCallback\(\s*\(side: OrderSide\) => \{\s*setSheet\(side\);\s*refresh\(\);/);
    expect(panel).not.toContain("onTrade={setSheet}");
  });

  it("the portfolio's sheet re-reads its summary on a refusal too", () => {
    const portfolio = readFileSync(join(__dirname, "..", "portfolio", "portfolio-view.tsx"), "utf8");
    expect(portfolio).toContain("onQuote={() => void refresh()}");
  });
});
