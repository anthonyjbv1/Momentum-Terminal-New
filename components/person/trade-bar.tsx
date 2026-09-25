"use client";

import Link from "next/link";

import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import type { ProfilePerson, TradingAvailability } from "@/lib/person/profile-model";
import type { OrderSide } from "@/lib/trading/direction";
import { sharesLabel, type Cents, type ViewerTradingState } from "@/lib/trading/model";
import { Button, buttonClassName } from "@/components/ui/button";
import { TradeQuote } from "@/components/trade/trade-quote";

/**
 * Buy / Sell entry points. Buy is the light pill and Sell the dark one (see
 * --color-buy / --color-sell): monochrome, like the rest of the interface;
 * direction colour stays on the change figures.
 *
 *   TradeActions  inline, beside the score, from the md breakpoint up
 *   TradeBar      fixed above the tab bar on mobile
 *
 * Under the launch gate (long-only) a Sell can only close, so when the
 * viewer holds nothing Sell is not offered as Buy's equal: it sits back as a
 * quiet outline reading "Nothing to close". Signed out, Buy leads to sign-in
 * and says the money is paper.
 *
 * THE MARKET'S STATES (Phase 29). A person can be HALTED (a circuit breaker
 * or an operator; every order refused until a time), PAUSED (nothing can be
 * placed) or DISPLAY-ONLY (the Momentum Score is shown, nothing new can be
 * opened, what is held can still be closed). Each state is said in the
 * status line in plain words, and the pill that cannot act is disabled with
 * the state as its label rather than a price it will not honour.
 *
 * PHASE 29b. The mobile bar is OPAQUE — nothing scrolls visibly under it —
 * and exactly --spacing-tradebar tall, one status line and one row of pills,
 * so the profile can reserve precisely that much room below its last line
 * (pb-tradebar) on top of the tab bar and the home indicator. The halted
 * line is "Halted · N min left"; the reason is in the notice on the page.
 * "Closes up to X" appears only when X is not simply what the status line
 * already says is held. Every time-dependent phrase reads the page's `now`
 * (useNow), never the wall clock, so the server's HTML and the first client
 * render agree.
 */
export interface TradeControlProps {
  person: ProfilePerson;
  /** platform_settings.shorting_enabled, read on the server. */
  shortingEnabled: boolean;
  /** Live quotes, cents per unit, premium included. */
  buyCents: Cents;
  sellCents: Cents;
  viewer: ViewerTradingState;
  /** Whether the market is open, and if not, why (Phase 29). */
  availability: TradingAvailability;
  /** The page's clock (useNow): the halt's time left is measured from it. */
  now: number;
  onTrade: (side: OrderSide) => void;
  className?: string;
}

/** Time left on a halt, short: "12 min", "<1 min", "1.5 h". */
export function untilLabel(iso: string, now: number): string {
  const remaining = Math.max(0, Date.parse(iso) - now);
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes <= 1) return "<1 min";
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} h`;
}

/** The one short line about the market's state, or null when it is open. */
export function availabilityNote(availability: TradingAvailability, now: number): string | null {
  switch (availability.state) {
    case "halted":
      return `Halted · ${untilLabel(availability.until, now)} left`;
    case "paused":
      return "Trading paused";
    case "display_only":
      return "Display-only · closing only";
    case "tradeable":
      return null;
  }
}

/**
 * "Closes up to X" — only when X is not the holding the status line already
 * states. Today a Sell can always close the whole holding, so the two are the
 * same number and the note is not shown; the rule is here for the day they
 * differ (a lot still inside its minimum hold, for one).
 */
export function closesNote(heldShares: number, closableShares: number): string | null {
  if (closableShares <= 0 || closableShares === heldShares) return null;
  return `Closes up to ${sharesLabel(closableShares)}`;
}

function buyState(availability: TradingAvailability): { enabled: boolean; label: string } {
  switch (availability.state) {
    case "halted":
      return { enabled: false, label: "Halted" };
    case "paused":
      return { enabled: false, label: "Paused" };
    case "display_only":
      return { enabled: false, label: "Display only" };
    case "tradeable":
      return { enabled: true, label: "Buy" };
  }
}

function sellState(viewer: ViewerTradingState, shortingEnabled: boolean, availability: TradingAvailability): { enabled: boolean; note: string | null; label: string } {
  if (!viewer.signedIn) return { enabled: false, note: null, label: "Sell" };
  const held = viewer.position?.openUnits ?? 0;
  // A halt or a pause closes both doors. Display-only leaves the way out open.
  if (availability.state === "halted") return { enabled: false, note: null, label: "Halted" };
  if (availability.state === "paused") return { enabled: false, note: null, label: "Paused" };
  const closable = held;
  if (shortingEnabled && availability.state === "tradeable") return { enabled: true, note: held > 0 ? closesNote(held, closable) : null, label: "Sell" };
  if (held > 0) return { enabled: true, note: closesNote(held, closable), label: "Sell" };
  return { enabled: false, note: "Nothing to close", label: "Sell" };
}

/**
 * The line above the pills: the paper balance, what is held, and what a Sell
 * can do. Phase 25 flagged it and Phase 26 changed it. It is a sentence, and
 * it was switching typeface twice inside itself to say two things, one of
 * which — "3 shares" — is a phrase rather than a figure at all. Inter
 * throughout now, with tabular figures so a fill cannot jog the words after
 * the balance. The pills below it moved in Phase 25, so the control is
 * finally in one typeface top to bottom.
 */
function Status({ viewer, note, market, className }: { viewer: ViewerTradingState; note: string | null; market: string | null; className?: string }) {
  // While the market is not open its state is the one thing to say, and it is
  // said alone (Phase 29b): "Halted · 12 min left" must never be the part of a
  // one-line status that gets cut off. The balance is in the banner.
  if (market) {
    return (
      <p className={cn("text-xs tabular-nums text-fg-muted", className)}>
        <span className="text-fg-secondary">{market}</span>
      </p>
    );
  }
  if (!viewer.signedIn) {
    return <p className={cn("text-xs text-fg-muted", className)}>Sign in to trade with paper money.</p>;
  }
  const held = viewer.position?.openUnits ?? 0;
  return (
    <p className={cn("text-xs tabular-nums text-fg-muted", className)}>
      <span className="text-fg-faint">Paper</span> <span className="text-fg-secondary">{formatCents(viewer.balanceCents ?? 0)}</span>
      {held > 0 ? (
        <>
          <span aria-hidden> · </span>holding <span className="text-fg-secondary">{sharesLabel(held)}</span>
        </>
      ) : null}
      {note ? (
        <>
          <span aria-hidden> · </span>
          {note}
        </>
      ) : null}
    </p>
  );
}

export function TradeActions({ person, shortingEnabled, buyCents, sellCents, viewer, availability, now, onTrade, className }: TradeControlProps) {
  const sell = sellState(viewer, shortingEnabled, availability);
  const buy = buyState(availability);
  return (
    <div className={cn("flex flex-col items-stretch gap-2 md:items-end", className)}>
      <div className="flex gap-2">
        <BuyControl person={person} buyCents={buyCents} viewer={viewer} state={buy} onTrade={onTrade} size="md" className="min-w-28" />
        <SellControl person={person} sellCents={sellCents} state={sell} onTrade={onTrade} size="md" className="min-w-28" />
      </div>
      <Status viewer={viewer} note={sell.note} market={availabilityNote(availability, now)} className="min-h-4 md:text-right" />
    </div>
  );
}

export function TradeBar({ person, shortingEnabled, buyCents, sellCents, viewer, availability, now, onTrade }: Omit<TradeControlProps, "className">) {
  const sell = sellState(viewer, shortingEnabled, availability);
  const buy = buyState(availability);
  return (
    // Opaque, and exactly h-tradebar tall: the profile reserves that height (pb-tradebar) so nothing sits under it.
    <div data-trade-bar className="fixed inset-x-0 bottom-tabbar-safe z-(--z-tabbar) h-tradebar border-t border-line bg-canvas md:hidden">
      <div className="mx-auto flex h-full max-w-shell flex-col justify-center gap-1.5 px-5">
        <Status viewer={viewer} note={sell.note} market={availabilityNote(availability, now)} className="h-4 truncate text-center" />
        <div className="flex gap-3">
          <BuyControl person={person} buyCents={buyCents} viewer={viewer} state={buy} onTrade={onTrade} size="lg" className="flex-1" />
          <SellControl person={person} sellCents={sellCents} state={sell} onTrade={onTrade} size="lg" className="flex-1" />
        </div>
      </div>
    </div>
  );
}

function BuyControl({
  person,
  buyCents,
  viewer,
  state,
  onTrade,
  size,
  className,
}: {
  person: ProfilePerson;
  buyCents: Cents;
  viewer: ViewerTradingState;
  state: { enabled: boolean; label: string };
  onTrade: (side: OrderSide) => void;
  size: "md" | "lg";
  className?: string;
}) {
  if (!state.enabled) {
    return (
      <Button variant="outline" size={size} className={cn("text-fg-muted", className)} disabled aria-label={`Buy ${person.displayName}: ${state.label.toLowerCase()}`}>
        {state.label}
      </Button>
    );
  }
  if (!viewer.signedIn) {
    return (
      <Link href={`/login?next=${encodeURIComponent(`/person/${person.slug}`)}`} className={buttonClassName("buy", size, className)} aria-label={`Sign in to buy ${person.displayName}`}>
        <TradeQuote label="Buy" cents={buyCents} />
      </Link>
    );
  }
  return (
    <Button variant="buy" size={size} className={className} onClick={() => onTrade("BUY")} aria-label={`Buy ${person.displayName}`}>
      <TradeQuote label="Buy" cents={buyCents} />
    </Button>
  );
}

function SellControl({
  person,
  sellCents,
  state,
  onTrade,
  size,
  className,
}: {
  person: ProfilePerson;
  sellCents: Cents;
  state: { enabled: boolean; note: string | null; label: string };
  onTrade: (side: OrderSide) => void;
  size: "md" | "lg";
  className?: string;
}) {
  if (!state.enabled) {
    return (
      <Button
        variant="outline"
        size={size}
        className={cn("text-fg-muted", className)}
        disabled
        aria-label={`Sell ${person.displayName}: ${state.label === "Sell" ? "nothing to close" : state.label.toLowerCase()}`}
      >
        {state.label === "Sell" ? <TradeQuote label="Sell" cents={sellCents} /> : state.label}
      </Button>
    );
  }
  return (
    <Button variant="sell" size={size} className={className} onClick={() => onTrade("SELL")} aria-label={`Sell ${person.displayName}`}>
      <TradeQuote label="Sell" cents={sellCents} />
    </Button>
  );
}
