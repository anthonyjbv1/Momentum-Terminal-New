import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketOverrides } from "@/components/person/market-overrides";

import { LIVE_TICK_MS } from "./live-series";
import { OVERRIDE_COLUMNS, noOverrides, overrideSentences, readOverrides, type TierMarketDefaults } from "./market-overrides";
import { toProfilePerson, type ProfilePersonRow } from "./profile-model";

/**
 * "Individual people can carry their own settings; where they do, their
 * profile says so" (the explainer, Phase 29d). These tests make that true:
 * every per-person column market_params_for() reads has a sentence, the
 * profile reads every one of them, and MrBeast's depth override — live in
 * production for the demo — reads the way a person would say it.
 */

const ROOT = join(__dirname, "..", "..");

const PUBLIC_FIGURE: TierMarketDefaults = {
  tier: "public_figure",
  pricingMode: "curve",
  depthUnits: 300_000,
  halfLifeSeconds: 480 * 30,
  premiumCapCents: 800,
  maxOrderShareOfDepth: 0.2,
  shortingAllowed: true,
};

const say = (overrides: Partial<ReturnType<typeof noOverrides>>, tier: TierMarketDefaults = PUBLIC_FIGURE, shortingEnabled = false) =>
  overrideSentences("MrBeast", { ...noOverrides(), ...overrides }, tier, shortingEnabled, LIVE_TICK_MS);

describe("a person's own market settings, in words", () => {
  it("MrBeast's depth override: 20 shares a point against 300, and what it does to the largest order", () => {
    expect(say({ depthUnits: 20_000 })).toEqual([
      "20 shares of net buying move MrBeast’s market price one point, against 300 shares for other public figures, so the largest single order here is 4 shares (60 shares for other public figures).",
    ]);
  });

  it("says nothing for a person on the tier's settings, or with an override equal to the tier's", () => {
    expect(say({})).toEqual([]);
    expect(say({ depthUnits: 300_000, halfLifeTicks: 480, premiumCapCents: 800, pricingMode: "curve", shorting: true })).toEqual([]);
  });

  it("the half-life, in hours, against the tier's", () => {
    expect(say({ halfLifeTicks: 240 })).toEqual(["With no trading, the premium on MrBeast halves every 2 hours, against 4 hours for other public figures."]);
  });

  it("the cap, in points, against the tier's", () => {
    expect(say({ premiumCapCents: 500 })).toEqual(["MrBeast’s market price may sit at most 5.0 points from the score, against 8.0 points for other public figures."]);
  });

  it("a flat market says so, and then says nothing about depth, half-life or cap, which do nothing on a flat market", () => {
    expect(say({ pricingMode: "flat", depthUnits: 20_000, premiumCapCents: 500 })).toEqual([
      "MrBeast’s market is flat: trading does not move the market price, which stays at the score. The markets of other public figures move with trading.",
    ]);
    expect(say({ pricingMode: "curve", depthUnits: 20_000 }, { ...PUBLIC_FIGURE, pricingMode: "flat" })[0]).toBe(
      "MrBeast’s market moves with trading, while the markets of other public figures are flat for now.",
    );
  });

  it("selling short, and whether the platform lets it happen at all", () => {
    const noShortTier = { ...PUBLIC_FIGURE, shortingAllowed: false };
    expect(say({ shorting: true }, noShortTier, false)).toEqual(["Selling MrBeast short is allowed by MrBeast’s own setting, though selling short is switched off across the platform for now."]);
    expect(say({ shorting: true }, noShortTier, true)).toEqual(["Selling MrBeast short is allowed by MrBeast’s own setting."]);
    expect(say({ shorting: false })).toEqual(["Selling MrBeast short is not allowed, whatever the rule for other public figures."]);
  });

  it("names the right peers for a private individual", () => {
    expect(say({ premiumCapCents: 100 }, { ...PUBLIC_FIGURE, tier: "private_individual", premiumCapCents: 300 })[0]).toContain("for other private individuals");
  });
});

describe("the profile reads every override there is", () => {
  it("every per-person override column in the migrations has a sentence", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const columns = new Set<string>();
    for (const file of readdirSync(dir)) {
      const sql = readFileSync(join(dir, file), "utf8");
      for (const match of sql.matchAll(/add column (?:if not exists )?(\w+_override)\b/g)) columns.add(match[1]);
    }
    expect([...columns].sort()).toEqual(Object.values(OVERRIDE_COLUMNS).sort());
  });

  it("the profile's person read selects all of them", () => {
    const profile = readFileSync(join(ROOT, "lib", "person", "profile.ts"), "utf8");
    for (const column of Object.values(OVERRIDE_COLUMNS)) expect(profile).toContain(column);
  });

  it("parses the row the database returns, and ignores anything that is not a setting", () => {
    expect(readOverrides({ depth_units_override: "20000", decay_half_life_ticks_override: null, premium_cap_cents_override: 0, pricing_mode_override: "sideways", shorting_override: null })).toEqual({
      depthUnits: 20_000,
      halfLifeTicks: null,
      premiumCapCents: null,
      pricingMode: null,
      shorting: null,
    });
    const row = { id: "p", slug: "mrbeast", display_name: "MrBeast", category: "creator", avatar_url: null, current_score: 68.6, revert_target: 68, target_offset: 0, spread: 0.5, created_at: "", last_tick_at: null, depth_units_override: 20000 } as unknown as ProfilePersonRow;
    expect(toProfilePerson(row).overrides.depthUnits).toBe(20_000);
  });
});

describe("the profile section", () => {
  it("shows MrBeast's setting, and renders nothing for everyone else", () => {
    const html = renderToStaticMarkup(createElement(MarketOverrides, { name: "MrBeast", overrides: { ...noOverrides(), depthUnits: 20_000 }, tier: PUBLIC_FIGURE, shortingEnabled: false }));
    expect(html).toContain("MrBeast’s market settings");
    expect(html).toContain("20 shares of net buying move MrBeast’s market price one point");
    expect(html).toContain('href="/how-the-price-works"');
    expect(renderToStaticMarkup(createElement(MarketOverrides, { name: "Drake", overrides: noOverrides(), tier: PUBLIC_FIGURE, shortingEnabled: false }))).toBe("");
    expect(renderToStaticMarkup(createElement(MarketOverrides, { name: "Drake", overrides: { ...noOverrides(), depthUnits: 20_000 }, tier: null, shortingEnabled: false }))).toBe("");
  });
});
