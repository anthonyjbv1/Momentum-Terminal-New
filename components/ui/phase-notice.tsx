import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Badge } from "./badge";

/**
 * Marks a slot whose real content arrives in a later phase. Keeps
 * placeholder pages honest without leaving raw empty space.
 */
export function PhaseNotice({ phase, children, className }: { phase: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-lg border border-dashed border-line-strong px-4 py-3", className)}>
      <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
      <p className="text-sm text-fg-muted">{children}</p>
      <Badge tone="accent" className="ml-auto">
        {phase}
      </Badge>
    </div>
  );
}
