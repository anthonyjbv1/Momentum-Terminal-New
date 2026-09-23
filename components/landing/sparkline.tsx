import { monotonePath } from "@/lib/person/chart-math";

/**
 * A day of score history as one quiet line: no axes, no labels, no colour.
 * The number beside it does the talking; this shows the shape of the day.
 * Monochrome (currentColor) and static — it is the reveal on the hero
 * number that carries the motion, not this.
 */
export interface SparklineProps {
  points: Array<{ at: string; score: number }>;
  className?: string;
  /** Read out for assistive technology. */
  label: string;
}

const VIEW_W = 100;
const VIEW_H = 32;
const PAD = 2;

export function Sparkline({ points, className, label }: SparklineProps) {
  if (points.length < 2) return null;
  const scores = points.map((point) => point.score);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  // Never flatter than half a point of range, so a still day is a line and
  // not a spike drawn from noise.
  const span = Math.max(hi - lo, 0.5);
  const mid = (hi + lo) / 2;
  const top = mid + span / 2;
  const xy = points.map((point, index) => ({
    x: PAD + (index / (points.length - 1)) * (VIEW_W - PAD * 2),
    y: PAD + ((top - point.score) / span) * (VIEW_H - PAD * 2),
  }));

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" role="img" aria-label={label} className={className}>
      <path d={monotonePath(xy)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
