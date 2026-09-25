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
 *
 * THE ALLOWLIST IS EXPLICIT. Every route a signed-out visitor may reach is
 * named in full below; nothing is opened by prefix. The unauthenticated
 * flows and what they call (audited in lib/auth-gate.test.ts, which reads
 * the auth code and fails if it starts calling an API route not listed
 * here):
 *
 *   sign-up              GET /signup, then the Server Action POST to /signup.
 *                        The username check and auth.signUp happen inside
 *                        the action, server to server against Supabase;
 *                        no API route of ours is called.
 *   sign-in              GET /login, then the Server Action POST to /login.
 *   email confirmation   the link lands on GET /auth/callback (PKCE code or
 *                        token hash), which sets the session and redirects.
 *   password reset       not built yet; when it is, its page and callback
 *                        are added here by name.
 *   sign-out             a Server Action from a signed-in page.
 *
 * The shared-secret routes are named too: they are authorised by
 * INGEST_SECRET / ENGINE_SECRET / CRON_SECRET, never by a session, and
 * fail closed on their own.
 *
 * THE FIRST PUBLIC PAGE (Phase 28). Signed out, "/" is no longer a redirect
 * to /login: it is REWRITTEN to the landing page, so the URL a stranger
 * lands on and the URL a member uses are the same one and only the session
 * decides which tree renders. Signed in, "/" is the app's home exactly as
 * before. The landing's own route (/welcome), the privacy page, the OG
 * image and the two public API routes are named here in full; the landing
 * and privacy pages are the ONLY responses that carry no noindex header and
 * the only paths robots are allowed. Everything else is exactly as gated as
 * it was.
 */

/**
 * What a crawler is told: the landing page and the privacy page, and
 * nothing else. `$` anchors the allow to the exact path (Google, Bing);
 * a crawler that ignores it falls back to the blanket disallow, which is
 * the safe way round.
 */
export const ROBOTS_TXT = "User-agent: *\nAllow: /$\nAllow: /privacy$\nAllow: /how-the-price-works$\nAllow: /og$\nDisallow: /\n";

/** Header set on every response that passes through the proxy, the two indexable pages excepted. */
export const NOINDEX_HEADER_NAME = "X-Robots-Tag";
export const NOINDEX_HEADER_VALUE = "noindex, nofollow, noarchive";

/**
 * Reachable signed out. Exact paths; the unauthenticated flows above use
 * nothing else. /how-the-price-works (Phase 29) is the public explainer of
 * the market price, linked from every profile.
 */
export const PUBLIC_ROUTES: readonly string[] = ["/login", "/signup", "/auth/callback", "/privacy", "/how-the-price-works", "/og"];

/** The public API (Phase 28): the featured score and the waitlist. Exact paths, no session, rate-limited on their own. */
export const PUBLIC_API_ROUTES: readonly string[] = ["/api/public/featured", "/api/waitlist"];

/** Authorised by their own shared secret, never by a browser session. Exact paths. */
export const SHARED_SECRET_ROUTES: readonly string[] = ["/api/ingest", "/api/ingest/cron", "/api/ingest/live", "/api/engine/tick", "/api/engine/cron", "/api/admin/health"];

/**
 * Where "/" is rewritten to for a signed-out visitor. Requesting it by name
 * sends anyone to "/", so the landing page has one address.
 */
export const LANDING_ROUTE = "/welcome";

/** The pages a search engine may index and that carry no noindex header. */
export const INDEXABLE_ROUTES: readonly string[] = ["/", "/privacy", "/how-the-price-works"];

const ROBOTS_PATH = "/robots.txt";

export type GateDecision =
  | { kind: "allow" }
  | { kind: "robots" }
  | { kind: "unauthorized" }
  | { kind: "redirect"; next: string }
  /** Signed out at "/": serve the landing page in place. */
  | { kind: "landing" }
  /** The landing's own path was asked for by name: send them to "/". */
  | { kind: "home" };

/**
 * The gate's decision for one request, as a pure function so it can be
 * tested exhaustively without a request object.
 */
export function decideAuthGate(pathname: string, search: string, isSignedIn: boolean): GateDecision {
  if (pathname === ROBOTS_PATH) return { kind: "robots" };
  if (pathname === LANDING_ROUTE) return { kind: "home" };
  if (isSignedIn) return { kind: "allow" };
  if (pathname === "/") return { kind: "landing" };
  if (PUBLIC_ROUTES.includes(pathname)) return { kind: "allow" };
  if (PUBLIC_API_ROUTES.includes(pathname)) return { kind: "allow" };
  if (SHARED_SECRET_ROUTES.includes(pathname)) return { kind: "allow" };
  if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "unauthorized" };
  return { kind: "redirect", next: `${pathname}${search}` };
}

/** Whether this path's response may be indexed (and so carries no noindex header). */
export function isIndexable(pathname: string): boolean {
  return INDEXABLE_ROUTES.includes(pathname);
}

/** Adds the noindex header to a response and returns it. */
export function withNoIndex<T extends Response>(response: T): T {
  response.headers.set(NOINDEX_HEADER_NAME, NOINDEX_HEADER_VALUE);
  return response;
}

/**
 * Runs in proxy.ts after the session has been resolved. Returns the gate's
 * response for a refused request, otherwise whatever `next` produces; either
 * way the noindex header is set (the indexable pages excepted) and refreshed
 * session cookies are kept.
 */
export function applyAuthGate(request: NextRequest, session: ResolvedSession, next: () => NextResponse): NextResponse {
  const { pathname, search } = request.nextUrl;
  const decision = decideAuthGate(pathname, search, session.isSignedIn);
  const index = <T extends Response>(response: T): T => (isIndexable(pathname) ? response : withNoIndex(response));

  switch (decision.kind) {
    case "allow":
      return index(next());
    case "landing": {
      const url = request.nextUrl.clone();
      url.pathname = LANDING_ROUTE;
      return index(withCookies(NextResponse.rewrite(url), session.response));
    }
    case "home": {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return withNoIndex(withCookies(NextResponse.redirect(url), session.response));
    }
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
