"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { formatCents } from "@/lib/money";
import {
  RANGES,
  defaultRange,
  formatSignedPercent,
  marketLine,
  periodChange,
  rangeAvailable,
  tradingAvailability,
  type PeriodChange,
  type PersonProfile,
  type RangeKey,
  type TradingAvailability,
} from "@/lib/person/profile-model";
import type { OrderSide } from "@/lib/trading/direction";
import { EMPTY_POSITION, cents, pointsToCents, quoteFromScore, type Cents, type OrderResult, type PositionSummary, type TradeBook, type ViewerTradingState } from "@/lib/trading/model";
import { PositionCard } from "@/components/trade/position-card";
import { TradeSheet } from "@/components/trade/trade-sheet";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { directionAtPrecision, directionIcon, directionLabels, directionTone, formatChange } from "@/components/ui/direction-indicator";
import { SectionHeader } from "@/components/ui/page-header";
import { ScoreDisplay } from "@/components/ui/score-display";
import { useNow } from "@/components/ui/use-now";

import { RangeToggle } from "./range-toggle";
import { ScoreChart } from "./score-chart";
import { TradeActions, TradeBar } from "./trade-bar";
import { useLiveSeries, type LiveSeriesOptions } from "./use-live-series";
import { PROFILE_SURFACE, logProfileEvent } from "./use-profile-logging";

/**
 * The hero: the Momentum Score, the change over the selected range beneath
 * it, THE MARKET LINE under that (Phase 29), and the score line with its
 * range toggle. One panel, because the number and the line are one reading.
 * On desktop the Buy / Sell entry sits beside the score; on mobile it is the
 * bar fixed above the tab bar (rendered here so it shares the live quotes).
 * The viewer's position, the trade sheet and the balance it shows all live
 * here too, so a fill updates every one of them without a reload.
 *
 * TWO NUMBERS (Phase 29). The hero is the Momentum Score: the data's number,
 * moved by the score forces alone. Under it, one line says where the MARKET
 * PRICE sits — "Market $66.00 · +4.0 above the data" — because that is the
 * number you trade at, and the gap between the two is what trading has done
 * to it. The quotes either side of the market price are derived here from
 * the live score, spread and premium, exactly as the database's generated
 * columns derive them, and the sheet is handed the whole book so its preview
 * walks the same curve the server will.
 *
 * WHAT PHASE 26 TOOK OUT. The card carried two rows of small statistics —
 * Gravity target, Spread, Buy, Sell — and each was a problem of its own.
 * What is left is the score, its change, the market line, and the line.
 *
 * Everything in it is kept current on the Engine's cadence by useLiveSeries:
 * the score flashes, the change and the quotes update, and the chart reveals
 * the new tick. With the Engine dormant nothing changes.
 */
export interface ScorePanelProps {
  profile: PersonProfile;
  loggingEnabled: boolean;
  /** Server render time, so relative ages agree between server and client. */
  renderedAt: number;
  /** platform_settings.shorting_enabled, read on the server. */
  shortingEnabled: boolean;
  /** The signed-in viewer's balance and position on this person, read on the server. */
  viewer: ViewerTradingState;
  /** platform_settings.price_tolerance_cents, for the sheet's copy. */
  toleranceCents: Cents;
  /** platform_settings.min_order_cents, for the sheet's floor. */
  minOrderCents: Cents;
  /** Feed overrides for verification harnesses; production uses the defaults. */
  live?: LiveSeriesOptions;
  className?: string;
}

/**
 * THE CHANGE, AS ONE STATEMENT (Phase 26): "↗ +0.3 (+0.59%) · 1H".
 * Both figures are one text node: the same size, the same weight, one line
 * box, and therefore one baseline by construction. The arrow is centred on
 * that line, the period label stays neutral, and direction colour lands on
 * the figures only, at the precision they are DISPLAYED at (Phase 19+).
 */
function ChangeLine({ change, rangeLabel }: { change: PeriodChange; rangeLabel: string | null }) {
  const direction = directionAtPrecision(change.change, 1);
  const Icon = directionIcon[direction];
  const points = formatChange(change.change);
  const figures = change.percent !== null ? `${points} (${formatSignedPercent(change.percent)})` : points;

  return (
    <p className="flex flex-wrap items-center gap-x-2 text-base">
      <span className={cn("inline-flex items-center gap-1.5 font-medium tabular-nums", directionTone[direction])} aria-label={`${directionLabels[direction]}, ${figures}`}>
        <Icon className="size-5 shrink-0" strokeWidth={2.5} aria-hidden />
        <span>{figures}</span>
      </span>
      {rangeLabel ? (
        <>
          <span className="text-fg-faint" aria-hidden>
            ·
          </span>
          <span className="text-fg-muted">{rangeLabel}</span>
        </>
      ) : null}
    </p>
  );
}

/**
 * THE MARKET LINE (Phase 29): the price you trade at, and where it sits
 * relative to the data. Monochrome: the relation is a fact about the market,
 * not a direction of the score.
 */
function MarketLine({ marketPrice, premiumCents }: { marketPrice: number; premiumCents: number }) {
  const market = marketLine({ premiumCents });
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm tabular-nums text-fg-muted">
      <span>
        Market <span key={premiumCents} className="font-medium text-fg-secondary animate-tick-flash">{formatCents(pointsToCents(marketPrice))}</span>
      </span>
      <span className="text-fg-faint" aria-hidden>
        ·
      </span>
      <span>{market.text}</span>
      <span className="text-fg-faint" aria-hidden>
        ·
      </span>
      <Link href="/how-the-price-works" className="text-fg-faint underline-offset-4 hover:text-fg-muted hover:underline">
        How the price works
      </Link>
    </p>
  );
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** The market's state, when it is not simply open. */
function AvailabilityNotice({ availability, personName }: { availability: TradingAvailability; personName: string }) {
  if (availability.state === "tradeable") return null;
  let text: string;
  switch (availability.state) {
    case "halted": {
      const until = Number.isFinite(Date.parse(availability.until)) ? clock.format(Date.parse(availability.until)) : null;
      text = `Trading in ${personName} is halted${until ? ` until ${until}` : ""}${availability.reason ? `: ${availability.reason}` : "."} Nothing can be placed until it is lifted; the score keeps updating.`;
      break;
    }
    case "paused":
      text = `Trading in ${personName} is paused. The score keeps updating; nothing can be placed for now.`;
      break;
    case "display_only":
      text = `${personName} is display-only: the Momentum Score is shown, but no new positions can be opened. Anything already held can still be closed.`;
      break;
  }
  return (
    <p role="status" className="flex items-start gap-3 rounded-xl bg-surface-raised px-4 py-3 text-sm text-fg-secondary">
      <Badge tone="outline" className="mt-0.5 shrink-0 uppercase tracking-wide">
        {availability.state === "display_only" ? "Display only" : availability.state === "halted" ? "Halted" : "Paused"}
      </Badge>
      <span>{text}</span>
    </p>
  );
}

export function ScorePanel({ profile, loggingEnabled, renderedAt, shortingEnabled, viewer: initialViewer, toleranceCents, minOrderCents, live, className }: ScorePanelProps) {
  const { person, series: initialSeries, latestTick } = profile;
  const router = useRouter();
  const state = useLiveSeries(person, initialSeries, live);
  const series = state.series;
  const now = useNow(renderedAt);

  const available = useMemo(
    () => Object.fromEntries(RANGES.map((range) => [range.key, rangeAvailable(series[range.key])])) as Record<RangeKey, boolean>,
    [series],
  );
  const [chosen, setChosen] = useState<RangeKey | null>(() => defaultRange(initialSeries));
  // The chosen range, or the shortest drawable one once ticks have started landing.
  const range = chosen !== null && available[chosen] ? chosen : defaultRange(series);
  const points = useMemo(() => (range ? series[range] : []), [range, series]);
  const change = useMemo(() => periodChange(points), [points]);
  const rangeLabel = RANGES.find((definition) => definition.key === range)?.label ?? null;

  const lastTickAt = state.lastTickAt ?? latestTick?.at ?? null;
  const agesFrom = state.updatedAt ?? renderedAt;

  // Live quotes in cents, from the same score + spread + premium the page
  // shows, and the whole book the sheet previews on.
  const quote = useMemo(() => quoteFromScore(state.score, state.spread, state.premiumCents), [state.score, state.spread, state.premiumCents]);
  const book = useMemo<TradeBook>(
    () => ({
      buyCents: quote.buyCents,
      sellCents: quote.sellCents,
      baseBuyCents: pointsToCents(state.score + state.spread),
      baseSellCents: pointsToCents(state.score - state.spread),
      premiumCents: state.premiumCents,
      inventoryUnits: person.depthUnits === null ? null : state.inventoryUnits,
      depthUnits: person.depthUnits,
      premiumCapCents: person.premiumCapCents,
    }),
    [quote, state.score, state.spread, state.premiumCents, state.inventoryUnits, person.depthUnits, person.premiumCapCents],
  );
  const availability = useMemo(
    () => tradingAvailability({ tradingMode: state.tradingMode, haltedUntil: state.haltedUntil, haltReason: state.haltReason }, now),
    [state.tradingMode, state.haltedUntil, state.haltReason, now],
  );

  // The viewer's money and position: from the server first, then from each fill.
  const [balanceCents, setBalanceCents] = useState<Cents | null>(initialViewer.balanceCents);
  const [position, setPosition] = useState<PositionSummary>(initialViewer.position ?? { personId: person.id, ...EMPTY_POSITION });
  const viewer: ViewerTradingState = useMemo(
    () => ({ signedIn: initialViewer.signedIn, balanceCents, position: initialViewer.signedIn ? position : null }),
    [initialViewer.signedIn, balanceCents, position],
  );
  const [sheet, setSheet] = useState<OrderSide | null>(null);

  const onRange = (next: RangeKey) => {
    setChosen(next);
    logProfileEvent(loggingEnabled, { eventType: "change_range", personId: person.id, metadata: { range: next, surface: PROFILE_SURFACE } });
  };

  const onFilled = useCallback(
    (result: Extract<OrderResult, { ok: true }>) => {
      setBalanceCents(result.balanceCents);
      setPosition(result.position);
      // The banner's balance chip is a Server Component: ask the server for a fresh one.
      router.refresh();
    },
    [router],
  );

  return (
    <section aria-labelledby="score-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        title="Momentum score"
        meta={
          lastTickAt ? (
            <>
              Updated{" "}
              <time dateTime={lastTickAt} className="num">
                {relativeTime(lastTickAt, agesFrom)}
              </time>
            </>
          ) : (
            <Badge tone="warning" dot>
              Awaiting first tick
            </Badge>
          )
        }
      />
      <h2 id="score-heading" className="sr-only">
        Momentum score
      </h2>

      <Card className="flex flex-col gap-8 p-6 sm:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between md:gap-10">
          <div className="flex min-w-0 flex-col gap-4">
            <ScoreDisplay score={state.score} size="xl" flash />

            {change ? <ChangeLine change={change} rangeLabel={rangeLabel} /> : <p className="text-base text-fg-muted">No change recorded yet</p>}

            <MarketLine marketPrice={state.marketPrice} premiumCents={state.premiumCents} />
          </div>

          <TradeActions
            person={person}
            shortingEnabled={shortingEnabled}
            buyCents={quote.buyCents}
            sellCents={quote.sellCents}
            viewer={viewer}
            availability={availability}
            onTrade={setSheet}
            className="hidden md:flex"
          />
        </div>

        <AvailabilityNotice availability={availability} personName={person.displayName} />

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <p className="shrink-0 whitespace-nowrap text-label text-fg-muted">Score history</p>
            <RangeToggle value={range} available={available} onChange={onRange} />
          </div>
          <ScoreChart
            points={points}
            range={range ?? "1h"}
            revertTarget={person.revertTarget}
            personName={person.displayName}
            version={state.version}
            cadenceMs={live?.cadenceMs}
          />
        </div>
      </Card>

      {viewer.signedIn ? <PositionCard position={position} buyCents={quote.buyCents} sellCents={quote.sellCents} premiumCents={state.premiumCents} /> : null}

      {/* The bar is fixed above the tab bar; while the sheet is up it would sit over the sheet, so it steps aside. */}
      {sheet === null ? (
        <TradeBar person={person} shortingEnabled={shortingEnabled} buyCents={quote.buyCents} sellCents={quote.sellCents} viewer={viewer} availability={availability} onTrade={setSheet} />
      ) : null}

      {viewer.signedIn && sheet !== null ? (
        <TradeSheet
          key={sheet}
          open
          side={sheet}
          person={{ id: person.id, slug: person.slug, displayName: person.displayName }}
          book={book}
          marketPrice={state.marketPrice}
          availability={availability}
          balanceCents={balanceCents ?? cents(0)}
          position={position}
          shortingEnabled={shortingEnabled}
          toleranceCents={toleranceCents}
          minOrderCents={minOrderCents}
          loggingEnabled={loggingEnabled}
          surface={PROFILE_SURFACE}
          onClose={() => setSheet(null)}
          onFilled={onFilled}
        />
      ) : null}
    </section>
  );
}
