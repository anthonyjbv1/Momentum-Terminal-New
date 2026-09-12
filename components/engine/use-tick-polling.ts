"use client";

import { useEffect } from "react";

import { LIVE_TICK_MS } from "@/lib/person/live-series";

import { msUntilNextTick } from "./engine-clock";

/**
 * Polling on the Engine's cadence, shared by every live surface.
 *
 * The clock is the same wall-aligned 30-second clock the banner counts down
 * on. A little after each boundary (the Engine needs a moment to persist)
 * `poll` runs; if it reports nothing landed it runs once more a few seconds
 * later, then waits for the next boundary. A tab coming back from the
 * background polls immediately. `poll` resolves true when something new
 * arrived, and must never throw.
 */

/** How long after the tick boundary to ask, so the Engine has written the tick. */
export const LIVE_POLL_DELAY_MS = 2_500;
/** One follow-up when the boundary poll came back empty. */
export const LIVE_RETRY_DELAY_MS = 7_500;

export interface TickPollingOptions {
  /** The Engine's cadence; defaults to the real 30 seconds. */
  cadenceMs?: number;
  /** Off switch. */
  enabled?: boolean;
}

export function useTickPolling(poll: () => Promise<boolean>, { cadenceMs = LIVE_TICK_MS, enabled = true }: TickPollingOptions = {}): void {
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        if (!stopped) fn();
      }, ms);
      timers.add(handle);
    };

    const schedule = () => {
      const wait = msUntilNextTick(Date.now(), cadenceMs / 1000) + LIVE_POLL_DELAY_MS;
      later(async () => {
        const landed = await poll();
        if (!landed) later(() => void poll(), LIVE_RETRY_DELAY_MS);
        schedule();
      }, wait);
    };
    schedule();

    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      for (const handle of timers) clearTimeout(handle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, cadenceMs, poll]);
}
