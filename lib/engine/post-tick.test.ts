import { describe, expect, it, vi } from "vitest";

import type { LLMResponse } from "@/lib/llm/types";
import { createMemoryUsageLogger } from "@/lib/llm/usage";

import { DEFAULT_ENGINE_CONFIG, withEngineConfig } from "./config";
import { NO_DEADLINE, deadlineAfter } from "./deadline";
import { createMemoryMemoryStore } from "./memory/store";
import { emptyMemory } from "./memory/types";
import { createMemoryNarrativeStore } from "./narratives";
import { runPostTick } from "./post-tick";
import type { TickSummary } from "./types";

const summary: TickSummary = {
  tickNumber: 3,
  dryRun: false,
  startedAt: "2026-09-07T12:00:00.000Z",
  finishedAt: "2026-09-07T12:00:01.000Z",
  durationMs: 1000,
  mood: 0.4,
  peopleUpdated: 2,
  signalsProcessed: 2,
  scoring: { backlogBefore: 2, loaded: 2, selected: 2, personOrder: ["drake", "mrbeast"], attempted: 2, llmScored: 2, fallbacks: 0, withoutModel: 0, expired: 0, deferred: 0, deferredByReason: {}, llmCalls: 2, llmCallBudget: 4, processed: 2, backlogAfter: 0, partial: false, budgetMs: 25_000, remainingMs: 20_000 },
  deferred: [],
  people: [
    { id: "d", slug: "drake", displayName: "Drake", revertTarget: 65, previousScore: 50, newScore: 51.24, change: 1.24, spread: 0.5, buyPrice: 51.74, sellPrice: 50.74, forces: { gravity: 0.04, signals: 1.2 }, signalsProcessed: 1 },
    { id: "m", slug: "mrbeast", displayName: "MrBeast", revertTarget: 68, previousScore: 50, newScore: 50.1, change: 0.1, spread: 0.5, buyPrice: 50.6, sellPrice: 49.6, forces: { gravity: 0.05, signals: 0.05 }, signalsProcessed: 1 },
  ],
  signals: [
    { id: "s1", personSlug: "drake", headline: "Drake drops surprise album", label: "positive", confidence: 0.8, direction: 1, impact: 1.2, ageHours: 0, freshness: 1, scorer: "llm", anomaly: "notable", narrative: "Drake's momentum climbed on a surprise album drop." },
    { id: "s2", personSlug: "mrbeast", headline: "MrBeast uploads a new video on YouTube (901 total)", label: "positive", confidence: 0.1, direction: 1, impact: 0.05, ageHours: 0, freshness: 1, scorer: "llm", anomaly: "routine" },
  ],
};

const fakeSummary = vi.fn<(request: { taskType: string; timeoutMs?: number; userPrompt: string }) => Promise<LLMResponse>>(async () => ({
  text: "Drake dropped a surprise album.",
  usage: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  provider: "fake",
  model: "fake-model",
  stopReason: "end_turn",
  latencyMs: 2,
}));

describe("runPostTick", () => {
  it("writes narratives for meaningful moves and remembers notable signals", async () => {
    const narrativeStore = createMemoryNarrativeStore();
    const memoryStore = createMemoryMemoryStore();

    const result = await runPostTick(summary, { narrativeStore, memoryStore, config: DEFAULT_ENGINE_CONFIG });

    expect(result).toEqual({ narratives: 1, memoryUpdates: 1, memoryLlmSummaries: 0, memorySummariesDeferred: 0, memoryEventsExpired: 0, errors: [] });
    expect(narrativeStore.rows[0]).toMatchObject({ personId: "d", tickNumber: 3, source: "llm" });
    const drake = memoryStore.memories.get("d")!;
    expect(drake.recentContext.notable_events).toHaveLength(1);
    expect(drake.recentContext.notable_events[0]).toMatchObject({ headline: "Drake drops surprise album", impact: 1.2, anomaly: "notable" });
    expect(drake.recentContext.last_updated_tick).toBe(3);
    expect(memoryStore.memories.has("m")).toBe(false); // routine, low impact: not remembered, and nothing to expire
  });

  it("does nothing on a dry run", async () => {
    const narrativeStore = createMemoryNarrativeStore();
    const memoryStore = createMemoryMemoryStore();
    const result = await runPostTick({ ...summary, dryRun: true }, { narrativeStore, memoryStore });
    expect(result.narratives).toBe(0);
    expect(narrativeStore.rows).toHaveLength(0);
    expect(memoryStore.memories.size).toBe(0);
  });

  it("reports failures without throwing", async () => {
    const narrativeStore = { insert: vi.fn(async () => { throw new Error("db down"); }) };
    const memoryStore = createMemoryMemoryStore();
    const log = vi.fn();
    const result = await runPostTick(summary, { narrativeStore, memoryStore, log });
    expect(result.errors).toEqual(["narratives failed: db down"]);
    expect(result.memoryUpdates).toBe(1);
    expect(log).toHaveBeenCalled();
  });

  describe("memory summaries under the tick's deadline", () => {
    // maxRecentEvents 0 makes every notable event overflow, so a summary call is wanted.
    const config = withEngineConfig({ memory: { maxRecentEvents: 0 } });

    it("makes the summary call when it can finish before the deadline, on the ledger in both halves", async () => {
      fakeSummary.mockClear();
      const usageLogger = createMemoryUsageLogger();
      const memoryStore = createMemoryMemoryStore();
      const result = await runPostTick(summary, { narrativeStore: createMemoryNarrativeStore(), memoryStore, config, complete: fakeSummary, usageLogger, deadline: NO_DEADLINE });

      expect(fakeSummary).toHaveBeenCalledTimes(1);
      expect(fakeSummary.mock.calls[0][0]).toMatchObject({ taskType: "memory", timeoutMs: DEFAULT_ENGINE_CONFIG.llm.timeoutMs });
      expect(result).toMatchObject({ memoryUpdates: 1, memoryLlmSummaries: 1, memorySummariesDeferred: 0 });
      expect(memoryStore.memories.get("d")?.recentContext.summary).toBe("Drake dropped a surprise album.");
      expect(usageLogger.rows).toEqual([expect.objectContaining({ taskType: "memory", personId: "d", tickNumber: 3, status: "completed", model: "fake-model" })]);
    });

    it("does not START a summary call that could not finish before the deadline: deterministic text instead, and the tick is not delayed", async () => {
      fakeSummary.mockClear();
      const usageLogger = createMemoryUsageLogger();
      const memoryStore = createMemoryMemoryStore();
      const result = await runPostTick(summary, { narrativeStore: createMemoryNarrativeStore(), memoryStore, config, complete: fakeSummary, usageLogger, deadline: deadlineAfter(0) });

      expect(fakeSummary).not.toHaveBeenCalled();
      expect(result).toMatchObject({ narratives: 1, memoryUpdates: 1, memoryLlmSummaries: 0, memorySummariesDeferred: 1, errors: [] });
      expect(memoryStore.memories.get("d")?.recentContext.summary).toContain("Earlier: Drake drops surprise album (2026-09-07, +1.20)");
      expect(usageLogger.rows).toHaveLength(0);
    });
  });

  describe("memory event expiry (Phase 12+)", () => {
    it("ages a QUIET person's memory: an event past maxEventAgeDays expires and folds into the summary with its date, without any signal for them this tick", async () => {
      fakeSummary.mockClear();
      const memoryStore = createMemoryMemoryStore();
      const stale = emptyMemory("m");
      // 40 days before the tick: past the 30-day horizon. MrBeast has only a routine signal this tick, so nothing new arrives for him.
      stale.recentContext = { summary: "A scandal dominated the summer.", notable_events: [{ at: "2026-07-29T12:00:00.000Z", headline: "Dramatic scandal", label: "negative", impact: -3.5, anomaly: "anomalous" }] };
      await memoryStore.saveRecentContext("m", stale.recentContext);
      fakeSummary.mockImplementationOnce(async () => ({ text: "In late July a scandal weighed on him; nothing notable since.", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake-model", stopReason: "end_turn", latencyMs: 1 }));

      const result = await runPostTick(summary, { narrativeStore: createMemoryNarrativeStore(), memoryStore, complete: fakeSummary, deadline: NO_DEADLINE });

      expect(result).toMatchObject({ memoryUpdates: 2, memoryEventsExpired: 1, memoryLlmSummaries: 1, errors: [] });
      const mrbeast = memoryStore.memories.get("m")!;
      expect(mrbeast.recentContext.notable_events).toEqual([]);
      expect(mrbeast.recentContext.summary).toBe("In late July a scandal weighed on him; nothing notable since.");
      expect(mrbeast.recentContext.last_updated_tick).toBe(3);
      // The fold prompt dated everything and named the horizon.
      const request = fakeSummary.mock.calls[0][0];
      expect(request.userPrompt).toContain("Today: 2026-09-07");
      expect(request.userPrompt).toContain("Events older than 30 days are history");
      expect(request.userPrompt).toContain("- 2026-07-29 (40 days ago): Dramatic scandal (negative, impact -3.50)");
      // Drake's fresh event is kept verbatim as before.
      expect(memoryStore.memories.get("d")?.recentContext.notable_events.map((e) => e.headline)).toEqual(["Drake drops surprise album"]);
    });

    it("a person with nothing new and nothing expired is not rewritten", async () => {
      const memoryStore = createMemoryMemoryStore();
      const recent = emptyMemory("m");
      recent.recentContext = { summary: "Busy week.", notable_events: [{ at: "2026-09-05T12:00:00.000Z", headline: "Big collab", label: "positive", impact: 1.4 }], updated_at: "2026-09-05T12:00:00.000Z" };
      await memoryStore.saveRecentContext("m", recent.recentContext);
      const result = await runPostTick(summary, { narrativeStore: createMemoryNarrativeStore(), memoryStore });
      expect(result).toMatchObject({ memoryUpdates: 1, memoryEventsExpired: 0 }); // Drake only
      expect(memoryStore.memories.get("m")?.recentContext.updated_at).toBe("2026-09-05T12:00:00.000Z");
    });
  });
});
