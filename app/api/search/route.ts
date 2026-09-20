import { NextResponse } from "next/server";

import { searchPeople } from "@/lib/search/search";
import { SEARCH_LIMIT } from "@/lib/search/search-model";

/**
 * GET /api/search?q=<query>&limit=<n>
 *
 * People matching the query, ranked, already filtered to the discoverable.
 * Never cached: a search is a read of live scores.
 */

export const dynamic = "force-dynamic";

const MAX_LIMIT = 25;
/** Longer than any name; anything past this is not a search, it is a paste. */
const MAX_QUERY_LENGTH = 120;
const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);

  const requested = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : SEARCH_LIMIT;

  if (query === "") return NextResponse.json({ query: "", results: [] }, { headers: NO_STORE });

  try {
    const results = await searchPeople(query, limit);
    return NextResponse.json({ query, results }, { headers: NO_STORE });
  } catch (error) {
    console.warn("[search] query failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
