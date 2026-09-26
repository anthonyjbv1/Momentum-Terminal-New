import type { ReactNode } from "react";

import { Logo } from "@/components/brand/momentum-mark";
import { cn } from "@/lib/cn";

/**
 * The quiet frame (Phase 32): the mark and nothing else. The join page, the
 * onboarding screens and the Terms use it instead of the app's banner, which
 * carries the Engine's thirty-second countdown: a first visit asks for
 * attention to what the product is, and a ticking clock on a sign-up screen
 * reads as pressure whatever it is actually counting.
 */
export function QuietLayout({ children, width = "md", aside }: { children: ReactNode; width?: "md" | "lg" | "xl"; aside?: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-banner w-full max-w-shell items-center justify-between gap-4 px-5 sm:px-8">
        <Logo />
        {aside ?? null}
      </header>
      <main className={cn("mx-auto w-full px-5 pb-20 pt-6 sm:px-8 sm:pt-12", width === "md" && "max-w-md", width === "lg" && "max-w-2xl", width === "xl" && "max-w-3xl")}>{children}</main>
    </div>
  );
}
