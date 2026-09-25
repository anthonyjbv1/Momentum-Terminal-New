import { formatCents } from "@/lib/money";

import type { OrderSide } from "./direction";
import { UNITS_PER_SHARE, sharesLabel, sharesText, type Cents, type FilledOrder, type OrderPreview, type TradeBook } from "./model";

/**
 * EVERY SENTENCE IN THE TRADE SHEET THAT STATES A PRICE (Phase 29b), in one
 * place, as plain functions of the numbers the sheet shows beside them.
 *
 * Phase 29 said "Each quote is the first share's price", and it was not: the
 * quote is the market price ± half the spread, with the premium truncated to
 * the cent, while the curve prices the first thousandth of a share from the
 * exact inventory — so "Buy at $73.40" sat beside "first share $73.41". A
 * quote is THE PRICE BEFORE YOUR ORDER, and that is what every sentence here
 * now calls it. Keeping the sentences here, rather than inline in JSX, is
 * what lets lib/trading/sheet-copy.test.ts read each one back and hold it to
 * the figures it sits next to, over thousands of books and orders.
 */

export function verb(side: OrderSide, tense: "base" | "past" | "ing" = "base"): string {
  if (side === "BUY") return tense === "past" ? "Bought" : tense === "ing" ? "Buying" : "Buy";
  return tense === "past" ? "Sold" : tense === "ing" ? "Selling" : "Sell";
}

/** The side's quote: what the pill and the quote cell show — the price before your order. */
export function quoteBefore(book: Pick<TradeBook, "buyCents" | "sellCents">, side: OrderSide): Cents {
  return side === "BUY" ? book.buyCents : book.sellCents;
}

/** Whether the order walks the curve far enough for its last share to price differently from its average. */
export function walks(preview: Pick<OrderPreview, "units" | "priceCents" | "worstCents">, curved: boolean): boolean {
  return curved && preview.units > 0 && preview.worstCents !== preview.priceCents;
}

/** Whether shares × price is exactly the total, to the cent — the only case "=" is honest. */
function exactProduct(units: number, priceCents: number, grossCents: number): boolean {
  return units * priceCents === grossCents * UNITS_PER_SHARE;
}

/**
 * Under the two quote cells: the spread, and what a quote is. Two lines at
 * 375px. On a flat market there is no curve, so no second sentence.
 */
export function spreadNote(book: Pick<TradeBook, "buyCents" | "sellCents">, curved: boolean): string {
  const spread = `The ${formatCents(book.buyCents - book.sellCents)} between Buy and Sell is the platform’s spread.`;
  return curved ? `${spread} Each quote is the price before your order.` : spread;
}

/** Dollars mode, under the field: what the amount buys, and at what price. */
export function dollarsLine(side: OrderSide, spendCents: Cents, preview: OrderPreview, curved: boolean): string {
  const at = `${formatCents(spendCents)} ${side === "BUY" ? "buys" : "sells"} ${sharesLabel(preview.shares)} at ${walks(preview, curved) ? "an average of " : ""}${formatCents(preview.priceCents)}`;
  const left = side === "BUY" && preview.grossCents < spendCents ? ` · ${formatCents(spendCents - preview.grossCents)} stays in your balance` : "";
  return `${at}${left}`;
}

/** The confirm step's headline. */
export function confirmHeadline(side: OrderSide, preview: OrderPreview, personName: string, curved: boolean): string {
  return `${verb(side)} ${sharesLabel(preview.shares)} of ${personName} at ${walks(preview, curved) ? "an average of " : ""}${formatCents(preview.priceCents)} each.`;
}

/**
 * The line under it. On a walk: the price before the order, the last share
 * and the total. Otherwise the multiplication — "=" only when it is exact to
 * the cent, "≈" when the rounding rule settled the last fraction of a cent.
 */
export function confirmBreakdown(side: OrderSide, preview: OrderPreview, book: Pick<TradeBook, "buyCents" | "sellCents">, curved: boolean): string {
  if (walks(preview, curved)) {
    return `Before your order ${formatCents(quoteBefore(book, side))} · last share ${formatCents(preview.worstCents)} · total ${formatCents(preview.grossCents)}`;
  }
  const sign = exactProduct(preview.units, preview.priceCents, preview.grossCents) ? "=" : "≈";
  return `${sharesText(preview.shares)} × ${formatCents(preview.priceCents)} ${sign} ${formatCents(preview.grossCents)}`;
}

/** The small print on the confirm step: what the button's price is, and the band it is held to. */
export function toleranceNote(side: OrderSide, curved: boolean, toleranceCents: Cents): string {
  return `The ${curved ? "average fill" : `${side === "BUY" ? "Buy" : "Sell"} quote`} as of now. If it moves more than ${formatCents(toleranceCents)} before the server reads it, you will be asked to confirm again.`;
}

/** The labels down the preview list, for the rows that carry a price. */
export const PREVIEW_LABELS = {
  price: "Price per share",
  average: "Average price per share",
  lastShare: "Last share",
  cost: "Cost",
  proceeds: "Proceeds",
  balanceAfter: "Paper balance after",
} as const;

/** After a fill: the headline, in the server's numbers. */
export function filledHeadline(side: OrderSide, order: Pick<FilledOrder, "units" | "fillPriceCents" | "worstFillCents">, personName: string): string {
  const walked = order.worstFillCents !== order.fillPriceCents;
  return `${verb(side, "past")} ${sharesLabel(order.units)} of ${personName} at ${walked ? "an average of " : ""}${formatCents(order.fillPriceCents)} each.`;
}

/** After a fill: where the walk began and ended, as the server read it. */
export function filledDetail(side: OrderSide, order: Pick<FilledOrder, "fillPriceCents" | "worstFillCents" | "baseCents" | "premiumBeforeCents">): string {
  if (order.worstFillCents === order.fillPriceCents) return `Filled at the ${side === "BUY" ? "Buy" : "Sell"} quote the server read as it received the order.`;
  return `Filled along the market’s price as the server read it: before your order ${formatCents(order.baseCents + order.premiumBeforeCents)}, last share ${formatCents(order.worstFillCents)}.`;
}
