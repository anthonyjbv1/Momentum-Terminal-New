import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/config";
import { createMemoryMemoryStore } from "@/lib/engine/memory/store";
import type { PersonMemory } from "@/lib/engine/memory/types";
import { LLMError, type LLMResponse } from "@/lib/llm/types";
import { createMemoryUsageLogger } from "@/lib/llm/usage";
import type { Json } from "@/types/database";

import { LLMScorer, type LLMScorerPerson } from "./llm";
import type { SentimentInput } from "./types";

const PEOPLE: Record<string, LLMScorerPerson> = {
  "p-drake": { id: "p-drake", slug: "drake", displayName: "Drake", category: "musician" },
  "p-mrbeast": { id: "p-mrbeast", slug: "mrbeast", displayName: "MrBeast", category: "creator" },
  "p-buffett": { id: "p-buffett", slug: "warren-buffett", displayName: "Warren Buffett", category: "executive" },
};

function memory(personId: string, summary: string, noise: string): PersonMemory {
  return {
    personId,
    profile: { role: "musician", summary, momentum_drivers: ["releases"], context: "ctx" },
    baselinePatterns: { typical_signal_volume: "high", typical_change_magnitude: "moderate", routine: ["weekly stats"], notable: ["releases"], noise_note: noise },
    recentContext: { summary: "Quiet lately.", notable_events: [] },
    updatedAt: null,
  };
}

function signal(id: string, personId: string, headline: string, rawPayload: Json | null = null): SentimentInput {
  return { id, headline, rawPayload, personId, sourceName: "spotify", sourceTier: 2 };
}

type Assessment = { label?: string; confidence?: number; anomaly?: string };

/** Fake completion: answers for every id it finds in the prompt. */
function fakeComplete(assess: (id: string) => Assessment = () => ({}), narrative = "Momentum shifted on fresh news.") {
  const prompts: string[] = [];
  const fn = vi.fn(async (request: { userPrompt: string }): Promise<LLMResponse> => {
    prompts.push(request.userPrompt);
    const ids = [...request.userPrompt.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
    const signals = ids.map((id) => ({ id, label: "positive", confidence: 0.9, direction: 1, anomaly: "notable", rationale: `about ${id}`, ...assess(id) }));
    return {
      text: JSON.stringify({ signals, narrative }),
      structuredData: { signals, narrative },
      usage: { inputTokens: 900, outputTokens: 120, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      provider: "fake",
      model: "fake-model",
      stopReason: "end_turn",
      latencyMs: 3,
    };
  });
  return Object.assign(fn, { prompts });
}

function makeScorer(complete: ReturnType<typeof fakeComplete>, overrides: Partial<ConstructorParameters<typeof LLMScorer>[0]> = {}) {
  const memoryStore = createMemoryMemoryStore([
    memory("p-drake", "Rapper and singer.", "Weekly streaming drift is noise; releases are signal."),
    memory("p-buffett", "Chairman of Berkshire Hathaway.", "A 2% net worth move is notable for Buffett."),
  ]);
  const usageLogger = createMemoryUsageLogger();
  const log = vi.fn();
  const scorer = new LLMScorer({
    complete,
    memoryStore,
    usageLogger,
    resolvePerson: async (id) => PEOPLE[id] ?? null,
    config: { ...DEFAULT_ENGINE_CONFIG.llm, ...(overrides.config ?? {}) },
    log,
    batchDelayMs: 0,
    ...overrides,
  });
  return { scorer, memoryStore, usageLogger, log };
}

describe("LLMScorer", () => {
  it("batches a tick's signals into one LLM call per person, with that person's memory in the prompt", async () => {
    const complete = fakeComplete();
    const { scorer, memoryStore, usageLogger } = makeScorer(complete);

    const results = await Promise.all([
      scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album")),
      scorer.scoreSignal(signal("s2", "p-drake", "Drake announces world tour")),
      scorer.scoreSignal(signal("s3", "p-buffett", "Berkshire sells Apple stake")),
    ]);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(memoryStore.loadCalls).toBe(1);
    expect(results.map((r) => r.scorer)).toEqual(["llm", "llm", "llm"]);
    expect(results[0]).toMatchObject({ label: "positive", direction: 1, confidence: 0.9, anomaly: "notable", rationale: "about s1", narrative: "Momentum shifted on fresh news." });

    const drakePrompt = complete.prompts.find((p) => p.includes("Name: Drake"))!;
    expect(drakePrompt).toContain("Rapper and singer.");
    expect(drakePrompt).toContain("Weekly streaming drift is noise");
    expect(drakePrompt).toContain("id=s1");
    expect(drakePrompt).toContain("id=s2");
    expect(drakePrompt).not.toContain("id=s3");
    const buffettPrompt = complete.prompts.find((p) => p.includes("Name: Warren Buffett"))!;
    expect(buffettPrompt).toContain("A 2% net worth move is notable for Buffett.");

    expect(usageLogger.entries).toHaveLength(2);
    expect(usageLogger.entries[0]).toMatchObject({ provider: "fake", model: "fake-model", taskType: "sentiment", inputTokens: 900, outputTokens: 120 });
    expect(usageLogger.entries.map((e) => e.personId).sort()).toEqual(["p-buffett", "p-drake"]);
  });

  it("never sends baseline or tiny-change signals to the LLM", async () => {
    const complete = fakeComplete();
    const { scorer } = makeScorer(complete);

    const baseline = await scorer.scoreSignal(signal("b1", "p-mrbeast", "MrBeast stands at 516M subscribers on YouTube", { kind: "baseline" }));
    const tiny = await scorer.scoreSignal(signal("c1", "p-mrbeast", "MrBeast gains 100K YouTube subscribers (+0.02%) since last check", { kind: "change", relativeChange: 0.0002 }));

    expect(complete).not.toHaveBeenCalled();
    expect(baseline).toMatchObject({ label: "neutral", direction: 0, confidence: 0, scorer: "prefilter" });
    expect(tiny.scorer).toBe("rules");
    expect(tiny.rationale).toContain("below LLM threshold");
    expect(scorer.stats.prefiltered).toBe(2);
  });

  it("folds the anomaly assessment into confidence", async () => {
    const complete = fakeComplete((id) => (id === "r" ? { anomaly: "routine" } : id === "a" ? { anomaly: "anomalous" } : { label: "neutral", anomaly: "routine" }));
    const { scorer } = makeScorer(complete);
    const [routine, anomalous, neutral] = await Promise.all([
      scorer.scoreSignal(signal("r", "p-drake", "Drake posts weekly stats")),
      scorer.scoreSignal(signal("a", "p-drake", "Drake retires from music")),
      scorer.scoreSignal(signal("n", "p-drake", "Drake seen at a game")),
    ]);
    expect(routine.confidence).toBeCloseTo(0.45); // 0.9 * 0.5
    expect(anomalous.confidence).toBe(1); // 0.9 * 1.2 capped
    expect(neutral).toMatchObject({ label: "neutral", direction: 0, confidence: 0 });
  });

  it("falls back to the rules scorer when the provider fails, without failing the caller", async () => {
    const complete = vi.fn(async () => {
      throw new LLMError("boom", { kind: "timeout", provider: "fake", retryable: true });
    });
    const { scorer, log } = makeScorer(complete as unknown as ReturnType<typeof fakeComplete>);

    const result = await scorer.scoreSignal(signal("s1", "p-drake", "Drake crosses 100M monthly listeners on Spotify"));
    expect(result).toMatchObject({ label: "positive", direction: 1, confidence: 0.8, scorer: "rules-fallback" });
    expect(result.rationale).toContain("fallback: LLM call failed (timeout: boom)");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("falling back to the rules scorer"), expect.anything());
    expect(scorer.stats.fallbacks).toBe(1);
  });

  it("enforces the per-tick call cap and routes the overflow to the rules scorer", async () => {
    const complete = fakeComplete();
    const { scorer } = makeScorer(complete, { config: { ...DEFAULT_ENGINE_CONFIG.llm, maxCallsPerTick: 1 } });

    const results = await Promise.all([
      scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album")),
      scorer.scoreSignal(signal("s2", "p-buffett", "Berkshire sells Apple stake")),
      scorer.scoreSignal(signal("s3", "p-mrbeast", "MrBeast crosses 600M subscribers")),
    ]);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.scorer === "llm")).toHaveLength(1);
    expect(results.filter((r) => r.scorer === "rules-fallback")).toHaveLength(2);
    expect(scorer.stats.capped).toBe(2);
  });

  it("falls back for malformed responses and for signals the model left out", async () => {
    const malformed = vi.fn(async (): Promise<LLMResponse> => ({
      text: "{}",
      structuredData: { nope: true },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      provider: "fake",
      model: "fake",
      stopReason: "end_turn",
      latencyMs: 1,
    }));
    const { scorer: a } = makeScorer(malformed as unknown as ReturnType<typeof fakeComplete>);
    expect((await a.scoreSignal(signal("s1", "p-drake", "Drake wins award"))).scorer).toBe("rules-fallback");

    const partial = fakeComplete();
    const { scorer: b } = makeScorer(partial);
    // The fake answers only ids it sees; hide one id from the prompt by making the model omit it.
    partial.mockImplementationOnce(async (request: { userPrompt: string }) => {
      const signals = [{ id: "s1", label: "positive", confidence: 0.7, direction: 1, anomaly: "notable", rationale: "x" }];
      void request;
      return { text: "", structuredData: { signals, narrative: "n" }, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake", stopReason: "end_turn", latencyMs: 1 };
    });
    const [kept, dropped] = await Promise.all([
      b.scoreSignal(signal("s1", "p-drake", "Drake wins award")),
      b.scoreSignal(signal("s2", "p-drake", "Drake loses lawsuit")),
    ]);
    expect(kept.scorer).toBe("llm");
    expect(dropped.scorer).toBe("rules-fallback");
    expect(dropped.label).toBe("negative");
  });
});
