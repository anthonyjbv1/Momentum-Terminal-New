import { describe, expect, it, vi } from "vitest";

import type { LLMResponse } from "@/lib/llm/types";
import { createMemoryUsageLogger } from "@/lib/llm/usage";

import { DEFAULT_ENGINE_CONFIG, withEngineConfig } from "./config";
import { NO_DEADLINE, deadlineAfter } from "./deadline";
import { createMemoryMemoryStore } from "./memory/store";
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
  scoring: { backlogBefore: 2, loaded: 2, selected: 2, attempted: 2, llmScored: 2, fallbacks: 0, withoutModel: 0, deferred: 0, deferredByReason: {}, llmCalls: 2, llmCallBudget: 4, processed: 2, backlogAfter: 0, partial: false, budgetMs: 25_000, remainingMs: 20_000 },
  deferred: [],
  people: [
    { id: "d", slug: "drake", displayName: "Drake", revertTarget: 65, previousScore: 50, newScore: 51.24, change: 1.24, spread: 0.5, buyPrice: 51.74, sellPrice: 50.74, forces: { gravity: 0.04, signals: 1.2 }, signalsProcessed: 1 },
    { id: "m", slug: "mrbeast", displayName: "MrBeast", revertTarget: 68, previousScore: 50, newScore: 50.1, change: 0.1, spread: 0.5, buyPrice: 50.6, sellPrice: 49.6, forces: { gravity: 0.05, signals: 0.05 }, signalsProcessed: 1 },
  ],
  signals: [
    { id: "s1", personSlug: "drake", headline: "Drake drops surprise album", label: "positive", confidence: 0.8, direction: 1, impact: 1.2, scorer: "llm", anomaly: "notable", narrative: "Drake's momentum climbed on a surprise album drop." },
    { id: "s2", personSlug: "mrbeast", headline: "MrBeast uploads a new video on YouTube (901 total)", label: "positive", confidence: 0.1, direction: 1, impact: 0.05, scorer: "llm", anomaly: "routine" },
  ],
};

const fakeSummary = vi.fn<(request: { taskType: string; timeoutMs?: number }) => Promise<LLMResponse>>(async () => ({
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

    expect(result).toEqual({ narratives: 1, memoryUpdates: 1, memoryLlmSummaries: 0, memorySummariesDeferred: 0, errors: [] });
    expect(narrativeStore.rows[0]).toMatchObject({ personId: "d", tickNumber: 3, source: "llm" });
    const drake = memoryStore.memories.get("d")!;
    expect(drake.recentContext.notable_events).toHaveLength(1);
    expect(drake.recentContext.notable_events[0]).toMatchObject({ headline: "Drake drops surprise album", impact: 1.2, anomaly: "notable" });
    expect(drake.recentContext.last_updated_tick).toBe(3);
    expect(memoryStore.memories.has("m")).toBe(false); // routine, low impact: not remembered
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
      expect(memoryStore.memories.get("d")?.recentContext.summary).toContain("Earlier: Drake drops surprise album");
      expect(usageLogger.rows).toHaveLength(0);
    });
  });
});
