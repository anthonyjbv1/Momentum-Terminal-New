"use client";

import { cn } from "@/lib/cn";
import type { CategoryOption } from "@/lib/home/board-model";

/**
 * Category filter: a quiet row of pills. The selected one inverts to white,
 * everything else stays a grey surface — no accent colour, since colour on
 * this platform means direction.
 */
export interface CategoryFilterProps {
  options: CategoryOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function CategoryFilter({ options, value, onChange, className }: CategoryFilterProps) {
  return (
    <div
      role="group"
      aria-label="Filter people by category"
      className={cn("flex gap-2 overflow-x-auto scrollbar-none", className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              active ? "bg-surface-inverse text-fg-inverse" : "bg-surface text-fg-muted hover:bg-surface-raised hover:text-fg-secondary",
            )}
          >
            {option.label}
            <span className={cn("num text-xs", active ? "text-fg-inverse/60" : "text-fg-faint")}>{option.count}</span>
          </button>
        );
      })}
    </div>
  );
}
