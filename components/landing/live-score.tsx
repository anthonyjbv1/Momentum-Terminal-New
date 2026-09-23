"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { FEATURED, HERO } from "@/lib/landing/copy";
import { CountdownTimer } from "@/components/ui/countdown-timer";
import { directionAtPrecision, directionTone, formatChange } from "@/components/ui/direction-indicator";
import { LocalTime } from "@/components/ui/local-time";
import { splitScore } from "@/components/ui/score-display";

import { useFeatured } from "./use-featured";

/**
 * THE HERO NUMBER: the founder's Momentum Score, as the platform holds it,
 * moving on the Engine's 30-second cadence. The countdown beside it is the
 * app's own CountdownTimer on the app's own clock module, so a visitor
 * holding the landing page next to a member holding a profile sees the same
 * seconds run down and the same tick land.
 *
 * Three states, all honest:
 *   live        — the feed answers and the tick is recent: "Live · next tick 0:12".
 *   last known  — the feed has failed or the tick is old: the same number,
 *                 labelled "Last known · as of <time>". Nothing is invented.
 *   unavailable — no number has ever arrived: no number is shown.
 *
 * The change chips take colour from direction, as the design system allows,
 * at the precision they are shown to (a 0.0 is never coloured). The score
 * itself stays white.
 */

const CHANGE_PRECISION = 1;

export function LiveScore({ className }: { className?: string }) {
  const { payload, live, version } = useFeatured();
  const flashKey = useFlashKey(version);

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <span className="text-label text-fg-muted">{HERO.scoreLabel}</span>
        <Heartbeat live={live} lastTickAt={payload?.lastTickAt ?? null} />
      </div>

      {payload ? (
        <ScoreFigure score={payload.score} flashKey={flashKey} />
      ) : (
        <div className="flex flex-col gap-2 py-4" role="status">
          <p className="text-2xl font-semibold tracking-tight text-fg">{HERO.unavailable}</p>
          <p className="text-base text-fg-muted">{HERO.unavailableDetail}</p>
        </div>
      )}

      {payload ? (
        <dl className="grid grid-cols-3 gap-3 sm:gap-4">
          <ChangeChip label={HERO.change.h1} value={payload.change.h1} />
          <ChangeChip label={HERO.change.h24} value={payload.change.h24} />
          <ChangeChip label={HERO.change.d7} value={payload.change.d7} />
        </dl>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-line pt-5">
        <p className="text-base font-medium text-fg">
          {FEATURED.name}
          <span className="text-fg-muted"> · {FEATURED.role}</span>
        </p>
        <p className="text-sm text-fg-muted">{FEATURED.consent}</p>
      </div>
    </div>
  );
}

/**
 * The flash re-runs only when a NEWER tick lands (the provider bumps
 * `version`), never on the first paint: a page that lights up on arrival
 * claims a change that did not happen.
 */
function useFlashKey(version: number): number | null {
  const [key, setKey] = useState<number | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setKey(version);
  }, [version]);
  return key;
}

function ScoreFigure({ score, flashKey }: { score: number; flashKey: number | null }) {
  const { whole, fraction } = splitScore(score);
  return (
    <p className="num flex items-baseline gap-1 font-semibold leading-none tracking-tighter text-fg" aria-live="polite" aria-atomic="true">
      <span key={flashKey ?? "first"} className={cn("text-7xl sm:text-8xl", flashKey !== null && "animate-tick-flash")} aria-label={`Momentum Score ${whole}.${fraction}`}>
        {whole}
      </span>
      <span className="text-3xl font-medium text-fg-muted sm:text-4xl" aria-hidden>
        .{fraction}
      </span>
    </p>
  );
}

function Heartbeat({ live, lastTickAt }: { live: boolean; lastTickAt: string | null }) {
  if (live) {
    return (
      <span className="flex items-center gap-2 whitespace-nowrap text-sm text-fg-muted">
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-fg opacity-40" />
          <span className="relative inline-flex size-2 rounded-full bg-fg" />
        </span>
        <span className="font-medium text-fg-secondary">{HERO.live}</span>
        <span aria-hidden>·</span>
        <span className="flex items-center gap-1.5">
          {HERO.nextTick} <CountdownTimer size="banner" className="items-start" />
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 whitespace-nowrap text-sm text-fg-muted">
      <span className="inline-flex size-2 rounded-full bg-fg-faint" aria-hidden />
      <span className="font-medium text-fg-secondary">{HERO.lastKnown}</span>
      {lastTickAt ? (
        <>
          <span aria-hidden>·</span>
          <span>
            {HERO.asOf} <LocalTime iso={lastTickAt} className="num" />
          </span>
        </>
      ) : null}
    </span>
  );
}

function ChangeChip({ label, value }: { label: string; value: number | null }) {
  const direction = directionAtPrecision(value, CHANGE_PRECISION);
  const known = value !== null;
  return (
    <div className="flex flex-col justify-between gap-1 rounded-xl bg-surface-raised px-3 py-3 sm:px-4">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={cn("num text-lg font-medium leading-none sm:text-xl", known ? directionTone[direction] : "text-fg-faint")} aria-label={known ? undefined : "No reading yet"}>
        {known ? formatChange(value, CHANGE_PRECISION) : "—"}
      </dd>
    </div>
  );
}
