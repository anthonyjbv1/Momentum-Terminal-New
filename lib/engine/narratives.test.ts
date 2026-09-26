import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { buildNarratives, buildNarrativesDetailed, checkNarrative, templateNarrative } from "./narratives";
import type { PersonSummary, TickSummary } from "./types";

function person(overrides: Partial<PersonSummary>): PersonSummary {
  return {
    id: "p",
    slug: "p",
    displayName: "Person",
    revertTarget: 60,
    targetOffset: 0,
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
  scoring: { backlogBefore: 1, loaded: 1, selected: 1, personOrder: ["drake"], attempted: 1, llmScored: 1, fallbacks: 0, withoutModel: 0, expired: 0, deferred: 0, deferredByReason: {}, llmCalls: 1, llmCallBudget: 4, processed: 1, backlogAfter: 0, partial: false, budgetMs: 25_000, remainingMs: 20_000 },
  deferred: [],
  people: [
    person({ id: "d", slug: "drake", displayName: "Drake", previousScore: 50, newScore: 51.24, change: 1.24, forces: { gravity: 0.04, signals: 1.2 }, signalsProcessed: 1 }),
    person({ id: "k", slug: "kendrick-lamar", displayName: "Kendrick Lamar", previousScore: 50, newScore: 49.35, change: -0.65, forces: { gravity: 0.04, market_mood: 0.02, inverse_pair: -0.71 } }),
    person({ id: "m", slug: "mrbeast", displayName: "MrBeast", previousScore: 50, newScore: 50.6, change: 0.6, forces: { gravity: 0.05, market_mood: 0.55 } }),
    person({ id: "e", slug: "elon-musk", displayName: "Elon Musk", previousScore: 50, newScore: 50.04, change: 0.04, forces: { gravity: 0.04 } }),
  ],
  signals: [
    { id: "s1", personSlug: "drake", headline: "Drake drops surprise album", label: "positive", confidence: 0.8, direction: 1, impact: 1.2, ageHours: 0, freshness: 1, scorer: "llm", anomaly: "notable", narrative: "Drake's momentum climbed on a surprise album drop, the strongest signal in weeks." },
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
      signals: [{ signalId: "s1", relation: "direct" }],
    });
    expect(rows[1]).toMatchObject({
      source: "template",
      text: "Kendrick Lamar's momentum slipped as Drake's surge pulled the pair the other way.",
      // Produced by Drake's signal, and recorded as such.
      signals: [{ signalId: "s1", relation: "inverse_pair" }],
    });
    expect(rows[2]).toMatchObject({ source: "template", text: "MrBeast drifted up with a broadly positive market mood.", signals: [] });
  });

  it("links exactly the signals that produced each narrative: several, one, none", () => {
    const sentence = "Drake's momentum climbed on an album drop and a sold-out tour.";
    const tick: TickSummary = {
      ...summary,
      people: [
        person({ id: "d", slug: "drake", displayName: "Drake", previousScore: 50, newScore: 51.8, change: 1.8, forces: { gravity: 0.04, signals: 1.76 }, signalsProcessed: 3 }),
        person({ id: "m", slug: "mrbeast", displayName: "MrBeast", previousScore: 50, newScore: 50.9, change: 0.9, forces: { gravity: 0.05, signals: 0.85 }, signalsProcessed: 2 }),
        person({ id: "e", slug: "elon-musk", displayName: "Elon Musk", previousScore: 50, newScore: 50.7, change: 0.7, forces: { gravity: 0.04, market_mood: 0.66 } }),
      ],
      signals: [
        // One LLM batch for Drake: both signals carry the same sentence, so both produced it.
        { id: "s1", personSlug: "drake", headline: "Drake drops surprise album", label: "positive", confidence: 0.8, direction: 1, impact: 1.2, ageHours: 0, freshness: 1, scorer: "llm", narrative: sentence },
        { id: "s2", personSlug: "drake", headline: "Drake tour sells out", label: "positive", confidence: 0.7, direction: 1, impact: 0.56, ageHours: 0, freshness: 1, scorer: "llm", narrative: sentence },
        // Pre-filtered before the LLM saw it: not part of the batch, not evidence.
        { id: "s3", personSlug: "drake", headline: "Drake weekly streams: 480M (baseline)", label: "neutral", confidence: 0.1, direction: 0, impact: 0, ageHours: 0, freshness: 1, scorer: "prefilter" },
        // MrBeast's template sentence quotes the one signal that moved the score; the zero-impact one did not.
        { id: "s4", personSlug: "mrbeast", headline: "MrBeast upload passes 40M views", label: "positive", confidence: 0.8, direction: 1, impact: 0.85, ageHours: 0, freshness: 1, scorer: "rules" },
        { id: "s5", personSlug: "mrbeast", headline: "MrBeast subscriber count: 300M (baseline)", label: "neutral", confidence: 0.2, direction: 0, impact: 0, ageHours: 0, freshness: 1, scorer: "rules" },
      ],
    };
    const rows = buildNarratives(tick, DEFAULT_ENGINE_CONFIG.narratives);
    expect(rows.map((row) => [row.personId, row.source, row.signals])).toEqual([
      ["d", "llm", [{ signalId: "s1", relation: "direct" }, { signalId: "s2", relation: "direct" }]],
      ["m", "template", [{ signalId: "s4", relation: "direct" }]],
      ["e", "template", []],
    ]);
    expect(rows[1].text).toBe('MrBeast\'s momentum climbed on "MrBeast upload passes 40M views".');
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

// ---------------------------------------------------------------------------
// Phase 31: the analyst's note, checked before it is published
// ---------------------------------------------------------------------------

describe("checkNarrative (Phase 31)", () => {
  const note = "Stephen A. Smith called the Chiefs the roadblock in the AFC. The praise lands in a week the comeback story is already running hot.";

  it("passes a plain note whose declared direction agrees with the Signals force", () => {
    expect(checkNarrative(note, "up", 0.62, 0.5)).toEqual({ ok: true });
    expect(checkNarrative("A quiet day. The only new mention was a passing one in a business roundup.", "flat", 0.1, 0.5)).toEqual({ ok: true });
    // No declared direction (a version-1 answer): only the voice is checked.
    expect(checkNarrative(note, undefined, -0.6, 0.5)).toEqual({ ok: true });
  });

  it("replaces a note that points the other way, or calls a narrative's worth of movement flat", () => {
    expect(checkNarrative(note, "down", 0.62, 0.5)).toEqual({ ok: false, reason: "direction" });
    expect(checkNarrative(note, "up", -0.62, 0.5)).toEqual({ ok: false, reason: "direction" });
    expect(checkNarrative(note, "flat", 0.62, 0.5)).toEqual({ ok: false, reason: "direction" });
  });

  it("replaces the Engine's own voice: the production sentences that describe weighing, and the leaked multiples", () => {
    for (const text of [
      "Expert commentary confirms Chiefs dominance; real estate and celebrity gossip add no momentum signal.",
      "Comment sentiment digests lack directional weight; the day's coverage is routine.",
      "Media chatter remains elevated but today's signal is noise: Bezos mentioned only as backdrop to unrelated cannabis story.",
      "Brin's social momentum continues surging with 3.5x usual reach today.",
      "Coverage and engagement surge 2.5x on the Muse launch.",
      "The Paramount news is already priced into today's coverage.",
      "Net effect mildly positive amid regulatory scrutiny.",
      "Reach ran +1.4σ above the usual week.",
    ]) {
      expect(checkNarrative(text, "up", 0.6, 0.5), text).toEqual({ ok: false, reason: "voice" });
    }
    // "Signals" as a verb inside a company name is the cost of the word ban; a note about a "signal" is replaced whatever it meant.
    expect(checkNarrative("Martha Stewart called MrBeast entertaining after three days filming with him.", "up", 0.6, 0.5)).toEqual({ ok: true });
  });
});

describe("buildNarrativesDetailed (Phase 31)", () => {
  const on = { ...DEFAULT_ENGINE_CONFIG.signalQuality, enabled: true };
  const withDirection = (direction: "up" | "down" | "flat", text = "Drake released a surprise album, his first in two years.") => ({
    ...summary,
    signals: [{ ...summary.signals[0], narrative: text, narrativeDirection: direction }],
  });

  it("publishes the LLM note when its direction agrees, replaces it with the template when it does not, and says why", () => {
    const agreed = buildNarrativesDetailed(withDirection("up"), DEFAULT_ENGINE_CONFIG.narratives, on);
    expect(agreed.rows[0]).toMatchObject({ personId: "d", source: "llm", text: "Drake released a surprise album, his first in two years." });
    expect(agreed.replaced).toEqual([]);

    const contradicted = buildNarrativesDetailed(withDirection("down"), DEFAULT_ENGINE_CONFIG.narratives, on);
    expect(contradicted.rows[0]).toMatchObject({ personId: "d", source: "template", text: 'Drake\'s momentum climbed on "Drake drops surprise album".' });
    expect(contradicted.replaced).toEqual([{ personId: "d", reason: "direction", text: "Drake released a surprise album, his first in two years." }]);
    // The template's evidence is the signals that moved the person, as it always was.
    expect(contradicted.rows[0].signals).toEqual([{ signalId: "s1", relation: "direct" }]);
  });

  it("replaces the Engine's voice too, and does nothing at all while the switch is off", () => {
    const voice = withDirection("up", "Comment digests show routine mixed sentiment, no momentum shift.");
    expect(buildNarrativesDetailed(voice, DEFAULT_ENGINE_CONFIG.narratives, on).replaced).toEqual([{ personId: "d", reason: "voice", text: "Comment digests show routine mixed sentiment, no momentum shift." }]);
    const off = buildNarrativesDetailed(withDirection("down", "Comment digests show routine mixed sentiment, no momentum shift."), DEFAULT_ENGINE_CONFIG.narratives, DEFAULT_ENGINE_CONFIG.signalQuality);
    expect(off.replaced).toEqual([]);
    expect(off.rows[0].source).toBe("llm");
    // buildNarratives without a quality argument is the pre-Phase 31 function.
    expect(buildNarratives(withDirection("down"), DEFAULT_ENGINE_CONFIG.narratives)[0].source).toBe("llm");
  });
});
