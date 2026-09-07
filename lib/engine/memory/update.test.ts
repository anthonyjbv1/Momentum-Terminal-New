import { describe, expect, it, vi } from "vitest";

import type { LLMResponse } from "@/lib/llm/types";

import { emptyMemory, type MemoryNotableEvent } from "./types";
import { deterministicSummary, mergeNotableEvents, refreshRecentContext } from "./update";

function event(headline: string, at: string, impact = 1): MemoryNotableEvent {
  return { at, headline, label: impact >= 0 ? "positive" : "negative", impact };
}

describe("memory updates", () => {
  it("merges newest-first, dedupes by headline and caps the list", () => {
    const context = { summary: "No notable events recorded yet.", notable_events: [event("Old news", "2026-09-01T00:00:00Z")] };
    const merged = mergeNotableEvents(context, [event("New album", "2026-09-07T00:00:00Z"), event("old news", "2026-09-01T00:00:00Z")], { maxEvents: 1, tickNumber: 9 });
    expect(merged.added).toBe(1);
    expect(merged.context.notable_events.map((e) => e.headline)).toEqual(["New album"]);
    expect(merged.overflow.map((e) => e.headline)).toEqual(["Old news"]);
    expect(merged.context.last_updated_tick).toBe(9);
  });

  it("builds a deterministic summary from folded events", () => {
    expect(deterministicSummary("No notable events recorded yet.", [event("Won award", "2026-09-01T00:00:00Z", 1.2)])).toBe("Earlier: Won award (+1.20).");
    expect(deterministicSummary("Busy month.", [event("Lost lawsuit", "2026-09-01T00:00:00Z", -0.9)])).toBe("Busy month. Earlier: Lost lawsuit (-0.90).");
  });

  it("refreshes with the LLM only when events overflow, and falls back to deterministic text on failure", async () => {
    const memory = emptyMemory("p");
    memory.recentContext.notable_events = [event("A", "2026-09-05T00:00:00Z"), event("B", "2026-09-04T00:00:00Z")];

    const llm = vi.fn(async (): Promise<LLMResponse> => ({ text: "Two big weeks: awards and a tour.", usage: { inputTokens: 50, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake", stopReason: "end_turn", latencyMs: 1 }));
    const onUsage = vi.fn();

    const noOverflow = await refreshRecentContext(memory, [event("C", "2026-09-06T00:00:00Z")], { maxEvents: 8, llmSummaries: true, personName: "P" }, { complete: llm, onUsage });
    expect(noOverflow.changed).toBe(true);
    expect(noOverflow.usedLlm).toBe(false);
    expect(llm).not.toHaveBeenCalled();

    const overflow = await refreshRecentContext(memory, [event("C", "2026-09-06T00:00:00Z")], { maxEvents: 2, llmSummaries: true, personName: "P" }, { complete: llm, onUsage });
    expect(overflow.usedLlm).toBe(true);
    expect(overflow.context.summary).toBe("Two big weeks: awards and a tour.");
    expect(overflow.context.notable_events.map((e) => e.headline)).toEqual(["C", "A"]);
    expect(onUsage).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async (): Promise<LLMResponse> => {
      throw new Error("llm down");
    });
    const fallback = await refreshRecentContext(memory, [event("C", "2026-09-06T00:00:00Z")], { maxEvents: 2, llmSummaries: true, personName: "P" }, { complete: failing });
    expect(fallback.usedLlm).toBe(false);
    expect(fallback.context.summary).toBe("Earlier: B (+1.00).");

    const unchanged = await refreshRecentContext(memory, [event("A", "2026-09-05T00:00:00Z")], { maxEvents: 8, llmSummaries: true, personName: "P" }, { complete: llm });
    expect(unchanged.changed).toBe(false);
  });
});
