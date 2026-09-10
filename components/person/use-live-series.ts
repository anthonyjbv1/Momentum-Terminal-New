"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { msUntilNextTick } from "@/components/engine/engine-clock";
import { LIVE_TICK_MS, foldTicksIntoRanges, latestTickAt, type LiveTick } from "@/lib/person/live-series";
import type { ProfilePerson, SeriesByRange } from "@/lib/person/profile-model";

/**
 * Keeps a person's score and series current on the Engine's cadence.
 *
 * The clock is the same wall-aligned 30-second clock the banner counts down
 * on. A little after each boundary (the Engine needs a moment to persist)
 * the hook asks the live endpoint for ticks newer than the last one it
 * holds; if nothing has landed yet it asks once more a few seconds later,
 * then waits for the next boundary. A tab coming back from the background
 * catches up immediately. Every answer that carries new ticks bumps
 * `version`, which is what the chart animates on.
 *
 * With the Engine dormant every poll comes back empty and nothing here
 * changes: the page stays exactly as the server rendered it.
 */

/** How long after the tick boundary to ask, so the Engine has written the tick. */
export const LIVE_POLL_DELAY_MS = 2_500;
/** One follow-up when the boundary poll came back empty. */
export const LIVE_RETRY_DELAY_MS = 7_500;

export interface LiveState {
  series: SeriesByRange;
  score: number;
  lastTickAt: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  spread: number;
  /** Increments whenever new ticks arrive. */
  version: number;
  /** When the state last changed, for relative ages. */
  updatedAt: number | null;
}

interface LiveResponse {
  score: number;
  lastTickAt: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  spread: number;
  ticks: LiveTick[];
}

export interface LiveSeriesOptions {
  /** Defaults to /api/person/[slug]/live. */
  endpoint?: string;
  /** The Engine's cadence; defaults to the real 30 seconds. */
  cadenceMs?: number;
  /** Off switch (e.g. when the person has been deactivated). */
  enabled?: boolean;
}

export function useLiveSeries(person: ProfilePerson, initial: SeriesByRange, options: LiveSeriesOptions = {}): LiveState {
  const endpoint = options.endpoint ?? `/api/person/${person.slug}/live`;
  const cadenceMs = options.cadenceMs ?? LIVE_TICK_MS;
  const enabled = options.enabled ?? true;

  const [state, setState] = useState<LiveState>(() => ({
    series: initial,
    score: person.score,
    lastTickAt: person.lastTickAt,
    buyPrice: person.buyPrice,
    sellPrice: person.sellPrice,
    spread: person.spread,
    version: 0,
    updatedAt: null,
  }));
  const cursor = useRef<string | null>(latestTickAt(initial));
  const inFlight = useRef(false);

  const poll = useCallback(async (): Promise<boolean> => {
    if (inFlight.current || typeof document === "undefined" || document.visibilityState === "hidden") return false;
    inFlight.current = true;
    try {
      const url = new URL(endpoint, window.location.origin);
      if (cursor.current) url.searchParams.set("after", cursor.current);
      const response = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return false;
      const body = (await response.json()) as Partial<LiveResponse>;
      const ticks = Array.isArray(body.ticks) ? body.ticks : [];
      const score = typeof body.score === "number" && Number.isFinite(body.score) ? body.score : null;
      if (ticks.length > 0) cursor.current = ticks[ticks.length - 1].at;

      setState((previous) => {
        const scoreChanged = score !== null && score !== previous.score;
        if (ticks.length === 0 && !scoreChanged) return previous;
        const now = Date.now();
        return {
          series: ticks.length > 0 ? foldTicksIntoRanges(previous.series, ticks, now) : previous.series,
          score: score ?? previous.score,
          lastTickAt: body.lastTickAt ?? previous.lastTickAt,
          buyPrice: typeof body.buyPrice === "number" ? body.buyPrice : previous.buyPrice,
          sellPrice: typeof body.sellPrice === "number" ? body.sellPrice : previous.sellPrice,
          spread: typeof body.spread === "number" ? body.spread : previous.spread,
          version: previous.version + (ticks.length > 0 ? 1 : 0),
          updatedAt: now,
        };
      });
      return ticks.length > 0;
    } catch {
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [endpoint]);

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

  return state;
}
