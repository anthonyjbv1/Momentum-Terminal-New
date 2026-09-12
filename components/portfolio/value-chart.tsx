"use client";

import { useCallback } from "react";

import { formatCents } from "@/lib/money";
import { valueDomain, type TimedScore } from "@/lib/person/chart-math";
import { LIVE_TICK_MS } from "@/lib/person/live-series";
import type { RangeKey, SeriesPoint } from "@/lib/person/profile-model";
import { valueRangeFloorCents, type PortfolioState } from "@/lib/portfolio/model";
import { ChartEmpty, LiveLineChart } from "@/components/charts/live-line-chart";

/**
 * Total portfolio value over time: the 6c+ live line with money's rules.
 * The plotted value is integer cents straight from portfolio_history; the
 * axis shows whole dollars where the grid allows and cents where it does
 * not; the vertical floor is a fraction of the latest value
 * (VALUE_RANGE_FLOOR_RATIO); and the paper credit is the dashed reference,
 * so above the line is profit and below it loss. Everything about the
 * cadence, the breath, the tick reveal and reduced motion is shared with
 * the score chart.
 */
export interface ValueChartProps {
  points: SeriesPoint[];
  range: RangeKey;
  /** The paper credit granted so far: the reference line. */
  paperCreditCents: number;
  state: PortfolioState;
  version?: number;
  cadenceMs?: number;
  className?: string;
}

const wholeDollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Axis labels: "$9,980" on a dollar grid, "$9,980.50" on a finer one. */
export function formatAxisCents(cents: number): string {
  const rounded = Math.round(cents);
  return rounded % 100 === 0 ? wholeDollars.format(rounded / 100) : formatCents(rounded);
}

const AXIS_WIDTH = 66;

export function ValueChart({ points, range, paperCreditCents, state, version = 0, cadenceMs = LIVE_TICK_MS, className }: ValueChartProps) {
  const domain = useCallback(
    (timed: TimedScore[]) => {
      const latest = timed.length > 0 ? timed[timed.length - 1].score : paperCreditCents;
      return valueDomain(timed, valueRangeFloorCents(latest), paperCreditCents, { lo: 0, hi: Math.max(paperCreditCents * 2, 1) });
    },
    [paperCreditCents],
  );
  const describe = useCallback(
    ({ first, last, min, max, rangeLabel }: { first: TimedScore; last: TimedScore; min: TimedScore; max: TimedScore; rangeLabel: string }) =>
      `Portfolio value over ${rangeLabel}: from ${formatCents(first.score)} to ${formatCents(last.score)}, low ${formatCents(min.score)}, high ${formatCents(max.score)}. Paper money.`,
    [],
  );

  const empty =
    state === "never_traded" ? (
      <ChartEmpty title="No value history yet" detail="The line begins with your first trade." />
    ) : (
      <ChartEmpty title="No value history yet" detail="The line begins with the Engine’s first tick." />
    );

  return (
    <LiveLineChart
      points={points}
      range={range}
      version={version}
      cadenceMs={cadenceMs}
      domain={domain}
      reference={{ value: paperCreditCents, label: "Paper credit" }}
      formatAxis={formatAxisCents}
      formatValue={(value) => formatCents(Math.round(value))}
      describe={describe}
      empty={empty}
      axisWidth={AXIS_WIDTH}
      className={className}
    />
  );
}
