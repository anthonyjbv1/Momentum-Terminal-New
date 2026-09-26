import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/config";
import { NO_DEADLINE, deadlineAfter } from "@/lib/engine/deadline";
import { createMemoryMemoryStore } from "@/lib/engine/memory/store";
import type { PersonMemory } from "@/lib/engine/memory/types";
import { AnthropicProvider } from "@/lib/llm/providers/anthropic";
import { routedComplete, type RoutedRequest } from "@/lib/llm/routing";
import { LLMError, type LLMResponse } from "@/lib/llm/types";
import { createMemoryUsageLogger } from "@/lib/llm/usage";
import type { Json } from "@/types/database";

import { TickCallBudget } from "./budget";
import { CALL_OVERHEAD_MS, LLMScorer, type LLMScorerPerson } from "./llm";
import { SENTIMENT_SYSTEM_PROMPT, SENTIMENT_SYSTEM_PROMPT_V2 } from "./prompts";
import { isDeferred, type ScoringContext, type ScoringOutcome, type SentimentInput, type SentimentResult } from "./types";

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

/** A scored outcome, or the test fails: the signal was attempted. */
function scored(outcome: ScoringOutcome): SentimentResult {
  if (isDeferred(outcome)) throw new Error(`expected a scored signal, got a deferral: ${outcome.reason} (${outcome.detail})`);
  return outcome;
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

/** A tick's context: a deadline and a fresh budget. */
function tickContext(budget = DEFAULT_ENGINE_CONFIG.llm.callBudgetPerTick, deadline = NO_DEADLINE): ScoringContext {
  return { deadline, callBudget: new TickCallBudget(budget) };
}

describe("LLMScorer", () => {
  it("batches a tick's signals into one LLM call per person, with that person's memory in the prompt", async () => {
    const complete = fakeComplete();
    const { scorer, memoryStore, usageLogger } = makeScorer(complete);

    const results = (
      await Promise.all([
        scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album")),
        scorer.scoreSignal(signal("s2", "p-drake", "Drake announces world tour")),
        scorer.scoreSignal(signal("s3", "p-buffett", "Berkshire sells Apple stake")),
      ])
    ).map(scored);

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

    const baseline = scored(await scorer.scoreSignal(signal("b1", "p-mrbeast", "MrBeast stands at 516M subscribers on YouTube", { kind: "baseline" })));
    const tiny = scored(await scorer.scoreSignal(signal("c1", "p-mrbeast", "MrBeast gains 100K YouTube subscribers (+0.02%) since last check", { kind: "change", relativeChange: 0.0002 })));

    expect(complete).not.toHaveBeenCalled();
    expect(baseline).toMatchObject({ label: "neutral", direction: 0, confidence: 0, scorer: "prefilter" });
    expect(tiny.scorer).toBe("rules");
    expect(tiny.rationale).toContain("below LLM threshold");
    expect(scorer.stats.prefiltered).toBe(2);
  });

  it("folds the anomaly assessment into confidence", async () => {
    const complete = fakeComplete((id) => (id === "r" ? { anomaly: "routine" } : id === "a" ? { anomaly: "anomalous" } : { label: "neutral", anomaly: "routine" }));
    const { scorer } = makeScorer(complete);
    const [routine, anomalous, neutral] = (
      await Promise.all([
        scorer.scoreSignal(signal("r", "p-drake", "Drake posts weekly stats")),
        scorer.scoreSignal(signal("a", "p-drake", "Drake retires from music")),
        scorer.scoreSignal(signal("n", "p-drake", "Drake seen at a game")),
      ])
    ).map(scored);
    expect(routine.confidence).toBeCloseTo(0.45); // 0.9 * 0.5
    expect(anomalous.confidence).toBe(1); // 0.9 * 1.2 capped
    expect(neutral).toMatchObject({ label: "neutral", direction: 0, confidence: 0 });
  });

  it("falls back to the rules scorer when the provider fails, without failing the caller", async () => {
    const complete = vi.fn(async () => {
      throw new LLMError("boom", { kind: "timeout", provider: "fake", retryable: true });
    });
    const { scorer, log, usageLogger } = makeScorer(complete as unknown as ReturnType<typeof fakeComplete>);

    const result = scored(await scorer.scoreSignal(signal("s1", "p-drake", "Drake crosses 100M monthly listeners on Spotify")));
    expect(result).toMatchObject({ label: "positive", direction: 1, confidence: 0.8, scorer: "rules-fallback" });
    expect(result.rationale).toContain("fallback: LLM call failed (timeout: boom)");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("falling back to the rules scorer"), expect.anything());
    expect(scorer.stats.fallbacks).toBe(1);
    // The attempt is on the ledger as failed, with the reason: it was billed and previously invisible.
    expect(usageLogger.rows).toEqual([expect.objectContaining({ taskType: "sentiment", personId: "p-drake", status: "failed", error: "timeout: boom" })]);
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
    expect(scored(await a.scoreSignal(signal("s1", "p-drake", "Drake wins award"))).scorer).toBe("rules-fallback");

    const partial = fakeComplete();
    const { scorer: b } = makeScorer(partial);
    // The fake answers only ids it sees; hide one id from the prompt by making the model omit it.
    partial.mockImplementationOnce(async (request: { userPrompt: string }) => {
      const signals = [{ id: "s1", label: "positive", confidence: 0.7, direction: 1, anomaly: "notable", rationale: "x" }];
      void request;
      return { text: "", structuredData: { signals, narrative: "n" }, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake", stopReason: "end_turn", latencyMs: 1 };
    });
    const [kept, dropped] = (
      await Promise.all([b.scoreSignal(signal("s1", "p-drake", "Drake wins award")), b.scoreSignal(signal("s2", "p-drake", "Drake loses lawsuit"))])
    ).map(scored);
    expect(kept.scorer).toBe("llm");
    expect(dropped.scorer).toBe("rules-fallback");
    expect(dropped.label).toBe("negative");
  });

  it("writes the ledger in two halves: a started row before the call, settled with usage after it", async () => {
    const complete = fakeComplete();
    const { scorer, usageLogger } = makeScorer(complete);
    await scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album"), tickContext());
    expect(usageLogger.rows).toHaveLength(1);
    expect(usageLogger.rows[0]).toMatchObject({ status: "completed", taskType: "sentiment", personId: "p-drake", model: "fake-model", inputTokens: 900, outputTokens: 120 });
  });
});

describe("LLMScorer — the two outcomes", () => {
  it("DEFERS chunks beyond the per-tick call budget instead of scoring them by rules: they stay unprocessed", async () => {
    const complete = fakeComplete();
    const { scorer, usageLogger } = makeScorer(complete);
    const context = tickContext(1);

    const outcomes = await Promise.all([
      scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album"), context),
      scorer.scoreSignal(signal("s2", "p-buffett", "Berkshire sells Apple stake"), context),
      scorer.scoreSignal(signal("s3", "p-mrbeast", "MrBeast crosses 600M subscribers"), context),
    ]);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => !isDeferred(o) && o.scorer === "llm")).toHaveLength(1);
    const deferred = outcomes.filter(isDeferred);
    expect(deferred).toHaveLength(2);
    expect(deferred.every((d) => d.reason === "call_budget")).toBe(true);
    expect(deferred[0].detail).toContain("per-tick call budget of 1 spent");
    // Nothing was scored by rules: a deferral is not a fallback.
    expect(outcomes.some((o) => !isDeferred(o) && o.scorer === "rules-fallback")).toBe(false);
    expect(scorer.stats).toMatchObject({ llmCalls: 1, deferred: 2, fallbacks: 0 });
    expect(context.callBudget.used).toBe(1);
    // A deferred chunk never touches the ledger: no money was spent on it.
    expect(usageLogger.rows).toHaveLength(1);
  });

  it("the budget is a per-tick COUNT: a new context is a new budget, whatever the clock says", async () => {
    const complete = fakeComplete();
    const { scorer } = makeScorer(complete);
    const first = await scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album"), tickContext(1));
    const second = await scorer.scoreSignal(signal("s2", "p-drake", "Drake announces world tour"), tickContext(1));
    expect(isDeferred(first)).toBe(false);
    expect(isDeferred(second)).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("ONE CHUNK PER PERSON PER TICK: a person's second chunk is deferred even with budget to spare", async () => {
    const complete = fakeComplete();
    const { scorer } = makeScorer(complete);
    const context = tickContext(20);
    const outcomes = await Promise.all(Array.from({ length: 30 }, (_, i) => scorer.scoreSignal(signal(`mb-${i}`, "p-mrbeast", `MrBeast headline ${i}`), context)));

    expect(complete).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => !isDeferred(o))).toHaveLength(DEFAULT_ENGINE_CONFIG.llm.maxSignalsPerCall);
    const deferred = outcomes.filter(isDeferred);
    expect(deferred).toHaveLength(30 - DEFAULT_ENGINE_CONFIG.llm.maxSignalsPerCall);
    expect(deferred.every((d) => d.reason === "person_cap")).toBe(true);
    expect(context.callBudget.used).toBe(1);
  });

  it("NO CHUNK STARTS AFTER deadline − (timeoutMs + overhead): later chunks are deferred, never aborted", async () => {
    const c = { now: 1_000_000 };
    const complete = fakeComplete();
    // Each call takes five seconds of the fake clock.
    complete.mockImplementation(async (request: { userPrompt: string }) => {
      c.now += 5_000;
      const ids = [...request.userPrompt.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
      const signals = ids.map((id) => ({ id, label: "positive", confidence: 0.9, direction: 1, anomaly: "notable", rationale: "r" }));
      return { text: "", structuredData: { signals }, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake", stopReason: "end_turn", latencyMs: 1 };
    });
    const timeoutMs = 15_000;
    const { scorer, log } = makeScorer(complete, { config: { ...DEFAULT_ENGINE_CONFIG.llm, timeoutMs, maxConcurrentCalls: 1 }, now: () => c.now });
    // 25 s of budget: a 15 s call (+1 s overhead) may start until t = 9 s.
    const context = tickContext(10, deadlineAfter(25_000, () => c.now));

    const outcomes = await Promise.all([
      scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album"), context), // starts at t=0, ends t=5
      scorer.scoreSignal(signal("s2", "p-buffett", "Berkshire sells Apple stake"), context), // starts at t=5, ends t=10
      scorer.scoreSignal(signal("s3", "p-mrbeast", "MrBeast crosses 600M subscribers"), context), // t=10: 10 + 16 > 25, deferred
    ]);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(isDeferred(outcomes[0])).toBe(false);
    expect(isDeferred(outcomes[1])).toBe(false);
    expect(outcomes[2]).toMatchObject({ deferred: true, reason: "deadline" });
    expect((outcomes[2] as { detail: string }).detail).toContain(`a call may take ${(timeoutMs + CALL_OVERHEAD_MS) / 1000}s`);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("deferring 1 signal(s) to a later tick: deadline"), expect.objectContaining({ reason: "deadline" }));
    // The budget was not touched by the deferred chunk.
    expect(context.callBudget.used).toBe(2);
  });

  it("an expired deadline defers everything before a single call is made", async () => {
    const complete = fakeComplete();
    const { scorer, usageLogger } = makeScorer(complete);
    const context = tickContext(4, deadlineAfter(0));
    const outcomes = await Promise.all([
      scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album"), context),
      scorer.scoreSignal(signal("s2", "p-buffett", "Berkshire sells Apple stake"), context),
    ]);
    expect(complete).not.toHaveBeenCalled();
    expect(outcomes.every((o) => isDeferred(o) && o.reason === "deadline")).toBe(true);
    expect(usageLogger.rows).toHaveLength(0);
  });

  it("FAILED and DEFERRED are different outcomes: a failed attempt is a rules score, a deferral is not a score at all", async () => {
    const complete = vi.fn(async () => {
      throw new LLMError("upstream 500", { kind: "server", provider: "fake", retryable: true });
    });
    const { scorer } = makeScorer(complete as unknown as ReturnType<typeof fakeComplete>);
    const context = tickContext(1);
    const [failed, deferred] = await Promise.all([
      scorer.scoreSignal(signal("s1", "p-drake", "Drake crosses 100M monthly listeners on Spotify"), context),
      scorer.scoreSignal(signal("s2", "p-buffett", "Berkshire sells Apple stake"), context),
    ]);
    expect(isDeferred(failed)).toBe(false);
    expect(scored(failed)).toMatchObject({ scorer: "rules-fallback", label: "positive" });
    expect(deferred).toMatchObject({ deferred: true, reason: "call_budget" });
    expect(scorer.stats).toMatchObject({ fallbacks: 1, deferred: 1 });
  });

  it("THE TIMEOUT THAT REACHES THE REQUEST: config.llm.timeoutMs (15 s) is the per-request timeout the SDK call gets, one attempt", async () => {
    // The whole path, no mocks between the pieces: LLMScorer → routedComplete
    // → AnthropicProvider.complete → client.messages.create(params, options).
    // The provider's 30 s client default is what a request WITHOUT its own
    // timeout would get; the scorer always passes its own.
    const create = vi.fn<(params: { model: string; messages: Array<{ content: string }> }, options?: { timeout?: number }) => Promise<unknown>>(async (params) => {
      const ids = [...params.messages[0].content.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
      const signals = ids.map((id) => ({ id, label: "positive", confidence: 0.7, direction: 1, anomaly: "notable", rationale: "r" }));
      return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: JSON.stringify({ signals, narrative: "n" }), citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    });
    const provider = new AnthropicProvider({ apiKey: "test-key", client: { messages: { create } } as unknown as Pick<Anthropic, "messages"> });
    const complete = ((request: RoutedRequest) => routedComplete(request, { getProvider: () => provider })) as unknown as ReturnType<typeof fakeComplete>;
    const { scorer, usageLogger } = makeScorer(complete);

    const outcome = await scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album"), tickContext());

    expect(scored(outcome)).toMatchObject({ scorer: "llm", label: "positive" });
    expect(create).toHaveBeenCalledTimes(1);
    const [, options] = create.mock.calls[0];
    expect(options).toEqual({ timeout: 15_000 });
    expect(options).toEqual({ timeout: DEFAULT_ENGINE_CONFIG.llm.timeoutMs });
    expect(provider.settings).toEqual({ timeoutMs: 30_000, maxRetries: 0 });
    expect(usageLogger.rows).toEqual([expect.objectContaining({ status: "completed", provider: "anthropic", model: "claude-opus-5" })]);
  });

  it("the rolling rate limit is a separate, process-wide safety net, and hitting it also defers", async () => {
    const complete = fakeComplete();
    const { scorer } = makeScorer(complete, { config: { ...DEFAULT_ENGINE_CONFIG.llm, rollingWindowMaxCalls: 1 } });
    const context = tickContext(4);
    const outcomes = await Promise.all([
      scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album"), context),
      scorer.scoreSignal(signal("s2", "p-buffett", "Berkshire sells Apple stake"), context),
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(outcomes.filter(isDeferred)).toEqual([expect.objectContaining({ reason: "rate_limit" })]);
  });
});

// ---------------------------------------------------------------------------
// Phase 31: prompt version 2
// ---------------------------------------------------------------------------

describe("prompt version 2 (Phase 31)", () => {
  function answering(salienceFor: (id: string) => string | undefined, direction: string | undefined = "up") {
    const prompts: string[] = [];
    const fn = vi.fn(async (request: RoutedRequest): Promise<LLMResponse> => {
      prompts.push(request.userPrompt);
      const ids = [...request.userPrompt.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
      const signals = ids.map((id) => {
        const salience = salienceFor(id);
        return { id, label: "positive", confidence: 0.9, direction: 1, anomaly: "notable", rationale: `about ${id}`, ...(salience ? { salience } : {}) };
      });
      const data = { signals, narrative: "Drake released a surprise album, his first in two years.", ...(direction ? { narrative_direction: direction } : {}) };
      return { text: JSON.stringify(data), structuredData: data, usage: { inputTokens: 900, outputTokens: 120, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake-model", stopReason: "end_turn", latencyMs: 3 };
    });
    return Object.assign(fn, { prompts });
  }

  it("asks with the version-2 prompt and schema and reads salience and the note's direction; version 1 asks as before and reads neither", async () => {
    const complete = answering((id) => (id === "s2" ? "incidental" : id === "s3" ? "unrelated" : "relevant"));
    const { scorer } = makeScorer(complete, { promptVersion: 2 });
    expect(scorer.promptVersion).toBe(2);
    const [a, b, c] = (await Promise.all([scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album")), scorer.scoreSignal(signal("s2", "p-drake", "Drake among guests at gala")), scorer.scoreSignal(signal("s3", "p-drake", "Drake University wins"))])).map(scored);
    const request = complete.mock.calls[0][0];
    expect(request.systemPrompt).toBe(SENTIMENT_SYSTEM_PROMPT_V2);
    expect(request.responseFormat).toMatchObject({ type: "json", name: "sentiment_assessment_v2" });
    expect([a.salience, b.salience, c.salience]).toEqual(["relevant", "incidental", "unrelated"]);
    expect(a.narrativeDirection).toBe("up");
    // The label and confidence are untouched by salience: the force multiplies later, and only while the switch is on.
    expect(a).toMatchObject({ label: "positive", direction: 1, confidence: 0.9 });
    expect(c).toMatchObject({ label: "positive", direction: 1, confidence: 0.9 });

    const v1 = makeScorer(complete);
    expect(v1.scorer.promptVersion).toBe(1);
    const d = scored(await v1.scorer.scoreSignal(signal("s4", "p-drake", "Drake drops surprise album")));
    expect(complete.mock.calls[1][0].systemPrompt).toBe(SENTIMENT_SYSTEM_PROMPT);
    expect(complete.mock.calls[1][0].responseFormat).toMatchObject({ name: "sentiment_assessment" });
    expect(d.salience).toBeUndefined();
    expect(d.narrativeDirection).toBeUndefined();
  });

  it("a version-2 answer that leaves salience out reads as relevant, and an unknown direction is dropped: the absence of a label never zeroes a signal", async () => {
    const complete = answering(() => undefined, "sideways");
    const { scorer } = makeScorer(complete, { promptVersion: 2 });
    const result = scored(await scorer.scoreSignal(signal("s1", "p-drake", "Drake drops surprise album")));
    expect(result.salience).toBe("relevant");
    expect(result.narrativeDirection).toBeUndefined();
  });
});
