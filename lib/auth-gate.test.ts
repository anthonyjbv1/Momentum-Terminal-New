import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import {
  NOINDEX_HEADER_NAME,
  NOINDEX_HEADER_VALUE,
  ROBOTS_TXT,
  applyAuthGate,
  decideAuthGate,
} from "./auth-gate";
import type { ResolvedSession } from "./supabase-proxy";

/**
 * The auth gate: the whole app behind a session while the test is closed,
 * robots kept out, and the gate itself contained in one file.
 */

const SIGNED_OUT = false;
const SIGNED_IN = true;

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

  it("keeps sign-in, sign-up and the auth callbacks reachable", () => {
    expect(decideAuthGate("/login", "?next=%2Ffeed", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/signup", "", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/auth/callback", "?code=abc", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/auth", "", SIGNED_OUT)).toEqual({ kind: "allow" });
    // Exact and prefix matches only: nothing that merely starts with a public name.
    expect(decideAuthGate("/login-help", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/login-help" });
    expect(decideAuthGate("/authors", "", SIGNED_OUT)).toEqual({ kind: "redirect", next: "/authors" });
  });

  it("leaves the shared-secret internal routes to their own check", () => {
    expect(decideAuthGate("/api/ingest", "?source=youtube", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/api/engine/tick", "?dryRun=1", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/api/engine/cron", "", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/api/admin/health", "", SIGNED_OUT)).toEqual({ kind: "allow" });
    expect(decideAuthGate("/api/ingestion", "", SIGNED_OUT)).toEqual({ kind: "unauthorized" });
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

/** Every source file under the app, excluding dependencies and build output. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", "supabase", "public"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("the gate is contained", () => {
  const root = join(__dirname, "..");

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
