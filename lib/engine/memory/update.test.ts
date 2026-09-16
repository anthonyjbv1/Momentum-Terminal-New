import { describe, expect, it, vi } from "vitest";

import type { LLMResponse } from "@/lib/llm/types";

import { emptyMemory, type MemoryNotableEvent } from "./types";
import { MEMORY_SYSTEM_PROMPT, deterministicSummary, isExpiredEvent, mergeNotableEvents, refreshRecentContext } from "./update";

function event(headline: string, at: string, impact = 1): MemoryNotableEvent {
  return { at, headline, label: impact >= 0 ? "positive" : "negative", impact };
}

const TODAY = new Date("2026-09-16T12:00:00.000Z");

describe("memory updates", () => {
  it("merges newest-first, dedupes by headline and caps the list", () => {
    const context = { summary: "No notable events recorded yet.", notable_events: [event("Old news", "2026-09-01T00:00:00Z")] };
    const merged = mergeNotableEvents(context, [event("New album", "2026-09-07T00:00:00Z"), event("old news", "2026-09-01T00:00:00Z")], { maxEvents: 1, tickNumber: 9, now: TODAY });
    expect(merged.added).toBe(1);
    expect(merged.context.notable_events.map((e) => e.headline)).toEqual(["New album"]);
    expect(merged.overflow.map((e) => e.headline)).toEqual(["Old news"]);
    expect(merged.expired).toBe(0);
    expect(merged.context.last_updated_tick).toBe(9);
  });

  it("builds a deterministic summary from folded events, dated", () => {
    expect(deterministicSummary("No notable events recorded yet.", [event("Won award", "2026-09-01T00:00:00Z", 1.2)])).toBe("Earlier: Won award (2026-09-01, +1.20).");
    expect(deterministicSummary("Busy month.", [event("Lost lawsuit", "2026-09-01T00:00:00Z", -0.9)])).toBe("Busy month. Earlier: Lost lawsuit (2026-09-01, -0.90).");
  });

  it("refreshes with the LLM only when events overflow, and falls back to deterministic text on failure", async () => {
    const memory = emptyMemory("p");
    memory.recentContext.notable_events = [event("A", "2026-09-05T00:00:00Z"), event("B", "2026-09-04T00:00:00Z")];

    const llm = vi.fn(async (): Promise<LLMResponse> => ({ text: "Two big weeks: awards and a tour.", usage: { inputTokens: 50, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake", stopReason: "end_turn", latencyMs: 1 }));
    const onUsage = vi.fn();

    const noOverflow = await refreshRecentContext(memory, [event("C", "2026-09-06T00:00:00Z")], { maxEvents: 8, llmSummaries: true, personName: "P", now: TODAY }, { complete: llm, onUsage });
    expect(noOverflow.changed).toBe(true);
    expect(noOverflow.usedLlm).toBe(false);
    expect(llm).not.toHaveBeenCalled();

    const overflow = await refreshRecentContext(memory, [event("C", "2026-09-06T00:00:00Z")], { maxEvents: 2, llmSummaries: true, personName: "P", now: TODAY }, { complete: llm, onUsage });
    expect(overflow.usedLlm).toBe(true);
    expect(overflow.context.summary).toBe("Two big weeks: awards and a tour.");
    expect(overflow.context.notable_events.map((e) => e.headline)).toEqual(["C", "A"]);
    expect(onUsage).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async (): Promise<LLMResponse> => {
      throw new Error("llm down");
    });
    const fallback = await refreshRecentContext(memory, [event("C", "2026-09-06T00:00:00Z")], { maxEvents: 2, llmSummaries: true, personName: "P", now: TODAY }, { complete: failing });
    expect(fallback.usedLlm).toBe(false);
    expect(fallback.context.summary).toBe("Earlier: B (2026-09-04, +1.00).");

    const unchanged = await refreshRecentContext(memory, [event("A", "2026-09-05T00:00:00Z")], { maxEvents: 8, llmSummaries: true, personName: "P", now: TODAY }, { complete: llm });
    expect(unchanged.changed).toBe(false);
  });
});

describe("memory event expiry (Phase 12+)", () => {
  const maxEventAgeDays = 30;

  it("drops an event older than maxEventAgeDays whatever the count, and folds it into the summary with its date", () => {
    const context = {
      summary: "No notable events recorded yet.",
      notable_events: [event("Fresh win", "2026-09-10T00:00:00Z", 1.1), event("Dramatic scandal", "2026-06-12T00:00:00Z", -3.5)],
    };
    const merged = mergeNotableEvents(context, [], { maxEvents: 8, maxEventAgeDays, now: TODAY });
    expect(merged.added).toBe(0);
    expect(merged.expired).toBe(1);
    expect(merged.context.notable_events.map((e) => e.headline)).toEqual(["Fresh win"]);
    expect(merged.overflow.map((e) => e.headline)).toEqual(["Dramatic scandal"]);
    expect(deterministicSummary(context.summary, merged.overflow)).toBe("Earlier: Dramatic scandal (2026-06-12, -3.50).");
    // The boundary: 30 days exactly is kept, a minute past it is not; an undated event never expires by age.
    expect(isExpiredEvent(event("x", new Date(TODAY.getTime() - 30 * 86_400_000).toISOString()), TODAY, maxEventAgeDays)).toBe(false);
    expect(isExpiredEvent(event("x", new Date(TODAY.getTime() - 30 * 86_400_000 - 60_000).toISOString()), TODAY, maxEventAgeDays)).toBe(true);
    expect(isExpiredEvent(event("x", "not a date"), TODAY, maxEventAgeDays)).toBe(false);
    expect(isExpiredEvent(event("x", "2020-01-01T00:00:00Z"), TODAY, undefined)).toBe(false);
  });

  it("a refresh with nothing new still expires and folds, so a quiet person's memory ages", async () => {
    const memory = emptyMemory("p");
    memory.recentContext = { summary: "A scandal dominated the spring.", notable_events: [event("Dramatic scandal", "2026-06-12T12:00:00Z", -3.5)] };
    const llm = vi.fn(async (request: { systemPrompt: string; userPrompt: string }): Promise<LLMResponse> => {
      void request;
      return { text: "In June a scandal weighed on him; nothing notable since.", usage: { inputTokens: 50, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake", stopReason: "end_turn", latencyMs: 1 };
    });

    const refreshed = await refreshRecentContext(memory, [], { maxEvents: 8, maxEventAgeDays, llmSummaries: true, personName: "P", now: TODAY, tickNumber: 4 }, { complete: llm });

    expect(refreshed).toMatchObject({ changed: true, usedLlm: true, expired: 1 });
    expect(refreshed.context.notable_events).toEqual([]);
    expect(refreshed.context.summary).toBe("In June a scandal weighed on him; nothing notable since.");
    // The fold prompt carries today's date, the horizon, and the event with its date and age, and asks for history.
    const request = llm.mock.calls[0][0];
    expect(request.systemPrompt).toBe(MEMORY_SYSTEM_PROMPT);
    expect(request.systemPrompt).toContain("HISTORY");
    expect(request.userPrompt).toContain("Today: 2026-09-16");
    expect(request.userPrompt).toContain("Events older than 30 days are history");
    expect(request.userPrompt).toContain("- 2026-06-12 (96 days ago): Dramatic scandal (negative, impact -3.50)");
  });

  it("a person whose every event has expired still has a valid context: empty list, dated history in the summary", async () => {
    const memory = emptyMemory("p");
    memory.recentContext = { summary: "No notable events recorded yet.", notable_events: [event("Old A", "2026-05-01T00:00:00Z", 2), event("Old B", "2026-04-01T00:00:00Z", -1)] };
    const refreshed = await refreshRecentContext(memory, [], { maxEvents: 8, maxEventAgeDays, llmSummaries: false, personName: "P", now: TODAY });
    expect(refreshed.expired).toBe(2);
    expect(refreshed.context.notable_events).toEqual([]);
    expect(refreshed.context.summary).toBe("Earlier: Old A (2026-05-01, +2.00); Old B (2026-04-01, -1.00).");
    // And a memory with nothing at all stays untouched rather than churning.
    const untouched = await refreshRecentContext(emptyMemory("q"), [], { maxEvents: 8, maxEventAgeDays, llmSummaries: false, personName: "Q", now: TODAY });
    expect(untouched.changed).toBe(false);
  });
});
