import type { NextRequest } from "next/server";

import { applyAuthGate } from "@/lib/auth-gate";
import { applyRouteRules, resolveSession } from "@/lib/supabase-proxy";

/**
 * Next.js proxy (formerly middleware). Refreshes the Supabase session on every
 * request and enforces the signed-in / signed-out route rules.
 */
export async function proxy(request: NextRequest) {
  const session = await resolveSession(request);
  // Phase 7 auth gate: the whole app behind a session while the test is closed.
  // To reopen: delete lib/auth-gate.ts and make this `return applyRouteRules(request, session);`.
  return applyAuthGate(request, session, () => applyRouteRules(request, session));
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets and common image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
