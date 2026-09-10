import type { SeriesPoint } from "./profile-model";

/**
 * The score chart's arithmetic, kept pure so it is unit-tested without a
 * browser: the vertical domain with its floor, the grid, the monotone spline,
 * and the frame in between two series during a tick reveal.
 */

/**
 * THE Y-RANGE FLOOR, in score points. The vertical axis clamps to the data
 * so a moving line is readable, but it never spans fewer points than this:
 * with the countdown, the pulse and the tick reveal already drawing the eye
 * to every move, a 0.02-point drift must stay a flicker, not become a cliff.
 */
export const Y_RANGE_FLOOR = 2;

/** Padding above and below the (floored) span, as a fraction of it. */
export const Y_PADDING = 0.15;

/** How long the line takes to grow into a new tick. */
export const TICK_REVEAL_MS = 700;

/** Consecutive ticks further apart than this many slices are drawn as a break. */
export const GAP_SLICES = 3;

export interface XY {
  x: number;
  y: number;
}

export interface TimedScore {
  t: number;
  score: number;
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The reveal's easing: fast out of the gate, settling gently into place. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

/** 1, 2, 5 × 10ⁿ: the step that gives about `target` gridlines across `span`. */
export function niceStep(span: number, target = 4): number {
  const raw = Math.max(span, Number.EPSILON) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

export function gridValues(lo: number, hi: number): number[] {
  const step = niceStep(hi - lo);
  const values: number[] = [];
  for (let value = Math.ceil(lo / step) * step; value <= hi + step / 1000; value += step) {
    values.push(Number(value.toFixed(6)));
    if (values.length > 12) break;
  }
  return values;
}

export interface ScoreDomain {
  lo: number;
  hi: number;
  gravityInRange: boolean;
}

/**
 * The vertical domain: the data's span, never narrower than Y_RANGE_FLOOR,
 * centred on the data, padded by Y_PADDING each side, and widened to take in
 * the gravity target when it lies within one span of the data.
 */
export function scoreDomain(points: TimedScore[], revertTarget: number): ScoreDomain {
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const point of points) {
    if (point.score < dataMin) dataMin = point.score;
    if (point.score > dataMax) dataMax = point.score;
  }
  if (!Number.isFinite(dataMin)) return { lo: 0, hi: 100, gravityInRange: revertTarget >= 0 && revertTarget <= 100 };

  const span = Math.max(dataMax - dataMin, Y_RANGE_FLOOR);
  const mid = (dataMax + dataMin) / 2;
  const pad = span * Y_PADDING;
  let lo = mid - span / 2 - pad;
  let hi = mid + span / 2 + pad;
  if (revertTarget >= lo - span && revertTarget <= hi + span) {
    lo = Math.min(lo, revertTarget - pad);
    hi = Math.max(hi, revertTarget + pad);
  }
  return { lo, hi, gravityInRange: revertTarget >= lo && revertTarget <= hi };
}

export interface TimeDomain {
  t0: number;
  t1: number;
}

export function timeDomain(points: TimedScore[]): TimeDomain {
  if (points.length === 0) return { t0: 0, t1: 1 };
  const t0 = points[0].t;
  return { t0, t1: Math.max(points[points.length - 1].t, t0 + 1) };
}

export function toTimed(points: SeriesPoint[]): TimedScore[] {
  const out: TimedScore[] = [];
  for (const point of points) {
    const t = Date.parse(point.at);
    if (Number.isFinite(t)) out.push({ t, score: point.score });
  }
  return out;
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson), the scheme behind d3's
 * curveMonotoneX: the curve passes through every point and never overshoots
 * between two of them, so a flat run stays flat and a peak stays the peak.
 * Returns one SVG subpath.
 */
export function monotonePath(points: XY[]): string {
  const n = points.length;
  if (n === 0) return "";
  const f = (v: number) => v.toFixed(2);
  if (n === 1) return `M${f(points[0].x)},${f(points[0].y)}`;
  if (n === 2) return `M${f(points[0].x)},${f(points[0].y)} L${f(points[1].x)},${f(points[1].y)}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i];
  }

  const tangent: number[] = new Array(n).fill(0);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      tangent[i] = tau * a * slope[i];
      tangent[i + 1] = tau * b * slope[i];
    }
  }

  let d = `M${f(points[0].x)},${f(points[0].y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const h = dx[i];
    const c1x = points[i].x + h / 3;
    const c1y = points[i].y + (tangent[i] * h) / 3;
    const c2x = points[i + 1].x - h / 3;
    const c2y = points[i + 1].y - (tangent[i + 1] * h) / 3;
    d += ` C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(points[i + 1].x)},${f(points[i + 1].y)}`;
  }
  return d;
}

/** Splits a timed series into runs at gaps wider than gapMs and splines each run. */
export function seriesPath(points: Array<XY & { t: number }>, gapMs: number): string {
  const runs: XY[][] = [];
  let run: XY[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0 && points[i].t - points[i - 1].t > gapMs && run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(points[i]);
  }
  if (run.length > 0) runs.push(run);
  return runs.map(monotonePath).join(" ");
}

/**
 * The frame between two series during a tick reveal, at eased progress `t`.
 * Every point of `to` but the last sits at its own time; points `from` had
 * that `to` has dropped ride along too (they slide out under the clip); and
 * the leading point travels from where `from` ended to where `to` ends, so a
 * new tick grows out of the previous one and a revised close moves in place.
 */
export function blendSeries(from: TimedScore[], to: TimedScore[], t: number): TimedScore[] {
  if (to.length === 0) return [];
  const toLast = to[to.length - 1];
  const fromLast = from[from.length - 1];
  const lead: TimedScore = fromLast ? { t: lerp(fromLast.t, toLast.t, t), score: lerp(fromLast.score, toLast.score, t) } : toLast;

  const body = new Map<number, number>();
  for (const point of from.slice(0, -1)) body.set(point.t, point.score);
  for (const point of to.slice(0, -1)) body.set(point.t, point.score);

  const frame = [...body.entries()]
    .map(([time, score]) => ({ t: time, score }))
    .filter((point) => point.t < lead.t)
    .sort((a, b) => a.t - b.t);
  frame.push(lead);
  return frame;
}
