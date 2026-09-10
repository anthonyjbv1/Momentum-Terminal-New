"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import type { ProfilePerson } from "@/lib/person/profile-model";
import { Button } from "@/components/ui/button";

/**
 * Buy / Sell entry points. The trading flow itself is Phase 6e; until then a
 * tap acknowledges quietly and opens nothing. Buy is the light pill and Sell
 * the dark one (see --color-buy / --color-sell): monochrome, like the rest of
 * the interface; direction colour stays on the change figures.
 *
 *   TradeActions  inline, beside the score, from the md breakpoint up
 *   TradeBar      fixed above the tab bar on mobile
 */

const NOTICE_MS = 2400;

type TradeSide = "buy" | "sell";

function useTradeStub() {
  const [notice, setNotice] = useState<TradeSide | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const tap = (side: TradeSide) => {
    setNotice(side);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  return { notice, tap };
}

/** The quote beside the verb, in the label colour. */
function Quote({ label, price }: { label: string; price: number | null }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{label}</span>
      {price !== null ? <span className="num text-xs font-medium">{price.toFixed(1)}</span> : null}
    </span>
  );
}

/**
 * What a tap says. Under the launch gate (long-only) a Sell can only close a
 * position, and the note says so; the database enforces it either way.
 */
function stubMessage(side: TradeSide, shortingEnabled: boolean): string {
  if (side === "buy") return "Buy opens with the trading flow in Phase 6e.";
  return shortingEnabled ? "Sell opens with the trading flow in Phase 6e." : "Sell closes an open position. Trading opens with Phase 6e.";
}

function StubNotice({ notice, shortingEnabled, className }: { notice: TradeSide | null; shortingEnabled: boolean; className?: string }) {
  return (
    <p role="status" aria-live="polite" className={cn("text-xs text-fg-muted", className)}>
      {notice ? stubMessage(notice, shortingEnabled) : " "}
    </p>
  );
}

export interface TradeControlProps {
  person: ProfilePerson;
  /** platform_settings.shorting_enabled, read on the server. */
  shortingEnabled: boolean;
  /** Live quotes when the page has them; falls back to the person's. */
  buyPrice?: number | null;
  sellPrice?: number | null;
  className?: string;
}

export function TradeActions({ person, shortingEnabled, buyPrice, sellPrice, className }: TradeControlProps) {
  const { notice, tap } = useTradeStub();
  return (
    <div className={cn("flex flex-col items-stretch gap-2 md:items-end", className)}>
      <div className="flex gap-2">
        <Button variant="buy" size="md" className="min-w-28" onClick={() => tap("buy")} aria-label={`Buy ${person.displayName}`}>
          <Quote label="Buy" price={buyPrice ?? person.buyPrice} />
        </Button>
        <Button variant="sell" size="md" className="min-w-28" onClick={() => tap("sell")} aria-label={`Sell ${person.displayName}`}>
          <Quote label="Sell" price={sellPrice ?? person.sellPrice} />
        </Button>
      </div>
      <StubNotice notice={notice} shortingEnabled={shortingEnabled} className="min-h-4 md:text-right" />
    </div>
  );
}

export function TradeBar({ person, shortingEnabled, buyPrice, sellPrice }: Omit<TradeControlProps, "className">) {
  const { notice, tap } = useTradeStub();
  return (
    <div className="fixed inset-x-0 bottom-tabbar-safe z-(--z-tabbar) border-t border-line bg-canvas/85 backdrop-blur-xl md:hidden">
      <div className="mx-auto flex max-w-shell flex-col gap-1.5 px-5 pb-3 pt-2.5">
        <StubNotice notice={notice} shortingEnabled={shortingEnabled} className="min-h-4 text-center" />
        <div className="flex gap-3">
          <Button variant="buy" size="lg" className="flex-1" onClick={() => tap("buy")} aria-label={`Buy ${person.displayName}`}>
            <Quote label="Buy" price={buyPrice ?? person.buyPrice} />
          </Button>
          <Button variant="sell" size="lg" className="flex-1" onClick={() => tap("sell")} aria-label={`Sell ${person.displayName}`}>
            <Quote label="Sell" price={sellPrice ?? person.sellPrice} />
          </Button>
        </div>
      </div>
    </div>
  );
}
