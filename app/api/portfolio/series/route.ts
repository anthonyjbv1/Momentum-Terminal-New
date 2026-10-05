import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { RANGE_KEYS, type RangeKey } from "@/lib/person/profile-model";
import { getMyValueSeries } from "@/lib/portfolio/server";

/**
 * GET /api/portfolio/series?range=7d|all
 *
 * One chart range of the signed-in user's value history, read exactly as the
 * page read it before the tab-switch lag fix (2026-10-04): the same
 * my_portfolio_value_series RPC with the same since and points for the
 * range, downsampled by the database. The page renders 1H and 24H on the
 * server and asks here for 7D and ALL when they are first tapped, so the two
 * slowest reads no longer hold the tab. Identity from the auth cookies.
 * Never cached.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function isRangeKey(value: string | null): value is RangeKey {
  return value !== null && (RANGE_KEYS as readonly string[]).includes(value);
}

export async function GET(request: Request) {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });

  const range = new URL(request.url).searchParams.get("range");
  if (!isRangeKey(range)) return NextResponse.json({ error: "bad_range" }, { status: 400, headers: NO_STORE });

  try {
    const series = await getMyValueSeries([range]);
    return NextResponse.json({ range, points: series[range] }, { headers: NO_STORE });
  } catch (error) {
    console.warn("[portfolio] series read failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
