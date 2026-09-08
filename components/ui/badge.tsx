import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/** Small mono label for categories, sources and states. */
export type BadgeTone = "neutral" | "positive" | "negative" | "warning" | "accent" | "outline";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-surface-raised text-fg-secondary",
  positive: "bg-positive/12 text-positive",
  negative: "bg-negative/12 text-negative",
  warning: "bg-neutral/12 text-neutral",
  accent: "bg-accent/12 text-accent",
  outline: "border border-line-strong text-fg-muted",
};

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: BadgeTone;
  /** A leading dot in the tone colour (live / status badges). */
  dot?: boolean;
}

export function Badge({ className, tone = "neutral", dot = false, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-label",
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
