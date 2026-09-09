"use client";

import { useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { RANGES, defaultRange, formatSignedPercent, periodChange, rangeAvailable, type PersonProfile, type RangeKey } from "@/lib/person/profile-model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DirectionIndicator } from "@/components/ui/direction-indicator";
import { SectionHeader } from "@/components/ui/page-header";
import { ScoreDisplay } from "@/components/ui/score-display";

import { RangeToggle } from "./range-toggle";
import { ScoreChart } from "./score-chart";
import { TradeActions } from "./trade-bar";
import { PROFILE_SURFACE, logProfileEvent } from "./use-profile-logging";

/**
 * The hero: the Momentum Score, the change over the selected range beneath
 * it, the gravity target and spread in small type, and the score line with
 * its range toggle. One panel, because the number and the line are one
 * reading. On desktop the Buy / Sell entry sits beside the score.
 */
export interface ScorePanelProps {
  profile: PersonProfile;
  loggingEnabled: boolean;
  /** Server render time, so relative ages agree between server and client. */
  renderedAt: number;
  className?: string;
}

const changeTones = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-neutral",
} as const;

export function ScorePanel({ profile, loggingEnabled, renderedAt, className }: ScorePanelProps) {
  const { person, series, latestTick } = profile;

  const available = useMemo(
    () => Object.fromEntries(RANGES.map((range) => [range.key, rangeAvailable(series[range.key])])) as Record<RangeKey, boolean>,
    [series],
  );
  const [range, setRange] = useState<RangeKey | null>(() => defaultRange(series));
  const points = useMemo(() => (range ? series[range] : []), [range, series]);
  const change = useMemo(() => periodChange(points), [points]);
  const rangeLabel = RANGES.find((definition) => definition.key === range)?.label ?? null;

  const onRange = (next: RangeKey) => {
    setRange(next);
    logProfileEvent(loggingEnabled, { eventType: "change_range", personId: person.id, metadata: { range: next, surface: PROFILE_SURFACE } });
  };

  return (
    <section aria-labelledby="score-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        title="Momentum score"
        meta={
          latestTick ? (
            <>
              Updated{" "}
              <time dateTime={latestTick.at} className="num">
                {relativeTime(latestTick.at, renderedAt)}
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
            <ScoreDisplay score={person.score} size="xl" />

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
                <dd className="num text-fg-secondary">{person.spread.toFixed(1)}</dd>
              </div>
              {person.buyPrice !== null ? (
                <div className="flex items-baseline gap-2">
                  <dt>Buy</dt>
                  <dd className="num text-fg-secondary">{person.buyPrice.toFixed(1)}</dd>
                </div>
              ) : null}
              {person.sellPrice !== null ? (
                <div className="flex items-baseline gap-2">
                  <dt>Sell</dt>
                  <dd className="num text-fg-secondary">{person.sellPrice.toFixed(1)}</dd>
                </div>
              ) : null}
            </dl>
          </div>

          <TradeActions person={person} className="hidden md:flex" />
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <p className="shrink-0 whitespace-nowrap text-label text-fg-muted">Score history</p>
            <RangeToggle value={range} available={available} onChange={onRange} />
          </div>
          <ScoreChart points={points} range={range ?? "1h"} revertTarget={person.revertTarget} personName={person.displayName} />
        </div>
      </Card>
    </section>
  );
}
