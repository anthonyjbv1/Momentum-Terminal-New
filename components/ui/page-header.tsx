import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Page title block: eyebrow, title, one-line description, optional actions. */
export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="flex flex-col gap-1.5">
        {eyebrow ? <p className="text-label text-fg-muted">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{title}</h1>
        {description ? <p className="max-w-prose text-sm text-fg-muted sm:text-base">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Section title inside a page or rail. */
export function SectionHeader({ title, meta, className }: { title: string; meta?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <h2 className="text-label text-fg-muted">{title}</h2>
      {meta ? <div className="text-xs text-fg-faint">{meta}</div> : null}
    </div>
  );
}
