import { NextResponse, type NextRequest } from "next/server";

import { createRateLimiter } from "@/lib/behavioral/core";
import { readFeatured } from "@/lib/landing/featured";
import { FEATURED_PAYLOAD_KEYS } from "@/lib/landing/model";

/**
 * GET /api/public/featured — the ONE public read (Phase 28).
 *
 * The featured person's current Momentum Score, recent change, a day of
 * history, the five forces over the last hour and the newest plain-language
 * signals. Nothing about any user, trade or position, and nothing about any
 * other person: the slug is a constant in lib/landing/model.ts, and THIS
 * HANDLER READS NO PARAMETER. Path, query and headers are ignored, so there
 * is no input through which a caller could name somebody else.
 *
 * No session. Server-cached for one 30-second slot (lib/landing/featured.ts)
 * and rate-limited per address in this instance's memory: a burst hits the
 * memo, a runaway client hits the limit, and neither reaches the database
 * more than once a tick.
 *
 * When the read fails the answer is 503 and nothing else — never a stale
 * body dressed as a fresh one. The page keeps the last value it received and
 * says when it was from.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per address per minute. The page asks twice a tick at most; this is forty times that. */
const limiter = createRateLimiter({ maxPerWindow: 240, windowMs: 60_000 });

const HEADERS = {
  // A short shared cache absorbs a burst at the edge; the memo behind it is
  // what makes the answer one tick old at most.
  "cache-control": "public, max-age=0, s-maxage=5, stale-while-revalidate=25",
  vary: "accept",
} as const;
const NO_STORE = { "cache-control": "no-store" } as const;

function clientAddress(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function GET(request: NextRequest) {
  if (!limiter.allow(clientAddress(request), Date.now())) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "retry-after": "60" } });
  }
  try {
    const payload = await readFeatured();
    if (!payload) return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
    // The allowlist, applied on the way out as well as on the way in.
    const body = Object.fromEntries(FEATURED_PAYLOAD_KEYS.map((key) => [key, payload[key]]));
    return NextResponse.json(body, { headers: HEADERS });
  } catch (error) {
    console.warn("[public/featured] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
