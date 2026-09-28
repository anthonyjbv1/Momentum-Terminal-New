import { cn } from "@/lib/cn";

import { DirectionIndicator, type DirectionIndicatorSize } from "./direction-indicator";

/**
 * The Momentum Score: the platform's signature number.
 * Monospaced, tabular, tightened; the direction read sits at the baseline
 * beside it. The decimal is the same size, weight and colour as the integer
 * (Phase 33): "72.4" is one number, and a quieter ".4" read as a footnote to
 * the 72. Colour never touches the score itself — only the change carries
 * direction.
 */
export type ScoreSize = "sm" | "md" | "lg" | "xl";

const scoreSizes: Record<ScoreSize, { whole: string; gap: string; direction: DirectionIndicatorSize }> = {
  sm: { whole: "text-lg", gap: "gap-1.5", direction: "sm" },
  md: { whole: "text-2xl", gap: "gap-2", direction: "sm" },
  lg: { whole: "text-4xl", gap: "gap-3", direction: "md" },
  xl: { whole: "text-6xl", gap: "gap-4", direction: "lg" },
};

export interface ScoreDisplayProps {
  score: number;
  /** Change in points over the display window; omit to hide the direction read. */
  change?: number | null;
  size?: ScoreSize;
  /** Show "Heating" / "Cooling" / "Flat" after the change. */
  withLabel?: boolean;
  /** Re-runs the tick flash whenever the score changes. */
  flash?: boolean;
  className?: string;
}

export function splitScore(score: number): { whole: string; fraction: string } {
  const clamped = Number.isFinite(score) ? score : 0;
  const fixed = clamped.toFixed(1);
  const [whole, fraction = "0"] = fixed.split(".");
  return { whole, fraction };
}

export function ScoreDisplay({ score, change, size = "md", withLabel = false, flash = false, className }: ScoreDisplayProps) {
  const { whole, fraction } = splitScore(score);
  const dims = scoreSizes[size];

  return (
    <span className={cn("inline-flex items-baseline", dims.gap, className)}>
      <span
        key={flash ? score : undefined}
        className={cn("num inline-flex items-baseline font-semibold leading-none tracking-tighter text-fg", dims.whole, flash && "animate-tick-flash")}
        aria-label={`Momentum score ${whole}.${fraction}`}
      >
        <span>{whole}</span>
        <span>.{fraction}</span>
      </span>
      {change !== undefined ? <DirectionIndicator change={change} size={dims.direction} withLabel={withLabel} /> : null}
    </span>
  );
}
