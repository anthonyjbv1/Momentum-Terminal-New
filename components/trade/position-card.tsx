"use client";

import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import { marketLine } from "@/lib/person/profile-model";
import type { Cents, PositionSummary } from "@/lib/trading/model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

import { Money } from "./money";

/**
 * The viewer's position on this person, marked to the live quote: shares
 * held, the weighted-average entry (a display figure: realized P&L is FIFO
 * by lot), the value at the quote it would close at, and both P&L figures.
 * Colour appears only on the two P&L numbers, by direction. Absent when
 * nothing is held: the trade controls say so instead.
 *
 * The Value hint used to name the mark in points — "at Sell 55.6" — with
 * the same price in money, "$55.64 per share", directly underneath it: one
 * quote, twice, in two units. Phase 26 dropped the figure from the hint
 * rather than converting it, since the line below already states it to the
 * cent; the hint now says only which side the position is marked at.
 *
 * THE MARK INCLUDES THE PREMIUM (Phase 29). A HIGH position is marked at
 * the Sell side of the MARKET PRICE, a LOW one at its Buy side, so the mark
 * carries whatever premium trading has put on the person right now. The
 * footnote says where the market price sits relative to the data, because a
 * premium is the part of the mark that decays back toward zero on its own.
 */
export interface PositionCardProps {
  position: PositionSummary;
  /** Live quotes from the score panel, cents per unit, premium included. */
  buyCents: Cents;
  sellCents: Cents;
  /** The premium in cents per share, for the footnote. 0 on a flat market. */
  premiumCents?: number;
  /** A display-only index (Phase 29b): no market-price wording, no premium footnote. */
  scoreOnly?: boolean;
  className?: string;
}

export function PositionCard({ position, buyCents, sellCents, premiumCents = 0, scoreOnly = false, className }: PositionCardProps) {
  if (position.openUnits <= 0 || !position.direction) return null;

  // A HIGH position closes at the Sell side of the market price, a LOW one at the Buy side.
  const mark = position.direction === "HIGH" ? sellCents : buyCents;
  const value = position.openUnits * mark;
  const unrealized = position.direction === "HIGH" ? value - position.costCents : position.costCents - value;
  const unrealizedPct = position.costCents > 0 ? (unrealized / position.costCents) * 100 : 0;
  const market = marketLine({ premiumCents: scoreOnly ? 0 : premiumCents });

  return (
    <section aria-labelledby="position-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        title="Your position"
        meta={
          <Badge tone="outline" className="uppercase tracking-wide">
            Paper
          </Badge>
        }
      />
      <h2 id="position-heading" className="sr-only">
        Your position
      </h2>
      <Card className="grid grid-cols-2 gap-x-6 gap-y-5 p-6 sm:grid-cols-4 sm:p-7">
        <Stat label="Held">
          <span className="num text-2xl font-semibold tracking-tight text-fg">{position.openUnits.toLocaleString("en-US")}</span>
          <span className="text-sm text-fg-muted">
            {position.openUnits === 1 ? "share" : "shares"} · {position.direction}
          </span>
        </Stat>
        <Stat label="Avg entry" hint="weighted average">
          <Money cents={position.avgEntryCents ?? 0} className="text-2xl font-semibold tracking-tight text-fg" />
          <span className="text-sm text-fg-muted">cost {formatCents(position.costCents)}</span>
        </Stat>
        <Stat label="Value" hint={scoreOnly ? `at the ${position.direction === "HIGH" ? "Sell" : "Buy"} quote` : `at the ${position.direction === "HIGH" ? "Sell" : "Buy"} side of the market price`}>
          <Money cents={value} className="text-2xl font-semibold tracking-tight text-fg" />
          <span className="text-sm text-fg-muted">{formatCents(mark)} per share</span>
        </Stat>
        <Stat label="Unrealized">
          <Money cents={unrealized} signed className="text-2xl font-semibold tracking-tight" />
          <span className={cn("num text-sm", unrealized > 0 ? "text-positive" : unrealized < 0 ? "text-negative" : "text-fg-muted")}>
            {unrealized > 0 ? "+" : unrealized < 0 ? "−" : ""}
            {Math.abs(unrealizedPct).toFixed(1)}%
          </span>
        </Stat>
        <p className="col-span-2 text-xs text-fg-faint sm:col-span-4">
          Realized on this person so far: <Money cents={position.realizedPnlCents} signed className="text-xs" />. Closes settle FIFO, oldest lot first, across{" "}
          {position.lots === 1 ? "one lot" : `${position.lots} lots`}; the average entry is for reading, not for settling.
          {market.relation !== "in_line" ? (
            <>
              {" "}
              The market price is <span className="num text-fg-muted">{market.text}</span> right now; that part of the mark drifts back toward the score on its own.
            </>
          ) : null}
        </p>
      </Card>
    </section>
  );
}

function Stat({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-label text-fg-muted">
        {label}
        {hint ? <span className="ml-1.5 normal-case tracking-normal text-fg-faint">{hint}</span> : null}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
