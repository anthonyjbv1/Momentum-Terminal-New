"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { NAV_ITEMS, isNavItemActive } from "./nav-items";

/** Social-app tab bar, mobile only: four icons, the active one white. Clears the home indicator. */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-(--z-tabbar) border-t border-line bg-canvas/85 pb-safe backdrop-blur-xl md:hidden">
      <ul className="flex h-tabbar items-center justify-around px-4">
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item.href, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex size-touch items-center justify-center rounded-full transition-colors",
                  active ? "text-fg" : "text-fg-muted hover:text-fg-secondary",
                )}
              >
                <Icon className="size-6" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
