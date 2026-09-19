import { cn } from "@/lib/cn";
import { directionAtPrecision, formatChange } from "@/components/ui/direction-indicator";

/**
 * The platform pulse in the banner: overall Market Mood and whether the
 * Engine is live. Monochrome: a grey dot on standby, a white one when live.
 * Only the mood number itself may take a direction colour.
 *
 * The mood it shows is the board's tide over the Engine's trailing window
 * (Phase 19+), not the tick's own signals: a reading that existed for one
 * tick in thirty was a splash, and an indicator that reads flat whatever
 * happens is decoration rather than information.
 */
export interface PulseIndicatorProps {
  /** Market Mood in score points; null until the board is live. */
  mood: number | null;
  status: "live" | "standby";
  /** The window the mood was read over, for the description. Null leaves it unsaid. */
  windowMinutes?: number | null;
  className?: string;
}

/** "the last hour", "the last 30 minutes", "the last 2 hours". */
export function windowLabel(minutes: number): string {
  if (minutes === 60) return "the last hour";
  if (minutes % 60 === 0) return `the last ${minutes / 60} hours`;
  return `the last ${minutes} minutes`;
}

const MOOD_DECIMALS = 2;

export function PulseIndicator({ mood, status, windowMinutes = null, className }: PulseIndicatorProps) {
  // The colour follows the figure shown: a mood that rounds to 0.00 is flat,
  // whatever its sign underneath (Phase 19+).
  const direction = directionAtPrecision(mood, MOOD_DECIMALS);
  const value = mood === null ? "—" : formatChange(mood, MOOD_DECIMALS);
  const tone = mood === null ? "text-fg-muted" : direction === "heating" ? "text-positive" : direction === "cooling" ? "text-negative" : "text-fg";
  const label = status === "live" ? "Engine live" : "Engine on standby";
  const over = mood !== null && windowMinutes ? ` over ${windowLabel(windowMinutes)}` : "";

  return (
    <div
      className={cn("flex h-10 items-center gap-2 rounded-full bg-surface px-3.5", className)}
      title={`${label} · Market Mood ${value}${over}`}
      aria-label={`${label}. Market Mood ${value}${over}.`}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status === "live" ? "bg-fg animate-pulse-soft" : "bg-fg-faint")} />
      <span className="text-xs font-medium text-fg-muted">Mood</span>
      <span className={cn("num text-xs font-semibold", tone)}>{value}</span>
    </div>
  );
}
