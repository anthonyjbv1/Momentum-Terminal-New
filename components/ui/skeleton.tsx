import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/** Loading placeholder with the shared shimmer. Size it with width/height utilities. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden {...props} />;
}

/** A few lines of text. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-3", index === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function SkeletonCircle({ className }: { className?: string }) {
  return <Skeleton className={cn("size-10 rounded-full", className)} />;
}

/** A person row: avatar, name + meta, score column. */
export function SkeletonPersonRow({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 px-5 py-4", className)} aria-hidden>
      <SkeletonCircle />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex flex-col items-end gap-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-3 w-10" />
      </div>
    </div>
  );
}

/** A stat tile: label and a big number. */
export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border border-line bg-surface p-5", className)} aria-hidden>
      <Skeleton className="h-2.5 w-16" />
      <Skeleton className="h-7 w-24" />
    </div>
  );
}

/** A feed item: source line, headline, footer. */
export function SkeletonFeedItem({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4", className)} aria-hidden>
      <div className="flex items-center gap-2">
        <Skeleton className="size-5 rounded-full" />
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="ml-auto h-2.5 w-10" />
      </div>
      <SkeletonText lines={2} />
    </div>
  );
}
