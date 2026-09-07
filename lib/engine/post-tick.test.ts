import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
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
  people: [
    { id: "d", slug: "drake", displayName: "Drake", revertTarget: 65, previousScore: 50, newScore: 51.24, change: 1.24, spread: 0.5, buyPrice: 51.74, sellPrice: 50.74, forces: { gravity: 0.04, signals: 1.2 }, signalsProcessed: 1 },
    { id: "m", slug: "mrbeast", displayName: "MrBeast", revertTarget: 68, previousScore: 50, newScore: 50.1, change: 0.1, spread: 0.5, buyPrice: 50.6, sellPrice: 49.6, forces: { gravity: 0.05, signals: 0.05 }, signalsProcessed: 1 },
  ],
  signals: [
    { id: "s1", personSlug: "drake", headline: "Drake drops surprise album", label: "positive", confidence: 0.8, direction: 1, impact: 1.2, scorer: "llm", anomaly: "notable", narrative: "Drake's momentum climbed on a surprise album drop." },
    { id: "s2", personSlug: "mrbeast", headline: "MrBeast uploads a new video on YouTube (901 total)", label: "positive", confidence: 0.1, direction: 1, impact: 0.05, scorer: "llm", anomaly: "routine" },
  ],
};

describe("runPostTick", () => {
  it("writes narratives for meaningful moves and remembers notable signals", async () => {
    const narrativeStore = createMemoryNarrativeStore();
    const memoryStore = createMemoryMemoryStore();

    const result = await runPostTick(summary, { narrativeStore, memoryStore, config: DEFAULT_ENGINE_CONFIG });

    expect(result).toEqual({ narratives: 1, memoryUpdates: 1, memoryLlmSummaries: 0, errors: [] });
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
});
