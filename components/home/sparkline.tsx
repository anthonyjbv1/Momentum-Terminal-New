import { cn } from "@/lib/cn";

/**
 * A bare trend line for a score series. Deliberately monochrome: on a person
 * card the direction indicator is the only thing allowed to carry colour, so
 * the sparkline reads as texture rather than as a second signal.
 *
 * Renders nothing below two points, which is what a person looks like before
 * the Engine has ticked twice.
 */
export interface SparklineProps {
  /** Score points, oldest first. */
  points: number[];
  className?: string;
}

const VIEWBOX_WIDTH = 100;
const VIEWBOX_HEIGHT = 24;
/** Keeps a flat series off the very edge of the box. */
const PADDING = 2;

export function sparklinePath(points: number[], width = VIEWBOX_WIDTH, height = VIEWBOX_HEIGHT, padding = PADDING): string | null {
  const usable = points.filter((point) => Number.isFinite(point));
  if (usable.length < 2) return null;

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min;
  const innerHeight = height - padding * 2;
  const step = width / (usable.length - 1);

  return usable
    .map((point, index) => {
      // A flat series sits on the centre line rather than dividing by zero.
      const ratio = span === 0 ? 0.5 : (point - min) / span;
      const x = index * step;
      const y = padding + (1 - ratio) * innerHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function Sparkline({ points, className }: SparklineProps) {
  const path = sparklinePath(points);
  if (!path) return null;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("text-fg-faint", className)}
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
