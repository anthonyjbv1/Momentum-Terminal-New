import type { ReactNode } from "react";

/**
 * Desktop right-hand rail, sticky under the banner. A slot that renders
 * nothing leaves the element empty, and `empty:hidden` collapses it so the
 * main column takes the full width; the layout never has to know.
 */
export function RightRail({ children }: { children?: ReactNode }) {
  return (
    <aside
      aria-label="Sidebar"
      className="sticky top-banner hidden max-h-under-banner w-rail shrink-0 self-start overflow-y-auto border-l border-line py-8 pl-8 empty:hidden lg:block"
    >
      {children}
    </aside>
  );
}
