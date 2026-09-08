"use client";

import { cn } from "@/lib/cn";
import { formatCountdown, useEngineClock } from "@/components/engine/engine-clock";

/**
 * The countdown to the next Engine tick. On every page and modal, but it
 * whispers: small monospaced digits over a hairline that fills as the
 * 30-second cycle runs. Grey most of the time, white in the final seconds,
 * never coloured — green and red belong to direction alone.
 */
export type CountdownTimerSize = "banner" | "lg";

const timerSizes: Record<CountdownTimerSize, { digits: string; track: string; gap: string }> = {
  banner: { digits: "text-xs", track: "h-px w-9", gap: "gap-1.5" },
  lg: { digits: "text-3xl", track: "h-0.5 w-28", gap: "gap-3" },
};

export interface CountdownTimerProps {
  size?: CountdownTimerSize;
  /** Show a "next tick" caption under the digits (off in the banner). */
  showLabel?: boolean;
  className?: string;
}

export function CountdownTimer({ size = "banner", showLabel = false, className }: CountdownTimerProps) {
  const { secondsLeft, progress, urgent, justTicked } = useEngineClock();
  const dims = timerSizes[size];

  return (
    <div
      className={cn("flex flex-col items-end", dims.gap, className)}
      role="timer"
      aria-live="off"
      aria-label={`Next Engine tick in ${secondsLeft} seconds`}
      title="Momentum Scores update every 30 seconds"
    >
      <span
        className={cn(
          "num font-medium leading-none transition-colors duration-300",
          dims.digits,
          urgent ? "text-fg" : "text-fg-muted",
          justTicked && "animate-tick-flash",
        )}
      >
        {formatCountdown(secondsLeft)}
      </span>
      <span className={cn("block overflow-hidden rounded-full bg-line", dims.track)} aria-hidden>
        <span
          className={cn("block h-full rounded-full", urgent ? "bg-fg" : "bg-fg-muted")}
          style={{ width: `${Math.round(progress * 1000) / 10}%`, transition: justTicked ? "none" : "width 1s linear, background-color 300ms" }}
        />
      </span>
      {showLabel ? <span className="text-xs text-fg-faint">next tick</span> : null}
    </div>
  );
}
