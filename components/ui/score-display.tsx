import { cn } from "@/lib/cn";

import { DirectionIndicator, type DirectionIndicatorSize } from "./direction-indicator";

/**
 * The Momentum Score: the platform's signature number.
 * Monospaced, tabular, tightened; integer part bright, decimal quieter; the
 * direction read sits at the baseline beside it. Colour never touches the
 * score itself — only the change carries direction.
 */
export type ScoreSize = "sm" | "md" | "lg" | "xl";

const scoreSizes: Record<ScoreSize, { whole: string; fraction: string; gap: string; direction: DirectionIndicatorSize }> = {
  sm: { whole: "text-lg", fraction: "text-sm", gap: "gap-1.5", direction: "sm" },
  md: { whole: "text-2xl", fraction: "text-base", gap: "gap-2", direction: "sm" },
  lg: { whole: "text-4xl", fraction: "text-xl", gap: "gap-3", direction: "md" },
  xl: { whole: "text-6xl", fraction: "text-3xl", gap: "gap-4", direction: "lg" },
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
        className={cn("num inline-flex items-baseline font-semibold leading-none tracking-tighter text-fg", flash && "animate-tick-flash")}
        aria-label={`Momentum score ${whole}.${fraction}`}
      >
        <span className={dims.whole}>{whole}</span>
        <span className={cn("font-medium text-fg-muted", dims.fraction)}>.{fraction}</span>
      </span>
      {change !== undefined ? <DirectionIndicator change={change} size={dims.direction} withLabel={withLabel} /> : null}
    </span>
  );
}
