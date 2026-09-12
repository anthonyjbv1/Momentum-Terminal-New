"use client";

import Link from "next/link";

import { cn } from "@/lib/cn";
import { categoryLabel } from "@/lib/home/board-model";
import { formatCents } from "@/lib/money";
import type { PortfolioPosition } from "@/lib/portfolio/model";
import { sharesLabel } from "@/lib/trading/model";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";
import { Money, pointsText } from "@/components/trade/money";

/**
 * Open positions, one row per person, largest value first. Each row is the
 * server's own figures: shares held, the weighted-average entry (a display
 * basis), the value marked at the quote the position would close at (the
 * Sell quote for a HIGH), and unrealized P&L. The Sell control routes into
 * the 6e trade sheet; there is no second trading path. Colour appears only
 * on the P&L, by direction.
 */
export interface PositionsListProps {
  positions: PortfolioPosition[];
  onClose: (position: PortfolioPosition) => void;
  onOpenPerson: (position: PortfolioPosition) => void;
  className?: string;
}

export function PositionsList({ positions, onClose, onOpenPerson, className }: PositionsListProps) {
  return (
    <section aria-labelledby="positions-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        title="Open positions"
        meta={positions.length > 0 ? `${positions.length === 1 ? "1 person" : `${positions.length} people`} · marked at the Sell quote` : "None open"}
      />
      <h2 id="positions-heading" className="sr-only">
        Open positions
      </h2>

      {positions.length === 0 ? (
        <Card tone="ghost" className="px-6 py-10">
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-lg font-semibold tracking-tight text-fg">Nothing open.</p>
            <p className="text-sm leading-relaxed text-fg-muted">
              Everything you held has been closed. What you realized and every trade stay below; the next position starts on{" "}
              <Link href="/" className="text-fg underline-offset-4 hover:underline">
                Home
              </Link>{" "}
              or in the{" "}
              <Link href="/feed" className="text-fg underline-offset-4 hover:underline">
                Feed
              </Link>
              .
            </p>
          </div>
        </Card>
      ) : (
        <Card className="flex flex-col divide-y divide-line">
          {positions.map((position) => (
            <PositionRow key={`${position.person.id}:${position.direction}`} position={position} onClose={onClose} onOpenPerson={onOpenPerson} />
          ))}
        </Card>
      )}
    </section>
  );
}

function PositionRow({ position, onClose, onOpenPerson }: { position: PortfolioPosition; onClose: (position: PortfolioPosition) => void; onOpenPerson: (position: PortfolioPosition) => void }) {
  const { person } = position;
  const pct = position.unrealizedPct;
  const tone = position.unrealizedPnlCents > 0 ? "text-positive" : position.unrealizedPnlCents < 0 ? "text-negative" : "text-fg-muted";
  const markLabel = position.markSide === "SELL" ? "Sell" : "Buy";

  return (
    <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-4 gap-y-4 px-5 py-5 sm:grid-cols-[auto_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:gap-x-6">
      <Link
        href={`/person/${person.slug}`}
        onClick={() => onOpenPerson(position)}
        aria-label={`${person.name}, ${sharesLabel(position.openUnits)} held`}
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Avatar name={person.name} src={person.avatarUrl} size="md" />
      </Link>

      <div className="col-span-2 flex min-w-0 flex-col gap-0.5 sm:col-span-1">
        <Link href={`/person/${person.slug}`} onClick={() => onOpenPerson(position)} className="truncate font-medium text-fg underline-offset-4 hover:underline">
          {person.name}
        </Link>
        <p className="truncate text-sm text-fg-muted">
          {categoryLabel(person.category)}
          {!person.isActive ? <span className="text-fg-faint"> · off the board</span> : null}
        </p>
        <p className="num text-sm text-fg-secondary">
          {sharesLabel(position.openUnits)} <span className="text-fg-faint">·</span> avg {formatCents(position.avgEntryCents)}
          {position.lots > 1 ? <span className="text-fg-faint"> · {position.lots} lots</span> : null}
        </p>
      </div>

      <div className="col-start-2 flex min-w-0 flex-col gap-0.5 sm:col-start-auto">
        <p className="text-label text-fg-muted">
          Value <span className="normal-case tracking-normal text-fg-faint">at {markLabel} {pointsText(position.markPriceCents)}</span>
        </p>
        <Money cents={position.valueCents} className="text-lg font-semibold tracking-tight text-fg" />
        <p className="num text-xs text-fg-faint">{formatCents(position.markPriceCents)} per share</p>
      </div>

      <div className="col-start-3 flex min-w-0 flex-col gap-0.5 sm:col-start-auto">
        <p className="text-label text-fg-muted">Unrealized</p>
        <Money cents={position.unrealizedPnlCents} signed className="text-lg font-semibold tracking-tight" />
        <p className={cn("num text-xs", tone)}>
          {pct === null ? "—" : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`}
          {position.realizedPnlCents !== 0 ? (
            <span className="text-fg-faint">
              {" "}
              · realized <Money cents={position.realizedPnlCents} signed className="text-xs" />
            </span>
          ) : null}
        </p>
      </div>

      <div className="col-span-2 col-start-2 flex sm:col-span-1 sm:col-start-auto sm:justify-end">
        {person.isActive ? (
          <Button variant="sell" size="sm" className="min-w-24" onClick={() => onClose(position)} aria-label={`Sell ${person.name}`}>
            <span className="inline-flex items-baseline gap-2">
              <span>Sell</span>
              <span className="num text-xs font-medium">{pointsText(position.sellCents)}</span>
            </span>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="min-w-24 text-fg-muted" disabled title="This person is no longer on the board.">
            Off the board
          </Button>
        )}
      </div>
    </div>
  );
}
