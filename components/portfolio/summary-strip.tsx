"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import type { PortfolioSummary } from "@/lib/portfolio/model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/trade/money";

/**
 * The summary: total value leading, then cash, unrealized and realized.
 * Every figure is the server's; the strip lays them out. Colour appears only
 * on the P&L figures and the return, by direction. The total flashes when
 * it changes, the way the score does.
 */
export function SummaryStrip({ summary, className }: { summary: PortfolioSummary; className?: string }) {
  const pct = summary.totalReturnPct;
  return (
    <Card className={cn("flex flex-col gap-8 p-6 sm:p-8", className)}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <p className="text-label text-fg-muted">Total value</p>
          <Badge tone="outline" className="uppercase tracking-wide">
            Paper
          </Badge>
        </div>
        <p key={summary.totalValueCents} className="num text-4xl font-semibold leading-none tracking-tighter text-fg animate-tick-flash sm:text-6xl">
          {formatCents(summary.totalValueCents)}
        </p>
        <p className="text-sm text-fg-muted">
          <Money cents={summary.totalReturnCents} signed className="font-medium" />
          {pct !== null ? (
            <span className={cn("num", summary.totalReturnCents > 0 ? "text-positive" : summary.totalReturnCents < 0 ? "text-negative" : "text-fg-muted")}>
              {" "}
              ({pct > 0 ? "+" : pct < 0 ? "−" : ""}
              {Math.abs(pct).toFixed(2)}%)
            </span>
          ) : null}{" "}
          against your <span className="num text-fg-secondary">{formatCents(summary.paperCreditCents)}</span> of paper credit
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Stat label="Cash" hint="paper">
          <Money cents={summary.cashCents} className="text-xl font-semibold tracking-tight text-fg sm:text-2xl" />
        </Stat>
        <Stat label="Positions" hint="at Sell">
          <Money cents={summary.positionsValueCents} className="text-xl font-semibold tracking-tight text-fg sm:text-2xl" />
        </Stat>
        <Stat label="Unrealized" hint="open">
          <Money cents={summary.unrealizedPnlCents} signed className="text-xl font-semibold tracking-tight sm:text-2xl" />
        </Stat>
        <Stat label="Realized" hint="lifetime">
          <Money cents={summary.realizedPnlCents} signed className="text-xl font-semibold tracking-tight sm:text-2xl" />
        </Stat>
      </dl>
    </Card>
  );
}

function Stat({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-label text-fg-muted">
        {label}
        {hint ? <span className="ml-1.5 normal-case tracking-normal text-fg-faint">{hint}</span> : null}
      </dt>
      <dd className="flex flex-col gap-0.5">{children}</dd>
    </div>
  );
}
