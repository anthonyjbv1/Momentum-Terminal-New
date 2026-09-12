"use client";

import { useCallback, useRef, useState } from "react";

import { useTickPolling } from "@/components/engine/use-tick-polling";
import { LIVE_TICK_MS, foldTicksIntoRanges, latestTickAt } from "@/lib/person/live-series";
import type { SeriesByRange } from "@/lib/person/profile-model";
import { toPortfolioSummary, toValuePoint, type PortfolioSummary } from "@/lib/portfolio/model";

/**
 * Keeps the portfolio current on the Engine's cadence.
 *
 * On the same wall-aligned schedule as the profile (useTickPolling), the page
 * asks /api/portfolio/live for the summary as the server computes it now and
 * for value points recorded after the last one it holds. New points fold
 * into every chart range the way the database bucketed them and bump
 * `version`, which the chart animates on; the summary replaces the figures
 * wholesale. Nothing is computed here: what the server sends is what shows.
 *
 * `refresh()` asks straight away, for the moment after a fill. With the
 * Engine dormant and no order placed, every poll comes back empty and the
 * page stays exactly as the server rendered it.
 */

export interface LivePortfolioState {
  summary: PortfolioSummary;
  series: SeriesByRange;
  /** Increments whenever new value points arrive. */
  version: number;
  /** When the state last changed. */
  updatedAt: number | null;
}

export interface LivePortfolioOptions {
  /** Defaults to /api/portfolio/live. */
  endpoint?: string;
  /** The Engine's cadence; defaults to the real 30 seconds. */
  cadenceMs?: number;
  enabled?: boolean;
}

interface LiveResponse {
  summary: unknown;
  points: unknown[];
}

export function useLivePortfolio(initialSummary: PortfolioSummary, initialSeries: SeriesByRange, options: LivePortfolioOptions = {}): LivePortfolioState & { refresh: () => Promise<boolean> } {
  const endpoint = options.endpoint ?? "/api/portfolio/live";
  const cadenceMs = options.cadenceMs ?? LIVE_TICK_MS;
  const enabled = options.enabled ?? true;

  const [state, setState] = useState<LivePortfolioState>(() => ({ summary: initialSummary, series: initialSeries, version: 0, updatedAt: null }));
  const cursor = useRef<string | null>(latestTickAt(initialSeries));
  const inFlight = useRef(false);

  const fetchLive = useCallback(
    async (force: boolean): Promise<boolean> => {
      if (inFlight.current) return false;
      if (!force && (typeof document === "undefined" || document.visibilityState === "hidden")) return false;
      inFlight.current = true;
      try {
        const url = new URL(endpoint, window.location.origin);
        if (cursor.current) url.searchParams.set("after", cursor.current);
        const response = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return false;
        const body = (await response.json()) as Partial<LiveResponse>;
        const summary = toPortfolioSummary(body.summary);
        const points = (Array.isArray(body.points) ? body.points : []).map(toValuePoint).filter((point): point is NonNullable<typeof point> => point !== null);
        if (points.length > 0) cursor.current = points[points.length - 1].at;

        setState((previous) => {
          if (points.length === 0 && !force) return previous;
          const now = Date.now();
          return {
            summary: summary ?? previous.summary,
            series: points.length > 0 ? foldTicksIntoRanges(previous.series, points.map((point) => ({ at: point.at, score: point.valueCents })), now) : previous.series,
            version: previous.version + (points.length > 0 ? 1 : 0),
            updatedAt: now,
          };
        });
        return points.length > 0;
      } catch {
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [endpoint],
  );

  const poll = useCallback(() => fetchLive(false), [fetchLive]);
  const refresh = useCallback(() => fetchLive(true), [fetchLive]);

  useTickPolling(poll, { cadenceMs, enabled });

  return { ...state, refresh };
}
