import { cn } from "@/lib/cn";
import { directionOf, formatChange } from "@/components/ui/direction-indicator";

/**
 * The platform pulse in the banner: overall Market Mood and whether the
 * Engine is live. Monochrome: a grey dot on standby, a white one when live.
 * Only the mood number itself may take a direction colour.
 */
export interface PulseIndicatorProps {
  /** Market Mood in score points; null until the board is live. */
  mood: number | null;
  status: "live" | "standby";
  className?: string;
}

export function PulseIndicator({ mood, status, className }: PulseIndicatorProps) {
  const direction = directionOf(mood);
  const value = mood === null ? "—" : formatChange(mood, 2);
  const tone = mood === null ? "text-fg-muted" : direction === "heating" ? "text-positive" : direction === "cooling" ? "text-negative" : "text-fg";
  const label = status === "live" ? "Engine live" : "Engine on standby";

  return (
    <div
      className={cn("flex h-10 items-center gap-2 rounded-full bg-surface px-3.5", className)}
      title={`${label} · Market Mood ${value}`}
      aria-label={`${label}. Market Mood ${value}.`}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status === "live" ? "bg-fg animate-pulse-soft" : "bg-fg-faint")} />
      <span className="text-xs font-medium text-fg-muted">Mood</span>
      <span className={cn("num text-xs font-semibold", tone)}>{value}</span>
    </div>
  );
}
