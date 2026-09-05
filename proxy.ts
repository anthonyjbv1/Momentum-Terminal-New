import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase-proxy";

/**
 * Next.js proxy (formerly middleware). Refreshes the Supabase session on every
 * request and enforces the signed-in / signed-out route rules.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets and common image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
