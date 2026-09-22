"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { RANGES, defaultRange, formatSignedPercent, periodChange, rangeAvailable, type PeriodChange, type PersonProfile, type RangeKey } from "@/lib/person/profile-model";
import type { OrderSide } from "@/lib/trading/direction";
import { EMPTY_POSITION, cents, quoteFromScore, type Cents, type OrderResult, type PositionSummary, type ViewerTradingState } from "@/lib/trading/model";
import { PositionCard } from "@/components/trade/position-card";
import { TradeSheet } from "@/components/trade/trade-sheet";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { directionAtPrecision, directionIcon, directionLabels, directionTone, formatChange } from "@/components/ui/direction-indicator";
import { SectionHeader } from "@/components/ui/page-header";
import { ScoreDisplay } from "@/components/ui/score-display";

import { RangeToggle } from "./range-toggle";
import { ScoreChart } from "./score-chart";
import { TradeActions, TradeBar } from "./trade-bar";
import { useLiveSeries, type LiveSeriesOptions } from "./use-live-series";
import { PROFILE_SURFACE, logProfileEvent } from "./use-profile-logging";

/**
 * The hero: the Momentum Score, the change over the selected range beneath
 * it, and the score line with its range toggle. One panel, because the
 * number and the line are one reading. On desktop the Buy / Sell entry sits
 * beside the score; on mobile it is the bar fixed above the tab bar
 * (rendered here so it shares the live quotes). The viewer's position, the
 * trade sheet and the balance it shows all live here too, so a fill updates
 * every one of them without a reload.
 *
 * WHAT PHASE 26 TOOK OUT. The card carried two rows of small statistics —
 * Gravity target, Spread, Buy, Sell — and each was a problem of its own.
 * Buy and Sell repeated the trade bar that is on screen at all times, in a
 * second format. Spread showed the HALF-spread while the trade sheet showed
 * the full one, so the platform stated two different spreads; the sheet,
 * where a spread is actually charged, is now the only place it is stated.
 * Gravity moved into the chart, where the target is a line on the same axis
 * as the score rather than a number the reader has to place themselves.
 * What is left is the score, its change, and the line.
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

/**
 * THE CHANGE, AS ONE STATEMENT (Phase 26): "↗ +0.3 (+0.59%) · 1H".
 *
 * It used to be three pieces that happened to sit next to each other — the
 * arrow and the points figure at one size and weight, the percentage at
 * another, the period smaller again — and because the arrow was an inline
 * icon inside the first piece it pushed that figure off the baseline the
 * percentage sat on. Three sizes and two baselines for one sentence.
 *
 * So both figures are now one text node: the same size, the same weight,
 * one line box, and therefore one baseline by construction rather than by
 * alignment. The arrow is centred on that line rather than set in it, the
 * period label stays neutral, and direction colour lands on the figures
 * only. The colour and the arrow follow the points figure at the precision
 * it is DISPLAYED at, which is the Phase 19+ rule and the same call the
 * shared DirectionIndicator makes, so a reading that shows "0.0" is never
 * coloured or arrowed as a move.
 *
 * Set in Inter with tabular figures to match the hero score above it. This
 * is the second documented exception to "mono for numerics" (Portfolio is
 * the first); the chart's axis and time labels below it stay mono.
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

            {change ? <ChangeLine change={change} rangeLabel={rangeLabel} /> : <p className="text-base text-fg-muted">No change recorded yet</p>}
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
