import { describe, expect, it, vi } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";
import { LLMError, type LLMResponse } from "@/lib/llm/types";
import { createMemoryUsageLogger } from "@/lib/llm/usage";

import { DEFAULT_ENGINE_CONFIG as CONFIG, withEngineConfig } from "./config";
import { deadlineAfter } from "./deadline";
import { LLMScorer } from "./sentiment/llm";
import { rulesBasedScorer } from "./sentiment/rules";
import { createMemoryEngineStore, type MemoryEngineSeed } from "./store";
import { runEngineTick } from "./tick";
import type { EngineSignal } from "./types";

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

// ---------------------------------------------------------------------------
// THE TICK THAT ALWAYS COMMITS (Phase 11)
// ---------------------------------------------------------------------------

/** The production backlog shape at the time of the failure, on the three test people. */
function backlog(): EngineSignal[] {
  const make = (id: string, personId: string, minutesAgo: number): EngineSignal => {
    const at = new Date(NOW.getTime() - minutesAgo * 60_000);
    return { id, personId, headline: `${id} wins record award`, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt: at, createdAt: at };
  };
  return [
    ...Array.from({ length: 145 }, (_, i) => make(`mb-${String(i).padStart(3, "0")}`, "p-mrbeast", 3000 - i)),
    ...Array.from({ length: 82 }, (_, i) => make(`dr-${String(i).padStart(3, "0")}`, "p-drake", 2900 - i)),
    ...Array.from({ length: 55 }, (_, i) => make(`kl-${String(i).padStart(3, "0")}`, "p-kendrick", 2800 - i)),
  ];
}

/** An LLM scorer over a fake provider that answers every id in the prompt. */
function llmScorer(options: { failFor?: (personId: string) => boolean; callBudget?: number } = {}) {
  const usageLogger = createMemoryUsageLogger();
  const complete = vi.fn(async (request: { userPrompt: string }): Promise<LLMResponse> => {
    if (options.failFor && [...request.userPrompt.matchAll(/id=([\w-]+)/g)].some((m) => options.failFor!(m[1].slice(0, 2)))) {
      throw new LLMError("timed out", { kind: "timeout", provider: "fake", retryable: true });
    }
    const ids = [...request.userPrompt.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
    const signals = ids.map((id) => ({ id, label: "positive", confidence: 0.6, anomaly: "notable", rationale: "fake" }));
    return { text: "", structuredData: { signals, narrative: "Up on news." }, usage: { inputTokens: 2000, outputTokens: 700, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake-model", stopReason: "end_turn", latencyMs: 5 };
  });
  const scorer = new LLMScorer({ complete, usageLogger, batchDelayMs: 0, log: vi.fn(), config: { ...CONFIG.llm, callBudgetPerTick: options.callBudget ?? CONFIG.llm.callBudgetPerTick } });
  return { scorer, complete, usageLogger };
}

describe("Engine tick — the tick that always commits", () => {
  it("a 282-signal backlog: the tick COMMITS one chunk per person and leaves the rest unprocessed for the next tick", async () => {
    const signals = backlog();
    const store = createMemoryEngineStore(seed({ signals }));
    const { scorer, complete } = llmScorer();

    const summary = await runEngineTick({ store, scorer, now: NOW, config: withEngineConfig({ llm: { callBudgetPerTick: 4 } }) });

    // Committed: one tick, 36 signals (12 × 3 people), every one via the model, in exactly three calls.
    expect(store.ticks).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(summary.signalsProcessed).toBe(36);
    expect(summary.signals.every((s) => s.scorer === "llm")).toBe(true);
    expect(store.processedSignals).toHaveLength(36);
    expect(store.signals.filter((s) => s.processed)).toHaveLength(36);
    expect(store.signals.filter((s) => !s.processed)).toHaveLength(282 - 36);
    // The twelve OLDEST of each person, so the backlog drains in order.
    expect(store.signals.filter((s) => s.processed && s.personId === "p-mrbeast").map((s) => s.id)).toEqual(signals.slice(0, 12).map((s) => s.id));

    // The summary says exactly what happened and what is left.
    expect(summary.scoring).toEqual({
      backlogBefore: 282,
      loaded: 282,
      selected: 36,
      attempted: 36,
      llmScored: 36,
      fallbacks: 0,
      withoutModel: 0,
      deferred: 0,
      deferredByReason: {},
      llmCalls: 3,
      llmCallBudget: 4,
      processed: 36,
      backlogAfter: 246,
      partial: true,
      budgetMs: expect.any(Number),
      remainingMs: expect.any(Number),
    });
    expect(summary.deferred).toEqual([]);

    // Gravity moved everyone, and the Signals force is braked at ±10 per person.
    for (const p of summary.people) {
      expect(p.forces.gravity).toBeGreaterThan(0);
      expect(Math.abs(p.forces.signals ?? 0)).toBeLessThanOrEqual(CONFIG.signals.maxAbsImpactPerTick);
    }

    // The next tick takes the next chunk of each person: the backlog drains across ticks.
    const second = await runEngineTick({ store, scorer, now: new Date(NOW.getTime() + 30_000) });
    expect(second.tickNumber).toBe(2);
    expect(second.scoring).toMatchObject({ backlogBefore: 246, selected: 36, processed: 36, backlogAfter: 210, partial: true });
    expect(store.signals.filter((s) => s.processed && s.personId === "p-mrbeast").map((s) => s.id)).toEqual(signals.slice(0, 24).map((s) => s.id));
  });

  it("DEFERRED stays processed = false; FAILED is processed with a rules score; the two paths are distinct", async () => {
    const store = createMemoryEngineStore(seed({ signals: backlog() }));
    // MrBeast's call fails; the budget of 2 lets Drake through and defers Kendrick.
    const { scorer, complete, usageLogger } = llmScorer({ failFor: (prefix) => prefix === "mb", callBudget: 2 });

    const summary = await runEngineTick({ store, scorer, now: NOW, config: withEngineConfig({ llm: { callBudgetPerTick: 2 } }) });

    expect(store.ticks).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);

    // FAILED → rules-fallback, processed.
    const mrbeast = summary.signals.filter((s) => s.personSlug === "mrbeast");
    expect(mrbeast).toHaveLength(12);
    expect(mrbeast.every((s) => s.scorer === "rules-fallback")).toBe(true);
    expect(mrbeast[0].rationale).toContain("fallback: LLM call failed (timeout: timed out)");
    expect(store.signals.filter((s) => s.personId === "p-mrbeast" && s.processed)).toHaveLength(12);

    // Scored → llm, processed.
    expect(summary.signals.filter((s) => s.personSlug === "drake" && s.scorer === "llm")).toHaveLength(12);

    // DEFERRED → not in the summary's signals, not in the commit, still unprocessed.
    expect(summary.signals.some((s) => s.personSlug === "kendrick-lamar")).toBe(false);
    expect(summary.deferred).toHaveLength(12);
    expect(summary.deferred.every((d) => d.personSlug === "kendrick-lamar" && d.reason === "call_budget")).toBe(true);
    expect(store.signals.filter((s) => s.personId === "p-kendrick" && s.processed)).toHaveLength(0);
    expect(store.ticks[0].signals.some((s) => s.id.startsWith("kl-"))).toBe(false);

    expect(summary.scoring).toMatchObject({ selected: 36, attempted: 24, llmScored: 12, fallbacks: 12, deferred: 12, deferredByReason: { call_budget: 12 }, llmCalls: 2, processed: 24, backlogAfter: 258, partial: true });
    expect(summary.signalsProcessed).toBe(24);
    // Both attempts are on the ledger; the deferred chunk is not.
    expect(usageLogger.rows.map((r) => r.status).sort()).toEqual(["completed", "failed"]);
  });

  it("with the deadline already reached, no model call starts, and the tick STILL COMMITS: Gravity for everyone, the free signals scored", async () => {
    const metric: EngineSignal = {
      id: "metric-1",
      personId: "p-drake",
      headline: "Drake monthly listeners +2.1σ",
      rawPayload: { kind: "metric", metric: "monthly_listeners", polarity: 1, sigma: 2.1, scale: 1 },
      sourceName: "spotify",
      sourceTier: 2,
      occurredAt: NOW,
      createdAt: NOW,
    };
    const store = createMemoryEngineStore(seed({ signals: [...backlog(), metric] }));
    const { scorer, complete } = llmScorer();

    const summary = await runEngineTick({ store, scorer, now: NOW, deadline: deadlineAfter(0) });

    expect(complete).not.toHaveBeenCalled();
    expect(store.ticks).toHaveLength(1);
    expect(store.scoreHistory.map((h) => h.tickNumber)).toEqual([1, 1, 1]);
    expect(store.scoreEvents.filter((e) => e.force === "gravity")).toHaveLength(3);
    expect(summary.people.every((p) => p.forces.gravity !== undefined && p.forces.gravity > 0)).toBe(true);
    // The metric signal never needs the model, so it is scored and processed even now.
    expect(summary.signals).toEqual([expect.objectContaining({ id: "metric-1", scorer: "metric", label: "positive" })]);
    expect(summary.scoring).toMatchObject({ selected: 37, attempted: 0, withoutModel: 1, deferred: 36, deferredByReason: { deadline: 36 }, llmCalls: 0, processed: 1, backlogAfter: 282, partial: true, remainingMs: 0 });
    expect(store.signals.filter((s) => s.processed).map((s) => s.id)).toEqual(["metric-1"]);
  });

  it("a tick with nothing to defer reports itself as complete", async () => {
    const store = createMemoryEngineStore(seed({ signals: backlog().slice(0, 5) }));
    const { scorer } = llmScorer();
    const summary = await runEngineTick({ store, scorer, now: NOW });
    expect(summary.scoring).toMatchObject({ backlogBefore: 5, selected: 5, processed: 5, deferred: 0, backlogAfter: 0, partial: false, llmCalls: 1 });
  });
});
