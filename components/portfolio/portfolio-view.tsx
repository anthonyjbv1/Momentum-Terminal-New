"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import type { RosterPerson } from "@/lib/feed/feed";
import { RANGES, defaultRange, rangeAvailable, type RangeKey, type SeriesByRange } from "@/lib/person/profile-model";
import { portfolioState, toPositionSummary, type PortfolioPosition, type PortfolioSummary, type TradeHistoryEntry, type TradeHistoryPage } from "@/lib/portfolio/model";
import { cents, type Cents } from "@/lib/trading/model";
import { RangeToggle } from "@/components/person/range-toggle";
import { TradeSheet } from "@/components/trade/trade-sheet";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

import { PortfolioEmpty } from "./portfolio-empty";
import { PositionsList } from "./positions-list";
import { SummaryStrip } from "./summary-strip";
import { TradeHistory } from "./trade-history";
import { useLivePortfolio, type LivePortfolioOptions } from "./use-live-portfolio";
import { PORTFOLIO_SURFACE, logPortfolioEvent, usePortfolioLogging } from "./use-portfolio-logging";
import { ValueChart } from "./value-chart";

/**
 * The portfolio page below its header: the summary, the value line, the open
 * positions, the trade history, and the one trade sheet a close routes into.
 *
 * Every figure is the server's. The page holds the summary and the series it
 * was rendered with, refreshes them on the Engine's cadence, and after a
 * fill asks the server for the new summary rather than adjusting a number
 * itself. The 6e sheet is the only trading path: Sell on a row opens it for
 * that person with the surface set to "portfolio", so a close started here
 * is told apart from one started on the profile.
 */
export interface PortfolioViewProps {
  initialSummary: PortfolioSummary;
  initialSeries: SeriesByRange;
  initialHistory: TradeHistoryPage;
  roster: RosterPerson[];
  shortingEnabled: boolean;
  toleranceCents: Cents;
  loggingEnabled: boolean;
  /** Live overrides for verification harnesses; production uses the defaults. */
  live?: LivePortfolioOptions;
  /** Where further history pages come from; production uses the default. */
  historyEndpoint?: string;
  className?: string;
}

export function PortfolioView({ initialSummary, initialSeries, initialHistory, roster, shortingEnabled, toleranceCents, loggingEnabled, live, historyEndpoint, className }: PortfolioViewProps) {
  const router = useRouter();
  const { summary, series, version, refresh } = useLivePortfolio(initialSummary, initialSeries, live);
  const state = portfolioState(summary);

  usePortfolioLogging(loggingEnabled, { positions: initialSummary.positionCount, orders: initialSummary.orders });

  // The chart range, exactly as on the profile: the chosen one, or the shortest drawable.
  const available = useMemo(
    () => Object.fromEntries(RANGES.map((range) => [range.key, rangeAvailable(series[range.key])])) as Record<RangeKey, boolean>,
    [series],
  );
  const [chosen, setChosen] = useState<RangeKey | null>(() => defaultRange(initialSeries));
  const range = chosen !== null && available[chosen] ? chosen : defaultRange(series);
  const points = useMemo(() => (range ? series[range] : []), [range, series]);

  const onRange = (next: RangeKey) => {
    setChosen(next);
    logPortfolioEvent(loggingEnabled, { eventType: "filter_change", metadata: { surface: PORTFOLIO_SURFACE, filter: "range", value: next } });
  };

  // The sheet: which person is being closed. The position it shows is always
  // the latest the server sent for that person, so its quotes stay live.
  const [closing, setClosing] = useState<string | null>(null);
  const closingPosition: PortfolioPosition | null = useMemo(
    () => (closing === null ? null : (summary.positions.find((position) => position.person.id === closing) ?? null)),
    [closing, summary.positions],
  );

  const onFilled = useCallback(() => {
    // Ask the server for the summary as it stands now, and for the value point the order recorded.
    void refresh();
    // The banner's balance chip is a Server Component: it needs a fresh render too.
    router.refresh();
  }, [refresh, router]);

  const onOpenPosition = (position: PortfolioPosition) =>
    logPortfolioEvent(loggingEnabled, { eventType: "view_person", personId: position.person.id, metadata: { source: "portfolio_position" } });
  const onOpenHistory = (entry: TradeHistoryEntry) =>
    logPortfolioEvent(loggingEnabled, { eventType: "view_person", personId: entry.person.id, metadata: { source: "portfolio_history", order_id: entry.id } });

  return (
    <div className={cn("flex flex-col gap-10", className)}>
      <SummaryStrip summary={summary} />

      <section aria-labelledby="value-heading" className="flex flex-col gap-4">
        <SectionHeader
          title="Value over time"
          meta={summary.historyPoints > 0 ? `${summary.historyPoints === 1 ? "1 point" : `${summary.historyPoints.toLocaleString("en-US")} points`} recorded` : "Nothing recorded yet"}
        />
        <h2 id="value-heading" className="sr-only">
          Value over time
        </h2>
        <Card className="flex flex-col gap-4 p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <p className="shrink-0 whitespace-nowrap text-label text-fg-muted">Paper value</p>
            <RangeToggle value={range} available={available} onChange={onRange} />
          </div>
          <ValueChart points={points} range={range ?? "1h"} paperCreditCents={summary.paperCreditCents} state={state} version={version} cadenceMs={live?.cadenceMs} />
          <p className="text-xs text-fg-faint">
            Recorded at every Engine tick while you hold a position and after every trade, at the Sell quote. Nothing in between is invented.
          </p>
        </Card>
      </section>

      {state === "never_traded" ? (
        <PortfolioEmpty roster={roster} cashCents={summary.cashCents} />
      ) : (
        <>
          <PositionsList positions={summary.positions} onClose={(position) => setClosing(position.person.id)} onOpenPerson={onOpenPosition} />
          <TradeHistory initialPage={initialHistory} onOpenPerson={onOpenHistory} endpoint={historyEndpoint} />
        </>
      )}

      {closingPosition ? (
        <TradeSheet
          key={closingPosition.person.id}
          open
          side="SELL"
          person={{ id: closingPosition.person.id, slug: closingPosition.person.slug, displayName: closingPosition.person.name }}
          buyCents={closingPosition.buyCents}
          sellCents={closingPosition.sellCents}
          balanceCents={summary.cashCents ?? cents(0)}
          position={toPositionSummary(closingPosition)}
          shortingEnabled={shortingEnabled}
          toleranceCents={toleranceCents}
          loggingEnabled={loggingEnabled}
          surface={PORTFOLIO_SURFACE}
          onClose={() => setClosing(null)}
          onFilled={onFilled}
        />
      ) : null}
    </div>
  );
}
