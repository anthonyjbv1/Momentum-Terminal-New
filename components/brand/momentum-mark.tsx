import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * The Momentum Terminal mark: two orbital loops crossing, a hollow at the
 * centre. Drawn in the current text colour, so it is white on the black
 * banner and follows any recolour. A vector recreation of the brand asset;
 * drop the original SVG paths in here (and in app/icon.svg) if they exist.
 */
export function MomentumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={cn("size-8 shrink-0", className)} aria-hidden>
      <g fill="none" className="stroke-current" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="50" cy="50" rx="37" ry="15" transform="rotate(45 50 50)" />
        <ellipse cx="50" cy="50" rx="37" ry="15" transform="rotate(-45 50 50)" />
      </g>
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
        "flex shrink-0 items-center gap-3 rounded-full text-fg transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <MomentumMark />
      <span className="hidden items-baseline gap-1.5 text-base font-semibold tracking-tight sm:flex">
        Momentum
        <span className="font-normal text-fg-muted">Terminal</span>
      </span>
    </Link>
  );
}
