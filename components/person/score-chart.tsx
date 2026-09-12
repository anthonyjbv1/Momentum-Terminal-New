"use client";

import { useCallback } from "react";

import { scoreDomain, type TimedScore } from "@/lib/person/chart-math";
import { LIVE_TICK_MS } from "@/lib/person/live-series";
import type { RangeKey, SeriesPoint } from "@/lib/person/profile-model";
import { ChartEmpty, LiveLineChart } from "@/components/charts/live-line-chart";

/**
 * The score line (6c+): the live line chart with the score's own rules.
 * One decimal on the axis and the crosshair, the Y_RANGE_FLOOR of two
 * points, and the gravity target as the dashed reference. Everything about
 * the cadence, the breath, the tick reveal and reduced motion lives in
 * components/charts/live-line-chart.tsx, shared with the portfolio.
 */
export interface ScoreChartProps {
  points: SeriesPoint[];
  range: RangeKey;
  revertTarget: number;
  personName: string;
  /** Bumps when live ticks arrive; each change animates the reveal. */
  version?: number;
  /** The Engine's cadence, for the breath. Defaults to the real 30 seconds. */
  cadenceMs?: number;
  className?: string;
}

const oneDecimal = (value: number) => value.toFixed(1);

export function ScoreChart({ points, range, revertTarget, personName, version = 0, cadenceMs = LIVE_TICK_MS, className }: ScoreChartProps) {
  const domain = useCallback((timed: TimedScore[]) => scoreDomain(timed, revertTarget), [revertTarget]);
  const describe = useCallback(
    ({ first, last, min, max, rangeLabel }: { first: TimedScore; last: TimedScore; min: TimedScore; max: TimedScore; rangeLabel: string }) =>
      `${personName}, momentum score over ${rangeLabel}: from ${first.score.toFixed(1)} to ${last.score.toFixed(1)}, low ${min.score.toFixed(1)}, high ${max.score.toFixed(1)}.`,
    [personName],
  );

  return (
    <LiveLineChart
      points={points}
      range={range}
      version={version}
      cadenceMs={cadenceMs}
      domain={domain}
      reference={{ value: revertTarget, label: "Gravity target" }}
      formatAxis={oneDecimal}
      formatValue={oneDecimal}
      describe={describe}
      empty={<ChartEmpty title="No score history yet" detail="The line begins with the Engine’s first tick." />}
      className={className}
    />
  );
}
