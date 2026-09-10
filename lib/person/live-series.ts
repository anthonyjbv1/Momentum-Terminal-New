import { RANGES, type RangeDefinition, type SeriesByRange, type SeriesPoint } from "./profile-model";

/**
 * Keeping the profile's series alive in the browser.
 *
 * The page arrives with each range downsampled by the database. Between
 * ticks nothing changes. At each tick the page asks /api/person/[slug]/live
 * for ticks newer than the last one it holds, and folds them in here the way
 * the database would have bucketed them, so a live series and a freshly
 * loaded one look the same. Every range is bounded: points that age out of
 * the window are dropped and a hard cap applies on top, so the DOM and
 * memory stay flat however long the page is open.
 */

/** The Engine's cadence. Mirrors TICK_SECONDS in components/engine/engine-clock.ts (pinned by a test). */
export const LIVE_TICK_MS = 30_000;

/** Hard cap on points held per range in the browser. 1H at one point per tick is 120; this leaves room for bursts. */
export const MAX_LIVE_POINTS = 240;

/** One tick as the live endpoint reports it. */
export interface LiveTick {
  at: string;
  score: number;
}

/** Width of one slice of a range, in milliseconds. ALL derives it from the data it holds. */
export function sliceMs(range: RangeDefinition, series: SeriesPoint[]): number {
  if (range.windowMs !== null) return range.windowMs / range.points;
  if (series.length < 2) return LIVE_TICK_MS;
  const first = Date.parse(series[0].at);
  const last = Date.parse(series[series.length - 1].at);
  return Math.max((last - first) / range.points, LIVE_TICK_MS);
}

function validTicks(ticks: LiveTick[]): Array<LiveTick & { t: number }> {
  return ticks
    .map((tick) => ({ ...tick, t: Date.parse(tick.at) }))
    .filter((tick) => Number.isFinite(tick.t) && Number.isFinite(tick.score))
    .sort((a, b) => a.t - b.t);
}

/**
 * Folds newly observed ticks into one range's series: a tick that lands
 * inside the last slice's span updates that slice's close (its open and
 * count carry), a tick beyond it opens a new slice. Ticks the series already
 * has are ignored. Then the window is enforced and the cap applied.
 */
export function foldTicks(series: SeriesPoint[], ticks: LiveTick[], range: RangeDefinition, now: number): SeriesPoint[] {
  const incoming = validTicks(ticks);
  if (incoming.length === 0) return series;

  const width = sliceMs(range, series);
  let out = series.slice();

  for (const tick of incoming) {
    const last = out[out.length - 1];
    if (last) {
      const lastT = Date.parse(last.at);
      if (tick.t <= lastT) continue;
      // Slices wider than a tick absorb ticks that fall inside them.
      if (width > LIVE_TICK_MS && tick.t - lastT < width) {
        out[out.length - 1] = { ...last, at: tick.at, score: tick.score, samples: last.samples + 1 };
        continue;
      }
    }
    out.push({ at: tick.at, score: tick.score, open: tick.score, samples: 1 });
  }

  if (range.windowMs !== null) {
    const cutoff = now - range.windowMs;
    out = out.filter((point) => Date.parse(point.at) >= cutoff);
  }
  if (out.length > MAX_LIVE_POINTS) out = out.slice(out.length - MAX_LIVE_POINTS);
  return out;
}

/** foldTicks over every range. Returns the same object when nothing changed. */
export function foldTicksIntoRanges(series: SeriesByRange, ticks: LiveTick[], now: number): SeriesByRange {
  if (validTicks(ticks).length === 0) return series;
  const next = { ...series };
  for (const range of RANGES) next[range.key] = foldTicks(series[range.key], ticks, range, now);
  return next;
}

/** The newest tick time the series hold, or null before any history. */
export function latestTickAt(series: SeriesByRange): string | null {
  let latest: string | null = null;
  for (const range of RANGES) {
    const last = series[range.key][series[range.key].length - 1];
    if (last && (latest === null || last.at > latest)) latest = last.at;
  }
  return latest;
}
