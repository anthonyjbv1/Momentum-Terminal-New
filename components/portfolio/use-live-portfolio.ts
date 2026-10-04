"use client";

import { useCallback, useRef, useState } from "react";

import { useTickPolling } from "@/components/engine/use-tick-polling";
import { LIVE_TICK_MS, foldTicksIntoRanges, latestTickAt } from "@/lib/person/live-series";
import { RANGE_KEYS, type RangeKey, type SeriesByRange, type SeriesPoint } from "@/lib/person/profile-model";
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
 *
 * RANGES ON DEMAND (the tab-switch lag fix, 2026-10-04). The page arrives
 * with the ranges the server rendered (`initialRanges`, 1H and 24H); the
 * others are read from /api/portfolio/series the first time they are asked
 * for, by the same RPC with the same arguments, and are then live like the
 * rest. Until a range is loaded its series stays empty and ticks are not
 * folded into it, so a half-built 7D never shows; `loading` names the range
 * being read.
 */

export interface LivePortfolioState {
  summary: PortfolioSummary;
  series: SeriesByRange;
  /** Increments whenever new value points arrive. */
  version: number;
  /** When the state last changed. */
  updatedAt: number | null;
  /** The ranges whose series have been read (server-rendered or fetched). */
  loaded: readonly RangeKey[];
  /** The range being fetched right now, if any. */
  loading: RangeKey | null;
}

export interface LivePortfolioOptions {
  /** Defaults to /api/portfolio/live. */
  endpoint?: string;
  /** Defaults to /api/portfolio/series. */
  seriesEndpoint?: string;
  /** The Engine's cadence; defaults to the real 30 seconds. */
  cadenceMs?: number;
  enabled?: boolean;
}

interface LiveResponse {
  summary: unknown;
  points: unknown[];
}

interface SeriesResponse {
  range: string;
  points: unknown[];
}

/** The series route's points, as the server serialised them: the page's own SeriesPoint shape, checked field by field. */
export function toSeriesPoints(value: unknown): SeriesPoint[] {
  if (!Array.isArray(value)) return [];
  const out: SeriesPoint[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const at = typeof record.at === "string" ? record.at : null;
    const score = typeof record.score === "number" && Number.isFinite(record.score) ? record.score : null;
    if (at === null || score === null) continue;
    out.push({
      at,
      score,
      open: typeof record.open === "number" && Number.isFinite(record.open) ? record.open : score,
      samples: typeof record.samples === "number" && record.samples >= 1 ? Math.round(record.samples) : 1,
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Every range not yet loaded stays empty, whatever was folded into it. */
function keepUnloadedEmpty(series: SeriesByRange, loaded: readonly RangeKey[]): SeriesByRange {
  const next = { ...series };
  for (const key of RANGE_KEYS) if (!loaded.includes(key)) next[key] = [];
  return next;
}

export function useLivePortfolio(
  initialSummary: PortfolioSummary,
  initialSeries: SeriesByRange,
  options: LivePortfolioOptions = {},
  initialRanges: readonly RangeKey[] = RANGE_KEYS,
): LivePortfolioState & { refresh: () => Promise<boolean>; loadRange: (range: RangeKey) => Promise<boolean> } {
  const endpoint = options.endpoint ?? "/api/portfolio/live";
  const seriesEndpoint = options.seriesEndpoint ?? "/api/portfolio/series";
  const cadenceMs = options.cadenceMs ?? LIVE_TICK_MS;
  const enabled = options.enabled ?? true;

  const [state, setState] = useState<LivePortfolioState>(() => ({
    summary: initialSummary,
    series: keepUnloadedEmpty(initialSeries, initialRanges),
    version: 0,
    updatedAt: null,
    loaded: initialRanges,
    loading: null,
  }));
  const cursor = useRef<string | null>(latestTickAt(keepUnloadedEmpty(initialSeries, initialRanges)));
  const inFlight = useRef(false);
  const rangeInFlight = useRef<RangeKey | null>(null);

  const loadRange = useCallback(
    async (range: RangeKey): Promise<boolean> => {
      if (rangeInFlight.current === range) return false;
      rangeInFlight.current = range;
      setState((previous) => (previous.loaded.includes(range) ? previous : { ...previous, loading: range }));
      try {
        const url = new URL(seriesEndpoint, window.location.origin);
        url.searchParams.set("range", range);
        const response = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return false;
        const body = (await response.json()) as Partial<SeriesResponse>;
        const points = toSeriesPoints(body.points);
        setState((previous) => ({
          ...previous,
          series: { ...previous.series, [range]: points },
          loaded: previous.loaded.includes(range) ? previous.loaded : [...previous.loaded, range],
          loading: previous.loading === range ? null : previous.loading,
          version: previous.version + 1,
          updatedAt: Date.now(),
        }));
        return true;
      } catch {
        return false;
      } finally {
        rangeInFlight.current = null;
        setState((previous) => (previous.loading === range ? { ...previous, loading: null } : previous));
      }
    },
    [seriesEndpoint],
  );

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
            ...previous,
            summary: summary ?? previous.summary,
            series:
              points.length > 0
                ? keepUnloadedEmpty(
                    foldTicksIntoRanges(
                      previous.series,
                      points.map((point) => ({ at: point.at, score: point.valueCents })),
                      now,
                    ),
                    previous.loaded,
                  )
                : previous.series,
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

  return { ...state, refresh, loadRange };
}
