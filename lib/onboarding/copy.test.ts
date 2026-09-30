import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";

import { ONBOARDING, ONBOARDING_STEPS, TOUR, TOUR_STEPS, allOnboardingStrings, nextStep, previousStep, progressLabel, stepFromParam, tourProgressLabel } from "./copy";
import { TOUR_PREFERRED_SLUG, pickTourPerson } from "./model";

/**
 * THE ONBOARDING RULES (Phase 32, reshaped in Phase 32b): three screens,
 * each skippable, paper trading said plainly, the score and the price told
 * apart, trading optional and never pushed, and no urgency of any kind: no
 * countdown, no "act now", no scarcity, and no bar that fills. The middle
 * screen is a tour of one real person's page: eight stops, each anchored to
 * an element some component actually carries, display only.
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
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("onboarding copy", () => {
  const strings = allOnboardingStrings();

  it("is three screens, in order: the welcome, the tour, the follow picker", () => {
    expect(ONBOARDING_STEPS).toEqual(["paper", "tour", "follow"]);
    expect(strings.length).toBeGreaterThan(30);
  });

  it("breaks none of the house rules", () => {
    const hits = strings.flatMap((value) => copyViolations(value).map((rule) => `[${rule}] ${value}`));
    expect(hits).toEqual([]);
  });

  it("says paper, not real money, and that you cannot lose more than you put in, before anything else", () => {
    const paper = [ONBOARDING.paper.title, ONBOARDING.paper.balance, ...ONBOARDING.paper.lines].join(" ");
    expect(paper).toMatch(/paper/i);
    expect(paper).toMatch(/not real money/);
    expect(paper).toMatch(/cannot be deposited, withdrawn or exchanged/);
    expect(paper).toMatch(/cannot lose more than you put in/);
    expect(paper).toMatch(/for learning how momentum moves, not for making money/);
    expect(ONBOARDING.paper.balance).toContain("{balance}");
    // The welcome is first and leads to the tour, and says so.
    expect(stepFromParam(undefined)).toBe("paper");
    expect(nextStep("paper")).toBe("tour");
    expect(ONBOARDING.paper.next).toMatch(/tour/);
  });

  it("has no countdown, no ticking clock and no filling progress bar in any screen, the tour included", () => {
    const hits: string[] = [];
    for (const file of screenSources) {
      const text = readFileSync(file, "utf8");
      for (const [name, pattern] of [
        ["countdown", /Countdown|countdown-timer|useNow|use-now|setInterval/],
        ["progress bar", /role=["']progressbar|<progress\b|aria-valuenow/],
        ["app banner", /TopBanner|top-banner|AppShell|app-shell/],
        ["confetti", /confetti|canvas-confetti/i],
      ] as const) {
        if (pattern.test(text)) hits.push(`${file.slice(root.length)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("offers Skip on every screen", () => {
    const page = read("components/onboarding/onboarding-screen.tsx");
    const steps = read("components/onboarding/steps.tsx");
    // The frame carries Skip; both /start screens render inside it. The tour carries its own (below).
    expect(steps).toMatch(/StepFrame[\s\S]*skipAction[\s\S]*ONBOARDING\.skip/);
    expect(steps).toMatch(/<StepFrame step="paper"/);
    expect(page).toMatch(/<StepFrame step="follow"/);
    expect(ONBOARDING.skip).toBe("Skip for now");
  });

  it("walks the steps and says where you are in words", () => {
    expect(stepFromParam("nonsense")).toBe("paper");
    // The screens the tour replaced are no longer steps: an old link lands on the welcome.
    expect(stepFromParam("what")).toBe("paper");
    expect(stepFromParam("forecast")).toBe("paper");
    expect(stepFromParam(["follow", "paper"])).toBe("follow");
    expect(nextStep("tour")).toBe("follow");
    expect(nextStep("follow")).toBeNull();
    expect(previousStep("paper")).toBeNull();
    expect(previousStep("follow")).toBe("tour");
    expect(ONBOARDING_STEPS.map(progressLabel)).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
  });

  it("ends on the follow picker exactly as it was, with Back to the tour", () => {
    const picker = read("components/onboarding/follow-picker.tsx");
    expect(ONBOARDING.follow).toMatchObject({ title: "Pick a few people to follow", save: "Save and continue", none: "Nobody picked yet. That is fine too." });
    expect(picker).toMatch(/previousStep\("follow"\)/);
    expect(picker).toMatch(/copy\.save/);
    expect(read("app/start/actions.ts")).toMatch(/step: "follow", action: "finish", followed: ids\.length[\s\S]*await markOnboarded\(\);\s*redirect\("\/"\)/);
  });
});

describe("the tour", () => {
  const tourSource = read("components/onboarding/product-tour.tsx");
  const componentSources = sources(join(root, "components")).map((file) => ({ file: file.slice(root.length + 1), text: readFileSync(file, "utf8") }));

  it("is eight stops, in the brief's order, each on its own anchor", () => {
    expect(TOUR_STEPS).toEqual(["score", "market", "signals", "forces", "forecast", "buy", "portfolio", "feed"]);
    expect(TOUR.stops.map((stop) => stop.key)).toEqual([...TOUR_STEPS]);
    expect(TOUR.stops.length).toBeGreaterThanOrEqual(6);
    expect(TOUR.stops.length).toBeLessThanOrEqual(8);
    expect(new Set(TOUR.stops.map((stop) => stop.anchor)).size).toBe(TOUR.stops.length);
    expect(tourProgressLabel(0)).toBe("1 of 8");
    expect(tourProgressLabel(7)).toBe("8 of 8");
  });

  it("anchors every stop to a data-tour attribute some component actually carries", () => {
    const navKeys = [...read("components/shell/nav-items.ts").matchAll(/key: "([a-z]+)"/g)].map((match) => match[1]);
    const navTemplate = componentSources.filter(({ text }) => text.includes("data-tour={`nav-${item.key}`}"));
    const missing: string[] = [];
    for (const stop of TOUR.stops) {
      const literal = componentSources.filter(({ text }) => text.includes(`data-tour="${stop.anchor}"`));
      const viaNav = stop.anchor.startsWith("nav-") && navKeys.includes(stop.anchor.slice(4)) ? navTemplate : [];
      if (literal.length + viaNav.length === 0) missing.push(`${stop.key} → data-tour="${stop.anchor}"`);
    }
    expect(missing).toEqual([]);
    // The tabs are rendered twice (the bottom bar and the banner), the Buy pill in two places too: the tour lights the visible one.
    expect(navTemplate.map(({ file }) => file).sort()).toEqual(["components/shell/bottom-nav.tsx", "components/shell/desktop-nav.tsx"]);
    expect((read("components/person/trade-bar.tsx").match(/data-tour="buy"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(tourSource).toMatch(/getClientRects\(\)\.length > 0/);
  });

  it("tells the score and the price apart", () => {
    const score = TOUR.stops.find((stop) => stop.key === "score")!;
    const market = TOUR.stops.find((stop) => stop.key === "market")!;
    expect(score.title).toBe("Momentum Score");
    expect(score.body).toMatch(/nothing anyone does here can move it/);
    expect(market.title).toBe("Market price");
    expect(market.body).toMatch(/moves when people buy and sell/);
    expect(market.body).toMatch(/back toward the score/);
  });

  it("offers a forecast as free, trading as optional, and places nothing", () => {
    const forecast = TOUR.stops.find((stop) => stop.key === "forecast")!;
    const buy = TOUR.stops.find((stop) => stop.key === "buy")!;
    expect(forecast.body).toMatch(/free/);
    expect(forecast.body).toMatch(/moves nothing/);
    expect(buy.body).toMatch(/Trading is optional\. Nothing here asks you to\./);
    // The lit element is covered by a button of the tour's own: no trade, vote or navigation reaches the page.
    expect(tourSource).toMatch(/aria-label=\{tapLabel\} onClick=\{\(\) => go\(1\)\}/);
    expect(tourSource).not.toMatch(/onTrade|\/api\/trade|\/api\/forecast|<Link\b|href=/);
  });

  it("says where it is in words, offers Skip tour on every stop, Back and Next, and one line for each tab", () => {
    expect(TOUR.skip).toBe("Skip tour");
    // One caption block, rendered in both the phone panel and the desktop card, carries progress, Skip, Back and Next.
    expect(tourSource).toMatch(/const caption = \([\s\S]*\{progress\}[\s\S]*\{TOUR\.skip\}[\s\S]*\{TOUR\.back\}[\s\S]*\{last \? TOUR\.done : TOUR\.next\}[\s\S]*\);/);
    expect((tourSource.match(/\{caption\}/g) ?? []).length).toBe(2);
    for (const key of ["portfolio", "feed"] as const) {
      const stop = TOUR.stops.find((candidate) => candidate.key === key)!;
      expect(stop.body.split(/(?<=[.!?])\s+/).length, key).toBe(1);
    }
  });

  it("lights one element at a time, follows the reader's motion setting, and logs each stop with the existing event", () => {
    expect(tourSource).toMatch(/prefers-reduced-motion/);
    expect(tourSource).toMatch(/motion-safe:/);
    expect(tourSource).toMatch(/behavior: reduced \? "auto" : "smooth"/);
    expect(tourSource).toMatch(/eventType: "onboarding_step", metadata: \{ step: "tour", action, tour_step: tourStep, replay: origin === "replay" \}/);
    // The caption panel sits at the top on a phone when the element itself is fixed at the bottom.
    expect(TOUR.stops.filter((stop) => stop.panel === "top").map((stop) => stop.key)).toEqual(["buy", "portfolio", "feed"]);
  });
});

describe("the tour's person", () => {
  it("is MrBeast when tradeable, else the first tradeable person in board order, never a display-only or paused one", () => {
    expect(TOUR_PREFERRED_SLUG).toBe("mrbeast");
    expect(pickTourPerson([{ slug: "elon-musk", tradingMode: null }, { slug: "mrbeast", tradingMode: "tradeable" }])).toBe("mrbeast");
    expect(pickTourPerson([{ slug: "elon-musk", tradingMode: null }, { slug: "mrbeast", tradingMode: "display_only" }])).toBe("elon-musk");
    expect(pickTourPerson([{ slug: "anthony-baptiste", tradingMode: "display_only" }, { slug: "drake", tradingMode: "paused" }, { slug: "kai-cenat", tradingMode: "tradeable" }])).toBe("kai-cenat");
    expect(pickTourPerson([{ slug: "anthony-baptiste", tradingMode: "display_only" }])).toBeNull();
    expect(pickTourPerson([])).toBeNull();
  });
});
