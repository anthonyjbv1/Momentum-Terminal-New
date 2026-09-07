import { describe, expect, it } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";

import { DEFAULT_ENGINE_CONFIG as CONFIG, withEngineConfig } from "./config";
import { rulesBasedScorer } from "./sentiment/rules";
import { createMemoryEngineStore, type MemoryEngineSeed } from "./store";
import { runEngineTick } from "./tick";

const NOW = new Date("2026-09-07T12:00:00.000Z");

const drake = makePerson({ id: "p-drake", slug: "drake", display_name: "Drake", revert_target: 65, category: "musician" });
const kendrick = makePerson({ id: "p-kendrick", slug: "kendrick-lamar", display_name: "Kendrick Lamar", revert_target: 63, category: "musician" });
const mrbeast = makePerson({ id: "p-mrbeast", slug: "mrbeast", display_name: "MrBeast", revert_target: 68 });
const pair = { id: "pair-1", person_a_id: "p-drake", person_b_id: "p-kendrick", dampening: 0.4 };

function seed(extra: Partial<MemoryEngineSeed> = {}): MemoryEngineSeed {
  return { people: [drake, kendrick, mrbeast], inversePairs: [pair], ...extra };
}

describe("Engine tick", () => {
  it("with no signals moves every score slightly toward its revert target via Gravity only", async () => {
    const store = createMemoryEngineStore(seed());
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });

    expect(summary.tickNumber).toBe(1);
    expect(summary.dryRun).toBe(false);
    expect(summary.mood).toBe(0);
    expect(summary.signalsProcessed).toBe(0);
    expect(summary.peopleUpdated).toBe(3);

    for (const p of summary.people) {
      const target = { drake: 65, "kendrick-lamar": 63, mrbeast: 68 }[p.slug]!;
      expect(p.newScore).toBeGreaterThan(50);
      expect(p.newScore).toBeLessThan(target);
      expect(p.change).toBeGreaterThan(0);
      expect(p.change).toBeLessThan(0.1);
      expect(Object.keys(p.forces)).toEqual(["gravity"]);
      expect(p.spread).toBe(0.5);
      expect(p.buyPrice).toBeCloseTo(p.newScore + 0.5, 2);
      expect(p.sellPrice).toBeCloseTo(p.newScore - 0.5, 2);
    }
    // Gravity for one 30s tick from 50 toward 68: 18 * (1 - e^(-0.35/120)) = 0.0524 -> 50.05
    expect(summary.people.find((p) => p.slug === "mrbeast")?.newScore).toBe(50.05);

    expect(store.scoreHistory.map((h) => h.tickNumber)).toEqual([1, 1, 1]);
    expect(store.scoreEvents.every((e) => e.force === "gravity" && e.impact > 0)).toBe(true);
    expect(store.scoreEvents).toHaveLength(3);
    expect(store.people.find((p) => p.id === "p-mrbeast")?.current_score).toBe(50.05);
  });

  it("increments tick_number and uses the time since the last tick", async () => {
    const store = createMemoryEngineStore(seed());
    await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    const later = new Date(NOW.getTime() + 60 * 60 * 1000); // one hour of silence
    const second = await runEngineTick({ store, scorer: rulesBasedScorer, now: later });

    expect(second.tickNumber).toBe(2);
    expect(store.scoreHistory.map((h) => h.tickNumber)).toEqual([1, 1, 1, 2, 2, 2]);
    const mr = second.people.find((p) => p.slug === "mrbeast")!;
    // One hour toward 68 from 50.05: 68 - 17.95 * e^-0.35 = 55.35
    expect(mr.newScore).toBeCloseTo(68 - (68 - 50.05) * Math.exp(-0.35), 1);
  });

  it("applies a seeded signal, marks it processed, and moves the inverse pair the other way", async () => {
    const store = createMemoryEngineStore(
      seed({
        signals: [
          {
            id: "sig-1",
            personId: "p-drake",
            headline: "Drake crosses 100M monthly listeners on Spotify",
            rawPayload: { kind: "milestone" },
            sourceName: "spotify",
            sourceTier: 2,
            occurredAt: NOW,
            createdAt: NOW,
          },
        ],
      }),
    );
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });

    const drakeSummary = summary.people.find((p) => p.slug === "drake")!;
    const kendrickSummary = summary.people.find((p) => p.slug === "kendrick-lamar")!;
    const mrbeastSummary = summary.people.find((p) => p.slug === "mrbeast")!;

    // "crosses" -> positive 0.8 -> impact 1.5 * 1.0 * 0.8 = 1.2
    expect(summary.signals).toEqual([
      expect.objectContaining({ id: "sig-1", personSlug: "drake", label: "positive", confidence: 0.8, direction: 1, impact: 1.2 }),
    ]);
    expect(drakeSummary.forces.signals).toBe(1.2);
    expect(drakeSummary.forces.market_mood).toBeUndefined(); // own news never feeds back through the mood
    expect(drakeSummary.newScore).toBeCloseTo(50 + 1.2 + 0.0437, 2); // + gravity toward 65

    // Kendrick: inverse -(1.2 * 0.4) = -0.48, plus mood 0.25 * mean(others) = 0.25 * 0.6 = 0.15
    expect(kendrickSummary.forces.inverse_pair).toBeCloseTo(-0.48);
    expect(kendrickSummary.forces.market_mood).toBeCloseTo(0.15);
    expect(kendrickSummary.newScore).toBeLessThan(mrbeastSummary.newScore);

    // MrBeast only feels the tide.
    expect(mrbeastSummary.forces.market_mood).toBeCloseTo(0.15);
    expect(mrbeastSummary.forces.signals).toBeUndefined();
    expect(summary.mood).toBeCloseTo(1.2 / 3);

    // Persisted: signal processed with its sentiment + impact; events logged without zero entries.
    expect(store.processedSignals).toEqual([{ id: "sig-1", impactScore: 1.2, sentimentLabel: "positive", sentimentConfidence: 0.8 }]);
    expect(store.signals[0].processed).toBe(true);
    const forces = store.scoreEvents.map((e) => `${e.personId}:${e.force}`).sort();
    expect(forces).toEqual(
      [
        "p-drake:gravity",
        "p-drake:signals",
        "p-kendrick:gravity",
        "p-kendrick:inverse_pair",
        "p-kendrick:market_mood",
        "p-mrbeast:gravity",
        "p-mrbeast:market_mood",
      ].sort(),
    );
    expect(store.scoreEvents.some((e) => e.force === "conviction" || e.force === "trading_activity")).toBe(false);

    // A second tick has nothing left to process.
    const again = await runEngineTick({ store, scorer: rulesBasedScorer, now: new Date(NOW.getTime() + 30_000) });
    expect(again.signalsProcessed).toBe(0);
    expect(again.mood).toBe(0);
  });

  it("treats baseline signals as zero impact but still marks them processed", async () => {
    const store = createMemoryEngineStore(
      seed({
        signals: [
          {
            id: "sig-base",
            personId: "p-mrbeast",
            headline: "MrBeast stands at 516M subscribers, 90B total views and 900 videos on YouTube",
            rawPayload: { kind: "baseline" },
            sourceName: "youtube",
            sourceTier: 2,
            occurredAt: NOW,
            createdAt: NOW,
          },
        ],
      }),
    );
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    expect(summary.signals[0]).toMatchObject({ label: "neutral", confidence: 0, direction: 0, impact: 0 });
    expect(summary.people.find((p) => p.slug === "mrbeast")?.forces.signals).toBeUndefined();
    expect(store.processedSignals[0]).toMatchObject({ id: "sig-base", impactScore: 0, sentimentLabel: "neutral" });
  });

  it("dry runs compute everything and persist nothing", async () => {
    const store = createMemoryEngineStore(seed());
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.people).toHaveLength(3);
    expect(summary.peopleUpdated).toBe(0);
    expect(store.ticks).toHaveLength(0);
    expect(store.scoreHistory).toHaveLength(0);
    expect(store.people.every((p) => p.current_score === 50)).toBe(true);
  });

  it("clamps to the floor and ceiling", async () => {
    const high = makePerson({ id: "p-high", slug: "high", current_score: 99.9, revert_target: 60 });
    const low = makePerson({ id: "p-low", slug: "low", current_score: 35.2, revert_target: 60 });
    const loud = (id: string, personId: string, headline: string) => ({
      id,
      personId,
      headline,
      rawPayload: null,
      sourceName: "forbes",
      sourceTier: 1,
      occurredAt: NOW,
      createdAt: NOW,
    });
    const store = createMemoryEngineStore({
      people: [high, low],
      signals: [
        ...Array.from({ length: 8 }, (_, i) => loud(`up${i}`, "p-high", "wins record award")),
        ...Array.from({ length: 8 }, (_, i) => loud(`dn${i}`, "p-low", "arrested in fraud scandal")),
      ],
    });
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config: withEngineConfig({ marketMood: { fraction: 0 } }) });
    expect(summary.people.find((p) => p.slug === "high")?.newScore).toBe(CONFIG.score.ceiling);
    expect(summary.people.find((p) => p.slug === "low")?.newScore).toBe(CONFIG.score.floor);
  });

  it("refuses to persist a stale tick", async () => {
    const store = createMemoryEngineStore(seed({ lastTickNumber: 4 }));
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    expect(summary.tickNumber).toBe(5);
    await expect(store.applyTick({ ...store.ticks[0], expectedTickNumber: 5 })).rejects.toThrow(/stale tick/);
  });
});
