import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";

/**
 * Money on screen. Always integer cents in, always the same two-decimal
 * currency string out. `signed` shows a real sign and, only then, colour on
 * direction: green up, red down, grey flat.
 *
 * TWO FACES, AND WHY (Phase 25). Mono's only functional job is a figure that
 * TICKS: its digits are fixed-width, so a value that updates does not jitter.
 * Inter's digits are fixed-width too under `tabular-nums`, so the jitter
 * argument does not require the monospace face — and where money sits inside
 * a sentence, mono makes the sentence change typeface mid-line, which is most
 * of why a page can read like a log.
 *
 *   face="mono"  the default, and unchanged everywhere it was already used:
 *                the profile, the trade sheet, the balance chip, Home.
 *   face="text"  Inter with tabular figures. Portfolio passes this at every
 *                call site — a deliberate, documented exception to the 6a
 *                "mono for numerics" rule, not a new global default.
 *
 * Both faces are tabular, so nothing gains or loses jitter by moving between
 * them; the only difference is the typeface.
 */
export type MoneyFace = "mono" | "text";

export interface MoneyProps {
  cents: number;
  signed?: boolean;
  /** "mono" (default) is the numeric face; "text" is Inter with tabular figures. */
  face?: MoneyFace;
  className?: string;
}

export function Money({ cents, signed = false, face = "mono", className }: MoneyProps) {
  const value = Number.isSafeInteger(cents) ? cents : 0;
  const numerals = face === "mono" ? "num" : "tabular-nums";
  if (!signed) return <span className={cn(numerals, className)}>{formatCents(value)}</span>;
  const tone = value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return (
    <span className={cn(numerals, tone, className)}>
      {sign}
      {formatCents(Math.abs(value))}
    </span>
  );
}

/** A quote in points, one decimal, as the page shows scores. */
export function pointsText(cents: number): string {
  return (cents / 100).toFixed(1);
}
