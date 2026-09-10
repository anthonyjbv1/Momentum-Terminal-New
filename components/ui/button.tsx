import { LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/**
 * Button. Pill-shaped, quiet by default. Variants are the platform's verbs:
 *   primary   the one main action on a screen (white on black)
 *   buy       HIGH — the light pill: near-white fill, black label.
 *   sell      LOW  — the dark pill: near-black fill, white label.
 *   outline   secondary actions: a soft grey surface
 *   ghost     tertiary / icon actions
 *
 * Buy and Sell are trading controls, not calls to action, and they are
 * monochrome: direction colour belongs to the change figures, never to the
 * buttons. Their tokens are --color-buy / --color-sell (+ -fg) in tokens.css.
 */
export type ButtonVariant = "primary" | "buy" | "sell" | "outline" | "ghost";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-surface-inverse text-fg-inverse hover:bg-fg-secondary",
  buy: "bg-buy text-buy-fg hover:brightness-90",
  sell: "bg-sell text-sell-fg hover:brightness-150",
  outline: "bg-surface text-fg hover:bg-surface-raised",
  ghost: "bg-transparent text-fg-secondary hover:bg-surface hover:text-fg",
};

export const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-4 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-7 text-base",
  icon: "size-touch",
};

export const buttonBase =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium " +
  "transition-[background-color,color,transform,filter,opacity] duration-150 ease-out " +
  "active:scale-97 disabled:pointer-events-none disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
  "[&_svg]:size-4 [&_svg]:shrink-0";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export function Button({ className, variant = "primary", size = "md", loading = false, disabled, children, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/** The same look on an anchor (next/link passes through). */
export function buttonClassName(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string): string {
  return cn(buttonBase, buttonVariants[variant], buttonSizes[size], className);
}
