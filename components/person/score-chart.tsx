"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/cn";
import { RANGES, type RangeKey, type SeriesPoint } from "@/lib/person/profile-model";

/**
 * The score line. One thin white line on the black ground, a recessive grid,
 * one axis (score, on the right), three time marks along the bottom, the
 * gravity target as a faint dashed reference, and a crosshair with a small
 * tooltip on hover or touch. No gradients, no fills, no glow.
 *
 * Only score_history is drawn. The database omits empty slices, and a gap
 * between ticks wider than three slices breaks the line rather than bridging
 * it, so a pause in the Engine reads as a pause.
 */
export interface ScoreChartProps {
  points: SeriesPoint[];
  range: RangeKey;
  revertTarget: number;
  personName: string;
  className?: string;
}

const MARGIN = { top: 18, right: 52, bottom: 28, left: 12 };
/** Consecutive ticks further apart than this many slices are drawn as a break. */
const GAP_SLICES = 3;

interface Size {
  width: number;
  height: number;
}

function useSize<T extends HTMLElement>(ref: React.RefObject<T | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
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

/**
 * The vertical domain: the data padded by a fifth of its span (never less
 * than a point of span, so a quiet line is not stretched into drama), widened
 * to include the gravity target when it is within a span of the data.
 */
export function scoreDomain(points: SeriesPoint[], revertTarget: number): { lo: number; hi: number; gravityInRange: boolean } {
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const point of points) {
    if (point.score < dataMin) dataMin = point.score;
    if (point.score > dataMax) dataMax = point.score;
  }
  const span = Math.max(dataMax - dataMin, 1);
  let lo = dataMin - span * 0.2;
  let hi = dataMax + span * 0.2;
  if (revertTarget >= lo - span && revertTarget <= hi + span) {
    lo = Math.min(lo, revertTarget - span * 0.15);
    hi = Math.max(hi, revertTarget + span * 0.15);
  }
  return { lo, hi, gravityInRange: revertTarget >= lo && revertTarget <= hi };
}

const clockFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dayClockFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

function axisTime(ms: number, spanMs: number): string {
  return spanMs <= TWO_DAYS ? clockFormat.format(ms) : dayFormat.format(ms);
}

export function ScoreChart({ points, range, revertTarget, personName, className }: ScoreChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const size = useSize(wrapperRef);
  const [hover, setHover] = useState<number | null>(null);

  const drawable = points.length >= 2;
  const rangeDefinition = RANGES.find((definition) => definition.key === range) ?? RANGES[0];

  const geometry = useMemo(() => {
    if (!drawable || !size || size.width === 0) return null;
    const innerWidth = Math.max(size.width - MARGIN.left - MARGIN.right, 1);
    const innerHeight = Math.max(size.height - MARGIN.top - MARGIN.bottom, 1);

    const times = points.map((point) => Date.parse(point.at));
    const t0 = times[0];
    const t1 = Math.max(times[times.length - 1], t0 + 1);
    const { lo, hi, gravityInRange } = scoreDomain(points, revertTarget);

    const x = (t: number) => MARGIN.left + ((t - t0) / (t1 - t0)) * innerWidth;
    const y = (v: number) => MARGIN.top + ((hi - v) / (hi - lo)) * innerHeight;

    const sliceMs = rangeDefinition.windowMs !== null ? rangeDefinition.windowMs / rangeDefinition.points : (t1 - t0) / rangeDefinition.points;
    const gapMs = Math.max(sliceMs * GAP_SLICES, 1);

    const xs = times.map(x);
    const ys = points.map((point) => y(point.score));
    let path = "";
    for (let index = 0; index < points.length; index += 1) {
      const broke = index === 0 || times[index] - times[index - 1] > gapMs;
      path += `${broke ? "M" : "L"}${xs[index].toFixed(1)},${ys[index].toFixed(1)} `;
    }

    const first = points[0];
    const last = points[points.length - 1];
    let min = first;
    let max = first;
    for (const point of points) {
      if (point.score < min.score) min = point;
      if (point.score > max.score) max = point;
    }

    return {
      innerWidth,
      innerHeight,
      t0,
      t1,
      lo,
      hi,
      gravityInRange,
      x,
      y,
      xs,
      ys,
      path: path.trim(),
      grid: gridValues(lo, hi),
      first,
      last,
      min,
      max,
    };
  }, [drawable, points, rangeDefinition, revertTarget, size]);

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!geometry) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    // Nearest point by x; the arrays are short enough for a linear scan.
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < geometry.xs.length; index += 1) {
      const distance = Math.abs(geometry.xs[index] - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    setHover(best);
  };

  const summary = geometry
    ? `${personName}, momentum score over ${rangeDefinition.label}: from ${geometry.first.score.toFixed(1)} to ${geometry.last.score.toFixed(1)}, low ${geometry.min.score.toFixed(1)}, high ${geometry.max.score.toFixed(1)}.`
    : `${personName}, momentum score over ${rangeDefinition.label}: no history yet.`;

  const hovered = hover !== null && geometry && points[hover] ? { point: points[hover], x: geometry.xs[hover], y: geometry.ys[hover] } : null;

  return (
    <div ref={wrapperRef} className={cn("relative h-56 w-full select-none sm:h-72", className)}>
      {!drawable ? (
        <EmptyChart />
      ) : geometry && size ? (
        <>
          <svg
            width={size.width}
            height={size.height}
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="img"
            aria-label={summary}
            className="absolute inset-0 touch-pan-y overflow-visible"
            onPointerMove={onPointerMove}
            onPointerDown={onPointerMove}
            onPointerLeave={() => setHover(null)}
            onPointerCancel={() => setHover(null)}
          >
            {/* Grid and score axis, on the right */}
            {geometry.grid.map((value) => {
              const gy = geometry.y(value);
              return (
                <g key={value}>
                  <line x1={MARGIN.left} x2={MARGIN.left + geometry.innerWidth} y1={gy} y2={gy} className="stroke-line" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={MARGIN.left + geometry.innerWidth + 10} y={gy + 3.5} className="num fill-fg-faint text-2xs">
                    {value.toFixed(1)}
                  </text>
                </g>
              );
            })}

            {/* Gravity target */}
            {geometry.gravityInRange ? (
              <g>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + geometry.innerWidth}
                  y1={geometry.y(revertTarget)}
                  y2={geometry.y(revertTarget)}
                  className="stroke-line-strong"
                  strokeWidth={1}
                  strokeDasharray="3 5"
                />
                <text x={MARGIN.left} y={geometry.y(revertTarget) - 6} className="fill-fg-faint text-2xs">
                  Gravity target <tspan className="num">{revertTarget.toFixed(1)}</tspan>
                </text>
              </g>
            ) : (
              <text x={MARGIN.left} y={MARGIN.top - 6} className="fill-fg-faint text-2xs">
                Gravity target <tspan className="num">{revertTarget.toFixed(1)}</tspan> {revertTarget > geometry.hi ? "above this range" : "below this range"}
              </text>
            )}

            {/* Time axis: start, middle, end */}
            {[
              { t: geometry.t0, anchor: "start" as const },
              { t: (geometry.t0 + geometry.t1) / 2, anchor: "middle" as const },
              { t: geometry.t1, anchor: "end" as const },
            ].map(({ t, anchor }) => (
              <text key={anchor} x={geometry.x(t)} y={size.height - 8} textAnchor={anchor} className="num fill-fg-faint text-2xs">
                {axisTime(t, geometry.t1 - geometry.t0)}
              </text>
            ))}

            {/* The line */}
            <path d={geometry.path} fill="none" className="stroke-fg" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={geometry.xs[geometry.xs.length - 1]} cy={geometry.ys[geometry.ys.length - 1]} r={3} className="fill-fg" />

            {/* Crosshair */}
            {hovered ? (
              <g>
                <line x1={hovered.x} x2={hovered.x} y1={MARGIN.top} y2={MARGIN.top + geometry.innerHeight} className="stroke-line-strong" strokeWidth={1} strokeDasharray="2 3" />
                <circle cx={hovered.x} cy={hovered.y} r={4.5} className="fill-fg stroke-canvas" strokeWidth={2} />
              </g>
            ) : null}
          </svg>

          {hovered ? (
            <div
              className="pointer-events-none absolute top-0 flex -translate-x-1/2 flex-col items-center gap-0.5 rounded-md bg-surface-overlay px-2.5 py-1.5 shadow-raised"
              style={{ left: Math.min(Math.max(hovered.x, 56), size.width - 56) }}
            >
              <span className="num text-sm font-semibold leading-none text-fg">{hovered.point.score.toFixed(1)}</span>
              <span className="num whitespace-nowrap text-2xs text-fg-muted">
                {(geometry.t1 - geometry.t0 <= TWO_DAYS ? clockFormat : dayClockFormat).format(Date.parse(hovered.point.at))}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center" role="img" aria-label="No score history yet">
      <span className="absolute inset-x-0 top-1/2 h-px bg-line" aria-hidden />
      <p className="relative bg-surface px-4 text-sm font-medium text-fg-secondary">No score history yet</p>
      <p className="relative bg-surface px-4 text-sm text-fg-muted">The line begins with the Engine&rsquo;s first tick.</p>
    </div>
  );
}
