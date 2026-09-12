"use client";

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { GAP_SLICES, TICK_REVEAL_MS, blendSeries, easeOutCubic, gridValues, lerp, seriesPath, timeDomain, toTimed, type TimedScore, type ValueDomain } from "@/lib/person/chart-math";
import { LIVE_TICK_MS } from "@/lib/person/live-series";
import { RANGES, type RangeKey, type SeriesPoint } from "@/lib/person/profile-model";
import { useReducedMotion } from "@/components/ui/use-reduced-motion";

/**
 * THE LIVE LINE, built for a 30-second cadence. The score chart (6c+) and
 * the portfolio value chart (6f) are this one component with different
 * formatting, floors and reference lines.
 *
 * Between ticks the line is still and the leading dot breathes: one slow
 * cycle per tick, phase-locked to the banner countdown (the CSS animation
 * runs on the wall clock with a negative delay, so both reset together).
 * When a tick lands (`version` changes) the line grows into the new value
 * over TICK_REVEAL_MS with an ease-out curve: the leading point travels from
 * the old end to the new one, the axis domains glide, and points that have
 * aged out slide off the left edge under the clip. A one-shot ring leaves
 * the dot at that moment.
 *
 * One thin white monotone spline on the black ground, a recessive grid, a
 * single value axis on the right, three time marks, an optional dashed
 * reference line, and a crosshair with the exact value and time on hover or
 * touch. No gradients, no fills, no glow. Colour never touches the line;
 * direction lives in the change figure above the chart.
 *
 * The vertical axis clamps to the data but never spans less than the
 * caller's floor (`domain`). prefers-reduced-motion removes the breath and
 * the ripple and applies each tick directly.
 */
export interface LiveLineChartProps {
  /** `score` carries the plotted value: score points, or integer cents. */
  points: SeriesPoint[];
  range: RangeKey;
  /** Bumps when live ticks arrive; each change animates the reveal. */
  version?: number;
  /** The Engine's cadence, for the breath. Defaults to the real 30 seconds. */
  cadenceMs?: number;
  /** The vertical domain rule: floor, padding, and whether the reference is pulled in. */
  domain: (points: TimedScore[]) => ValueDomain;
  /** A dashed reference line with a label: the gravity target, the paper credit. */
  reference?: { value: number; label: string } | null;
  /** Axis labels. */
  formatAxis: (value: number) => string;
  /** The crosshair's value. */
  formatValue: (value: number) => string;
  /** The accessible summary of the drawn line. */
  describe: (stats: { first: TimedScore; last: TimedScore; min: TimedScore; max: TimedScore; rangeLabel: string }) => string;
  /** Rendered when there are fewer than two points to join. */
  empty: ReactNode;
  /** Width reserved for the axis labels on the right, in SVG units. */
  axisWidth?: number;
  className?: string;
}

const MARGIN = { top: 18, bottom: 28, left: 12 };
const DEFAULT_AXIS_WIDTH = 52;

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

const clockFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dayClockFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

function axisTime(ms: number, spanMs: number): string {
  return spanMs <= TWO_DAYS ? clockFormat.format(ms) : dayFormat.format(ms);
}

interface Transition {
  from: TimedScore[];
  to: TimedScore[];
  startedAt: number;
}

export function LiveLineChart({
  points,
  range,
  version = 0,
  cadenceMs = LIVE_TICK_MS,
  domain,
  reference = null,
  formatAxis,
  formatValue,
  describe,
  empty,
  axisWidth = DEFAULT_AXIS_WIDTH,
  className,
}: LiveLineChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const size = useSize(wrapperRef);
  const clipId = useId();
  const reducedMotion = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);

  const timed = useMemo(() => toTimed(points), [points]);
  const drawable = timed.length >= 2;
  const rangeDefinition = RANGES.find((definition) => definition.key === range) ?? RANGES[0];

  // The tick reveal. A version change means new ticks: animate from what was
  // on screen to what is now true. A range switch keeps the version, so it
  // simply shows the other series.
  const shownRef = useRef<TimedScore[]>(timed);
  const versionRef = useRef(version);
  const [transition, setTransition] = useState<Transition | null>(null);
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    if (version === versionRef.current) {
      shownRef.current = timed;
      return;
    }
    versionRef.current = version;
    const from = shownRef.current;
    shownRef.current = timed;
    if (reducedMotion || from.length < 2 || timed.length < 2) {
      setTransition(null);
      setProgress(1);
      return;
    }
    setTransition({ from, to: timed, startedAt: performance.now() });
    setProgress(0);
  }, [timed, version, reducedMotion]);

  useEffect(() => {
    if (!transition) return;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - transition.startedAt) / TICK_REVEAL_MS);
      setProgress(t);
      if (t < 1) frame = requestAnimationFrame(step);
      else setTransition(null);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [transition]);

  // The breath is phase-locked to the wall clock, like the banner countdown:
  // the animation runs for one cadence and starts with a negative delay equal
  // to the time already elapsed in the current cycle. Set on the element
  // directly (an external system), re-synced whenever a tick lands so tab
  // throttling cannot let it drift.
  const breathRef = useRef<SVGCircleElement>(null);
  const ready = drawable && size !== null && size.width > 0;
  useEffect(() => {
    const element = breathRef.current;
    if (!element) return;
    element.style.animationDuration = `${cadenceMs}ms`;
    element.style.animationDelay = `-${Date.now() % cadenceMs}ms`;
  }, [cadenceMs, version, ready]);

  const frame = useMemo(() => {
    if (!drawable) return null;
    const eased = transition ? easeOutCubic(progress) : 1;
    const series = transition ? blendSeries(transition.from, transition.to, eased) : timed;
    const target = { ...timeDomain(timed), ...domain(timed) };
    if (!transition) return { series, domain: target, transitioning: false };
    const origin = { ...timeDomain(transition.from), ...domain(transition.from) };
    return {
      series,
      domain: {
        t0: lerp(origin.t0, target.t0, eased),
        t1: lerp(origin.t1, target.t1, eased),
        lo: lerp(origin.lo, target.lo, eased),
        hi: lerp(origin.hi, target.hi, eased),
        referenceInRange: target.referenceInRange,
      },
      transitioning: true,
    };
  }, [drawable, transition, progress, timed, domain]);

  const geometry = useMemo(() => {
    if (!frame || !size || size.width === 0) return null;
    const innerWidth = Math.max(size.width - MARGIN.left - axisWidth, 1);
    const innerHeight = Math.max(size.height - MARGIN.top - MARGIN.bottom, 1);
    const { t0, t1, lo, hi } = frame.domain;
    const x = (t: number) => MARGIN.left + ((t - t0) / (t1 - t0)) * innerWidth;
    const y = (v: number) => MARGIN.top + ((hi - v) / (hi - lo)) * innerHeight;

    const sliceMs = rangeDefinition.windowMs !== null ? rangeDefinition.windowMs / rangeDefinition.points : (t1 - t0) / rangeDefinition.points;
    const gapMs = Math.max(sliceMs * GAP_SLICES, 1);

    const plotted = frame.series.map((point) => ({ t: point.t, score: point.score, x: x(point.t), y: y(point.score) }));
    const lead = plotted[plotted.length - 1];

    let min = timed[0];
    let max = timed[0];
    for (const point of timed) {
      if (point.score < min.score) min = point;
      if (point.score > max.score) max = point;
    }

    return {
      innerWidth,
      innerHeight,
      x,
      y,
      t0,
      t1,
      lo,
      hi,
      referenceInRange: frame.domain.referenceInRange,
      transitioning: frame.transitioning,
      plotted,
      path: seriesPath(plotted, gapMs),
      lead,
      grid: gridValues(lo, hi),
      first: timed[0],
      last: timed[timed.length - 1],
      min,
      max,
    };
  }, [frame, size, rangeDefinition, timed, axisWidth]);

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!geometry || geometry.transitioning) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < geometry.plotted.length; index += 1) {
      const distance = Math.abs(geometry.plotted[index].x - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    setHover(best);
  };

  const summary = geometry
    ? describe({ first: geometry.first, last: geometry.last, min: geometry.min, max: geometry.max, rangeLabel: rangeDefinition.label })
    : undefined;

  const hovered = hover !== null && geometry && !geometry.transitioning && geometry.plotted[hover] ? geometry.plotted[hover] : null;

  return (
    <div ref={wrapperRef} className={cn("relative h-56 w-full select-none sm:h-72", className)}>
      {!drawable ? (
        empty
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
            <defs>
              <clipPath id={clipId}>
                <rect x={MARGIN.left} y={0} width={geometry.innerWidth} height={size.height - MARGIN.bottom} />
              </clipPath>
            </defs>

            {/* Grid and value axis, on the right */}
            {geometry.grid.map((value) => {
              const gy = geometry.y(value);
              return (
                <g key={value}>
                  <line x1={MARGIN.left} x2={MARGIN.left + geometry.innerWidth} y1={gy} y2={gy} className="stroke-line" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={MARGIN.left + geometry.innerWidth + 10} y={gy + 3.5} className="num fill-fg-faint text-2xs">
                    {formatAxis(value)}
                  </text>
                </g>
              );
            })}

            {/* The reference line */}
            {reference ? (
              geometry.referenceInRange ? (
                <g>
                  <line
                    x1={MARGIN.left}
                    x2={MARGIN.left + geometry.innerWidth}
                    y1={geometry.y(reference.value)}
                    y2={geometry.y(reference.value)}
                    className="stroke-line-strong"
                    strokeWidth={1}
                    strokeDasharray="3 5"
                  />
                  <text x={MARGIN.left} y={geometry.y(reference.value) - 6} className="fill-fg-faint text-2xs">
                    {reference.label} <tspan className="num">{formatAxis(reference.value)}</tspan>
                  </text>
                </g>
              ) : (
                <text x={MARGIN.left} y={MARGIN.top - 6} className="fill-fg-faint text-2xs">
                  {reference.label} <tspan className="num">{formatAxis(reference.value)}</tspan> {reference.value > geometry.hi ? "above this range" : "below this range"}
                </text>
              )
            ) : null}

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

            {/* The line, clipped so aged-out points slide away under the left edge */}
            <g clipPath={`url(#${clipId})`}>
              <path d={geometry.path} fill="none" className="stroke-fg" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>

            {/* The leading edge: the dot, its breath, and the ring that marks a tick landing */}
            <g transform={`translate(${geometry.lead.x.toFixed(2)} ${geometry.lead.y.toFixed(2)})`}>
              {version > 0 ? <circle key={`ripple-${version}`} r={4} className="fill-fg opacity-0 transform-fill-box animate-ripple" /> : null}
              <circle ref={breathRef} r={3.5} className="fill-fg transform-fill-box animate-breathe" />
            </g>

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
              <span className="num text-sm font-semibold leading-none text-fg">{formatValue(hovered.score)}</span>
              <span className="num whitespace-nowrap text-2xs text-fg-muted">
                {(geometry.t1 - geometry.t0 <= TWO_DAYS ? clockFormat : dayClockFormat).format(hovered.t)}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The chart's empty state: a rule across the middle with the reason on it. */
export function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center" role="img" aria-label={title}>
      <span className="absolute inset-x-0 top-1/2 h-px bg-line" aria-hidden />
      <p className="relative bg-surface px-4 text-sm font-medium text-fg-secondary">{title}</p>
      <p className="relative bg-surface px-4 text-sm text-fg-muted">{detail}</p>
    </div>
  );
}
