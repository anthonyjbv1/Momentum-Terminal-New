"use client";

import { Check, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { trackEvent } from "@/lib/behavioral/client";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import { marketLine, type TradingAvailability } from "@/lib/person/profile-model";
import type { OrderSide } from "@/lib/trading/direction";
import {
  PREVIEW_LABELS,
  confirmBreakdown,
  confirmHeadline,
  dollarsLine,
  filledDetail,
  filledHeadline,
  priceMovedBody,
  requoteLabel,
  spreadNote,
  toleranceNote,
  verb,
  walks,
} from "@/lib/trading/sheet-copy";
import {
  MAX_ORDER_SHARES,
  UNITS_PER_SHARE,
  cents,
  parseOrderResponse,
  pointsToCents,
  previewMarketOrder,
  previewMarketSpend,
  sharesLabel,
  sharesText,
  sharesToUnits,
  type Cents,
  type OrderPreview,
  type OrderRejectionCode,
  type OrderResult,
  type PositionSummary,
  type TradeBook,
  type TradeQuote,
} from "@/lib/trading/model";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";

import { Money } from "./money";

/**
 * The trade sheet: compose → confirm → result. A bottom sheet on a phone, a
 * dialog on desktop (the Sheet primitive), always below the banner so the
 * 30-second countdown stays in view.
 *
 * ONE PRICE, ONE FORMAT (Phase 26). Every price in here is rendered through
 * formatCents — the same value through the same function as the Buy/Sell
 * pill that opened the sheet. Scores are points; anything you can trade at
 * is dollars and cents.
 *
 * THE COST CURVE (Phase 29). The quote is THE PRICE BEFORE YOUR ORDER
 * (Phase 29b: it used to be called the price of the first share, which it is
 * not — the premium in the quote is truncated to the cent, the curve's first
 * thousandth of a share is not).
 * An order walks the market's cost curve, so a larger order fills at an
 * AVERAGE a little past the quote and its last share at a worse price still;
 * both are shown before anything is confirmed, and the average is the price
 * the sheet sends and the server's tolerance band is checked against. The
 * premium the order leaves on the market price is shown too. All of it is
 * computed by the same integer arithmetic the server runs
 * (lib/trading/market.ts mirrors the SQL and a test holds them together), so
 * the cost shown is the cost charged. The profile and the portfolio both pass
 * the person's whole book (Phase 29b), so both walk the curve.
 *
 * EVERY SENTENCE THAT STATES A PRICE is built in lib/trading/sheet-copy.ts
 * from the figures it sits beside, and a test holds each one to them.
 *
 * SCORE ONLY (Phase 29b). On a display-only index the sheet shows no market
 * price and no premium line: the quotes a close needs, and nothing else.
 *
 * THE MARKET'S STATES (Phase 29). Halted or paused, the sheet says so and
 * offers only Close. Display-only, a Buy says so; a Sell that closes what is
 * held goes through.
 *
 * TYPOGRAPHY (Phase 26). Inter with tabular figures throughout, the
 * Portfolio rule from Phase 25: the quote boxes, the spread sentence, the
 * quantity field, the chips and every summary value. "2 shares" is a phrase
 * and is set as one. The summary's value column is right-aligned so the
 * decimal points line up down it.
 *
 * THE QUOTE IS LIVE. The score is static for 30 seconds and then moves, the
 * premium moves whenever anyone trades, and a sheet open across either is
 * the expected case. The price shown here is the page's live book:
 *   compose  the figures simply update, and the price flashes once, the
 *            way the score does;
 *   confirm  the button always carries the average it will send. If that
 *            moves off the one the user reviewed, a notice names both and
 *            the button re-arms as "Confirm at the new price". Nothing is
 *            ever sent that the user has not just seen.
 * The server holds the last word: it fills along ITS curve, and if the
 * average sits more than the tolerance from the price sent, it refuses and
 * returns the new quote.
 *
 * THE BOOK AFTER AN ORDER (Phase 29e). Every answer from place_order() — a
 * fill or a refusal — carries the book as the server read it, and that book
 * is the one the next preview is priced on: the page applies it (onFilled,
 * onQuote) and, until the page's own book moves past it, the sheet holds it
 * itself. Before, a fill left the page's book where it was until the next
 * tick, so at MrBeast's demo depth every back-to-back order was priced 20¢
 * short and refused, and the refusal's re-quote sent the same stale price
 * again. A price_moved refusal now offers one action in the pinned footer —
 * "Buy at $70.41", the server's own new average, confirmed in one tap — and
 * "Change order" goes back to compose on the fresh book.
 *
 * WIDE SCREENS (Phase 29e). From `lg` up the sheet is two columns under one
 * pinned footer: the order on the left (quotes, market line, Shares|Dollars,
 * the field and its chips), its summary on the right (average, last share,
 * cost, balance and position after). The quote boxes shrink to one short row
 * and the footer's actions sit under the summary. Below `lg` nothing moves:
 * the columns stack in the phone's order with the phone's spacing.
 *
 * Nothing here computes money the server will trust. Previews are integer
 * cents from the same rules, for reading only.
 */

export interface TradeSheetPerson {
  id: string;
  slug: string;
  displayName: string;
}

export interface TradeSheetProps {
  open: boolean;
  side: OrderSide;
  person: TradeSheetPerson;
  /** The live book from the score panel: quotes, base prices, inventory and depth. */
  book: TradeBook;
  /** The market price in points (score + premium), for the line under the quotes. */
  marketPrice: number;
  /**
   * A display-only index (Phase 29b): the score is the only number shown, so
   * the sheet leaves out the market price and the premium lines. Closing works
   * exactly as before.
   */
  scoreOnly?: boolean;
  /** Whether the market is open right now, and if not, why. */
  availability: TradingAvailability;
  balanceCents: Cents;
  position: PositionSummary;
  shortingEnabled: boolean;
  toleranceCents: Cents;
  /** platform_settings.min_order_cents, read on the server. */
  minOrderCents: Cents;
  loggingEnabled: boolean;
  surface: string;
  onClose: () => void;
  onFilled: (result: Extract<OrderResult, { ok: true }>) => void;
  /**
   * A refusal's quote: the book place_order() read (Phase 29e). The sheet
   * prices on it at once; the page applies it too, so its own quotes agree.
   */
  onQuote?: (quote: TradeQuote) => void;
}

type Step = "compose" | "confirm" | "result";

/**
 * TWO WAYS TO SAY THE SAME ORDER (Phase 27).
 *
 *   Shares   "0.75 of a share"  — a quantity; the cost follows from it
 *   Dollars  "$10"              — an amount; the quantity follows from it
 *
 * Buy opens in Dollars and Sell in Shares, because that is what each side is
 * actually about. Only ONE of the two is ever sent. In Dollars mode the
 * request carries the amount and no quantity at all, so the server resolves
 * it against the curve it reads.
 */
type Mode = "shares" | "dollars";

const SHARE_PRESETS = [1, 5, 10];
const DOLLAR_PRESETS = [10, 25, 100];

const REJECTION_TITLES: Record<OrderRejectionCode, string> = {
  price_moved: "The price moved",
  insufficient_balance: "Not enough paper balance",
  exceeds_position: "That exceeds your position",
  daily_limit: "Daily limit reached",
  cooldown: "Not just yet",
  max_units: "Position limit reached",
  open_interest: "Concentration limit reached",
  unknown_person: "Not on the board",
  no_quote: "No quote right now",
  below_minimum: "That order is too small",
  frozen: "Your account is frozen",
  identity_required: "Verify your identity first",
  excluded: "Not permitted in this market",
  halted: "Trading is halted",
  paused: "Trading is paused",
  display_only: "Display-only",
  order_too_large: "That order is too large",
  exposure_cap: "The platform’s exposure limit",
  premium_cap: "Too far from the data",
  unauthenticated: "Sign in to trade",
  invalid: "That order is not valid",
  unavailable: "Trading is unavailable",
};

/** Refusals that name the most the order could be, in `extra.max_units`. */
const SIZED_DOWN_CODES: ReadonlySet<OrderRejectionCode> = new Set(["insufficient_balance", "exceeds_position", "order_too_large", "premium_cap", "exposure_cap"]);

/** Keeps a typed number to one decimal point and at most `places` after it. */
function limitDecimals(raw: string, places: number): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  if (rest.length === 0) return whole.slice(0, 7);
  return `${whole.slice(0, 7)}.${rest.join("").slice(0, places)}`;
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** Whether the sheet can compose an order at all on this side, and the sentence when it cannot. */
function closedReason(availability: TradingAvailability, side: OrderSide, personName: string): { title: string; body: string } | null {
  switch (availability.state) {
    case "halted": {
      const until = Number.isFinite(Date.parse(availability.until)) ? clock.format(Date.parse(availability.until)) : null;
      return {
        title: "Trading is halted",
        body: `Trading in ${personName} is halted${until ? ` until ${until}` : ""}${availability.reason ? `: ${availability.reason}` : "."} Nothing can be placed or closed until it is lifted. The Momentum Score keeps updating.`,
      };
    }
    case "paused":
      return { title: "Trading is paused", body: `Trading in ${personName} is paused. The Momentum Score keeps updating; nothing can be placed for now.` };
    case "display_only":
      if (side === "SELL") return null;
      return {
        title: "Display-only",
        body: `${personName} is display-only: the Momentum Score is shown, but new positions cannot be opened. Anything you already hold can still be closed.`,
      };
    case "tradeable":
      return null;
  }
}

export function TradeSheet({
  open,
  side,
  person,
  book: pageBook,
  marketPrice: pageMarketPrice,
  scoreOnly = false,
  availability,
  balanceCents,
  position,
  shortingEnabled,
  toleranceCents,
  minOrderCents,
  loggingEnabled,
  surface,
  onClose,
  onFilled,
  onQuote,
}: TradeSheetProps) {
  const [step, setStep] = useState<Step>("compose");
  const [mode, setMode] = useState<Mode>(side === "BUY" ? "dollars" : "shares");
  const [quantityText, setQuantityText] = useState("1");
  const [amountText, setAmountText] = useState("10");
  const [armedPriceCents, setArmedPriceCents] = useState<Cents | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OrderResult | null>(null);
  const filled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // THE SERVER'S BOOK (Phase 29e): the quote a refusal came back with, priced
  // on until the page's live book changes — which, once the page has applied
  // the same quote or polled past it, is at least as new.
  const [served, setServed] = useState<TradeQuote | null>(null);
  const [seenPageBook, setSeenPageBook] = useState(pageBook);
  if (seenPageBook !== pageBook) {
    setSeenPageBook(pageBook);
    setServed(null);
  }
  const book: TradeBook = served ?? pageBook;
  const marketPrice = served ? served.marketPrice : pageMarketPrice;

  const curved = book.depthUnits !== null && book.inventoryUnits !== null;
  const typedShares = useMemo(() => {
    const parsed = Number.parseFloat(quantityText);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(sharesToUnits(parsed), MAX_ORDER_SHARES * UNITS_PER_SHARE) / UNITS_PER_SHARE;
  }, [quantityText]);
  const typedSpendCents = useMemo(() => {
    const parsed = Number.parseFloat(amountText);
    if (!Number.isFinite(parsed) || parsed <= 0) return cents(0);
    return cents(Math.min(Math.round(parsed * 100), MAX_ORDER_SHARES * 100 * 100));
  }, [amountText]);

  // ONE PREVIEW, WHICHEVER MODE. Both walk the same curve the server walks,
  // so the average shown here is the average that will be charged.
  const preview = useMemo(
    () =>
      mode === "dollars"
        ? previewMarketSpend(side, typedSpendCents, book, balanceCents, minOrderCents)
        : previewMarketOrder(side, typedShares, book, balanceCents, minOrderCents),
    [mode, side, typedShares, typedSpendCents, book, balanceCents, minOrderCents],
  );
  // THE PRICE THE SHEET SENDS: the average fill over the whole quantity.
  const livePrice = preview.priceCents;
  const shares = preview.shares;
  const canSellOnly = side === "SELL" && !shortingEnabled;
  const closed = closedReason(availability, side, person.displayName);
  const nothingToClose = !closed && canSellOnly && position.openUnits <= 0;
  const maxShares = side === "BUY" ? preview.affordableShares : canSellOnly ? position.openUnits : MAX_ORDER_SHARES;

  /**
   * THE CEILING CHIP, in the mode it is standing in. Buying in Dollars, the
   * ceiling is an amount — the whole balance. Everywhere else it is a
   * quantity. "All" is ALWAYS a quantity, even in Dollars mode, and the chip
   * changes mode to say it: resolving a dollar figure back into a holding can
   * only land within a unit of it, and a Sell that leaves 0.001 of a share
   * behind has not closed the position.
   */
  const maxChip =
    mode === "dollars" && side === "BUY"
      ? balanceCents >= minOrderCents
        ? {
            label: `Max · ${formatCents(balanceCents)}`,
            active: typedSpendCents === balanceCents,
            onClick: () => setAmountText((balanceCents / 100).toFixed(2)),
          }
        : null
      : maxShares > 0 && maxShares < MAX_ORDER_SHARES
        ? {
            label: `${side === "BUY" ? "Max" : "All"} · ${sharesText(maxShares)}`,
            active: mode === "shares" && shares === maxShares,
            onClick: () => {
              setMode("shares");
              setQuantityText(sharesText(maxShares));
            },
          }
        : null;

  // The panel mounts this component fresh for every open (keyed by side), so
  // state starts clean without a reset; the open is logged once, on mount.
  useEffect(() => {
    if (open && loggingEnabled) trackEvent({ eventType: "open_trade_sheet", personId: person.id, metadata: { side, surface } });
  }, [open, side, person.id, surface, loggingEnabled]);

  const close = useCallback(() => {
    if (loggingEnabled && !filled.current) {
      trackEvent({
        eventType: "abandon_trade_sheet",
        personId: person.id,
        metadata: { side, step, units: preview.units, units_per_share: UNITS_PER_SHARE, mode, surface },
      });
    }
    onClose();
  }, [loggingEnabled, person.id, side, step, preview.units, mode, surface, onClose]);

  const composeError = useMemo((): string | null => {
    if (closed || nothingToClose) return null;
    if (mode === "dollars") {
      if (typedSpendCents <= 0) return "Enter an amount.";
      if (typedSpendCents < minOrderCents) return `The smallest order is ${formatCents(minOrderCents)}.`;
      if (side === "BUY" && typedSpendCents > balanceCents) {
        return `Not enough paper balance. You have ${formatCents(balanceCents)} to spend.`;
      }
      if (side === "SELL" && canSellOnly && shares > position.openUnits) {
        return `${formatCents(typedSpendCents)} is more than you hold. You hold ${sharesLabel(position.openUnits)}.`;
      }
      if (preview.units <= 0) return `${formatCents(typedSpendCents)} does not buy a tradeable quantity at this price.`;
      return null;
    }
    if (preview.units <= 0) return `Enter a quantity, down to ${1 / UNITS_PER_SHARE} of a share.`;
    if (preview.belowMinimum) {
      return `${sharesLabel(shares)} is ${formatCents(preview.grossCents)}. The smallest order is ${formatCents(minOrderCents)}.`;
    }
    if (side === "BUY" && preview.grossCents > balanceCents) {
      return preview.affordableShares > 0
        ? `Not enough paper balance for ${sharesLabel(shares)}. You can afford ${sharesText(preview.affordableShares)}.`
        : "Not enough paper balance for the smallest tradeable quantity at this price.";
    }
    if (canSellOnly && shares > position.openUnits) return `You hold ${sharesLabel(position.openUnits)}. A Sell can close at most that many.`;
    return null;
  }, [closed, nothingToClose, mode, typedSpendCents, minOrderCents, shares, side, preview, balanceCents, canSellOnly, position.openUnits]);

  const review = () => {
    if (composeError || preview.units <= 0) return;
    setArmedPriceCents(livePrice);
    setStep("confirm");
  };

  /**
   * Sends the order. The price is the average the reader is looking at —
   * the preview's, or, from a price_moved refusal, the server's own new
   * average, which the footer's button names.
   */
  const submit = async (quotedPriceCents: Cents = livePrice) => {
    if (submitting || preview.units <= 0) return;
    setSubmitting(true);
    let outcome: OrderResult;
    try {
      const response = await fetch("/api/trade/order", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // EXACTLY ONE OF THE TWO. In Dollars mode the quantity is the
        // server's to resolve, so it is not sent at all. The price sent is
        // the AVERAGE the user reviewed: that is what the server compares.
        body: JSON.stringify({
          personId: person.id,
          side,
          ...(mode === "dollars" ? { maxSpendCents: typedSpendCents } : { shares }),
          quotedPriceCents,
          surface,
        }),
      });
      outcome = parseOrderResponse(await response.json().catch(() => null), person.id);
    } catch {
      outcome = { ok: false, code: "unavailable", message: "The order could not reach the server. Nothing was placed.", quote: null, extra: {} };
    }
    setSubmitting(false);
    setResult(outcome);
    setStep("result");
    if (outcome.ok) {
      filled.current = true;
      onFilled(outcome);
    } else if (outcome.quote) {
      // The book as the server read it for this order: the next preview, the
      // one-tap re-confirm and "Change order" are all priced on it.
      setServed(outcome.quote);
      onQuote?.(outcome.quote);
    }
  };

  // A price_moved refusal's one action: the same order at the server's new average.
  const requote =
    step === "result" && result && !result.ok && result.code === "price_moved" && typeof result.extra.fill_price_cents === "number" && result.extra.fill_price_cents > 0
      ? cents(result.extra.fill_price_cents)
      : null;

  const quoteMoved = step === "confirm" && armedPriceCents !== null && armedPriceCents !== livePrice;
  const title = `${verb(side)} ${person.displayName}`;

  const reopenCompose = () => {
    setResult(null);
    setStep("compose");
  };

  /**
   * THE PINNED ACTION (Phase 26b). Every step's bottom action row lives here
   * rather than at the end of its own scrolling block, so how far the reader
   * is through the sheet has nothing to do with whether they can act on it.
   * From `lg` up the row is laid on the body's two columns (Phase 29e): the
   * primary action under the summary, the secondary one under the order.
   */
  const footer = ((): React.ReactNode => {
    if (step === "compose" && (closed || nothingToClose)) {
      return (
        <FooterRow>
          <Button variant="outline" size="lg" className="w-full lg:col-start-2" onClick={close}>
            Close
          </Button>
        </FooterRow>
      );
    }
    if (step === "compose") {
      return (
        <FooterRow className="flex-col gap-2">
          <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="w-full lg:col-start-2 lg:row-start-1" onClick={review} disabled={Boolean(composeError) || preview.units <= 0}>
            Review {verb(side).toLowerCase()}
          </Button>
          <p className="text-center text-xs text-fg-faint lg:col-start-1 lg:row-start-1 lg:text-left">Nothing is placed until you confirm the exact price.</p>
        </FooterRow>
      );
    }
    if (step === "confirm") {
      return (
        <FooterRow>
          <Button variant="outline" size="lg" className="lg:justify-self-start" onClick={() => setStep("compose")} disabled={submitting}>
            Back
          </Button>
          <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="flex-1" onClick={() => void submit()} loading={submitting}>
            {quoteMoved ? `Confirm at ${formatCents(livePrice)}` : `Confirm ${verb(side).toLowerCase()}`} · {formatCents(preview.grossCents)}
          </Button>
        </FooterRow>
      );
    }
    if (step === "result" && result?.ok) {
      return (
        <FooterRow>
          <Button variant="primary" size="lg" className="w-full lg:col-start-2" onClick={close}>
            Done
          </Button>
        </FooterRow>
      );
    }
    if (step === "result" && requote !== null) {
      // THE PRICE MOVED (Phase 29e): one action, the same order at the
      // server's new average, sent in one tap. Changing the order goes back
      // to compose on the book the refusal carried. Close is the sheet's own X.
      return (
        <FooterRow>
          <Button variant="outline" size="lg" className="flex-1 lg:flex-none lg:justify-self-start" onClick={reopenCompose} disabled={submitting}>
            Change order
          </Button>
          <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="flex-1" onClick={() => void submit(requote)} loading={submitting}>
            {requoteLabel(side, requote)}
          </Button>
        </FooterRow>
      );
    }
    if (step === "result" && result && !result.ok) {
      const terminal = result.code === "unauthenticated" || result.code === "unknown_person" || result.code === "frozen" || result.code === "excluded" || result.code === "halted" || result.code === "paused" || result.code === "identity_required";
      return (
        <FooterRow>
          <Button variant="ghost" size="lg" className={cn("flex-1", terminal && "lg:col-start-2")} onClick={close}>
            Close
          </Button>
          {!terminal ? (
            <Button variant="outline" size="lg" className="flex-1" onClick={reopenCompose}>
              Change order
            </Button>
          ) : null}
        </FooterRow>
      );
    }
    return null;
  })();

  const quoteBlock = <QuoteBlock side={side} book={book} marketPrice={marketPrice} curved={curved} scoreOnly={scoreOnly} />;

  return (
    <Sheet open={open} onClose={close} title={title} description="Paper trading. Not real money." footer={footer} size="wide">
      {step === "compose" && closed ? <Columns left={<>{quoteBlock}<MarketClosed title={closed.title} body={closed.body} /></>} /> : null}
      {step === "compose" && !closed && nothingToClose ? <Columns left={<>{quoteBlock}<NothingToClose personName={person.displayName} /></>} /> : null}

      {step === "compose" && !closed && !nothingToClose ? (
        <Columns
          left={
            <>
              {quoteBlock}
              <div className="flex flex-col gap-2">
                {/* The toggle names the field (Phase 29b): a second "Shares" beside it said the same word twice. The input carries its own aria-label. On a wide screen the two share a row. */}
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
                  <ModeToggle mode={mode} onChange={setMode} />
                  {mode === "dollars" ? (
                    <div className="flex items-center gap-2 lg:flex-1">
                      <span aria-hidden className="text-xl font-semibold tabular-nums text-fg-muted">
                        $
                      </span>
                      <input
                        ref={inputRef}
                        id="trade-units"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label="Amount in dollars"
                        value={amountText}
                        onChange={(event) => setAmountText(limitDecimals(event.target.value, 2))}
                        aria-invalid={composeError ? true : undefined}
                        className={cn(inputClassName, "text-center text-xl tabular-nums")}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 lg:flex-1">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="One fewer share"
                        onClick={() => setQuantityText(sharesText(Math.max(1 / UNITS_PER_SHARE, shares - 1)))}
                        disabled={preview.units <= UNITS_PER_SHARE}
                      >
                        <Minus />
                      </Button>
                      <input
                        ref={inputRef}
                        id="trade-units"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label="Number of shares"
                        value={quantityText}
                        onChange={(event) => setQuantityText(limitDecimals(event.target.value, 3))}
                        aria-invalid={composeError ? true : undefined}
                        className={cn(inputClassName, "text-center text-xl tabular-nums")}
                      />
                      <Button variant="outline" size="icon" aria-label="One more share" onClick={() => setQuantityText(sharesText(Math.min(MAX_ORDER_SHARES, shares + 1)))}>
                        <Plus />
                      </Button>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {mode === "dollars"
                    ? DOLLAR_PRESETS.map((preset) => (
                        <Chip key={preset} active={typedSpendCents === preset * 100} onClick={() => setAmountText(String(preset))}>
                          ${preset}
                        </Chip>
                      ))
                    : SHARE_PRESETS.map((preset) => (
                        <Chip key={preset} active={shares === preset} onClick={() => setQuantityText(String(preset))}>
                          {preset}
                        </Chip>
                      ))}
                  {maxChip ? (
                    <Chip active={maxChip.active} onClick={maxChip.onClick}>
                      {maxChip.label}
                    </Chip>
                  ) : null}
                </div>
                {composeError ? (
                  <p role="alert" className="text-sm text-fg-secondary">
                    {composeError}
                  </p>
                ) : null}
                {mode === "dollars" && !composeError && preview.units > 0 ? <p className="text-sm tabular-nums text-fg-muted">{dollarsLine(side, typedSpendCents, preview, curved)}</p> : null}
              </div>
            </>
          }
          right={
            <SummaryPanel>
              <PreviewList side={side} preview={preview} book={book} curved={curved} position={position} scoreOnly={scoreOnly} />
            </SummaryPanel>
          }
        />
      ) : null}

      {step === "confirm" ? (
        <Columns
          left={
            <>
              {quoteBlock}
              <ConfirmSummary
                side={side}
                preview={preview}
                book={book}
                curved={curved}
                personName={person.displayName}
                spendCents={mode === "dollars" ? typedSpendCents : null}
                toleranceCents={toleranceCents}
              />
            </>
          }
          right={
            <div className="flex flex-col gap-5 lg:gap-3">
              {quoteMoved && armedPriceCents !== null ? (
                <p role="status" className="rounded-xl bg-surface-raised px-4 py-3 text-sm text-fg">
                  The price moved while you were reviewing: <Money cents={armedPriceCents} face="text" className="text-fg-muted" /> →{" "}
                  <Money cents={livePrice} face="text" />. The button below carries the new price.
                </p>
              ) : null}
              <SummaryPanel>
                <PreviewList side={side} preview={preview} book={book} curved={curved} position={position} scoreOnly={scoreOnly} compact />
              </SummaryPanel>
              <ConfirmNotes side={side} curved={curved} spendCents={mode === "dollars" ? typedSpendCents : null} toleranceCents={toleranceCents} className="hidden px-1 lg:flex" />
            </div>
          }
        />
      ) : null}

      {step === "result" && result ? (
        result.ok ? (
          <FilledView result={result} side={side} personName={person.displayName} scoreOnly={scoreOnly} />
        ) : (
          <RejectedView
            result={result}
            side={side}
            requoteCents={requote}
            summary={
              requote !== null && preview.units > 0 ? (
                <SummaryPanel>
                  <PreviewList side={side} preview={preview} book={book} curved={curved} position={position} scoreOnly={scoreOnly} compact />
                </SummaryPanel>
              ) : null
            }
            onShares={(next) => {
              setMode("shares");
              setQuantityText(sharesText(next));
              setResult(null);
              setStep("compose");
            }}
          />
        )
      ) : null}
    </Sheet>
  );
}

/**
 * THE BODY'S TWO COLUMNS (Phase 29e). Below `lg` a single column in the
 * phone's order and spacing — the left block's parts 1.5rem apart, then the
 * right block 1.25rem under them, exactly as the sheet stacked them before.
 * From `lg` up the right block becomes a fixed summary column beside the
 * left; with nothing on the right, the left has the width to itself.
 */
function Columns({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-trade-sheet lg:items-start lg:gap-x-10">
      <div className={cn("flex min-w-0 flex-col gap-6 lg:gap-4", !right && "lg:col-span-2")}>{left}</div>
      {right ? <div className="min-w-0">{right}</div> : null}
    </div>
  );
}

/** The summary column's own panel on a wide screen; on a phone the list sits on the sheet as it always has. */
function SummaryPanel({ children }: { children: React.ReactNode }) {
  return <div className="lg:rounded-2xl lg:bg-surface-raised/40 lg:p-5">{children}</div>;
}

/** The footer's row: a row of actions on a phone, laid on the body's two columns from `lg` up. */
function FooterRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex gap-3 lg:grid lg:grid-cols-trade-sheet lg:items-center lg:gap-x-10", className)}>{children}</div>;
}

/**
 * Both quotes, always: the spread is the platform's revenue and stays visible
 * on both sides. Under them, where the market price sits relative to the
 * data, and — on a curved book — the one sentence about size. From `lg` up
 * (Phase 29e) the two boxes are one short row, label and price on one line,
 * and the order's column is wide enough for the spread note on one line (at
 * a 1278-wide laptop window it is; on the narrowest wide window it wraps
 * rather than overflow).
 */
export function QuoteBlock({ side, book, marketPrice, curved, scoreOnly = false }: { side: OrderSide; book: TradeBook; marketPrice: number; curved: boolean; scoreOnly?: boolean }) {
  const market = marketLine({ premiumCents: book.premiumCents });
  return (
    <div className="flex flex-col gap-3 lg:gap-1.5">
      <div className="grid grid-cols-2 gap-3 lg:mb-1.5">
        <QuoteCell label="Buy at" cents={book.buyCents} active={side === "BUY"} />
        <QuoteCell label="Sell at" cents={book.sellCents} active={side === "SELL"} />
      </div>
      {scoreOnly ? null : (
        <p className="text-xs tabular-nums text-fg-muted">
          Market price <span className="font-medium text-fg-secondary">{formatCents(pointsToCents(marketPrice))}</span> <span className="text-fg-faint">·</span> {market.text}
        </p>
      )}
      <p className="text-xs tabular-nums text-fg-faint">{spreadNote(book, curved)}</p>
    </div>
  );
}

/**
 * The confirm step's statement of the order: what, at what, and the band the
 * price is held to. From `lg` up (Phase 29e) the two notes under it move to
 * the summary column (ConfirmNotes), which has the room; on a phone they stay
 * in the box, where they always were.
 */
export function ConfirmSummary({
  side,
  preview,
  book,
  curved,
  personName,
  spendCents,
  toleranceCents,
}: {
  side: OrderSide;
  preview: OrderPreview;
  book: TradeBook;
  curved: boolean;
  personName: string;
  /** Dollars mode: the amount asked for. Null in Shares mode. */
  spendCents: Cents | null;
  toleranceCents: Cents;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/60 p-5 lg:gap-2 lg:p-4">
      <p className="text-label text-fg-muted">You are about to</p>
      <p key={preview.priceCents} className="text-xl font-semibold leading-snug tracking-tight tabular-nums text-fg animate-tick-flash lg:text-lg">
        {confirmHeadline(side, preview, personName, curved)}
      </p>
      <p className="text-base tabular-nums text-fg-secondary">{confirmBreakdown(side, preview, book, curved)}</p>
      <ConfirmNotes side={side} curved={curved} spendCents={spendCents} toleranceCents={toleranceCents} className="lg:hidden" />
    </div>
  );
}

/** The confirm step's small print: the amount asked for (Dollars mode) and the tolerance band. */
export function ConfirmNotes({ side, curved, spendCents, toleranceCents, className }: { side: OrderSide; curved: boolean; spendCents: Cents | null; toleranceCents: Cents; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {spendCents !== null ? (
        <p className="text-sm tabular-nums text-fg-muted">
          You asked to spend {formatCents(spendCents)}. The server resolves the quantity against the quote it reads, so the charge is never more than that.
        </p>
      ) : null}
      <p className="text-xs tabular-nums text-fg-faint">{toleranceNote(side, curved, toleranceCents)}</p>
    </div>
  );
}

function QuoteCell({ label, cents, active }: { label: string; cents: Cents; active: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-2xl px-4 py-3 lg:flex-row lg:items-baseline lg:justify-between lg:gap-3 lg:py-2", active ? "bg-surface-raised" : "bg-surface-raised/40")}>
      <span className="text-label text-fg-muted">{label}</span>
      <span key={cents} className={cn("text-xl font-semibold tabular-nums tracking-tight lg:text-lg", active ? "text-fg animate-tick-flash" : "text-fg-muted")}>
        {formatCents(cents)}
      </span>
    </div>
  );
}

export function PreviewList({
  side,
  preview,
  book,
  curved,
  position,
  scoreOnly = false,
  compact = false,
}: {
  side: OrderSide;
  preview: OrderPreview;
  book: TradeBook;
  curved: boolean;
  position: PositionSummary;
  scoreOnly?: boolean;
  compact?: boolean;
}) {
  const { shares, priceCents, worstCents, grossCents, balanceAfterCents } = preview;
  const closing = side === "SELL" && position.direction === "HIGH";
  const closedShares = closing ? Math.min(shares, position.openUnits) : 0;
  // Through the same rule as the money beside it, so a fraction of a cent
  // never shows up here as a P&L the ledger will not produce.
  const estimatedPnl =
    closing && position.avgEntryCents !== null
      ? cents(Math.round(sharesToUnits(closedShares) * (priceCents - position.avgEntryCents) / UNITS_PER_SHARE))
      : null;
  const positionAfter = side === "BUY" ? position.openUnits + shares : Math.max(0, position.openUnits - shares);
  const walked = walks(preview, curved);
  const premiumMoves = !scoreOnly && curved && preview.units > 0 && preview.premiumAfterCents !== book.premiumCents;
  const after = marketLine({ premiumCents: preview.premiumAfterCents });

  return (
    // The value column is right-aligned (Phase 26): the figures stack in one
    // column with their decimal points under each other. tabular-nums does the rest.
    <dl className={cn("grid grid-cols-[1fr_auto] gap-x-6 text-sm [&>dd]:text-right", compact ? "gap-y-2" : "gap-y-2.5")}>
      {!compact ? (
        <>
          <dt className="text-fg-muted">{walked ? PREVIEW_LABELS.average : PREVIEW_LABELS.price}</dt>
          <dd>
            <Money cents={priceCents} face="text" className="text-fg" />
          </dd>
        </>
      ) : null}
      {walked ? (
        <>
          <dt className="text-fg-muted">{PREVIEW_LABELS.lastShare}</dt>
          <dd>
            <Money cents={worstCents} face="text" className="text-fg" />
          </dd>
        </>
      ) : null}
      <dt className="text-fg-muted">{side === "BUY" ? PREVIEW_LABELS.cost : PREVIEW_LABELS.proceeds}</dt>
      <dd>
        <Money cents={grossCents} face="text" className="font-medium text-fg" />
      </dd>
      {estimatedPnl !== null ? (
        <>
          <dt className="text-fg-muted">
            Est. realized P&amp;L <span className="text-fg-faint">· settles FIFO by lot</span>
          </dt>
          <dd>
            <Money cents={estimatedPnl} signed face="text" />
          </dd>
        </>
      ) : null}
      {premiumMoves ? (
        <>
          <dt className="text-fg-muted">Market price after</dt>
          <dd className="tabular-nums text-fg">{after.text}</dd>
        </>
      ) : null}
      <dt className="text-fg-muted">{PREVIEW_LABELS.balanceAfter}</dt>
      <dd>
        <Money cents={balanceAfterCents} face="text" className="text-fg" />
      </dd>
      <dt className="text-fg-muted">Position after</dt>
      <dd className="tabular-nums text-fg">{positionAfter > 0 ? sharesLabel(positionAfter) : "None"}</dd>
    </dl>
  );
}

/** The market is not open on this side: the state, in a sentence. The Close button is in the footer. */
function MarketClosed({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/60 p-5">
      <p className="text-lg font-semibold tracking-tight text-fg">{title}</p>
      <p className="text-sm leading-relaxed text-fg-muted">{body}</p>
    </div>
  );
}

/** The step's own Close button is in the sheet's footer (Phase 26b). */
function NothingToClose({ personName }: { personName: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/60 p-5">
      <p className="text-lg font-semibold tracking-tight text-fg">Nothing to close.</p>
      <p className="text-sm leading-relaxed text-fg-muted">
        You hold no shares of {personName}. While the platform is long-only, Sell only closes or reduces a position you already have; Buy is how one opens.
      </p>
    </div>
  );
}

export function FilledView({ result, side, personName, scoreOnly = false }: { result: Extract<OrderResult, { ok: true }>; side: OrderSide; personName: string; scoreOnly?: boolean }) {
  const { order, position, balanceCents, quote } = result;
  const marketAfter = quote && !scoreOnly ? marketLine({ premiumCents: quote.premiumCents }) : null;
  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-trade-sheet lg:items-center lg:gap-x-10">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-inverse text-fg-inverse animate-rise-in" aria-hidden>
          <Check className="size-6" strokeWidth={2.5} />
        </span>
        <p className="text-xl font-semibold tracking-tight tabular-nums text-fg">{filledHeadline(side, order, personName)}</p>
        <p className="text-sm tabular-nums text-fg-muted">{filledDetail(side, order)}</p>
      </div>

      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2.5 text-sm lg:rounded-2xl lg:bg-surface-raised/40 lg:p-5 [&>dd]:text-right">
        <dt className="text-fg-muted">{side === "BUY" ? "Cost" : "Proceeds"}</dt>
        <dd>
          <Money cents={side === "BUY" ? order.costCents : order.proceedsCents} face="text" className="font-medium text-fg" />
        </dd>
        {order.closedUnits > 0 ? (
          <>
            <dt className="text-fg-muted">Realized P&amp;L</dt>
            <dd>
              <Money cents={order.realizedPnlCents} signed face="text" className="font-medium" />
            </dd>
          </>
        ) : null}
        {quote && marketAfter ? (
          <>
            <dt className="text-fg-muted">Market price now</dt>
            <dd className="tabular-nums text-fg">
              {formatCents(pointsToCents(quote.marketPrice))} <span className="text-fg-muted">· {marketAfter.text}</span>
            </dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Paper balance now</dt>
        <dd>
          <Money cents={balanceCents} face="text" className="text-fg" />
        </dd>
        <dt className="text-fg-muted">Position now</dt>
        <dd className="tabular-nums text-fg">
          {position.openUnits > 0 ? (
            <>
              {sharesLabel(position.openUnits)}
              {position.avgEntryCents !== null ? (
                <span className="text-fg-muted">
                  {" "}
                  · avg <Money cents={position.avgEntryCents} face="text" />
                </span>
              ) : null}
            </>
          ) : (
            "None"
          )}
        </dd>
      </dl>
    </div>
  );
}

/**
 * The rejection, and the way out that needs its context: the smaller order
 * the limit allows. Close and Change order are in the sheet's footer (Phase
 * 26b), and so is a price_moved refusal's one-tap re-confirm (Phase 29e):
 * the body says what moved, once, under one heading, and beside it (below
 * it on a phone) the summary of the order the footer's button will send,
 * priced on the book the refusal carried.
 */
export function RejectedView({
  result,
  side,
  requoteCents,
  summary,
  onShares,
}: {
  result: Extract<OrderResult, { ok: false }>;
  side: OrderSide;
  /** price_moved: the server's new average, which the footer's button sends. */
  requoteCents: Cents | null;
  summary: React.ReactNode;
  onShares: (shares: number) => void;
}) {
  // max_units comes back in the server's scale; the sentence is in shares.
  const maxShares = typeof result.extra.max_units === "number" ? result.extra.max_units / UNITS_PER_SHARE : null;
  const haltedUntil = typeof result.extra.halted_until === "string" && Number.isFinite(Date.parse(result.extra.halted_until)) ? Date.parse(result.extra.halted_until) : null;
  const quotedCents = typeof result.extra.quoted_price_cents === "number" ? cents(result.extra.quoted_price_cents) : null;
  const priceMoved = result.code === "price_moved" && requoteCents !== null && quotedCents !== null;

  const message = (
    <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/60 p-5">
      <p className="text-lg font-semibold tracking-tight text-fg">{REJECTION_TITLES[result.code]}</p>
      {priceMoved ? (
        <p className="text-sm leading-relaxed tabular-nums text-fg-secondary">{priceMovedBody(side, requoteCents, quotedCents)}</p>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-fg-secondary">{result.message}</p>
          {haltedUntil !== null ? <p className="text-sm tabular-nums text-fg-muted">Trading resumes at {clock.format(haltedUntil)}.</p> : null}
          <p className="text-xs text-fg-faint">Nothing was placed.</p>
        </>
      )}
    </div>
  );

  return (
    <Columns
      left={
        <div className="flex flex-col gap-5">
          {message}
          {SIZED_DOWN_CODES.has(result.code) && maxShares !== null && maxShares > 0 ? (
            <Button variant="outline" size="lg" className="w-full" onClick={() => onShares(maxShares)}>
              {verb(side)} {sharesLabel(maxShares)} instead
            </Button>
          ) : null}
        </div>
      }
      right={priceMoved ? summary : null}
    />
  );
}

/**
 * THE MODE TOGGLE. A two-option segmented control, the pair always visible so
 * the other way of ordering is a fact about the sheet rather than something
 * to be discovered. It is a radiogroup, not two buttons: the two are mutually
 * exclusive and arrow keys should move between them.
 */
function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div role="radiogroup" aria-label="Order in" className="inline-flex items-center gap-1 rounded-full bg-surface-raised p-1">
      {(["shares", "dollars"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={mode === option}
          onClick={() => onChange(option)}
          className={cn(
            "inline-flex h-8 items-center rounded-full px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            mode === option ? "bg-surface-inverse text-fg-inverse" : "text-fg-muted hover:text-fg",
          )}
        >
          {option === "shares" ? "Shares" : "Dollars"}
        </button>
      ))}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center rounded-full px-3.5 text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        active ? "bg-surface-inverse text-fg-inverse" : "bg-surface-raised text-fg-secondary hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
