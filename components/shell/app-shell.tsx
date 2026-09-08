import type { ReactNode } from "react";

import { BottomNav } from "./bottom-nav";
import { RightRail } from "./right-rail";
import { TopBanner } from "./top-banner";

/**
 * The frame every app page renders inside.
 *
 *   desktop  banner / [ main column | right rail ]
 *   mobile   banner / main column / bottom tab bar
 *
 * Pages fill `children`; a route provides rail content through the @rail
 * parallel slot in app/(app). The shell decides where things go.
 */
export function AppShell({ children, rail }: { children: ReactNode; rail?: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-(--z-toast) focus:rounded-md focus:bg-surface-overlay focus:px-3 focus:py-2 focus:text-sm focus:text-fg"
      >
        Skip to content
      </a>
      <TopBanner />
      <div className="mx-auto flex w-full max-w-shell px-4 pt-banner sm:px-6">
        <main id="main" className="min-w-0 flex-1 py-6 pb-tabbar-safe sm:py-8 md:pb-8 lg:pr-8">
          {children}
        </main>
        <RightRail>{rail}</RightRail>
      </div>
      <BottomNav />
    </div>
  );
}
