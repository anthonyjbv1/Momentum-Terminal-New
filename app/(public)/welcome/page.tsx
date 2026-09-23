import type { Metadata } from "next";
import { headers } from "next/headers";

import { logPublicEventInBackground, referrerHost } from "@/lib/behavioral/public-log";
import { META } from "@/lib/landing/copy";
import { readFeatured } from "@/lib/landing/featured";
import type { FeaturedPayload } from "@/lib/landing/model";
import { getRenderedAt } from "@/lib/render-time";
import { LandingView } from "@/components/landing/landing-view";

/**
 * THE LANDING PAGE (Phase 28), served at "/" to a signed-out visitor by the
 * auth gate's rewrite; this path by name redirects to "/".
 *
 * Rendered per request: the score in the HTML is the one the database holds
 * at that moment (memoised for the current 30-second slot), so the first
 * paint carries a real number and the browser only has to keep it moving.
 * A failed read renders the page WITHOUT a number — never a made-up one —
 * and the client keeps asking.
 *
 * The view is logged server-side as an anonymous event, with the referring
 * host and the campaign parameters and nothing about the person.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: META.title },
  alternates: { canonical: "/" },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : undefined;
}

export default async function LandingPage({ searchParams }: { searchParams: SearchParams }) {
  const [params, requestHeaders] = await Promise.all([searchParams, headers()]);

  let initial: FeaturedPayload | null = null;
  try {
    initial = await readFeatured();
  } catch (error) {
    console.warn("[landing] featured read failed:", error instanceof Error ? error.message : error);
  }

  logPublicEventInBackground({
    eventType: "view_landing",
    metadata: {
      referrer_host: referrerHost(requestHeaders.get("referer")) ?? undefined,
      utm_source: first(params.utm_source),
      utm_medium: first(params.utm_medium),
      utm_campaign: first(params.utm_campaign),
    },
  });

  return <LandingView initial={initial} renderedAt={getRenderedAt()} />;
}
