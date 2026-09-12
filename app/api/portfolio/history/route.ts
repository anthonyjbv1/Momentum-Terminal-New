import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { HISTORY_PAGE_SIZE } from "@/lib/portfolio/model";
import { getMyTradeHistory } from "@/lib/portfolio/server";

/**
 * GET /api/portfolio/history?before=<ISO time>&before_id=<uuid>&limit=<n>
 *
 * The next page of the signed-in user's trade history. Keyset pagination:
 * `before` and `before_id` come from the previous page's `nextCursor`.
 * Identity from the auth cookies; the RPC runs as the user. Never cached.
 */

export const dynamic = "force-dynamic";

const MAX_LIMIT = 100;
const NO_STORE = { "cache-control": "no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });

  const search = new URL(request.url).searchParams;
  const before = search.get("before");
  const beforeId = search.get("before_id");
  const cursor =
    before && beforeId && Number.isFinite(Date.parse(before)) && UUID.test(beforeId)
      ? { before, beforeId: beforeId.toLowerCase() }
      : null;

  const requested = Number.parseInt(search.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : HISTORY_PAGE_SIZE;

  try {
    const page = await getMyTradeHistory(cursor, limit);
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    console.warn("[portfolio] history page failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
