import type { Metadata } from "next";

import { requireAdmin } from "@/lib/admin/auth";

import "./admin.css";

/**
 * /admin — the operator console, its own route tree (Phase 9).
 *
 * Deliberately outside the (app) group. The Phase 7 auth gate is one file that
 * gets deleted when the beta opens; admin pages living inside the main tree
 * would become public at that moment and would have to be re-secured. Here the
 * only thing that has ever guarded them is the role check below, so removing
 * the gate cannot expose them.
 *
 * requireAdmin() runs in the layout AND again inside every data read — a layout
 * is not a security boundary on its own (a nested route can render without its
 * parent layout re-running on a client navigation), so the queries carry their
 * own check rather than trusting this one.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Operator",
  robots: { index: false, follow: false },
};

const SECTIONS = [
  { href: "#llm", label: "LLM cost" },
  { href: "#ingestion", label: "Ingestion" },
  { href: "#engine", label: "Engine" },
  { href: "#levers", label: "Levers" },
  { href: "#behaviour", label: "Behaviour" },
];

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const admin = await requireAdmin();

  return (
    <div className="adm">
      <div className="adm-bar">
        <b>Momentum Terminal · Operator</b>
        <span className="adm-who">{admin.email}</span>
        <nav>
          {SECTIONS.map((section) => (
            <a key={section.href} href={section.href}>
              {section.label}
            </a>
          ))}
        </nav>
      </div>
      <main className="adm-main">{children}</main>
    </div>
  );
}
