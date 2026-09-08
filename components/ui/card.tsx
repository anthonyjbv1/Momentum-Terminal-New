import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/**
 * Surface container: the base for person cards, panels and tiles.
 * A card is a raised object on the canvas: one border, one soft shadow,
 * generous radius. `interactive` adds the hover lift for clickable cards.
 */
export interface CardProps extends ComponentProps<"div"> {
  interactive?: boolean;
  /** `raised` for a lighter surface (nested cards, tiles on a card). */
  tone?: "default" | "raised" | "ghost";
}

const cardTones: Record<NonNullable<CardProps["tone"]>, string> = {
  default: "border border-line bg-surface shadow-card",
  raised: "border border-line bg-surface-raised",
  ghost: "border border-dashed border-line-strong bg-transparent",
};

export function Card({ className, interactive = false, tone = "default", ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-xl",
        cardTones[tone],
        interactive &&
          "transition-[border-color,background-color,transform,box-shadow] duration-200 ease-out hover:-translate-y-px hover:border-line-strong hover:bg-surface-raised/70 hover:shadow-raised",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-start justify-between gap-4 px-5 pt-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-base font-semibold tracking-tight text-fg", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-fg-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-3 px-5 pb-5", className)} {...props} />;
}
