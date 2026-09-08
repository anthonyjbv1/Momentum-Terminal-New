import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

export const inputClassName =
  "h-11 w-full rounded-md border border-line bg-surface-raised/60 px-3 text-base text-fg placeholder:text-fg-faint " +
  "transition-[border-color,background-color,box-shadow] duration-150 " +
  "hover:border-line-strong focus:border-accent focus:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:opacity-40 aria-invalid:border-negative";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(inputClassName, className)} {...props} />;
}

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint/error, with consistent rhythm. */
export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-negative">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-muted">{hint}</p>
      ) : null}
    </div>
  );
}
