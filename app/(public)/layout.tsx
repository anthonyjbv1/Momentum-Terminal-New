import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getSiteOrigin } from "@/lib/env";
import { META } from "@/lib/landing/copy";

/**
 * The public route group (Phase 28): the landing page, the privacy page and
 * the OG image. Outside (app) on purpose — no shell, no banner, no tab bar,
 * nothing that assumes a session — and outside (auth), which is the closed
 * beta's front door rather than the public's.
 *
 * Everything absolute here derives from ONE variable, NEXT_PUBLIC_SITE_URL
 * (lib/env.ts): the canonical URL, the OG image, the metadata. The Vercel
 * hostname is never written down.
 */
export const metadata: Metadata = {
  metadataBase: new URL(getSiteOrigin()),
  description: META.description,
  openGraph: {
    type: "website",
    siteName: "Momentum Terminal",
    title: META.title,
    description: META.description,
    url: "/",
    images: [{ url: "/og", width: 1200, height: 630, alt: META.ogAlt }],
  },
  twitter: {
    card: "summary_large_image",
    title: META.title,
    description: META.description,
    images: ["/og"],
  },
  robots: { index: true, follow: true },
};

export default function PublicLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh">{children}</div>;
}
