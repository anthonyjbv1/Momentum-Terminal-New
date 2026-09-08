"use client";

import { cn } from "@/lib/cn";
import { formatCountdown, useEngineClock } from "@/components/engine/engine-clock";

/**
 * The 30-second countdown to the next Engine tick. Lives in the top banner
 * on every page and modal; the large size is for tick-centred moments.
 *
 * A progress ring fills as the cycle runs; digits are the terminal clock
 * face. In the last seconds the ring and digits turn red and pulse.
 */
export type CountdownTimerSize = "banner" | "lg";

const RING_RADIUS = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const timerSizes: Record<CountdownTimerSize, { ring: string; digits: string; gap: string; stroke: number }> = {
  banner: { ring: "size-7", digits: "text-sm", gap: "gap-2", stroke: 2.5 },
  lg: { ring: "size-16", digits: "text-3xl", gap: "gap-4", stroke: 2 },
};

export interface CountdownTimerProps {
  size?: CountdownTimerSize;
  /** Show the "next tick" caption (hidden on the smallest screens by default). */
  showLabel?: boolean;
  className?: string;
}

export function CountdownTimer({ size = "banner", showLabel = true, className }: CountdownTimerProps) {
  const { secondsLeft, progress, urgent, justTicked } = useEngineClock();
  const dims = timerSizes[size];
  const offset = RING_CIRCUMFERENCE * (1 - progress);

  return (
    <div
      className={cn("flex items-center", dims.gap, urgent ? "text-negative" : "text-positive", className)}
      role="timer"
      aria-live="off"
      aria-label={`Next Engine tick in ${secondsLeft} seconds`}
      title="Momentum Scores update every 30 seconds"
    >
      <svg viewBox="0 0 24 24" className={cn(dims.ring, "shrink-0 -rotate-90", urgent && "animate-pulse-soft")} aria-hidden>
        <circle cx="12" cy="12" r={RING_RADIUS} fill="none" className="stroke-line-strong" strokeWidth={dims.stroke} />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          className="stroke-current"
          strokeWidth={dims.stroke}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          style={{ transition: justTicked ? "none" : "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <div className="flex flex-col leading-none">
        <span className={cn("num font-semibold text-fg", dims.digits, urgent && "text-negative")}>{formatCountdown(secondsLeft)}</span>
        {showLabel ? <span className="text-label mt-0.5 hidden text-fg-muted sm:block">Next tick</span> : null}
      </div>
    </div>
  );
}
