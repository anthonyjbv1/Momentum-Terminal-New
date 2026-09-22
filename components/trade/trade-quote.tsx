import type { Cents } from "@/lib/trading/model";

import { pointsText } from "./money";

/**
 * THE INSIDE OF A BUY/SELL PILL: the verb and the quote it trades at.
 *
 * One component, on purpose. This markup existed twice — once in the profile
 * trade bar and once on Portfolio's Sell buttons — and two copies of one
 * control is how they drift apart. Every pill on the platform reads from
 * here, so a change to the quote's typography lands on all of them at once.
 *
 * WHAT PHASE 25 CHANGED, AND WHAT IT DID NOT. The quote was monospaced at
 * `text-xs` beside an Inter label at the button's own size: two typefaces and
 * two sizes in a two-word control. It is now Inter at the label's size and
 * weight, with `tabular-nums` so a quote that moves on the Engine's cadence
 * still cannot shift the pill's width. The pill's colour, shape, height,
 * padding, gap and behaviour are untouched — `Button` owns all of those and
 * this component sets none of them.
 *
 * The pill does get WIDER, because Inter's digits at the label's size are
 * wider than mono's at `text-xs`. That is the consequence of matching them,
 * not a spacing change: `Button` is `whitespace-nowrap` with fixed padding,
 * so it sizes to its content.
 */
export function TradeQuote({ label, cents }: { label: string; cents: Cents }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{label}</span>
      {/* No size or weight of its own: it inherits the button's, which is the
          point — the two words should read as one line. */}
      <span className="tabular-nums">{pointsText(cents)}</span>
    </span>
  );
}
