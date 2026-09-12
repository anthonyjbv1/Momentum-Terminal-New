import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabasePublishableKey, getSupabaseUrl } from "@/lib/env";
import type { Database } from "@/types/database";

/** Routes that require a signed-in user. Prefix match. */
const PROTECTED_PREFIXES = ["/account", "/portfolio", "/profile"];

/** Routes that only make sense when signed out. Exact match. */
const SIGNED_OUT_ONLY_ROUTES = ["/login", "/signup"];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** The session as the proxy sees it, plus the response carrying any refreshed cookies. */
export interface ResolvedSession {
  response: NextResponse;
  isSignedIn: boolean;
}

/**
 * Refreshes an expired auth session and writes the new cookies to both the
 * request (so Server Components see them) and the response.
 */
export async function resolveSession(request: NextRequest): Promise<ResolvedSession> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(getSupabaseUrl(), getSupabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Do not put logic between createServerClient and this call: it is what
  // refreshes the session and triggers setAll above.
  const { data } = await supabase.auth.getClaims();
  return { response, isSignedIn: Boolean(data?.claims) };
}

/**
 * The per-route rules: signed-out visitors are sent away from protected
 * routes, signed-in users away from the login/signup pages.
 */
export function applyRouteRules(request: NextRequest, { response, isSignedIn }: ResolvedSession): NextResponse {
  const { pathname } = request.nextUrl;

  if (!isSignedIn && matchesPrefix(pathname, PROTECTED_PREFIXES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return withCookies(NextResponse.redirect(url), response);
  }

  if (isSignedIn && SIGNED_OUT_ONLY_ROUTES.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/profile";
    url.search = "";
    return withCookies(NextResponse.redirect(url), response);
  }

  return response;
}

/** Refresh the session, then apply the route rules. */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  return applyRouteRules(request, await resolveSession(request));
}

/** Carry refreshed session cookies over to a freshly created response. */
export function withCookies<T extends NextResponse>(target: T, source: NextResponse): T {
  for (const cookie of source.cookies.getAll()) {
    target.cookies.set(cookie);
  }
  return target;
}
