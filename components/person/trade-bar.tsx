"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import type { ProfilePerson } from "@/lib/person/profile-model";
import { Button } from "@/components/ui/button";

/**
 * Buy / Sell entry points. The trading flow itself is Phase 6e; until then a
 * tap acknowledges quietly and opens nothing. Green Buy and red Sell are the
 * only coloured controls on the page.
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

function Quote({ label, price }: { label: string; price: number | null }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{label}</span>
      {price !== null ? <span className="num text-xs font-medium opacity-80">{price.toFixed(1)}</span> : null}
    </span>
  );
}

function StubNotice({ notice, className }: { notice: TradeSide | null; className?: string }) {
  return (
    <p role="status" aria-live="polite" className={cn("text-xs text-fg-muted", className)}>
      {notice ? `${notice === "buy" ? "Buy" : "Sell"} opens with the trading flow in Phase 6e.` : " "}
    </p>
  );
}

export function TradeActions({ person, className }: { person: ProfilePerson; className?: string }) {
  const { notice, tap } = useTradeStub();
  return (
    <div className={cn("flex flex-col items-stretch gap-2 md:items-end", className)}>
      <div className="flex gap-2">
        <Button variant="buy" size="md" className="min-w-28" onClick={() => tap("buy")} aria-label={`Buy ${person.displayName}`}>
          <Quote label="Buy" price={person.buyPrice} />
        </Button>
        <Button variant="sell" size="md" className="min-w-28" onClick={() => tap("sell")} aria-label={`Sell ${person.displayName}`}>
          <Quote label="Sell" price={person.sellPrice} />
        </Button>
      </div>
      <StubNotice notice={notice} className="min-h-4 md:text-right" />
    </div>
  );
}

export function TradeBar({ person }: { person: ProfilePerson }) {
  const { notice, tap } = useTradeStub();
  return (
    <div className="fixed inset-x-0 bottom-tabbar-safe z-(--z-tabbar) border-t border-line bg-canvas/85 backdrop-blur-xl md:hidden">
      <div className="mx-auto flex max-w-shell flex-col gap-1.5 px-5 pb-3 pt-2.5">
        <StubNotice notice={notice} className="min-h-4 text-center" />
        <div className="flex gap-3">
          <Button variant="buy" size="lg" className="flex-1" onClick={() => tap("buy")} aria-label={`Buy ${person.displayName}`}>
            <Quote label="Buy" price={person.buyPrice} />
          </Button>
          <Button variant="sell" size="lg" className="flex-1" onClick={() => tap("sell")} aria-label={`Sell ${person.displayName}`}>
            <Quote label="Sell" price={person.sellPrice} />
          </Button>
        </div>
      </div>
    </div>
  );
}
