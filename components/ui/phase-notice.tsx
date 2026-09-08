import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Badge } from "./badge";

/**
 * Marks a slot whose real content arrives in a later phase. A quiet grey
 * line rather than a callout: it keeps placeholder pages honest without
 * shouting.
 */
export function PhaseNotice({ phase, children, className }: { phase: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 rounded-2xl bg-surface/60 px-5 py-4", className)}>
      <p className="text-sm text-fg-muted">{children}</p>
      <Badge tone="outline">{phase}</Badge>
    </div>
  );
}
