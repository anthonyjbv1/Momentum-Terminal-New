import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FORCE_DEFINITIONS } from "@/lib/person/profile-model";

import { EXPLAINER_META, HOW, META, WHY } from "./copy";

/**
 * /how-the-price-works says the same true things as the profile (Phase 29d).
 * The page is a server component that reads the database, so it is held to
 * its words through its source: the wording that must match the forces panel,
 * its own link preview, and the arithmetic behind a toggle that is closed by
 * default but still in the page.
 */

const page = readFileSync(join(__dirname, "..", "..", "app", "(public)", "how-the-price-works", "page.tsx"), "utf8");
const flat = page.replace(/\s+/g, " ");

describe("the explainer and the profile agree", () => {
  it("Market Mood is the tide across everyone we track, on every surface", () => {
    expect(FORCE_DEFINITIONS.market_mood.description).toBe("The tide across everyone we track");
    expect(WHY.forces.market_mood).toBe("The tide across everyone we track");
    expect(HOW.beats.some((beat) => beat.body.includes("the tide across everyone we track"))).toBe(true);
    expect(flat).toContain("Market Mood, the tide across everyone we track");
    // No surface still says the tide is "the platform", which contradicted "all three read the world outside this platform".
    for (const text of [flat, JSON.stringify(WHY), JSON.stringify(HOW), FORCE_DEFINITIONS.market_mood.description]) {
      expect(text).not.toMatch(/tide across the (entire platform|whole board)/);
    }
  });

  it("Conviction tightens the spread, never widens it, on both", () => {
    // forces-panel.test.ts proves the direction against lib/engine/spread.ts; this holds the two texts to it.
    expect(FORCE_DEFINITIONS.conviction.description).toBe("Capital committed · tightens the spread");
    expect(flat).toContain("Conviction is the capital held open on a person: more of it tightens that person&rsquo;s spread, and never widens it.");
    expect(flat).not.toMatch(/Conviction[^.]*(widens|sets) the spread/);
  });

  it("says individual people can carry their own settings, under the limits", () => {
    const limits = flat.indexOf("The limits");
    const line = flat.indexOf("Individual people can carry their own settings; where they do, their profile says so.");
    expect(limits).toBeGreaterThan(0);
    expect(line).toBeGreaterThan(limits);
  });
});

describe("the explainer's own link preview", () => {
  it("is not the landing page's", () => {
    expect(EXPLAINER_META.shareTitle).not.toBe(META.title);
    expect(EXPLAINER_META.description).not.toBe(META.description);
    expect(EXPLAINER_META.shareTitle).toContain("How the price works");
  });

  it("sets openGraph and twitter in full, so nothing is inherited from the landing", () => {
    const metadata = flat.slice(flat.indexOf("export const metadata"), flat.indexOf("export const dynamic"));
    expect(metadata).toMatch(/openGraph: \{[^}]*title: EXPLAINER_META\.shareTitle, description: EXPLAINER_META\.description, url: "\/how-the-price-works"/);
    expect(metadata).toMatch(/twitter: \{[^}]*title: EXPLAINER_META\.shareTitle, description: EXPLAINER_META\.description/);
  });
});

describe("the arithmetic", () => {
  it("sits behind a 'Show the arithmetic' toggle, closed by default, and stays in the page", () => {
    const open = flat.indexOf("<details");
    const close = flat.indexOf("</details>");
    expect(open).toBeGreaterThan(0);
    const details = flat.slice(open, close);
    // Closed by default: no `open` attribute on the element.
    expect(details.slice(0, details.indexOf(">"))).not.toMatch(/\bopen\b/);
    expect(details).toContain("Show the arithmetic");
    // The section itself, formulas and all, is inside the element, so it is in the server's HTML.
    expect(details).toContain('title="The arithmetic"');
    expect(details).toContain("ceil( u·S / 1000 + u·(2I + u) / (20·D) ) cents");
  });
});
