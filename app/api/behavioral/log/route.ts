import { NextResponse, type NextRequest } from "next/server";

import { createRateLimiter, createSupabaseBehavioralStore, handleBehavioralLogRequest } from "@/lib/behavioral/core";
import { BEHAVIORAL_SESSION_COOKIE, sessionIdFromCookieValue } from "@/lib/behavioral/session";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * POST /api/behavioral/log — client-side behavioral logging.
 *
 * Body: { events: [{ eventType, personId?, metadata?, sessionId? }, ...] }
 * (a bare array or a single event also works). Responds with
 * { accepted, dropped: [{ index, reason }] }.
 *
 * Identity comes from the auth cookies, never from the body, and the insert
 * runs through the caller's own RLS-scoped client: a user can only log events
 * as themselves. Content type is not enforced so navigator.sendBeacon works.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rateLimiter = createRateLimiter();

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getClaims();
    userId = typeof data?.claims.sub === "string" ? data.claims.sub : null;
  } catch {
    userId = null;
  }

  const rawBody = await request.text();
  const result = await handleBehavioralLogRequest({
    user: userId ? { id: userId } : null,
    rawBody,
    store: createSupabaseBehavioralStore(supabase),
    sessionId: sessionIdFromCookieValue(request.cookies.get(BEHAVIORAL_SESSION_COOKIE)?.value),
    rateLimiter,
  });

  return NextResponse.json(result.body, { status: result.status });
}
