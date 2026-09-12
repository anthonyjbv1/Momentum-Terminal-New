import type { Metadata } from "next";

import { requireUser } from "@/lib/auth";
import { getFeedRoster } from "@/lib/feed/feed";
import { getFirstTradeHistoryPage, getMyPortfolio, getMyValueSeries } from "@/lib/portfolio/server";
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
 */

// Live money; never serve a stale page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage() {
  await requireUser("/portfolio");

  const [summary, series, history, settings, roster] = await Promise.all([
    getMyPortfolio(),
    getMyValueSeries(),
    getFirstTradeHistoryPage().catch((error: unknown) => {
      console.warn("[portfolio] history read failed:", error instanceof Error ? error.message : error);
      return { entries: [], nextCursor: null };
    }),
    getPlatformSettings(),
    getFeedRoster().catch(() => []),
  ]);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Portfolio" description="What you hold, how it is doing, and every trade you have made. Paper money, marked at the Sell quote." />

      {summary ? (
        <PortfolioView
          initialSummary={summary}
          initialSeries={series}
          initialHistory={history}
          roster={roster}
          shortingEnabled={settings.shortingEnabled}
          toleranceCents={settings.priceToleranceCents}
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
