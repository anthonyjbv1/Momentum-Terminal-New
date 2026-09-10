import { NextResponse } from "next/server";

import { getFeedPage } from "@/lib/feed/feed";
import { FEED_PAGE_SIZE } from "@/lib/feed/feed-model";

/**
 * GET /api/feed?before=<ISO time>&before_id=<uuid>&limit=<n>
 *
 * The next page of the Feed for the stream's infinite scroll. Keyset
 * pagination: `before` and `before_id` come from the previous page's
 * `nextCursor`. Public read of public data, never cached.
 */

export const dynamic = "force-dynamic";

const MAX_LIMIT = 48;
const NO_STORE = { "cache-control": "no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;

  const before = search.get("before");
  const beforeId = search.get("before_id");
  const cursor =
    before && beforeId && Number.isFinite(Date.parse(before)) && UUID.test(beforeId)
      ? { before: new Date(Date.parse(before)).toISOString(), beforeId: beforeId.toLowerCase() }
      : null;

  const requested = Number.parseInt(search.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : FEED_PAGE_SIZE;

  try {
    const page = await getFeedPage(cursor, limit);
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    console.warn("[feed] page failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
