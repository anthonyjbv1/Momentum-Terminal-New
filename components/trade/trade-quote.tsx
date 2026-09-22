import { formatCents } from "@/lib/money";
import type { Cents } from "@/lib/trading/model";

/**
 * THE INSIDE OF A BUY/SELL PILL: the verb and the price it trades at.
 *
 * One component, on purpose. This markup existed twice — once in the profile
 * trade bar and once on Portfolio's Sell buttons — and two copies of one
 * control is how they drift apart. Every pill on the platform reads from
 * here, so a change to the quote lands on all of them at once.
 *
 * THE PRICE IS MONEY, NOT POINTS (Phase 26). The pill used to read
 * "Buy 56.7" while the sheet it opens charged $56.64: the same quote, in
 * two units, at two precisions, one tap apart. Someone who taps 56.7 and is
 * then asked to pay $56.64 has watched the price change, and no explanation
 * of points-per-share undoes that. So the rule is flat — a SCORE is points
 * and carries no currency; anything you can TRADE AT is dollars and cents —
 * and this pill renders its price through formatCents, the same function
 * the sheet, its summary and the confirmation use, from the same quote the
 * sheet is handed. There is no second rounding path to drift out of step.
 *
 * TYPOGRAPHY (Phase 25). Inter at the label's own size and weight, with
 * `tabular-nums` so a quote that moves on the Engine's cadence cannot shift
 * the pill's width. The pill's colour, shape, height, padding, gap and
 * behaviour are untouched — `Button` owns all of those and this component
 * sets none of them; the pill sizes to its content, so the longer string
 * simply makes it wider.
 */
export function TradeQuote({ label, cents }: { label: string; cents: Cents }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{label}</span>
      {/* No size or weight of its own: it inherits the button's, which is the
          point — the two words should read as one line. */}
      <span className="tabular-nums">{formatCents(cents)}</span>
    </span>
  );
}
