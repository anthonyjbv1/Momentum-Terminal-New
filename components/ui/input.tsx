import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

export const inputClassName =
  "h-12 w-full rounded-xl bg-surface-raised px-4 text-base text-fg placeholder:text-fg-faint " +
  "ring-1 ring-inset ring-transparent transition-[background-color,box-shadow] duration-150 " +
  "hover:ring-line focus:ring-line-strong focus-visible:outline-none " +
  "disabled:opacity-40 aria-invalid:ring-negative/60";

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
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-fg-muted">{hint}</p>
      ) : null}
    </div>
  );
}
