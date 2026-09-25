"use client";

import { useCallback, useMemo } from "react";

import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import { marketInLine, scoreDomain, type TimedScore } from "@/lib/person/chart-math";
import { LIVE_TICK_MS } from "@/lib/person/live-series";
import type { RangeKey, SeriesPoint } from "@/lib/person/profile-model";
import { pointsToCents } from "@/lib/trading/model";
import { ChartEmpty, LiveLineChart } from "@/components/charts/live-line-chart";

/**
 * The score line (6c+): the live line chart with the score's own rules.
 * One decimal on the axis and the crosshair, the Y_RANGE_FLOOR of half a
 * point, and the baseline (Gravity's target) as the dashed reference. Everything about
 * the cadence, the breath, the tick reveal and reduced motion lives in
 * components/charts/live-line-chart.tsx, shared with the portfolio.
 *
 * THE BASELINE READS OFF THE CHART (Phase 26; named in Phase 29c). What the
 * code calls the revert target — where Gravity pulls — is the person's
 * BASELINE to a reader, and that is the only word the page uses for it: the
 * dashed line carries "Baseline 55.0" at the right edge, where the line ends
 * and the reader's eye already is, and out of range the edge note reads
 * "Baseline 55.0 above this range".
 *
 * THE MARKET PRICE IS THE SECOND LINE (Phase 29). Where the series carries
 * it, the market price (score + premium) is drawn beside the score in the
 * muted ink, on the same axis: one point is one dollar, so the gap between
 * the two lines IS the premium, read directly. Two series means a legend,
 * and the crosshair names both values — the score in points, the market
 * price in dollars, because a score is points and anything you can trade at
 * is money (Phase 26). The baseline line stays.
 *
 * ONE LINE WHEN THEY COINCIDE (Phase 29c). While the premium is at most a
 * cent across the whole visible window (marketInLine), the two are one line.
 * The legend says so — "Market price · in line with the data", with no
 * swatch of its own — and the chart draws only the score: at the half-point
 * floor a cent is still a few pixels, and a grey edge peeking out from under
 * the score would read as the second line the legend says is not there. The
 * crosshair keeps naming both values. Once they part by more than a cent,
 * the second line and its swatch come back.
 *
 * A display-only index (Phase 29b) passes showMarket={false}: the score is
 * the only line, with no legend, because it is the only number the page shows.
 */
export interface ScoreChartProps {
  points: SeriesPoint[];
  range: RangeKey;
  revertTarget: number;
  personName: string;
  /** Draw the market price as the second line where the series carries it. False on a display-only index. */
  showMarket?: boolean;
  /** Bumps when live ticks arrive; each change animates the reveal. */
  version?: number;
  /** The Engine's cadence, for the breath. Defaults to the real 30 seconds. */
  cadenceMs?: number;
  className?: string;
}

const oneDecimal = (value: number) => value.toFixed(1);
const asMoney = (value: number) => formatCents(pointsToCents(value));
const marketOf = (point: SeriesPoint) => point.market;

export function ScoreChart({ points, range, revertTarget, personName, showMarket = true, version = 0, cadenceMs = LIVE_TICK_MS, className }: ScoreChartProps) {
  const domain = useCallback((timed: TimedScore[]) => scoreDomain(timed, revertTarget), [revertTarget]);
  const describe = useCallback(
    ({ first, last, min, max, rangeLabel }: { first: TimedScore; last: TimedScore; min: TimedScore; max: TimedScore; rangeLabel: string }) =>
      `${personName}, momentum score over ${rangeLabel}: from ${first.score.toFixed(1)} to ${last.score.toFixed(1)}, low ${min.score.toFixed(1)}, high ${max.score.toFixed(1)}.`,
    [personName],
  );
  // The market line is drawn when the series carries it on at least two points.
  const hasMarket = useMemo(() => showMarket && points.filter((point) => typeof point.market === "number").length >= 2, [showMarket, points]);
  const inLine = useMemo(() => hasMarket && marketInLine(points), [hasMarket, points]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {hasMarket ? (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs text-fg-muted" aria-label="Lines on the chart">
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-4 rounded-full bg-fg" />
            Momentum Score
          </li>
          {inLine ? (
            <li>Market price · in line with the data</li>
          ) : (
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-px w-4 rounded-full bg-fg-muted" />
              Market price
            </li>
          )}
        </ul>
      ) : null}
      <LiveLineChart
        points={points}
        range={range}
        version={version}
        cadenceMs={cadenceMs}
        domain={domain}
        reference={{ value: revertTarget, label: "Baseline", anchor: "end" }}
        secondary={hasMarket ? { label: "Market", value: marketOf, formatValue: asMoney, drawn: !inLine } : null}
        primaryLabel="Score"
        formatAxis={oneDecimal}
        formatValue={oneDecimal}
        describe={describe}
        empty={<ChartEmpty title="No score history yet" detail="The line begins with the Engine’s first tick." />}
      />
    </div>
  );
}
