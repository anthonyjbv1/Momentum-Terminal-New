import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * The Momentum mark: a rising line inside a rounded tile, its endpoint lit in
 * the signature green. Colours come from tokens (fill-/stroke- utilities),
 * so a recolour changes the mark too.
 */
export function MomentumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={cn("size-7 shrink-0", className)} aria-hidden>
      <rect x="0.75" y="0.75" width="26.5" height="26.5" rx="7" className="fill-surface-raised stroke-line-strong" strokeWidth="1.5" />
      <polyline
        points="6.5,19.5 11.5,13.5 15.5,16.5 21.5,8.5"
        fill="none"
        className="stroke-positive"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="21.5" cy="8.5" r="4" className="fill-positive/25" />
      <circle cx="21.5" cy="8.5" r="2" className="fill-positive" />
    </svg>
  );
}

/** Mark + wordmark, linking home. The wordmark hides on the narrowest screens. */
export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Momentum Terminal — Home"
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-md transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <MomentumMark />
      <span className="hidden flex-col leading-none sm:flex">
        <span className="text-sm font-semibold tracking-tight text-fg">Momentum</span>
        <span className="text-label text-fg-muted">Terminal</span>
      </span>
    </Link>
  );
}
