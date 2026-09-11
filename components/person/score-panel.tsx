"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { RANGES, defaultRange, formatSignedPercent, periodChange, rangeAvailable, type PersonProfile, type RangeKey } from "@/lib/person/profile-model";
import type { OrderSide } from "@/lib/trading/direction";
import { EMPTY_POSITION, cents, quoteFromScore, type Cents, type OrderResult, type PositionSummary, type ViewerTradingState } from "@/lib/trading/model";
import { PositionCard } from "@/components/trade/position-card";
import { TradeSheet } from "@/components/trade/trade-sheet";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DirectionIndicator } from "@/components/ui/direction-indicator";
import { SectionHeader } from "@/components/ui/page-header";
import { ScoreDisplay } from "@/components/ui/score-display";

import { RangeToggle } from "./range-toggle";
import { ScoreChart } from "./score-chart";
import { TradeActions, TradeBar } from "./trade-bar";
import { useLiveSeries, type LiveSeriesOptions } from "./use-live-series";
import { PROFILE_SURFACE, logProfileEvent } from "./use-profile-logging";

/**
 * The hero: the Momentum Score, the change over the selected range beneath
 * it, the gravity target and spread in small type, and the score line with
 * its range toggle. One panel, because the number and the line are one
 * reading. On desktop the Buy / Sell entry sits beside the score; on mobile
 * it is the bar fixed above the tab bar (rendered here so it shares the live
 * quotes). The viewer's position, the trade sheet and the balance it shows
 * all live here too, so a fill updates every one of them without a reload.
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
  /** Feed overrides for verification harnesses; production uses the defaults. */
  live?: LiveSeriesOptions;
  className?: string;
}

const changeTones = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-neutral",
} as const;

export function ScorePanel({ profile, loggingEnabled, renderedAt, shortingEnabled, viewer: initialViewer, toleranceCents, live, className }: ScorePanelProps) {
  const { person, series: initialSeries, latestTick } = profile;
  const router = useRouter();
  const state = useLiveSeries(person, initialSeries, live);
  const series = state.series;

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

  // Live quotes in cents, from the same score + spread the page shows.
  const quote = useMemo(() => quoteFromScore(state.score, state.spread), [state.score, state.spread]);

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

            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {change ? (
                <>
                  <DirectionIndicator change={change.change} size="lg" />
                  {change.percent !== null ? <span className={cn("num text-base", changeTones[change.direction])}>{formatSignedPercent(change.percent)}</span> : null}
                  <span className="text-sm text-fg-muted">{rangeLabel}</span>
                </>
              ) : (
                <span className="text-sm text-fg-muted">No change recorded yet</span>
              )}
            </div>

            <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-fg-muted">
              <div className="flex items-baseline gap-2">
                <dt>Gravity target</dt>
                <dd className="num text-fg-secondary">{person.revertTarget.toFixed(1)}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt>Spread</dt>
                <dd className="num text-fg-secondary">{state.spread.toFixed(1)}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt>Buy</dt>
                <dd className="num text-fg-secondary">{(quote.buyCents / 100).toFixed(1)}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt>Sell</dt>
                <dd className="num text-fg-secondary">{(quote.sellCents / 100).toFixed(1)}</dd>
              </div>
            </dl>
          </div>

          <TradeActions
            person={person}
            shortingEnabled={shortingEnabled}
            buyCents={quote.buyCents}
            sellCents={quote.sellCents}
            viewer={viewer}
            onTrade={setSheet}
            className="hidden md:flex"
          />
        </div>

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

      {viewer.signedIn ? <PositionCard position={position} buyCents={quote.buyCents} sellCents={quote.sellCents} /> : null}

      {/* The bar is fixed above the tab bar; while the sheet is up it would sit over the sheet, so it steps aside. */}
      {sheet === null ? (
        <TradeBar person={person} shortingEnabled={shortingEnabled} buyCents={quote.buyCents} sellCents={quote.sellCents} viewer={viewer} onTrade={setSheet} />
      ) : null}

      {viewer.signedIn && sheet !== null ? (
        <TradeSheet
          key={sheet}
          open
          side={sheet}
          person={{ id: person.id, slug: person.slug, displayName: person.displayName }}
          buyCents={quote.buyCents}
          sellCents={quote.sellCents}
          balanceCents={balanceCents ?? cents(0)}
          position={position}
          shortingEnabled={shortingEnabled}
          toleranceCents={toleranceCents}
          loggingEnabled={loggingEnabled}
          surface={PROFILE_SURFACE}
          onClose={() => setSheet(null)}
          onFilled={onFilled}
        />
      ) : null}
    </section>
  );
}
