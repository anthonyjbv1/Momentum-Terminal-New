import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";

/**
 * Money on screen. Always integer cents in, always the same two-decimal
 * currency string out, in the numeric face. `signed` shows a real sign and,
 * only then, colour on direction: green up, red down, grey flat.
 */
export interface MoneyProps {
  cents: number;
  signed?: boolean;
  className?: string;
}

export function Money({ cents, signed = false, className }: MoneyProps) {
  const value = Number.isSafeInteger(cents) ? cents : 0;
  if (!signed) return <span className={cn("num", className)}>{formatCents(value)}</span>;
  const tone = value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return (
    <span className={cn("num", tone, className)}>
      {sign}
      {formatCents(Math.abs(value))}
    </span>
  );
}

/** A quote in points, one decimal, as the page shows scores. */
export function pointsText(cents: number): string {
  return (cents / 100).toFixed(1);
}
