import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { buildNarratives, templateNarrative } from "./narratives";
import type { PersonSummary, TickSummary } from "./types";

function person(overrides: Partial<PersonSummary>): PersonSummary {
  return {
    id: "p",
    slug: "p",
    displayName: "Person",
    revertTarget: 60,
    previousScore: 50,
    newScore: 50,
    change: 0,
    spread: 0.5,
    buyPrice: 50.5,
    sellPrice: 49.5,
    forces: {},
    signalsProcessed: 0,
    ...overrides,
  };
}

const summary: TickSummary = {
  tickNumber: 7,
  dryRun: false,
  startedAt: "2026-09-07T12:00:00.000Z",
  finishedAt: "2026-09-07T12:00:01.000Z",
  durationMs: 1000,
  mood: 0.08,
  peopleUpdated: 4,
  signalsProcessed: 1,
  people: [
    person({ id: "d", slug: "drake", displayName: "Drake", previousScore: 50, newScore: 51.24, change: 1.24, forces: { gravity: 0.04, signals: 1.2 }, signalsProcessed: 1 }),
    person({ id: "k", slug: "kendrick-lamar", displayName: "Kendrick Lamar", previousScore: 50, newScore: 49.35, change: -0.65, forces: { gravity: 0.04, market_mood: 0.02, inverse_pair: -0.71 } }),
    person({ id: "m", slug: "mrbeast", displayName: "MrBeast", previousScore: 50, newScore: 50.6, change: 0.6, forces: { gravity: 0.05, market_mood: 0.55 } }),
    person({ id: "e", slug: "elon-musk", displayName: "Elon Musk", previousScore: 50, newScore: 50.04, change: 0.04, forces: { gravity: 0.04 } }),
  ],
  signals: [
    { id: "s1", personSlug: "drake", headline: "Drake drops surprise album", label: "positive", confidence: 0.8, direction: 1, impact: 1.2, scorer: "llm", anomaly: "notable", narrative: "Drake's momentum climbed on a surprise album drop, the strongest signal in weeks." },
  ],
};

describe("narratives", () => {
  it("writes narratives only for meaningful moves, reusing the LLM sentence where there is one", () => {
    const rows = buildNarratives(summary, DEFAULT_ENGINE_CONFIG.narratives);
    expect(rows.map((r) => r.personId)).toEqual(["d", "k", "m"]); // sorted by |change|, Musk (+0.04) skipped
    expect(rows[0]).toEqual({
      personId: "d",
      tickNumber: 7,
      text: "Drake's momentum climbed on a surprise album drop, the strongest signal in weeks.",
      scoreBefore: 50,
      scoreAfter: 51.24,
      source: "llm",
    });
    expect(rows[1]).toMatchObject({ source: "template", text: "Kendrick Lamar's momentum slipped as Drake's surge pulled the pair the other way." });
    expect(rows[2]).toMatchObject({ source: "template", text: "MrBeast drifted up with a broadly positive market mood." });
  });

  it("caps the number of narratives per tick", () => {
    const rows = buildNarratives(summary, { minAbsChange: 0.5, maxPerTick: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].personId).toBe("d");
  });

  it("has a template for every force", () => {
    const base = person({ displayName: "Jeff Bezos", slug: "jeff-bezos", change: 0.7, revertTarget: 56 });
    expect(templateNarrative({ ...base, forces: { gravity: 0.7 } }, summary)).toBe("Jeff Bezos' momentum settled up toward its baseline of 56.");
    expect(templateNarrative({ ...base, forces: { conviction: 0.12 } }, summary)).toContain("capital concentration lifted");
    expect(templateNarrative({ ...base, change: -0.7, forces: { trading_activity: -0.25 } }, summary)).toContain("A burst of selling pushed down");
    expect(templateNarrative({ ...base, forces: { signals: 0.7 }, slug: "drake" }, summary)).toContain('on "Drake drops surprise album"');
    expect(templateNarrative({ ...base, forces: {} }, summary)).toBe("Jeff Bezos' momentum climbed this tick.");
  });

  it("uses a template when the LLM narrative belongs to a signal-less move", () => {
    const noSignalForce = { ...summary, people: [person({ id: "d", slug: "drake", displayName: "Drake", change: 0.8, newScore: 50.8, forces: { market_mood: 0.5 } })] };
    const [row] = buildNarratives(noSignalForce, DEFAULT_ENGINE_CONFIG.narratives);
    expect(row.source).toBe("template");
  });
});
