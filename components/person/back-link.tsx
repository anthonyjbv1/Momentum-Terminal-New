import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/cn";

/** The way back to the board. Quiet, top-left, always present. */
export function BackLink({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full text-sm text-fg-muted transition-colors hover:text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-canvas",
        className,
      )}
    >
      <ArrowLeft className="size-4" strokeWidth={2} aria-hidden />
      Home
    </Link>
  );
}
