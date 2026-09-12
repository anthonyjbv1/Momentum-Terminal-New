import { NextResponse, type NextRequest } from "next/server";

import { withCookies, type ResolvedSession } from "@/lib/supabase-proxy";

/**
 * THE AUTH GATE (Phase 7, Part 1).
 *
 * While the platform is in its closed test the whole app sits behind a
 * signed-in session: a signed-out visitor is sent to /login (pages) or
 * refused with 401 (API), robots are told to stay out, and every response
 * carries a noindex header.
 *
 * Everything about the gate lives in this one file. To reopen the app:
 *   1. delete lib/auth-gate.ts (and lib/auth-gate.test.ts), and
 *   2. in proxy.ts replace the applyAuthGate(...) line with
 *      `return applyRouteRules(request, session);`
 * The per-route rules in lib/supabase-proxy.ts (sign-in required for the
 * account, portfolio and profile; login/signup only when signed out) are
 * untouched by the gate and keep working after it is gone.
 */

/** What a crawler is told: nothing here is for indexing. */
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/** Header set on every response that passes through the proxy. */
export const NOINDEX_HEADER_NAME = "X-Robots-Tag";
export const NOINDEX_HEADER_VALUE = "noindex, nofollow, noarchive";

/** Reachable signed out, exact path. */
const PUBLIC_EXACT = ["/login", "/signup"];

/** Reachable signed out, path prefix (the auth callbacks). */
const PUBLIC_PREFIXES = ["/auth"];

/**
 * Internal routes authorised by their own shared secret (INGEST_SECRET,
 * ENGINE_SECRET, CRON_SECRET), never by a browser session. The gate leaves
 * them to that check; they still fail closed on their own.
 */
const SHARED_SECRET_PREFIXES = ["/api/ingest", "/api/engine", "/api/admin"];

const ROBOTS_PATH = "/robots.txt";

export type GateDecision =
  | { kind: "allow" }
  | { kind: "robots" }
  | { kind: "unauthorized" }
  | { kind: "redirect"; next: string };

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The gate's decision for one request, as a pure function so it can be
 * tested exhaustively without a request object.
 */
export function decideAuthGate(pathname: string, search: string, isSignedIn: boolean): GateDecision {
  if (pathname === ROBOTS_PATH) return { kind: "robots" };
  if (isSignedIn) return { kind: "allow" };
  if (PUBLIC_EXACT.includes(pathname) || matchesPrefix(pathname, PUBLIC_PREFIXES)) return { kind: "allow" };
  if (matchesPrefix(pathname, SHARED_SECRET_PREFIXES)) return { kind: "allow" };
  if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "unauthorized" };
  return { kind: "redirect", next: `${pathname}${search}` };
}

/** Adds the noindex header to a response and returns it. */
export function withNoIndex<T extends Response>(response: T): T {
  response.headers.set(NOINDEX_HEADER_NAME, NOINDEX_HEADER_VALUE);
  return response;
}

/**
 * Runs in proxy.ts after the session has been resolved. Returns the gate's
 * response for a refused request, otherwise whatever `next` produces; either
 * way the noindex header is set and refreshed session cookies are kept.
 */
export function applyAuthGate(request: NextRequest, session: ResolvedSession, next: () => NextResponse): NextResponse {
  const { pathname, search } = request.nextUrl;
  const decision = decideAuthGate(pathname, search, session.isSignedIn);

  switch (decision.kind) {
    case "allow":
      return withNoIndex(next());
    case "robots":
      return withNoIndex(
        withCookies(new NextResponse(ROBOTS_TXT, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }), session.response),
      );
    case "unauthorized":
      return withNoIndex(withCookies(NextResponse.json({ error: "Sign in required." }, { status: 401 }), session.response));
    case "redirect": {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      url.searchParams.set("next", decision.next);
      return withNoIndex(withCookies(NextResponse.redirect(url), session.response));
    }
  }
}
