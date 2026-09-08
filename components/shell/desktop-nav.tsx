"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { NAV_ITEMS, isNavItemActive } from "./nav-items";

/** Banner navigation for md+ screens. The active item is simply white. */
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
              "inline-flex h-10 items-center rounded-full px-4 text-sm font-medium transition-colors",
              active ? "text-fg" : "text-fg-muted hover:text-fg-secondary",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
