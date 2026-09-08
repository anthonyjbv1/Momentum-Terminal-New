import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/**
 * Small pill for categories, sources and states. Monochrome by default;
 * positive / negative exist only for direction and live-status meaning.
 */
export type BadgeTone = "neutral" | "positive" | "negative" | "warning" | "accent" | "outline";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-surface-raised text-fg-secondary",
  positive: "bg-positive/15 text-positive",
  negative: "bg-negative/15 text-negative",
  warning: "bg-surface-raised text-fg-muted",
  accent: "bg-surface-inverse text-fg-inverse",
  outline: "ring-1 ring-inset ring-line-strong text-fg-muted",
};

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: BadgeTone;
  /** A leading dot in the current text colour (live / status badges). */
  dot?: boolean;
}

export function Badge({ className, tone = "neutral", dot = false, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium",
        badgeTones[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}
