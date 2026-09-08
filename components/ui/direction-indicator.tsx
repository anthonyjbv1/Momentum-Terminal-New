import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * Heating / cooling / neutral: the arrow-plus-colour read of a change.
 * Green means heating (score rising), red cooling, amber flat.
 */
export type Direction = "heating" | "cooling" | "neutral";

/** Changes smaller than this (in score points) read as flat. */
export const FLAT_THRESHOLD = 0.05;

export function directionOf(change: number | null | undefined, threshold: number = FLAT_THRESHOLD): Direction {
  if (change === null || change === undefined || Number.isNaN(change)) return "neutral";
  if (change > threshold) return "heating";
  if (change < -threshold) return "cooling";
  return "neutral";
}

export const directionLabels: Record<Direction, string> = {
  heating: "Heating",
  cooling: "Cooling",
  neutral: "Flat",
};

const directionTone: Record<Direction, string> = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-neutral",
};

const directionIcon: Record<Direction, typeof ArrowUpRight> = {
  heating: ArrowUpRight,
  cooling: ArrowDownRight,
  neutral: Minus,
};

export type DirectionIndicatorSize = "sm" | "md" | "lg";

const sizes: Record<DirectionIndicatorSize, { text: string; icon: string }> = {
  sm: { text: "text-xs", icon: "size-3" },
  md: { text: "text-sm", icon: "size-4" },
  lg: { text: "text-base", icon: "size-5" },
};

export interface DirectionIndicatorProps {
  /** Change in score points over the display window. */
  change: number | null | undefined;
  size?: DirectionIndicatorSize;
  /** Append "Heating" / "Cooling" / "Flat". */
  withLabel?: boolean;
  /** Hide the number, keep the arrow (dense lists). */
  iconOnly?: boolean;
  precision?: number;
  className?: string;
}

export function formatChange(change: number, precision = 1): string {
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  return `${sign}${Math.abs(change).toFixed(precision)}`;
}

export function DirectionIndicator({ change, size = "md", withLabel = false, iconOnly = false, precision = 1, className }: DirectionIndicatorProps) {
  const direction = directionOf(change);
  const Icon = directionIcon[direction];
  const value = change === null || change === undefined ? "—" : formatChange(change, precision);
  const label = directionLabels[direction];

  return (
    <span
      className={cn("num inline-flex items-center gap-0.5 font-medium leading-none", sizes[size].text, directionTone[direction], className)}
      aria-label={`${label}, ${value}`}
    >
      <Icon className={cn(sizes[size].icon, "shrink-0")} strokeWidth={2.5} aria-hidden />
      {iconOnly ? null : <span>{value}</span>}
      {withLabel ? <span className="ml-1 text-label opacity-80">{label}</span> : null}
    </span>
  );
}
