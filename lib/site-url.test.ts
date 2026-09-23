import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { absoluteUrl, getSiteOrigin, getSiteUrl } from "./env";

/**
 * THE SITE ADDRESS IS ONE VARIABLE (Phase 28). NEXT_PUBLIC_SITE_URL is where
 * the OG image, the canonical URL, the metadata, the privacy page and every
 * absolute link get their host; nothing in the app names one. This fails the
 * suite if a vercel.app hostname is ever written as a literal in app code,
 * so moving to a custom domain stays a one-line change.
 */

const root = join(__dirname, "..");
const SCAN = ["app", "components", "lib", "proxy.ts", "next.config.ts", "vercel.json", "package.json"];
const HOSTNAME = /[a-z0-9-]+\.vercel\.app/i;

function files(path: string, out: string[] = []): string[] {
  if (!statSync(path).isDirectory()) {
    out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === ".next") continue;
    files(join(path, entry), out);
  }
  return out;
}

describe("no vercel.app hostname in app code", () => {
  const scanned = SCAN.flatMap((entry) => files(join(root, entry))).filter((file) => /\.(ts|tsx|js|mjs|json|css)$/.test(file));

  it("scans the app, the components, the library and the config", () => {
    expect(scanned.length).toBeGreaterThan(100);
  });

  it("finds none", () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (HOSTNAME.test(line)) offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe("getSiteOrigin / absoluteUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("derive from NEXT_PUBLIC_SITE_URL with the trailing slash removed", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test/");
    expect(getSiteUrl()).toBe("https://example.test/");
    expect(getSiteOrigin()).toBe("https://example.test");
    expect(absoluteUrl("/privacy")).toBe("https://example.test/privacy");
    expect(absoluteUrl("og")).toBe("https://example.test/og");
  });

  it("always yield an origin new URL() accepts: a bare host is https, a path or query is dropped, garbage falls back", () => {
    // The first Phase 28 deploy failed at build time on `new URL(getSiteOrigin())` in the public layout:
    // the production variable had no scheme. The helper now normalises rather than the build breaking.
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "example.test");
    expect(getSiteOrigin()).toBe("https://example.test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", " example.test/ ");
    expect(getSiteOrigin()).toBe("https://example.test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test:8443/some/path?x=1");
    expect(getSiteOrigin()).toBe("https://example.test:8443");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    expect(getSiteOrigin()).toBe("http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url at all");
    expect(getSiteOrigin()).toBe("http://localhost:3000");
    for (const value of ["example.test", "https://example.test/", "not a url at all", ""]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
      expect(() => new URL(getSiteOrigin()), JSON.stringify(value)).not.toThrow();
    }
  });

  it("fall back to localhost when unset, for local runs", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    // An empty string is "unset" to Next's env loader as much as a missing one; the fallback covers both.
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(getSiteOrigin()).toBe("http://localhost:3000");
  });
});
