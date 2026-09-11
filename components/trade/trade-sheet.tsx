"use client";

import { Check, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { trackEvent } from "@/lib/behavioral/client";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import type { OrderSide } from "@/lib/trading/direction";
import {
  MAX_ORDER_UNITS,
  parseOrderResponse,
  previewOrder,
  sharesLabel,
  type Cents,
  type OrderRejectionCode,
  type OrderResult,
  type PositionSummary,
} from "@/lib/trading/model";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";

import { Money, pointsText } from "./money";

/**
 * The trade sheet: compose → confirm → result. A bottom sheet on a phone, a
 * dialog on desktop (the Sheet primitive), always below the banner so the
 * 30-second countdown stays in view.
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

const PRESETS = [1, 5, 10];

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
  unauthenticated: "Sign in to trade",
  invalid: "That order is not valid",
  unavailable: "Trading is unavailable",
};

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
  const [unitsText, setUnitsText] = useState("1");
  const [armedPriceCents, setArmedPriceCents] = useState<Cents | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OrderResult | null>(null);
  const filled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const livePrice = side === "BUY" ? buyCents : sellCents;
  const units = useMemo(() => {
    const parsed = Number.parseInt(unitsText, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_ORDER_UNITS) : 0;
  }, [unitsText]);
  const preview = useMemo(() => previewOrder(side, units, livePrice, balanceCents), [side, units, livePrice, balanceCents]);
  const canSellOnly = side === "SELL" && !shortingEnabled;
  const nothingToClose = canSellOnly && position.openUnits <= 0;
  const maxUnits = side === "BUY" ? preview.affordableUnits : canSellOnly ? position.openUnits : MAX_ORDER_UNITS;

  // The panel mounts this component fresh for every open (keyed by side), so
  // state starts clean without a reset; the open is logged once, on mount.
  useEffect(() => {
    if (open && loggingEnabled) trackEvent({ eventType: "open_trade_sheet", personId: person.id, metadata: { side, surface } });
  }, [open, side, person.id, surface, loggingEnabled]);

  const close = useCallback(() => {
    if (loggingEnabled && !filled.current) {
      trackEvent({ eventType: "abandon_trade_sheet", personId: person.id, metadata: { side, step, units, surface } });
    }
    onClose();
  }, [loggingEnabled, person.id, side, step, units, surface, onClose]);

  const composeError = useMemo((): string | null => {
    if (nothingToClose) return null;
    if (units <= 0) return "Enter a whole number of shares.";
    if (side === "BUY" && preview.grossCents > balanceCents) {
      return preview.affordableUnits > 0
        ? `Not enough paper balance for ${sharesLabel(units)}. You can afford ${preview.affordableUnits}.`
        : "Not enough paper balance for a single share at this price.";
    }
    if (canSellOnly && units > position.openUnits) return `You hold ${sharesLabel(position.openUnits)}. A Sell can close at most that many.`;
    return null;
  }, [nothingToClose, units, side, preview, balanceCents, canSellOnly, position.openUnits]);

  const review = () => {
    if (composeError || units <= 0) return;
    setArmedPriceCents(livePrice);
    setStep("confirm");
  };

  const submit = async () => {
    if (submitting || units <= 0) return;
    setSubmitting(true);
    let outcome: OrderResult;
    try {
      const response = await fetch("/api/trade/order", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: person.id, side, units, quotedPriceCents: livePrice, surface }),
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

  return (
    <Sheet open={open} onClose={close} title={title} description="Paper trading. Not real money.">
      <div className="flex flex-col gap-6">
        {step !== "result" ? <QuoteBlock side={side} buyCents={buyCents} sellCents={sellCents} /> : null}

        {step === "compose" && nothingToClose ? (
          <NothingToClose personName={person.displayName} onClose={close} />
        ) : null}

        {step === "compose" && !nothingToClose ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="trade-units" className="text-sm font-medium text-fg-secondary">
                Shares
              </label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="One fewer share"
                  onClick={() => setUnitsText(String(Math.max(1, units - 1)))}
                  disabled={units <= 1}
                >
                  <Minus />
                </Button>
                <input
                  ref={inputRef}
                  id="trade-units"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={unitsText}
                  onChange={(event) => setUnitsText(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                  aria-invalid={composeError ? true : undefined}
                  className={cn(inputClassName, "num text-center text-xl")}
                />
                <Button variant="outline" size="icon" aria-label="One more share" onClick={() => setUnitsText(String(Math.min(MAX_ORDER_UNITS, units + 1)))}>
                  <Plus />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <Chip key={preset} active={units === preset} onClick={() => setUnitsText(String(preset))}>
                    {preset}
                  </Chip>
                ))}
                {maxUnits > 0 && maxUnits < MAX_ORDER_UNITS ? (
                  <Chip active={units === maxUnits} onClick={() => setUnitsText(String(maxUnits))}>
                    {side === "BUY" ? "Max" : "All"} · {maxUnits.toLocaleString("en-US")}
                  </Chip>
                ) : null}
              </div>
              {composeError ? (
                <p role="alert" className="text-sm text-fg-secondary">
                  {composeError}
                </p>
              ) : null}
            </div>

            <PreviewList side={side} units={units} priceCents={livePrice} grossCents={preview.grossCents} balanceAfterCents={preview.balanceAfterCents} position={position} />

            <div className="flex flex-col gap-2">
              <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="w-full" onClick={review} disabled={Boolean(composeError) || units <= 0}>
                Review {verb(side).toLowerCase()}
              </Button>
              <p className="text-center text-xs text-fg-faint">Nothing is placed until you confirm the exact price.</p>
            </div>
          </div>
        ) : null}

        {step === "confirm" ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/60 p-5">
              <p className="text-label text-fg-muted">You are about to</p>
              <p className="text-xl font-semibold leading-snug tracking-tight text-fg">
                {verb(side)} {sharesLabel(units)} of {person.displayName} at{" "}
                <span key={livePrice} className="num animate-tick-flash">
                  {formatCents(livePrice)}
                </span>{" "}
                each.
              </p>
              <p className="num text-base text-fg-secondary">
                {units.toLocaleString("en-US")} × {formatCents(livePrice)} = {formatCents(preview.grossCents)}
              </p>
              <p className="text-xs text-fg-faint">
                {side === "BUY" ? "Buy" : "Sell"} quote {pointsText(livePrice)}, as of now. If it moves more than {formatCents(toleranceCents)} before the server reads it, you will be
                asked to confirm again.
              </p>
            </div>

            {quoteMoved && armedPriceCents !== null ? (
              <p role="status" className="rounded-xl bg-surface-raised px-4 py-3 text-sm text-fg">
                The quote moved while you were reviewing: <Money cents={armedPriceCents} className="text-fg-muted" /> → <Money cents={livePrice} />. The button below carries
                the new price.
              </p>
            ) : null}

            <PreviewList side={side} units={units} priceCents={livePrice} grossCents={preview.grossCents} balanceAfterCents={preview.balanceAfterCents} position={position} compact />

            <div className="flex gap-3">
              <Button variant="outline" size="lg" onClick={() => setStep("compose")} disabled={submitting}>
                Back
              </Button>
              <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="flex-1" onClick={submit} loading={submitting}>
                {quoteMoved ? `Confirm at ${formatCents(livePrice)}` : `Confirm ${verb(side).toLowerCase()}`} · {formatCents(preview.grossCents)}
              </Button>
            </div>
          </div>
        ) : null}

        {step === "result" && result ? (
          result.ok ? (
            <FilledView result={result} side={side} personName={person.displayName} onDone={close} />
          ) : (
            <RejectedView
              result={result}
              side={side}
              units={units}
              onBack={() => {
                setResult(null);
                setStep("compose");
              }}
              onRequote={(priceCents) => {
                setArmedPriceCents(priceCents);
                setResult(null);
                setStep("confirm");
              }}
              onUnits={(next) => {
                setUnitsText(String(next));
                setResult(null);
                setStep("compose");
              }}
              onClose={close}
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
        You buy at the Buy quote and sell at the Sell quote. The <Money cents={spread} className="text-fg-muted" /> per share between them is the platform&rsquo;s spread.
      </p>
    </div>
  );
}

function QuoteCell({ label, cents, active }: { label: string; cents: Cents; active: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-2xl px-4 py-3", active ? "bg-surface-raised" : "bg-surface-raised/40")}>
      <span className="text-label text-fg-muted">{label}</span>
      <span key={cents} className={cn("num text-xl font-semibold tracking-tight", active ? "text-fg animate-tick-flash" : "text-fg-muted")}>
        {formatCents(cents)}
      </span>
      <span className="num text-xs text-fg-faint">{pointsText(cents)} pts</span>
    </div>
  );
}

function PreviewList({
  side,
  units,
  priceCents,
  grossCents,
  balanceAfterCents,
  position,
  compact = false,
}: {
  side: OrderSide;
  units: number;
  priceCents: Cents;
  grossCents: Cents;
  balanceAfterCents: Cents;
  position: PositionSummary;
  compact?: boolean;
}) {
  const closing = side === "SELL" && position.direction === "HIGH";
  const closedUnits = closing ? Math.min(units, position.openUnits) : 0;
  const estimatedPnl = closing && position.avgEntryCents !== null ? (priceCents - position.avgEntryCents) * closedUnits : null;
  const positionAfter = side === "BUY" ? position.openUnits + units : Math.max(0, position.openUnits - units);

  return (
    <dl className={cn("grid grid-cols-[1fr_auto] gap-x-6 text-sm", compact ? "gap-y-2" : "gap-y-2.5")}>
      {!compact ? (
        <>
          <dt className="text-fg-muted">Price per share</dt>
          <dd>
            <Money cents={priceCents} className="text-fg" />
          </dd>
        </>
      ) : null}
      <dt className="text-fg-muted">{side === "BUY" ? "Cost" : "Proceeds"}</dt>
      <dd>
        <Money cents={grossCents} className="font-medium text-fg" />
      </dd>
      {estimatedPnl !== null ? (
        <>
          <dt className="text-fg-muted">
            Est. realized P&amp;L <span className="text-fg-faint">· settles FIFO by lot</span>
          </dt>
          <dd>
            <Money cents={estimatedPnl} signed />
          </dd>
        </>
      ) : null}
      <dt className="text-fg-muted">Paper balance after</dt>
      <dd>
        <Money cents={balanceAfterCents} className="text-fg" />
      </dd>
      <dt className="text-fg-muted">Position after</dt>
      <dd className="num text-fg">{positionAfter > 0 ? sharesLabel(positionAfter) : "None"}</dd>
    </dl>
  );
}

function NothingToClose({ personName, onClose }: { personName: string; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/60 p-5">
        <p className="text-lg font-semibold tracking-tight text-fg">Nothing to close.</p>
        <p className="text-sm leading-relaxed text-fg-muted">
          You hold no shares of {personName}. While the platform is long-only, Sell only closes or reduces a position you already have; Buy is how one opens.
        </p>
      </div>
      <Button variant="outline" size="lg" className="w-full" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

function FilledView({ result, side, personName, onDone }: { result: Extract<OrderResult, { ok: true }>; side: OrderSide; personName: string; onDone: () => void }) {
  const { order, position, balanceCents } = result;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-inverse text-fg-inverse animate-rise-in" aria-hidden>
          <Check className="size-6" strokeWidth={2.5} />
        </span>
        <p className="text-xl font-semibold tracking-tight text-fg">
          {verb(side, "past")} {sharesLabel(order.units)} of {personName} at <Money cents={order.fillPriceCents} /> each.
        </p>
        <p className="text-sm text-fg-muted">Filled at the {side === "BUY" ? "Buy" : "Sell"} quote the server read as it received the order.</p>
      </div>

      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2.5 text-sm">
        <dt className="text-fg-muted">{side === "BUY" ? "Cost" : "Proceeds"}</dt>
        <dd>
          <Money cents={side === "BUY" ? order.costCents : order.proceedsCents} className="font-medium text-fg" />
        </dd>
        {order.closedUnits > 0 ? (
          <>
            <dt className="text-fg-muted">Realized P&amp;L</dt>
            <dd>
              <Money cents={order.realizedPnlCents} signed className="font-medium" />
            </dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Paper balance now</dt>
        <dd>
          <Money cents={balanceCents} className="text-fg" />
        </dd>
        <dt className="text-fg-muted">Position now</dt>
        <dd className="num text-fg">
          {position.openUnits > 0 ? (
            <>
              {sharesLabel(position.openUnits)}
              {position.avgEntryCents !== null ? (
                <span className="text-fg-muted">
                  {" "}
                  · avg <Money cents={position.avgEntryCents} />
                </span>
              ) : null}
            </>
          ) : (
            "None"
          )}
        </dd>
      </dl>

      <Button variant="primary" size="lg" className="w-full" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function RejectedView({
  result,
  side,
  units,
  onBack,
  onRequote,
  onUnits,
  onClose,
}: {
  result: Extract<OrderResult, { ok: false }>;
  side: OrderSide;
  units: number;
  onBack: () => void;
  onRequote: (priceCents: Cents) => void;
  onUnits: (units: number) => void;
  onClose: () => void;
}) {
  const newPrice = typeof result.extra.fill_price_cents === "number" ? (result.extra.fill_price_cents as Cents) : result.quote ? (side === "BUY" ? result.quote.buyCents : result.quote.sellCents) : null;
  const maxUnits = typeof result.extra.max_units === "number" ? result.extra.max_units : null;

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
            <span className="num text-lg font-semibold text-fg">{formatCents(newPrice)}</span>
          </div>
          <Button variant={side === "BUY" ? "buy" : "sell"} size="lg" className="w-full" onClick={() => onRequote(newPrice)}>
            Review at {formatCents(newPrice)} · {sharesLabel(units)}
          </Button>
        </div>
      ) : null}

      {(result.code === "insufficient_balance" || result.code === "exceeds_position") && maxUnits !== null && maxUnits > 0 ? (
        <Button variant="outline" size="lg" className="w-full" onClick={() => onUnits(maxUnits)}>
          {verb(side)} {sharesLabel(maxUnits)} instead
        </Button>
      ) : null}

      <div className="flex gap-3">
        <Button variant="ghost" size="lg" className="flex-1" onClick={onClose}>
          Close
        </Button>
        {result.code !== "unauthenticated" && result.code !== "unknown_person" ? (
          <Button variant="outline" size="lg" className="flex-1" onClick={onBack}>
            Change order
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "num inline-flex h-9 items-center rounded-full px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        active ? "bg-surface-inverse text-fg-inverse" : "bg-surface-raised text-fg-secondary hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
