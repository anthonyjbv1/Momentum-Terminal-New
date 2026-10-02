import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isBetaSignupEnabled, isGoogleAuthEnabled } from "@/lib/env";

/**
 * THE SIGNUP SWITCH (Phase 32): "While off, the app behaves exactly as
 * today." Every way in that this phase adds is listed here with the check
 * that closes it, and the test fails if one loses its check or a new entry
 * point appears without being listed. The database's own rule (no account
 * without an attested invite) is separate and holds whatever the switch says:
 * lib/invites/invites.db.test.ts.
 */

const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const saved = { beta: process.env.BETA_SIGNUP_ENABLED, google: process.env.GOOGLE_AUTH_ENABLED };
afterEach(() => {
  process.env.BETA_SIGNUP_ENABLED = saved.beta;
  process.env.GOOGLE_AUTH_ENABLED = saved.google;
});

describe("the switch's values", () => {
  it('opens only on exactly "true", like the cron flags', () => {
    for (const value of [undefined, "", "false", "1", "TRUE", "True", "yes", "on"]) {
      if (value === undefined) delete process.env.BETA_SIGNUP_ENABLED;
      else process.env.BETA_SIGNUP_ENABLED = value;
      expect(isBetaSignupEnabled(), String(value)).toBe(false);
    }
    process.env.BETA_SIGNUP_ENABLED = "true";
    expect(isBetaSignupEnabled()).toBe(true);
  });

  it("offers Google only when both switches are on", () => {
    process.env.GOOGLE_AUTH_ENABLED = "true";
    process.env.BETA_SIGNUP_ENABLED = "false";
    expect(isGoogleAuthEnabled()).toBe(false);
    process.env.BETA_SIGNUP_ENABLED = "true";
    expect(isGoogleAuthEnabled()).toBe(true);
    process.env.GOOGLE_AUTH_ENABLED = "false";
    expect(isGoogleAuthEnabled()).toBe(false);
  });
});

describe("every way in is closed while the switch is off", () => {
  const gates: Array<{ path: string; why: string; pattern: RegExp }> = [
    { path: "app/join/[token]/page.tsx", why: "the join page 404s", pattern: /joinPageState\(token, \{ enabled: isBetaSignupEnabled\(\)[\s\S]*if \(state\.kind === "closed"\) notFound\(\)/ },
    { path: "app/join/[token]/actions.ts", why: "the join form refuses", pattern: /enabled: isBetaSignupEnabled\(\)/ },
    { path: "app/start/page.tsx", why: "onboarding 404s", pattern: /if \(!isBetaSignupEnabled\(\)\) notFound\(\)/ },
    { path: "app/start/actions.ts", why: "onboarding actions go Home", pattern: /if \(!isBetaSignupEnabled\(\)\) redirect\("\/"\)/ },
    { path: "app/(app)/person/[slug]/page.tsx", why: "no guided tour on a person's page (Phase 32b)", pattern: /tour && user && isBetaSignupEnabled\(\) && person\.tradingMode === "tradeable" \? <ProductTour/ },
    { path: "app/(public)/terms/page.tsx", why: "the draft Terms 404", pattern: /if \(!isBetaSignupEnabled\(\)\) notFound\(\)/ },
    { path: "app/(app)/profile/page.tsx", why: "the old profile renders", pattern: /if \(isBetaSignupEnabled\(\)\) \{[\s\S]*return <MemberProfile/ },
    { path: "app/(app)/profile/actions.ts", why: "profile actions do nothing", pattern: /if \(!isBetaSignupEnabled\(\)\) redirect\("\/profile"\)/ },
    { path: "app/(app)/profile/delete/page.tsx", why: "deletion 404s", pattern: /if \(!isBetaSignupEnabled\(\)\) notFound\(\)/ },
    { path: "app/(app)/(home)/page.tsx", why: "no Following filter", pattern: /user && isBetaSignupEnabled\(\) \? await getMyFollowIds\(\) : undefined/ },
    { path: "app/(auth)/login/page.tsx", why: "no sign-in link or Google on the login page", pattern: /const open = isBetaSignupEnabled\(\)/ },
    { path: "app/(auth)/actions.ts", why: "no sign-in links or Google", pattern: /if \(!isBetaSignupEnabled\(\)\) return \{ error:[\s\S]*if \(!isGoogleAuthEnabled\(\)\) redirect\("\/login"\)/ },
    { path: "app/admin/invite-actions.ts", why: "no invites are sent", pattern: /const betaSignup = isBetaSignupEnabled\(\);[\s\S]*if \(!betaSignup\) return 'Sending is off/ },
    { path: "app/(public)/privacy/page.tsx", why: "Privacy offers deletion by email, not in the app", pattern: /isBetaSignupEnabled\(\) \? PRIVACY_DELETION\.inApp : PRIVACY_DELETION\.byEmail/ },
  ];

  for (const gate of gates) {
    it(`${gate.path}: ${gate.why}`, () => {
      expect(read(gate.path)).toMatch(gate.pattern);
    });
  }

  it("a closed page's 404 carries no title of its own: the metadata follows the switch too", () => {
    for (const path of ["app/join/[token]/page.tsx", "app/(public)/terms/page.tsx", "app/start/page.tsx", "app/(app)/profile/delete/page.tsx"]) {
      const source = read(path);
      expect(source, path).not.toMatch(/export const metadata/);
      expect(source, path).toMatch(/export function generateMetadata\(\): Metadata \{[\s\S]*return isBetaSignupEnabled\(\) \? \{ \.\.\.base, title:/);
    }
  });

  it("the old public sign-up page is gone either way, and the gate sends /signup to the login page", () => {
    expect(() => read("app/(auth)/signup/page.tsx")).toThrow();
    expect(read("lib/auth-gate.ts")).not.toMatch(/"\/signup"/);
  });

  it("no other route or action file reads the switch without being listed above", () => {
    const listed = new Set(gates.map((gate) => gate.path));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir))) {
        const path = `${dir}/${entry}`;
        if (statSync(join(root, path)).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) && read(path).includes("isBetaSignupEnabled")) found.push(path);
      }
    };
    walk("app");
    expect(found.sort()).toEqual([...listed].sort());
  });
});
