import { ArrowDown, ArrowUp } from "lucide-react";

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
 * The direction's colour, exported so a surface that composes its own change
 * line (the profile score card, Phase 26) colours it the same as every
 * DirectionIndicator on the platform rather than keeping a second copy.
 */
export const directionTone: Record<Direction, string> = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-neutral",
};

/**
 * THE ARROW (Phase 33): straight up for heating, straight down for cooling,
 * and NOTHING for flat. A change that reads as zero has no direction, so it
 * gets no glyph: the figure stands alone in the neutral colour. Every change
 * on the platform draws its arrow through this one component, so Home, the
 * profile, the Feed, the portfolio and the header Mood cannot drift apart.
 * The Forecast buttons keep their own filled ▲ / ▼: those are the two
 * choices, not a reading.
 */
export const directionArrowIcon: Record<Direction, typeof ArrowUp | null> = {
  heating: ArrowUp,
  cooling: ArrowDown,
  neutral: null,
};

export interface DirectionArrowProps {
  direction: Direction;
  /** Sizes the glyph; defaults to the text size so it sits with the figure. */
  className?: string;
}

export function DirectionArrow({ direction, className }: DirectionArrowProps) {
  const Icon = directionArrowIcon[direction];
  if (!Icon) return null;
  return <Icon className={cn("arrow-em shrink-0", className)} strokeWidth={2.5} aria-hidden />;
}

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
  // No reading at all (the Engine has not moved this person yet) is a bare
  // dash: an arrow beside it would imply a measurement that does not exist.
  const unknown = change === null || change === undefined;
  const value = unknown ? "—" : formatChange(change, precision);
  const label = unknown ? "No change yet" : directionLabels[direction];

  // Inter with tabular figures, not the mono face: a change is a reading in
  // a sentence's typeface (the Phase 26 rule), and tabular digits keep it
  // from jittering as it ticks.
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums leading-none", sizes[size].text, directionTone[direction], className)}
      aria-label={`${label}${unknown ? "" : `, ${value}`}`}
    >
      {unknown ? null : <DirectionArrow direction={direction} className={sizes[size].icon} />}
      {iconOnly && !unknown ? null : <span>{value}</span>}
      {withLabel ? <span className="ml-1 text-label opacity-80">{label}</span> : null}
    </span>
  );
}
