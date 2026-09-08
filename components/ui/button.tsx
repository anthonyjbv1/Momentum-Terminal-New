import { LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/**
 * Button. Variants are the platform's verbs:
 *   primary   the one main action on a screen (inverse surface, quiet)
 *   buy       HIGH — the signature green
 *   sell      LOW  — red
 *   outline   secondary actions
 *   ghost     tertiary / icon actions
 */
export type ButtonVariant = "primary" | "buy" | "sell" | "outline" | "ghost";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-surface-inverse text-fg-inverse hover:bg-fg shadow-card",
  buy: "bg-positive text-positive-fg hover:shadow-glow-positive",
  sell: "bg-negative text-negative-fg hover:shadow-glow-negative",
  outline: "border border-line-strong bg-surface text-fg hover:border-fg-faint hover:bg-surface-raised",
  ghost: "bg-transparent text-fg-secondary hover:bg-surface-raised hover:text-fg",
};

export const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
  icon: "size-touch",
};

export const buttonBase =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform,filter] duration-150 ease-out " +
  "hover:brightness-105 active:scale-98 disabled:pointer-events-none disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
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
