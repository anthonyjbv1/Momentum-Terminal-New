import type { Metadata } from "next";

import { requireUser } from "@/lib/auth";
import { getFeedRoster } from "@/lib/feed/feed";
import { SERVER_RENDERED_RANGES, getFirstTradeHistoryPage, getMyPortfolio, getMyValueSeries } from "@/lib/portfolio/server";
import { getRenderedAt } from "@/lib/render-time";
import { getPlatformSettings } from "@/lib/trading/settings";
import { PortfolioView } from "@/components/portfolio/portfolio-view";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

/**
 * /portfolio — what you hold, how it is doing, and what you have traded
 * (Phase 6f).
 *
 *   summary → value over time → open positions → trade history
 *
 * Signed in only. Every figure is computed by the database in integer cents
 * (portfolio_summary_for, portfolio_value_series_for, trade_history_for) and
 * read as the user; the page renders and never calculates. Positions are
 * marked at the quote they would close at (the Sell quote for a HIGH), so
 * a value sits below the raw score by the spread, and the page says so.
 * With the Engine dormant the value line has only the points orders
 * recorded, or none, and says that too.
 *
 * WHAT RENDERS WHEN (the tab-switch lag fix, 2026-10-04). The value line's
 * 1H and 24H ranges are read here; 7D and ALL, the two slowest reads in the
 * app, are read by the same RPC through /api/portfolio/series when the range
 * is first tapped, so the tab no longer waits on them.
 */

// Live money; never serve a stale page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage() {
  await requireUser("/portfolio");

  const [summary, series, history, settings, roster] = await Promise.all([
    getMyPortfolio(),
    getMyValueSeries(SERVER_RENDERED_RANGES),
    getFirstTradeHistoryPage().catch((error: unknown) => {
      console.warn("[portfolio] history read failed:", error instanceof Error ? error.message : error);
      return { entries: [], nextCursor: null };
    }),
    getPlatformSettings(),
    getFeedRoster().catch(() => []),
  ]);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Portfolio" description="View and manage your positions" />

      {summary ? (
        <PortfolioView
          initialSummary={summary}
          initialSeries={series}
          initialRanges={SERVER_RENDERED_RANGES}
          initialHistory={history}
          roster={roster}
          shortingEnabled={settings.shortingEnabled}
          toleranceCents={settings.priceToleranceCents}
          minOrderCents={settings.minOrderCents}
          renderedAt={getRenderedAt()}
          loggingEnabled
        />
      ) : (
        <Card tone="ghost" className="px-6 py-14">
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-lg font-semibold tracking-tight text-fg">Your portfolio could not be read.</p>
            <p className="text-sm leading-relaxed text-fg-muted">Nothing is shown rather than a guess. Try again in a moment; your positions and balance are unchanged.</p>
          </div>
        </Card>
      )}
    </div>
  );
}
