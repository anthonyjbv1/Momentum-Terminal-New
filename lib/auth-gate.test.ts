import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import {
  NOINDEX_HEADER_NAME,
  NOINDEX_HEADER_VALUE,
  PUBLIC_ROUTES,
  ROBOTS_TXT,
  SHARED_SECRET_ROUTES,
  applyAuthGate,
  decideAuthGate,
} from "./auth-gate";
import type { ResolvedSession } from "./supabase-proxy";

/**
 * The auth gate: the whole app behind a session while the test is closed,
 * robots kept out, the allowlist explicit, the unauthenticated flows able to
 * complete, and the gate itself contained in one file.
 */

const SIGNED_OUT = false;
const SIGNED_IN = true;
const root = join(__dirname, "..");

describe("decideAuthGate", () => {
  it("sends a signed-out visitor to login from every page, remembering where they were going", () => {
    expect(decideAuthGate("/", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/" });
    expect(decideAuthGate("/person/drake", "?range=7d", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/person/drake?range=7d" });
    expect(decideAuthGate("/feed", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/feed" });
    expect(decideAuthGate("/portfolio", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/portfolio" });
    expect(decideAuthGate("/design", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/design" });
    expect(decideAuthGate("/no-such-page", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/no-such-page" });
  });

  it("refuses a signed-out API call with 401 rather than a redirect", () => {
    expect(decideAuthGate("/api/feed", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/person/drake/live", "?after=1", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/portfolio/live", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/trade/order", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/behavioral/log", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
  });

  it("keeps sign-in, sign-up and the auth callback reachable, by exact route only", () => {
    expect(PUBLIC_ROUTES).toEqual(["/login", "/signup", "/auth/callback"]);
    expect(decideAuthGate("/login", "?next=%2Ffeed", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/signup", "", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/auth/callback", "?code=abc", SIGNED_OUT)).toEqual({ kind: "allow" });
    // No prefix semantics: nothing that merely starts with a public route is open.
    expect(decideAuthGate("/auth", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/auth" });
    expect(decideAuthGate("/auth/callback/extra", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/auth/callback/extra" });
    expect(decideAuthGate("/login-help", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/login-help" });
    expect(decideAuthGate("/signup/", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/signup/" });
  });

  it("leaves the shared-secret internal routes to their own check, by exact route only", () => {
    expect(SHARED_SECRET_ROUTES).toEqual(["/api/ingest", "/api/engine/tick", "/api/engine/cron", "/api/admin/health"]);
    for (const route of SHARED_SECRET_ROUTES) expect(decideAuthGate(route, "?force=1", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/api/ingestion", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/engine", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/engine/reset", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/admin", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
    expect(decideAuthGate("/api/admin/users", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
  });

  it("serves robots.txt to everyone and lets a signed-in user through everywhere", () => {
    expect(decideAuthGate("/robots.txt", "", SIGNED_OUT)).toEqual({ kind: "robots" });
    expect(decideAuthGate("/robots.txt", "", SIGNED_IN)).toEqual({ kind: "robots" });
    expect(decideAuthGate("/", "", SIGNED_IN)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/person/drake", "", SIGNED_IN)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/api/feed", "", SIGNED_IN)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/login", "", SIGNED_IN)).toEqual({ kind: "allow" });
  });
});

function session(isSignedIn: boolean, cookies: Array<[string, string]> = []): ResolvedSession {
  const response = NextResponse.next();
  for (const [name, value] of cookies) response.cookies.set(name, value);
  return { response, isSignedIn };
}

const passThrough = () => NextResponse.next();

describe("applyAuthGate", () => {
  it("redirects a signed-out page request to login with the destination, keeping refreshed cookies", () => {
    const request = new NextRequest("https://example.test/person/drake?range=7d");
    const response = applyAuthGate(request, session(SIGNED_OUT, [["sb-token", "refreshed"]]), passThrough);
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/person/drake?range=7d");
    expect(response.cookies.get("sb-token")?.value).toBe("refreshed");
    expect(response.headers.get(NOINDEX_HEADER_NAME)).toBe(NOINDEX_HEADER_VALUE);
  });

  it("answers a signed-out API request with 401 JSON", async () => {
    const request = new NextRequest("https://example.test/api/feed");
    const response = applyAuthGate(request, session(SIGNED_OUT), passThrough);
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ error: "Sign in required." });
    expect(response.headers.get(NOINDEX_HEADER_NAME)).toBe(NOINDEX_HEADER_VALUE);
  });

  it("serves the disallow-all robots file", async () => {
    const request = new NextRequest("https://example.test/robots.txt");
    const response = applyAuthGate(request, session(SIGNED_OUT), passThrough);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(ROBOTS_TXT);
    expect(ROBOTS_TXT).toMatch(/^User-agent: \*\nDisallow: \/\n$/);
  });

  it("passes an allowed request through to the route rules and still marks it noindex", () => {
    let called = 0;
    const next = () => {
      called += 1;
      return NextResponse.next();
    };
    const signedIn = applyAuthGate(new NextRequest("https://example.test/feed"), session(SIGNED_IN), next);
    const login = applyAuthGate(new NextRequest("https://example.test/login"), session(SIGNED_OUT), next);
    expect(called).toBe(2);
    expect(signedIn.headers.get(NOINDEX_HEADER_NAME)).toBe(NOINDEX_HEADER_VALUE);
    expect(login.headers.get(NOINDEX_HEADER_NAME)).toBe(NOINDEX_HEADER_VALUE);
  });
});

/**
 * Every request a signed-out visitor's browser makes to us during sign-up
 * and sign-in, in order, run through the gate exactly as the proxy would.
 * A Server Action is a POST to the page's own path with a Next-Action
 * header; the username check and auth.signUp happen inside it, server to
 * server against Supabase, so no API route of ours is involved.
 */
describe("the unauthenticated flows complete against the gate", () => {
  const passes = (method: string, url: string, headers: Record<string, string> = {}, isSignedIn = SIGNED_OUT) => {
    let reached = false;
    const response = applyAuthGate(new NextRequest(url, { method, headers }), session(isSignedIn), () => {
      reached = true;
      return NextResponse.next();
    });
    return { reached, status: response.status, location: response.headers.get("location") };
  };

  it("sign-up: open the form, submit the Server Action, land on the confirmation link, arrive signed in", () => {
    expect(passes("GET", "https://example.test/signup")).toMatchObject({ reached: true, status: 200 });
    expect(passes("GET", "https://example.test/signup?_rsc=abc", { rsc: "1" })).toMatchObject({ reached: true, status: 200 });
    expect(passes("POST", "https://example.test/signup", { "next-action": "6012014edb0afa7f2abf2c47c0f8790ff690956132", "content-type": "multipart/form-data" })).toMatchObject({ reached: true, status: 200 });
    // After a failed attempt the form re-posts to the same path with the same headers.
    expect(passes("POST", "https://example.test/signup", { "next-action": "6012014edb0afa7f2abf2c47c0f8790ff690956132" })).toMatchObject({ reached: true, status: 200 });
    // The confirmation email lands here, still signed out, in either link style.
    expect(passes("GET", "https://example.test/auth/callback?code=pkce-code&next=%2Fprofile")).toMatchObject({ reached: true, status: 200 });
    expect(passes("GET", "https://example.test/auth/callback?token_hash=abc&type=signup&next=%2Fprofile")).toMatchObject({ reached: true, status: 200 });
    // The callback sets the session and redirects; the destination is then open.
    expect(passes("GET", "https://example.test/profile", {}, SIGNED_IN)).toMatchObject({ reached: true, status: 200 });
  });

  it("sign-in: open the form with a destination, submit the Server Action, follow the redirect signed in", () => {
    expect(passes("GET", "https://example.test/login?next=%2Fperson%2Fdrake")).toMatchObject({ reached: true, status: 200 });
    expect(passes("POST", "https://example.test/login?next=%2Fperson%2Fdrake", { "next-action": "abc" })).toMatchObject({ reached: true, status: 200 });
    expect(passes("GET", "https://example.test/person/drake", {}, SIGNED_IN)).toMatchObject({ reached: true, status: 200 });
    // A failed callback sends the visitor back to the form with a notice.
    expect(passes("GET", "https://example.test/login?error=auth_callback")).toMatchObject({ reached: true, status: 200 });
  });

  it("a signed-out visitor who is not signing up or in still cannot reach a page or an API route", () => {
    expect(passes("GET", "https://example.test/person/drake")).toMatchObject({ reached: false, status: 307 });
    expect(passes("GET", "https://example.test/api/feed")).toMatchObject({ reached: false, status: 401 });
    expect(passes("POST", "https://example.test/api/trade/order")).toMatchObject({ reached: false, status: 401 });
  });
});

/** Every source file under the app, excluding dependencies and build output. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", "supabase", "public"]);
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (skip.has(entry)) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe("the audit of what the unauthenticated flows call", () => {
  const authCode = [join(root, "app", "(auth)"), join(root, "app", "auth"), join(root, "components", "auth"), join(root, "lib", "auth")].flatMap((dir) => sourceFiles(dir));

  it("covers the sign-up, sign-in and callback code", () => {
    const names = authCode.map((file) => relative(root, file)).sort();
    expect(names).toEqual(expect.arrayContaining(["app/(auth)/actions.ts", "app/(auth)/login/page.tsx", "app/(auth)/signup/page.tsx", "app/auth/callback/route.ts", "components/auth/LoginForm.tsx", "components/auth/SignupForm.tsx", "lib/auth/username-availability.ts"]));
  });

  it("finds no API route of ours in those flows that the gate does not name", () => {
    const apiPaths = new Set<string>();
    for (const file of authCode) {
      for (const match of readFileSync(file, "utf8").matchAll(/["'`](\/api\/[a-z0-9/_\-[\]]+)/g)) apiPaths.add(match[1]);
    }
    const unlisted = [...apiPaths].filter((path) => !PUBLIC_ROUTES.includes(path) && !SHARED_SECRET_ROUTES.includes(path));
    expect(unlisted).toEqual([]);
  });

  it("finds every page and callback those flows use in the allowlist", () => {
    const routes = new Set<string>();
    for (const file of authCode) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/redirect\(\s*["'`](\/[a-z][a-z0-9/_-]*)/g)) routes.add(match[1]);
      for (const match of source.matchAll(/(?:href|\/auth\/callback)["'`=:\s]*["'`]?(\/(?:auth\/callback|login|signup)[a-z/]*)/g)) routes.add(match[1]);
    }
    // Destinations after sign-in (/profile, next) are reached signed in; the signed-out routes must be listed.
    const signedOutRoutes = [...routes].filter((route) => route.startsWith("/login") || route.startsWith("/signup") || route.startsWith("/auth/"));
    for (const route of signedOutRoutes) expect(PUBLIC_ROUTES, route).toContain(route);
  });
});

describe("the gate is contained", () => {
  it("is imported from proxy.ts and nowhere else, so removing it is one file and one line", () => {
    const importers = sourceFiles(root)
      .filter((file) => /auth-gate["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
      .sort();
    expect(importers).toEqual(["lib/auth-gate.test.ts", "proxy.ts"]);
  });

  it("does not need a robots file or a headers block anywhere else", () => {
    expect(() => statSync(join(root, "app", "robots.ts"))).toThrow();
    expect(() => statSync(join(root, "app", "robots.txt"))).toThrow();
    expect(readFileSync(join(root, "next.config.ts"), "utf8")).not.toMatch(/X-Robots-Tag/i);
  });
});
