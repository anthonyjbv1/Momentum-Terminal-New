"use client";

import { cn } from "@/lib/cn";
import { RANGES, type RangeKey } from "@/lib/person/profile-model";

/**
 * 1H / 24H / 7D / ALL. A range with nothing to draw is disabled rather than
 * hidden, so the set of ranges is stable and the gap is visibly a gap.
 */
export interface RangeToggleProps {
  value: RangeKey | null;
  available: Record<RangeKey, boolean>;
  onChange: (range: RangeKey) => void;
  className?: string;
}

export function RangeToggle({ value, available, onChange, className }: RangeToggleProps) {
  return (
    <div role="radiogroup" aria-label="Chart range" className={cn("inline-flex items-center gap-0.5 rounded-full bg-surface-raised p-1", className)}>
      {RANGES.map((range) => {
        const active = range.key === value;
        const enabled = available[range.key];
        return (
          <button
            key={range.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!enabled}
            title={enabled ? undefined : "No history in this range yet"}
            onClick={() => enabled && !active && onChange(range.key)}
            className={cn(
              "h-7 min-w-9 rounded-full px-2 text-xs font-medium transition-colors sm:min-w-11 sm:px-2.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              active ? "bg-surface-inverse text-fg-inverse" : "text-fg-muted hover:text-fg",
              !enabled && "cursor-not-allowed text-fg-faint opacity-60 hover:text-fg-faint",
            )}
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}
