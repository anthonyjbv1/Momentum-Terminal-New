"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { NAV_ITEMS, isNavItemActive } from "./nav-items";

/** Banner navigation for md+ screens. The active item carries a green underline. */
export function DesktopNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className={cn("items-center gap-1", className)}>
      {NAV_ITEMS.map((item) => {
        const active = isNavItemActive(item.href, pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative inline-flex h-banner items-center px-3 text-sm font-medium transition-colors",
              "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-positive after:transition-opacity",
              active ? "text-fg after:opacity-100" : "text-fg-muted after:opacity-0 hover:text-fg-secondary",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
