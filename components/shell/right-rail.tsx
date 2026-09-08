import type { ReactNode } from "react";

/**
 * Desktop right-hand rail, sticky under the banner. A slot that renders
 * nothing leaves the element empty, and `empty:hidden` collapses it so the
 * main column takes the full width; the layout never has to know.
 * No divider: the cards themselves give the column its edge.
 */
export function RightRail({ children }: { children?: ReactNode }) {
  return (
    <aside
      aria-label="Sidebar"
      className="sticky top-banner hidden max-h-under-banner w-rail shrink-0 self-start overflow-y-auto py-10 pl-10 empty:hidden lg:block"
    >
      {children}
    </aside>
  );
}
