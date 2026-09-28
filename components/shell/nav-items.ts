import { ChartPie, CircleUser, House, Newspaper, type LucideIcon } from "lucide-react";

/** The primary navigation, in order. Bottom tabs on mobile, banner links on desktop. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Stable name, for the tour's anchors (`data-tour="nav-<key>"`, Phase 32b) and nothing else. */
  key: "home" | "portfolio" | "feed" | "profile";
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: House, key: "home" },
  { href: "/portfolio", label: "Portfolio", icon: ChartPie, key: "portfolio" },
  { href: "/feed", label: "Feed", icon: Newspaper, key: "feed" },
  { href: "/profile", label: "Profile", icon: CircleUser, key: "profile" },
];

export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
