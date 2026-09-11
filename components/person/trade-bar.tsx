"use client";

import Link from "next/link";

import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import type { ProfilePerson } from "@/lib/person/profile-model";
import type { OrderSide } from "@/lib/trading/direction";
import { sharesLabel, type Cents, type ViewerTradingState } from "@/lib/trading/model";
import { Button, buttonClassName } from "@/components/ui/button";

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
 */
export interface TradeControlProps {
  person: ProfilePerson;
  /** platform_settings.shorting_enabled, read on the server. */
  shortingEnabled: boolean;
  /** Live quotes, cents per unit. */
  buyCents: Cents;
  sellCents: Cents;
  viewer: ViewerTradingState;
  onTrade: (side: OrderSide) => void;
  className?: string;
}

/** The quote beside the verb, in the label colour. */
function Quote({ label, cents }: { label: string; cents: Cents }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{label}</span>
      <span className="num text-xs font-medium">{(cents / 100).toFixed(1)}</span>
    </span>
  );
}

function sellState(viewer: ViewerTradingState, shortingEnabled: boolean): { enabled: boolean; note: string | null } {
  if (!viewer.signedIn) return { enabled: false, note: null };
  const held = viewer.position?.openUnits ?? 0;
  if (shortingEnabled) return { enabled: true, note: held > 0 ? `Closes up to ${sharesLabel(held)}` : null };
  if (held > 0) return { enabled: true, note: `Closes up to ${sharesLabel(held)}` };
  return { enabled: false, note: "Nothing to close" };
}

function Status({ viewer, note, className }: { viewer: ViewerTradingState; note: string | null; className?: string }) {
  if (!viewer.signedIn) {
    return <p className={cn("text-xs text-fg-muted", className)}>Sign in to trade with paper money.</p>;
  }
  const held = viewer.position?.openUnits ?? 0;
  return (
    <p className={cn("text-xs text-fg-muted", className)}>
      <span className="text-fg-faint">Paper</span> <span className="num text-fg-secondary">{formatCents(viewer.balanceCents ?? 0)}</span>
      {held > 0 ? (
        <>
          <span aria-hidden> · </span>holding <span className="num text-fg-secondary">{sharesLabel(held)}</span>
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

export function TradeActions({ person, shortingEnabled, buyCents, sellCents, viewer, onTrade, className }: TradeControlProps) {
  const sell = sellState(viewer, shortingEnabled);
  return (
    <div className={cn("flex flex-col items-stretch gap-2 md:items-end", className)}>
      <div className="flex gap-2">
        <BuyControl person={person} buyCents={buyCents} viewer={viewer} onTrade={onTrade} size="md" className="min-w-28" />
        <SellControl person={person} sellCents={sellCents} enabled={sell.enabled} onTrade={onTrade} size="md" className="min-w-28" />
      </div>
      <Status viewer={viewer} note={sell.note} className="min-h-4 md:text-right" />
    </div>
  );
}

export function TradeBar({ person, shortingEnabled, buyCents, sellCents, viewer, onTrade }: Omit<TradeControlProps, "className">) {
  const sell = sellState(viewer, shortingEnabled);
  return (
    <div className="fixed inset-x-0 bottom-tabbar-safe z-(--z-tabbar) border-t border-line bg-canvas/85 backdrop-blur-xl md:hidden">
      <div className="mx-auto flex max-w-shell flex-col gap-1.5 px-5 pb-3 pt-2.5">
        <Status viewer={viewer} note={sell.note} className="min-h-4 text-center" />
        <div className="flex gap-3">
          <BuyControl person={person} buyCents={buyCents} viewer={viewer} onTrade={onTrade} size="lg" className="flex-1" />
          <SellControl person={person} sellCents={sellCents} enabled={sell.enabled} onTrade={onTrade} size="lg" className="flex-1" />
        </div>
      </div>
    </div>
  );
}

function BuyControl({
  person,
  buyCents,
  viewer,
  onTrade,
  size,
  className,
}: {
  person: ProfilePerson;
  buyCents: Cents;
  viewer: ViewerTradingState;
  onTrade: (side: OrderSide) => void;
  size: "md" | "lg";
  className?: string;
}) {
  if (!viewer.signedIn) {
    return (
      <Link href={`/login?next=${encodeURIComponent(`/person/${person.slug}`)}`} className={buttonClassName("buy", size, className)} aria-label={`Sign in to buy ${person.displayName}`}>
        <Quote label="Buy" cents={buyCents} />
      </Link>
    );
  }
  return (
    <Button variant="buy" size={size} className={className} onClick={() => onTrade("BUY")} aria-label={`Buy ${person.displayName}`}>
      <Quote label="Buy" cents={buyCents} />
    </Button>
  );
}

function SellControl({
  person,
  sellCents,
  enabled,
  onTrade,
  size,
  className,
}: {
  person: ProfilePerson;
  sellCents: Cents;
  enabled: boolean;
  onTrade: (side: OrderSide) => void;
  size: "md" | "lg";
  className?: string;
}) {
  if (!enabled) {
    return (
      <Button variant="outline" size={size} className={cn("text-fg-muted", className)} disabled aria-label={`Sell ${person.displayName}: nothing to close`}>
        <Quote label="Sell" cents={sellCents} />
      </Button>
    );
  }
  return (
    <Button variant="sell" size={size} className={className} onClick={() => onTrade("SELL")} aria-label={`Sell ${person.displayName}`}>
      <Quote label="Sell" cents={sellCents} />
    </Button>
  );
}
