"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { NAV_ITEMS, isNavItemActive } from "./nav-items";

/** Social-app tab bar, mobile only. Clears the home indicator on notched phones. */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-(--z-tabbar) border-t border-line bg-canvas/85 pb-safe backdrop-blur-md md:hidden">
      <ul className="grid h-tabbar grid-cols-4">
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item.href, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="min-w-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-full min-h-touch flex-col items-center justify-center gap-1 text-2xs font-medium transition-colors",
                  active ? "text-positive" : "text-fg-muted hover:text-fg-secondary",
                )}
              >
                <span
                  aria-hidden
                  className={cn("absolute top-0 h-0.5 w-8 rounded-full bg-positive transition-opacity", active ? "opacity-100" : "opacity-0")}
                />
                <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
