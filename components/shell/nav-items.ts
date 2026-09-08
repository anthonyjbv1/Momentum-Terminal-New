import { ChartPie, CircleUser, House, Newspaper, type LucideIcon } from "lucide-react";

/** The primary navigation, in order. Bottom tabs on mobile, banner links on desktop. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/portfolio", label: "Portfolio", icon: ChartPie },
  { href: "/feed", label: "Feed", icon: Newspaper },
  { href: "/profile", label: "Profile", icon: CircleUser },
];

export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
