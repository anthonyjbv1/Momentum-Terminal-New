import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getMyPortfolio, getMyValuePointsAfter } from "@/lib/portfolio/server";

/**
 * GET /api/portfolio/live?after=<ISO time>
 *
 * What the portfolio page asks for on the Engine's cadence: the summary as
 * the server computes it now (every position marked at the current quotes)
 * and any value points recorded after `after`, oldest first. The page folds
 * the points into its chart and replaces its figures with the summary; it
 * computes nothing. Identity from the auth cookies. Never cached.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });

  const raw = new URL(request.url).searchParams.get("after");
  const after = raw && Number.isFinite(Date.parse(raw)) ? raw : null;

  try {
    const [summary, points] = await Promise.all([getMyPortfolio(), getMyValuePointsAfter(after)]);
    return NextResponse.json({ summary, points: points.map((point) => ({ at: point.at, value_cents: point.valueCents })) }, { headers: NO_STORE });
  } catch (error) {
    console.warn("[portfolio] live read failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
