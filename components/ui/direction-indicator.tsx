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

/** True when the value is shown as zero at `precision` — the same rounding the formatters do. */
export function roundsToZero(value: number, precision: number): boolean {
  return Number(Math.abs(value).toFixed(precision)) === 0;
}

/**
 * The direction of a value AS IT IS DISPLAYED (Phase 19+).
 *
 * Colour means direction in this design system, and a zero has no direction.
 * A number can still carry a sign after it has rounded to nothing — Gravity's
 * pull is a small negative that reads "0.00" at two decimals, which since
 * Phase 14 stored scores at four decimals is common rather than rare — and
 * colouring that red says "falling" where the figure says "nothing happened".
 *
 * So: a value that rounds to zero at the precision it is shown at is neutral,
 * whatever its sign underneath. Above that the existing flat threshold still
 * applies. This rounds with the same toFixed the formatters use, so the text
 * and its colour cannot disagree.
 *
 * Nothing here changes rounding or precision: it is a colouring rule only.
 */
export function directionAtPrecision(change: number | null | undefined, precision: number, threshold: number = FLAT_THRESHOLD): Direction {
  if (change === null || change === undefined || Number.isNaN(change)) return "neutral";
  if (roundsToZero(change, precision)) return "neutral";
  return directionOf(change, threshold);
}

export const directionLabels: Record<Direction, string> = {
  heating: "Heating",
  cooling: "Cooling",
  neutral: "Flat",
};

/**
 * The direction's colour and its arrow, exported so a surface that composes
 * its own change line (the profile score card, Phase 26) draws the same
 * arrow in the same colour as every DirectionIndicator on the platform
 * rather than keeping a second copy of the mapping.
 */
export const directionTone: Record<Direction, string> = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-neutral",
};

export const directionIcon: Record<Direction, typeof ArrowUpRight> = {
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

/**
 * "+1.2", "−0.4", "0.0" — the sign is a real minus, not a hyphen, and a
 * figure that rounds to zero carries no sign at all (Phase 19+): "+0.00" for
 * a value of 0.004 claims a direction the number does not show. The same rule
 * as formatSigned() in the profile model, and the same rule the colour
 * follows, so the text and its colour cannot disagree.
 */
export function formatChange(change: number, precision = 1): string {
  const fixed = Math.abs(change).toFixed(precision);
  if (Number(fixed) === 0) return fixed;
  return `${change > 0 ? "+" : "−"}${fixed}`;
}

export function DirectionIndicator({ change, size = "md", withLabel = false, iconOnly = false, precision = 1, className }: DirectionIndicatorProps) {
  // The arrow and the colour follow the figure this renders, at its own
  // precision: at the default (one decimal) that is the flat threshold
  // exactly, so nothing about the usual reading changes.
  const direction = directionAtPrecision(change, precision);
  const Icon = directionIcon[direction];
  // No reading at all (the Engine has not moved this person yet) is a bare
  // dash: an arrow beside it would imply a measurement that does not exist.
  const unknown = change === null || change === undefined;
  const value = unknown ? "—" : formatChange(change, precision);
  const label = unknown ? "No change yet" : directionLabels[direction];

  return (
    <span
      className={cn("num inline-flex items-center gap-0.5 font-medium leading-none", sizes[size].text, directionTone[direction], className)}
      aria-label={`${label}${unknown ? "" : `, ${value}`}`}
    >
      {unknown ? null : <Icon className={cn(sizes[size].icon, "shrink-0")} strokeWidth={2.5} aria-hidden />}
      {iconOnly && !unknown ? null : <span>{value}</span>}
      {withLabel ? <span className="ml-1 text-label opacity-80">{label}</span> : null}
    </span>
  );
}
