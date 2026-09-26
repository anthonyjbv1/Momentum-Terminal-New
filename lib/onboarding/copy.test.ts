import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";

import { ONBOARDING, ONBOARDING_STEPS, allOnboardingStrings, nextStep, previousStep, progressLabel, stepFromParam } from "./copy";
import { FORECAST_FALLBACK_COUNT, forecastChoices, type RosterEntry } from "./model";

/**
 * THE ONBOARDING RULES (Phase 32): three or four short screens, each
 * skippable, paper trading said plainly, the score and the price told apart,
 * trading optional and never pushed, the explainer one link away, and no
 * urgency of any kind: no countdown, no "act now", no scarcity, and no bar
 * that fills.
 */

const root = join(__dirname, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const screenSources = [...sources(join(root, "components", "onboarding")), ...sources(join(root, "app", "start"))];

describe("onboarding copy", () => {
  const strings = allOnboardingStrings();

  it("is four screens, in order", () => {
    expect(ONBOARDING_STEPS).toEqual(["what", "paper", "follow", "forecast"]);
    expect(strings.length).toBeGreaterThan(20);
  });

  it("breaks none of the house rules", () => {
    const hits = strings.flatMap((value) => copyViolations(value).map((rule) => `[${rule}] ${value}`));
    expect(hits).toEqual([]);
  });

  it("tells the score and the price apart, and links the explainer", () => {
    expect(ONBOARDING.what.score.label).toBe("Momentum Score");
    expect(ONBOARDING.what.price.label).toBe("Market price");
    expect(ONBOARDING.what.score.body).toMatch(/nothing anyone does here can move it/);
    expect(ONBOARDING.what.price.body).toMatch(/moves when people buy and sell/);
    expect(ONBOARDING.what.price.body).toMatch(/back toward the score/);
    const steps = readFileSync(join(root, "components", "onboarding", "steps.tsx"), "utf8");
    expect(steps).toContain('href="/how-the-price-works"');
  });

  it("says paper, not real money, and that you cannot lose more than you put in", () => {
    const paper = [ONBOARDING.paper.title, ONBOARDING.paper.balance, ...ONBOARDING.paper.lines].join(" ");
    expect(paper).toMatch(/paper/i);
    expect(paper).toMatch(/not real money/);
    expect(paper).toMatch(/cannot lose more than you put in/);
    expect(ONBOARDING.paper.balance).toContain("{balance}");
  });

  it("offers trading as optional, once, and never as the next step", () => {
    expect(ONBOARDING.forecast.trading).toMatch(/optional/i);
    expect(ONBOARDING.forecast.trading).toMatch(/Nothing here asks you to/);
    expect(ONBOARDING.forecast.title).toMatch(/free forecast/i);
    const forecast = readFileSync(join(root, "components", "onboarding", "forecast-step.tsx"), "utf8");
    // The forecast screen links nowhere that trades.
    expect(forecast).not.toMatch(/href=\{?["'`]\/(person|portfolio)/);
  });

  it("has no countdown, no ticking clock and no filling progress bar in any screen", () => {
    const hits: string[] = [];
    for (const file of screenSources) {
      const text = readFileSync(file, "utf8");
      for (const [name, pattern] of [
        ["countdown", /Countdown|countdown-timer|useNow|use-now|setInterval/],
        ["progress bar", /role=["']progressbar|<progress\b|aria-valuenow/],
        ["app banner", /TopBanner|top-banner|AppShell|app-shell/],
      ] as const) {
        if (pattern.test(text)) hits.push(`${file.slice(root.length)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("offers Skip on every screen", () => {
    const page = readFileSync(join(root, "app", "start", "page.tsx"), "utf8");
    const steps = readFileSync(join(root, "components", "onboarding", "steps.tsx"), "utf8");
    // The frame carries Skip; every onboarding screen renders inside it.
    expect(steps).toMatch(/StepFrame[\s\S]*skipAction[\s\S]*ONBOARDING\.skip/);
    expect(steps).toMatch(/<StepFrame step="what"/);
    expect(steps).toMatch(/<StepFrame step="paper"/);
    expect(page).toMatch(/<StepFrame step="follow"/);
    expect(page).toMatch(/<StepFrame step="forecast"/);
    expect(ONBOARDING.skip).toBe("Skip for now");
    expect(ONBOARDING.forecast.finish).toMatch(/without a forecast/);
  });

  it("walks the steps and says where you are in words", () => {
    expect(stepFromParam(undefined)).toBe("what");
    expect(stepFromParam("nonsense")).toBe("what");
    expect(stepFromParam(["paper", "what"])).toBe("paper");
    expect(nextStep("what")).toBe("paper");
    expect(nextStep("forecast")).toBeNull();
    expect(previousStep("what")).toBeNull();
    expect(previousStep("forecast")).toBe("follow");
    expect(ONBOARDING_STEPS.map(progressLabel)).toEqual(["1 of 4", "2 of 4", "3 of 4", "4 of 4"]);
  });
});

describe("forecast choices", () => {
  const roster: RosterEntry[] = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, slug: `p${i}`, name: `Person ${i}`, category: "creator", avatarUrl: null }));

  it("offers the people just followed, in board order", () => {
    expect(forecastChoices(roster, ["p7", "p2"]).map((p) => p.id)).toEqual(["p2", "p7"]);
  });

  it("offers the top of the board when nobody was followed", () => {
    expect(forecastChoices(roster, []).map((p) => p.id)).toEqual(roster.slice(0, FORECAST_FALLBACK_COUNT).map((p) => p.id));
  });

  it("ignores a followed id that is no longer on the board", () => {
    expect(forecastChoices(roster, ["gone"]).length).toBe(FORECAST_FALLBACK_COUNT);
  });
});
