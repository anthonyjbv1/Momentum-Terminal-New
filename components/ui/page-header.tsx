import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Page title block: a large, confident title, an optional one-line description, optional actions. */
export interface PageHeaderProps {
  /** Optional small caption above the title. Most pages leave it out. */
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="flex flex-col gap-2">
        {eyebrow ? <p className="text-sm text-fg-muted">{eyebrow}</p> : null}
        <h1 className="text-4xl font-bold tracking-tighter text-fg sm:text-5xl">{title}</h1>
        {description ? <p className="max-w-prose text-base text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Section title inside a page or rail. */
export function SectionHeader({ title, meta, className }: { title: string; meta?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-1", className)}>
      <h2 className="text-label text-fg-muted">{title}</h2>
      {meta ? <div className="text-sm text-fg-faint">{meta}</div> : null}
    </div>
  );
}
