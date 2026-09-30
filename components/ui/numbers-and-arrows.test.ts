import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PulseIndicator } from "@/components/shell/pulse-indicator";
import { Money } from "@/components/trade/money";

import { DirectionArrow, DirectionIndicator, directionArrowIcon } from "./direction-indicator";
import { ScoreDisplay } from "./score-display";

/**
 * NUMBERS AND ARROWS (Phase 33). Three display rules, read back from the
 * markup: every change draws the platform's straight arrow (up, down, none
 * when flat) through one component; a score's decimal is the same size,
 * weight and colour as its integer; and a change is set in Inter with
 * tabular figures, not the mono face. Colour still means direction only.
 */

const ARROW_UP = "lucide-arrow-up";
const ARROW_DOWN = "lucide-arrow-down";

function html(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

describe("the arrow", () => {
  it("is straight up for heating, straight down for cooling, and nothing for flat", () => {
    expect(html(createElement(DirectionArrow, { direction: "heating" }))).toContain(ARROW_UP);
    expect(html(createElement(DirectionArrow, { direction: "cooling" }))).toContain(ARROW_DOWN);
    expect(html(createElement(DirectionArrow, { direction: "neutral" }))).toBe("");
    expect(directionArrowIcon.neutral).toBeNull();
  });

  it("is never a diagonal", () => {
    for (const direction of ["heating", "cooling", "neutral"] as const) {
      expect(html(createElement(DirectionArrow, { direction }))).not.toMatch(/arrow-(up|down)-right/);
    }
  });

  it("sits beside every change: the Home read, the header Mood, a signed money figure", () => {
    expect(html(createElement(DirectionIndicator, { change: 0.2 }))).toContain(ARROW_UP);
    expect(html(createElement(DirectionIndicator, { change: -0.2 }))).toContain(ARROW_DOWN);
    expect(html(createElement(PulseIndicator, { mood: 0.12, status: "live" }))).toContain(ARROW_UP);
    expect(html(createElement(PulseIndicator, { mood: -0.12, status: "live" }))).toContain(ARROW_DOWN);
    expect(html(createElement(Money, { cents: 1_250, signed: true }))).toContain(ARROW_UP);
    expect(html(createElement(Money, { cents: -1_250, signed: true }))).toContain(ARROW_DOWN);
  });

  it("is absent where the change is flat, unknown, or the figure is not a change", () => {
    expect(html(createElement(DirectionIndicator, { change: 0 }))).not.toMatch(/lucide-/);
    expect(html(createElement(DirectionIndicator, { change: null }))).not.toMatch(/lucide-/);
    expect(html(createElement(PulseIndicator, { mood: 0, status: "live" }))).not.toMatch(/lucide-/);
    expect(html(createElement(PulseIndicator, { mood: null, status: "standby" }))).not.toMatch(/lucide-/);
    expect(html(createElement(Money, { cents: 0, signed: true }))).not.toMatch(/lucide-/);
    expect(html(createElement(Money, { cents: 1_250 }))).not.toMatch(/lucide-/);
  });

  it("keeps the value in points, with its sign", () => {
    expect(html(createElement(DirectionIndicator, { change: 0.2 }))).toContain("+0.2");
    expect(html(createElement(DirectionIndicator, { change: -0.2 }))).toContain("−0.2");
    expect(html(createElement(DirectionIndicator, { change: 0.2 }))).not.toContain("%");
  });
});

describe("the score's decimal", () => {
  it("is set with the integer: same size, same weight, same colour", () => {
    const markup = html(createElement(ScoreDisplay, { score: 72.4, size: "lg" }));
    // The two halves carry no size, weight or colour of their own: it all sits on the one span around them.
    const score = markup.match(/<span class="([^"]*)" aria-label="Momentum score 72.4"><span>72<\/span><span>\.4<\/span><\/span>/);
    expect(score).not.toBeNull();
    const classes = score![1].split(" ");
    expect(classes).toContain("text-4xl");
    expect(classes).toContain("font-semibold");
    expect(classes).toContain("text-fg");
    expect(classes).toContain("num");
    expect(markup).not.toContain("text-fg-muted");
  });
});

describe("the change's face", () => {
  it("is Inter with tabular figures, not the mono face", () => {
    for (const markup of [
      html(createElement(DirectionIndicator, { change: 0.2 })),
      html(createElement(PulseIndicator, { mood: 0.12, status: "live" })),
      html(createElement(Money, { cents: 1_250, signed: true, face: "text" })),
    ]) {
      const classes = markup.match(/class="([^"]*)"/g)!.map((attr) => attr.slice(7, -1).split(" "));
      expect(classes.some((list) => list.includes("tabular-nums"))).toBe(true);
      expect(classes.some((list) => list.includes("num"))).toBe(false);
    }
  });
});
