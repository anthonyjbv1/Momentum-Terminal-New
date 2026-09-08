import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/**
 * Surface container: the base for person cards, panels and tiles.
 * A soft grey object on the black ground: generous radius, no border, a
 * whisper of inner light. `interactive` brightens on hover for clickable cards.
 */
export interface CardProps extends ComponentProps<"div"> {
  interactive?: boolean;
  /** `raised` for a lighter surface (nested tiles); `ghost` for an outlined, empty slot. */
  tone?: "default" | "raised" | "ghost";
}

const cardTones: Record<NonNullable<CardProps["tone"]>, string> = {
  default: "bg-surface shadow-card",
  raised: "bg-surface-raised shadow-card",
  ghost: "bg-transparent ring-1 ring-inset ring-line",
};

export function Card({ className, interactive = false, tone = "default", ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl",
        cardTones[tone],
        interactive && "transition-[background-color,transform,box-shadow] duration-200 ease-out hover:-translate-y-px hover:bg-surface-raised hover:shadow-raised",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-start justify-between gap-4 px-6 pt-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-lg font-semibold tracking-tight text-fg", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-fg-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-6 py-6", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-3 px-6 pb-6", className)} {...props} />;
}
