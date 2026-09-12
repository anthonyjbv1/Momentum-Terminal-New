"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import { HISTORY_MAX_ENTRIES, HISTORY_PAGE_SIZE, historyVerb, mergeHistory, type TradeHistoryCursor, type TradeHistoryEntry, type TradeHistoryPage } from "@/lib/portfolio/model";
import { sharesLabel } from "@/lib/trading/model";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { SectionHeader } from "@/components/ui/page-header";
import { SkeletonPersonRow } from "@/components/ui/skeleton";
import { Money } from "@/components/trade/money";

/**
 * Every order, newest first: who, Buy or Sell, how many shares, the price it
 * executed at (the snapshot on the order, never recomputed), what it cost or
 * returned, when, and on a close the realized P&L. Colour only on that last
 * figure. Older pages come through /api/portfolio/history on request; the
 * keyset cursor keeps orders placed at one instant from skipping or
 * repeating across a page.
 */
export interface TradeHistoryProps {
  initialPage: TradeHistoryPage;
  onOpenPerson: (entry: TradeHistoryEntry) => void;
  /** Where further pages come from. Production uses /api/portfolio/history. */
  endpoint?: string;
  className?: string;
}

export function TradeHistory({ initialPage, onOpenPerson, endpoint = "/api/portfolio/history", className }: TradeHistoryProps) {
  const [entries, setEntries] = useState<TradeHistoryEntry[]>(initialPage.entries);
  const [cursor, setCursor] = useState<TradeHistoryCursor | null>(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  const capped = entries.length >= HISTORY_MAX_ENTRIES;
  const exhausted = cursor === null;

  const loadMore = useCallback(async () => {
    if (inFlight.current || cursor === null || capped) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("before", cursor.before);
      url.searchParams.set("before_id", cursor.beforeId);
      url.searchParams.set("limit", String(HISTORY_PAGE_SIZE));
      const response = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error(`history page ${response.status}`);
      const page = (await response.json()) as TradeHistoryPage;
      setEntries((previous) => mergeHistory(previous, page.entries));
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [capped, cursor, endpoint]);

  return (
    <section aria-labelledby="history-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader title="Trade history" meta={entries.length > 0 ? "Newest first" : undefined} />
      <h2 id="history-heading" className="sr-only">
        Trade history
      </h2>

      {entries.length === 0 ? (
        <Card tone="ghost">
          <p className="px-6 py-10 text-center text-sm text-fg-muted">No trades yet.</p>
        </Card>
      ) : (
        <Card className="flex flex-col divide-y divide-line">
          {entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} onOpenPerson={onOpenPerson} />
          ))}
          {loading ? (
            <>
              <SkeletonPersonRow />
              <SkeletonPersonRow />
            </>
          ) : null}
        </Card>
      )}

      {failed ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <p className="text-sm text-fg-muted">Older trades did not come through.</p>
          <Button variant="outline" size="sm" onClick={() => void loadMore()}>
            Try again
          </Button>
        </div>
      ) : null}

      {!loading && !failed && !exhausted && !capped ? (
        <div className="flex justify-center py-1">
          <Button variant="outline" size="sm" onClick={() => void loadMore()}>
            Show older trades
          </Button>
        </div>
      ) : null}

      {!loading && !failed && entries.length > 0 && (exhausted || capped) ? (
        <p className="py-1 text-center text-xs text-fg-faint">
          {capped ? (
            <>
              Showing your latest <span className="num">{HISTORY_MAX_ENTRIES}</span> trades.
            </>
          ) : (
            "That is every trade you have made."
          )}
        </p>
      ) : null}
    </section>
  );
}

function HistoryRow({ entry, onOpenPerson }: { entry: TradeHistoryEntry; onOpenPerson: (entry: TradeHistoryEntry) => void }) {
  const { person } = entry;
  const buy = entry.side === "BUY";
  return (
    <div className="flex items-start gap-4 px-5 py-4 sm:items-center">
      <Link
        href={`/person/${person.slug}`}
        onClick={() => onOpenPerson(entry)}
        aria-label={person.name}
        className="mt-0.5 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:mt-0"
      >
        <Avatar name={person.name} src={person.avatarUrl} size="sm" />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm text-fg">
          <span className="font-medium">{historyVerb(entry.side)}</span> <span className="num">{sharesLabel(entry.units)}</span> of{" "}
          <Link href={`/person/${person.slug}`} onClick={() => onOpenPerson(entry)} className="font-medium underline-offset-4 hover:underline">
            {person.name}
          </Link>{" "}
          at <span className="num">{formatCents(entry.fillPriceCents)}</span>
        </p>
        <p className="text-xs text-fg-faint">
          <LocalTime iso={entry.createdAt} className="num" />
          {entry.closedUnits > 0 && entry.openedUnits > 0 ? (
            <>
              <span aria-hidden> · </span>closed <span className="num">{entry.closedUnits}</span>, opened <span className="num">{entry.openedUnits}</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <p className="text-label text-fg-muted">{buy ? "Cost" : "Proceeds"}</p>
        <Money cents={buy ? entry.costCents : entry.proceedsCents} className="text-sm font-medium text-fg" />
        {entry.closedUnits > 0 ? (
          <p className="text-xs text-fg-faint">
            realized <Money cents={entry.realizedPnlCents} signed className="text-xs" />
          </p>
        ) : null}
      </div>
    </div>
  );
}
