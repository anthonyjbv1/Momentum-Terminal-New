"use client";

import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import type { Cents, PositionSummary } from "@/lib/trading/model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

import { Money, pointsText } from "./money";

/**
 * The viewer's position on this person, marked to the live quote: shares
 * held, the weighted-average entry (a display figure: realized P&L is FIFO
 * by lot), the value at the quote it would close at, and both P&L figures.
 * Colour appears only on the two P&L numbers, by direction. Absent when
 * nothing is held: the trade controls say so instead.
 */
export interface PositionCardProps {
  position: PositionSummary;
  /** Live quotes from the score panel, cents per unit. */
  buyCents: Cents;
  sellCents: Cents;
  className?: string;
}

export function PositionCard({ position, buyCents, sellCents, className }: PositionCardProps) {
  if (position.openUnits <= 0 || !position.direction) return null;

  // A HIGH position closes at the Sell quote, a LOW one at the Buy quote.
  const mark = position.direction === "HIGH" ? sellCents : buyCents;
  const value = position.openUnits * mark;
  const unrealized = position.direction === "HIGH" ? value - position.costCents : position.costCents - value;
  const unrealizedPct = position.costCents > 0 ? (unrealized / position.costCents) * 100 : 0;

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
        <Stat label="Value" hint={`at ${position.direction === "HIGH" ? "Sell" : "Buy"} ${pointsText(mark)}`}>
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
