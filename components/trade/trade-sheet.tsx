"use client";

import { Check, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { trackEvent } from "@/lib/behavioral/client";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import type { OrderSide } from "@/lib/trading/direction";
import {
  MAX_ORDER_SHARES,
  MIN_ORDER_CENTS,
  UNITS_PER_SHARE,
  cents,
  parseOrderResponse,
  previewOrder,
  previewSpend,
  sharesLabel,
  sharesText,
  sharesToUnits,
  type Cents,
  type OrderRejectionCode,
  type OrderResult,
  type PositionSummary,
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
 * ONE PRICE, ONE FORMAT (Phase 26). Every price in here is the quote the
 * score panel computed once and handed down, rendered through formatCents —
 * the same value through the same function as the Buy/Sell pill that opened
 * the sheet. The quote boxes used to repeat themselves in points ("56.6
 * pts") under the money figure, and the confirmation sentence named the
 * quote in points too; both are gone. Scores are points; anything you can
 * trade at is dollars and cents.
 *
 * TYPOGRAPHY (Phase 26). Inter with tabular figures throughout, the
 * Portfolio rule from Phase 25: the quote boxes, the spread sentence, the
 * quantity field, the chips and every summary value. "2 shares" is a phrase
 * and is set as one. The summary's value column is right-aligned so the
 * decimal points line up down it — $56.64 over $9,741.71 rather than two
 * strings starting at the same left edge and ending wherever they end.
 *
 * THE QUOTE IS LIVE. The score is static for 30 seconds and then moves, and
 * a sheet open across that boundary is the expected case. The price shown
 * here is the page's live quote:
 *   compose  the figures simply update, and the price flashes once, the
 *            way the score does;
 *   confirm  the button always carries the price it will send. If the quote
 *            moves off the one the user reviewed, a notice names both prices
 *            and the button re-arms as "Confirm at the new price". Nothing is
 *            ever sent that the user has not just seen.
 * The server holds the last word: it fills at ITS current quote, and if that
 * sits more than the tolerance from the price sent, it refuses and returns
 * the new quote, which lands here as a re-confirm step.
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
  /** Live quotes from the score panel, cents per unit. */
  buyCents: Cents;
  sellCents: Cents;
  balanceCents: Cents;
  position: PositionSummary;
  shortingEnabled: boolean;
  toleranceCents: Cents;
  loggingEnabled: boolean;
  surface: string;
  onClose: () => void;
  onFilled: (result: Extract<OrderResult, { ok: true }>) => void;
}

type Step = "compose" | "confirm" | "result";

/**
 * TWO WAYS TO SAY THE SAME ORDER (Phase 27).
 *
 *   Shares   "0.75 of a share"  — a quantity; the cost follows from it
 *   Dollars  "$10"              — an amount; the quantity follows from it
 *
 * Buy opens in Dollars and Sell in Shares, because that is what each side is
 * actually about. Somebody buying has an amount in mind and does not care
 * that it comes to 0.176 of a share; somebody selling is disposing of a
 * holding they can see, and "all of it" is a quantity, not an amount. The
 * choice is remembered for as long as the sheet is open and never guessed at
 * again.
 *
 * Only ONE of the two is ever sent. In Dollars mode the request carries the
 * amount and no quantity at all, so the server resolves it against the quote
 * it reads — the arithmetic is never done here against a price that may have
 * moved by the time it lands.
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
  unauthenticated: "Sign in to trade",
  invalid: "That order is not valid",
  unavailable: "Trading is unavailable",
};

/** Keeps a typed number to one decimal point and at most `places` after it. */
function limitDecimals(raw: string, places: number): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  if (rest.length === 0) return whole.slice(0, 7);
  return `${whole.slice(0, 7)}.${rest.join("").slice(0, places)}`;
}

function verb(side: OrderSide, tense: "base" | "past" | "ing" = "base"): string {
  if (side === "BUY") return tense === "past" ? "Bought" : tense === "ing" ? "Buying" : "Buy";
  return tense === "past" ? "Sold" : tense === "ing" ? "Selling" : "Sell";
}

export function TradeSheet({
  open,
  side,
  person,
  buyCents,
  sellCents,
  balanceCents,
  position,
  shortingEnabled,
  toleranceCents,
  loggingEnabled,
  surface,
  onClose,
  onFilled,
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

  const livePrice = side === "BUY" ? buyCents : sellCents;
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

  // ONE PREVIEW, WHICHEVER MODE. Both go through the same rounding rule the
  // server uses, so the cost shown here is the cost that will be charged.
  const preview = useMemo(
    () => (mode === "dollars" ? previewSpend(side, typedSpendCents, livePrice, balanceCents) : previewOrder(side, typedShares, livePrice, balanceCents)),
    [mode, side, typedShares, typedSpendCents, livePrice, balanceCents],
  );
  const shares = preview.shares;
  const canSellOnly = side === "SELL" && !shortingEnabled;
  const nothingToClose = canSellOnly && position.openUnits <= 0;
  const maxShares = side === "BUY" ? preview.affordableShares : canSellOnly ? position.openUnits : MAX_ORDER_SHARES;

  /**
   * THE CEILING CHIP, in the mode it is standing in. Buying in Dollars, the
   * ceiling is an amount — the whole balance — because a share count beside
   * $10 and $25 is a third unit in a row of two. Everywhere else it is a
   * quantity.
   *
   * "All" is ALWAYS a quantity, even in Dollars mode, and the chip changes
   * mode to say it: resolving a dollar figure back into a holding can only
   * land within a unit of it, and a Sell that leaves 0.001 of a share behind
   * has not closed the position. Naming the quantity closes it to exactly
   * zero.
   */
  const maxChip =
    mode === "dollars" && side === "BUY"
      ? balanceCents >= MIN_ORDER_CENTS
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
    if (nothingToClose) return null;
    if (mode === "dollars") {
      if (typedSpendCents <= 0) return "Enter an amount.";
      if (typedSpendCents < MIN_ORDER_CENTS) return `The smallest order is ${formatCents(MIN_ORDER_CENTS)}.`;
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
      return `${sharesLabel(shares)} is ${formatCents(preview.grossCents)}. The smallest order is ${formatCents(MIN_ORDER_CENTS)}.`;
    }
    if (side === "BUY" && preview.grossCents > balanceCents) {
      return preview.affordableShares > 0
        ? `Not enough paper balance for ${sharesLabel(shares)}. You can afford ${sharesText(preview.affordableShares)}.`
        : "Not enough paper balance for the smallest tradeable quantity at this price.";
    }
    if (canSellOnly && shares > position.openUnits) return `You hold ${sharesLabel(position.openUnits)}. A Sell can close at most that many.`;
    return null;
  }, [nothingToClose, mode, typedSpendCents, shares, side, preview, balanceCents, canSellOnly, position.openUnits]);

  const review = () => {
    if (composeError || preview.units <= 0) return;
    setArmedPriceCents(livePrice);
    setStep("confirm");
  };

  const submit = async () => {
    if (submitting || preview.units <= 0) return;
    setSubmitting(true);
    let outcome: OrderResult;
    try {
      const response = await fetch("/api/trade/order", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // EXACTLY ONE OF THE TWO. In Dollars mode the quantity is the
        // server's to resolve, so it is not sent at all.
        body: JSON.stringify({
          personId: person.id,
          side,
          ...(mode === "dollars" ? { maxSpendCents: typedSpendCents } : { shares }),
          quotedPriceCents: livePrice,
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
    }
  };

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
   * The copy, the variants and the order are exactly what each step rendered
   * before; only where they are drawn changed.
   *
   * What does NOT come up here is anything that needs the body to make sense
   * — the rejection's "Review at $57.14" sits beside the new quote it names,
   * and "Buy 3 shares instead" beside the limit that produced it. The footer
   * is for the step's own way forward.
   */
  const footer = ((): React.ReactNode => {
    if (step === "compose" && nothingToClose) {
      return (
        <Button variant="outline" size="lg" className="w-full" onClick={close}>
          Close
        </Button>
      );
    }
    if (step === "compose") {
      return (
        <div className="flex flex-col gap-2">
          <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="w-full" onClick={review} disabled={Boolean(composeError) || preview.units <= 0}>
            Review {verb(side).toLowerCase()}
          </Button>
          <p className="text-center text-xs text-fg-faint">Nothing is placed until you confirm the exact price.</p>
        </div>
      );
    }
    if (step === "confirm") {
      return (
        <div className="flex gap-3">
          <Button variant="outline" size="lg" onClick={() => setStep("compose")} disabled={submitting}>
            Back
          </Button>
          <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="flex-1" onClick={submit} loading={submitting}>
            {quoteMoved ? `Confirm at ${formatCents(livePrice)}` : `Confirm ${verb(side).toLowerCase()}`} · {formatCents(preview.grossCents)}
          </Button>
        </div>
      );
    }
    if (step === "result" && result?.ok) {
      return (
        <Button variant="primary" size="lg" className="w-full" onClick={close}>
          Done
        </Button>
      );
    }
    if (step === "result" && result && !result.ok) {
      return (
        <div className="flex gap-3">
          <Button variant="ghost" size="lg" className="flex-1" onClick={close}>
            Close
          </Button>
          {result.code !== "unauthenticated" && result.code !== "unknown_person" ? (
            <Button variant="outline" size="lg" className="flex-1" onClick={reopenCompose}>
              Change order
            </Button>
          ) : null}
        </div>
      );
    }
    return null;
  })();

  return (
    <Sheet open={open} onClose={close} title={title} description="Paper trading. Not real money." footer={footer}>
      <div className="flex flex-col gap-6">
        {step !== "result" ? <QuoteBlock side={side} buyCents={buyCents} sellCents={sellCents} /> : null}

        {step === "compose" && nothingToClose ? <NothingToClose personName={person.displayName} /> : null}

        {step === "compose" && !nothingToClose ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="trade-units" className="text-sm font-medium text-fg-secondary">
                  {mode === "dollars" ? "Amount" : "Shares"}
                </label>
                <ModeToggle mode={mode} onChange={setMode} />
              </div>
              {mode === "dollars" ? (
                <div className="flex items-center gap-2">
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
                <div className="flex items-center gap-2">
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
              {mode === "dollars" && !composeError && preview.units > 0 ? (
                <p className="text-sm tabular-nums text-fg-muted">
                  {formatCents(typedSpendCents)} buys {sharesLabel(shares)} at {formatCents(livePrice)}
                  {preview.grossCents < typedSpendCents ? <> · {formatCents(cents(typedSpendCents - preview.grossCents))} stays in your balance</> : null}
                </p>
              ) : null}
            </div>

            <PreviewList side={side} shares={shares} priceCents={livePrice} grossCents={preview.grossCents} balanceAfterCents={preview.balanceAfterCents} position={position} />
          </div>
        ) : null}

        {step === "confirm" ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/60 p-5">
              <p className="text-label text-fg-muted">You are about to</p>
              <p className="text-xl font-semibold leading-snug tracking-tight text-fg">
                {verb(side)} {sharesLabel(shares)} of {person.displayName} at{" "}
                <span key={livePrice} className="tabular-nums animate-tick-flash">
                  {formatCents(livePrice)}
                </span>{" "}
                each.
              </p>
              <p className="text-base tabular-nums text-fg-secondary">
                {sharesText(shares)} × {formatCents(livePrice)} = {formatCents(preview.grossCents)}
              </p>
              {mode === "dollars" ? (
                <p className="text-sm tabular-nums text-fg-muted">
                  You asked to spend {formatCents(typedSpendCents)}. The server resolves the quantity against the quote it reads, so the charge is never more than that.
                </p>
              ) : null}
              <p className="text-xs tabular-nums text-fg-faint">
                The {side === "BUY" ? "Buy" : "Sell"} quote as of now. If it moves more than {formatCents(toleranceCents)} before the server reads it, you will be asked to confirm
                again.
              </p>
            </div>

            {quoteMoved && armedPriceCents !== null ? (
              <p role="status" className="rounded-xl bg-surface-raised px-4 py-3 text-sm text-fg">
                The quote moved while you were reviewing: <Money cents={armedPriceCents} face="text" className="text-fg-muted" /> →{" "}
                <Money cents={livePrice} face="text" />. The button below carries the new price.
              </p>
            ) : null}

            <PreviewList side={side} shares={shares} priceCents={livePrice} grossCents={preview.grossCents} balanceAfterCents={preview.balanceAfterCents} position={position} compact />
          </div>
        ) : null}

        {step === "result" && result ? (
          result.ok ? (
            <FilledView result={result} side={side} personName={person.displayName} />
          ) : (
            <RejectedView
              result={result}
              side={side}
              shares={shares}
              onRequote={(priceCents) => {
                setArmedPriceCents(priceCents);
                setResult(null);
                setStep("confirm");
              }}
              onShares={(next) => {
                setMode("shares");
                setQuantityText(sharesText(next));
                setResult(null);
                setStep("compose");
              }}
            />
          )
        ) : null}
      </div>
    </Sheet>
  );
}

/** Both quotes, always: the spread is the platform's revenue and stays visible on both sides. */
function QuoteBlock({ side, buyCents, sellCents }: { side: OrderSide; buyCents: Cents; sellCents: Cents }) {
  const spread = buyCents - sellCents;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <QuoteCell label="Buy at" cents={buyCents} active={side === "BUY"} />
        <QuoteCell label="Sell at" cents={sellCents} active={side === "SELL"} />
      </div>
      <p className="text-xs text-fg-faint">
        You buy at the Buy quote and sell at the Sell quote. The <Money cents={spread} face="text" className="text-fg-muted" /> per share between them is the platform&rsquo;s
        spread.
      </p>
    </div>
  );
}

function QuoteCell({ label, cents, active }: { label: string; cents: Cents; active: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-2xl px-4 py-3", active ? "bg-surface-raised" : "bg-surface-raised/40")}>
      <span className="text-label text-fg-muted">{label}</span>
      <span key={cents} className={cn("text-xl font-semibold tabular-nums tracking-tight", active ? "text-fg animate-tick-flash" : "text-fg-muted")}>
        {formatCents(cents)}
      </span>
    </div>
  );
}

function PreviewList({
  side,
  shares,
  priceCents,
  grossCents,
  balanceAfterCents,
  position,
  compact = false,
}: {
  side: OrderSide;
  shares: number;
  priceCents: Cents;
  grossCents: Cents;
  balanceAfterCents: Cents;
  position: PositionSummary;
  compact?: boolean;
}) {
  const closing = side === "SELL" && position.direction === "HIGH";
  const closedShares = closing ? Math.min(shares, position.openUnits) : 0;
  // Through the same rule as the money beside it, so a fraction of a cent
  // never shows up here as a P&L the ledger will not produce.
  const estimatedPnl =
    closing && position.avgEntryCents !== null
      ? cents(Math.round(sharesToUnits(closedShares) * (priceCents - position.avgEntryCents) / UNITS_PER_SHARE))
      : null;
  const positionAfter = side === "BUY" ? position.openUnits + shares : Math.max(0, position.openUnits - shares);

  return (
    // The value column is right-aligned (Phase 26): the figures stack in one
    // column with their decimal points under each other, which is the only
    // way "$56.64" and "$9,741.71" read as a column of money rather than two
    // strings that happen to be near each other. tabular-nums does the rest.
    <dl className={cn("grid grid-cols-[1fr_auto] gap-x-6 text-sm [&>dd]:text-right", compact ? "gap-y-2" : "gap-y-2.5")}>
      {!compact ? (
        <>
          <dt className="text-fg-muted">Price per share</dt>
          <dd>
            <Money cents={priceCents} face="text" className="text-fg" />
          </dd>
        </>
      ) : null}
      <dt className="text-fg-muted">{side === "BUY" ? "Cost" : "Proceeds"}</dt>
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
      <dt className="text-fg-muted">Paper balance after</dt>
      <dd>
        <Money cents={balanceAfterCents} face="text" className="text-fg" />
      </dd>
      <dt className="text-fg-muted">Position after</dt>
      <dd className="tabular-nums text-fg">{positionAfter > 0 ? sharesLabel(positionAfter) : "None"}</dd>
    </dl>
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

function FilledView({ result, side, personName }: { result: Extract<OrderResult, { ok: true }>; side: OrderSide; personName: string }) {
  const { order, position, balanceCents } = result;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-inverse text-fg-inverse animate-rise-in" aria-hidden>
          <Check className="size-6" strokeWidth={2.5} />
        </span>
        <p className="text-xl font-semibold tracking-tight text-fg">
          {verb(side, "past")} {sharesLabel(order.units)} of {personName} at <Money cents={order.fillPriceCents} face="text" /> each.
        </p>
        <p className="text-sm text-fg-muted">Filled at the {side === "BUY" ? "Buy" : "Sell"} quote the server read as it received the order.</p>
      </div>

      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2.5 text-sm [&>dd]:text-right">
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
 * The rejection, and the two ways out that need its context: a re-quote at
 * the price it names, and the smaller order the limit allows. Close and
 * Change order are in the sheet's footer (Phase 26b).
 */
function RejectedView({
  result,
  side,
  shares,
  onRequote,
  onShares,
}: {
  result: Extract<OrderResult, { ok: false }>;
  side: OrderSide;
  shares: number;
  onRequote: (priceCents: Cents) => void;
  onShares: (shares: number) => void;
}) {
  const newPrice = typeof result.extra.fill_price_cents === "number" ? (result.extra.fill_price_cents as Cents) : result.quote ? (side === "BUY" ? result.quote.buyCents : result.quote.sellCents) : null;
  // max_units comes back in the server's scale; the sentence is in shares.
  const maxShares = typeof result.extra.max_units === "number" ? result.extra.max_units / UNITS_PER_SHARE : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/60 p-5">
        <p className="text-lg font-semibold tracking-tight text-fg">{REJECTION_TITLES[result.code]}</p>
        <p className="text-sm leading-relaxed text-fg-secondary">{result.message}</p>
        <p className="text-xs text-fg-faint">Nothing was placed.</p>
      </div>

      {result.code === "price_moved" && newPrice !== null ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between rounded-xl bg-surface-raised px-4 py-3">
            <span className="text-sm text-fg-muted">New {side === "BUY" ? "Buy" : "Sell"} quote</span>
            <span className="text-lg font-semibold tabular-nums text-fg">{formatCents(newPrice)}</span>
          </div>
          <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="w-full" onClick={() => onRequote(newPrice)}>
            Review at {formatCents(newPrice)} · {sharesLabel(shares)}
          </Button>
        </div>
      ) : null}

      {(result.code === "insufficient_balance" || result.code === "exceeds_position") && maxShares !== null && maxShares > 0 ? (
        <Button variant="outline" size="lg" className="w-full" onClick={() => onShares(maxShares)}>
          {verb(side)} {sharesLabel(maxShares)} instead
        </Button>
      ) : null}
    </div>
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
