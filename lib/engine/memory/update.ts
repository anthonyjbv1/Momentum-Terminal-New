import type { LLMResponse } from "@/lib/llm/types";
import type { RoutedRequest } from "@/lib/llm/routing";

import type { MemoryNotableEvent, MemoryRecentContext, PersonMemory } from "./types";

/**
 * Cheap, evolving memory. After a tick, notable signals are merged into the
 * person's recent_context: the newest events are kept verbatim (capped), and
 * events that fall off the end are folded into a short prose summary — by the
 * LLM when enabled (one small call), otherwise deterministically. Raw logs are
 * never accumulated.
 */

export interface MergeOptions {
  maxEvents: number;
  tickNumber?: number;
  now?: Date;
}

export interface MergeResult {
  context: MemoryRecentContext;
  /** Events that no longer fit and should be folded into the summary. */
  overflow: MemoryNotableEvent[];
  added: number;
}

function sameEvent(a: MemoryNotableEvent, b: MemoryNotableEvent): boolean {
  return a.headline.trim().toLowerCase() === b.headline.trim().toLowerCase();
}

export function deterministicSummary(previousSummary: string, folded: MemoryNotableEvent[]): string {
  if (folded.length === 0) return previousSummary;
  const parts = folded
    .slice(0, 6)
    .map((e) => `${e.headline} (${e.impact >= 0 ? "+" : ""}${e.impact.toFixed(2)})`);
  const line = `Earlier: ${parts.join("; ")}.`;
  const base = previousSummary && !previousSummary.startsWith("No notable events") ? previousSummary : "";
  return `${base} ${line}`.trim().slice(0, 1200);
}

export function mergeNotableEvents(context: MemoryRecentContext, incoming: MemoryNotableEvent[], options: MergeOptions): MergeResult {
  const fresh = incoming.filter((event) => !context.notable_events.some((existing) => sameEvent(existing, event)));
  const merged = [...fresh, ...context.notable_events].sort((a, b) => b.at.localeCompare(a.at));
  const kept = merged.slice(0, options.maxEvents);
  const overflow = merged.slice(options.maxEvents);
  return {
    context: {
      ...context,
      notable_events: kept,
      last_updated_tick: options.tickNumber ?? context.last_updated_tick,
      updated_at: (options.now ?? new Date()).toISOString(),
    },
    overflow,
    added: fresh.length,
  };
}

export interface RefreshDeps {
  /** LLM completion for the "memory" task; omit to use the deterministic summary only. */
  complete?: (request: RoutedRequest) => Promise<LLMResponse>;
  onUsage?: (response: LLMResponse) => Promise<void> | void;
  log?: (message: string) => void;
}

const MEMORY_SYSTEM_PROMPT = `You maintain a compact memory of recent events for one public figure, used by a scoring engine.
Rewrite the memory summary in at most two plain sentences (max 60 words): keep what still matters for judging whether future news is routine or unusual for this person, drop trivia. No markdown, no preamble.`;

/**
 * Merges events, then folds overflow into the summary. Uses the LLM only when
 * there is overflow and a completion function is provided; any LLM failure
 * falls back to the deterministic summary.
 */
export async function refreshRecentContext(
  memory: PersonMemory,
  incoming: MemoryNotableEvent[],
  options: MergeOptions & { llmSummaries: boolean; personName: string },
  deps: RefreshDeps = {},
): Promise<{ context: MemoryRecentContext; usedLlm: boolean; changed: boolean }> {
  const merged = mergeNotableEvents(memory.recentContext, incoming, options);
  if (merged.added === 0 && merged.overflow.length === 0) {
    return { context: memory.recentContext, usedLlm: false, changed: false };
  }

  let summary = memory.recentContext.summary;
  let usedLlm = false;

  if (merged.overflow.length > 0) {
    summary = deterministicSummary(summary, merged.overflow);
    if (options.llmSummaries && deps.complete) {
      try {
        const response = await deps.complete({
          taskType: "memory",
          systemPrompt: MEMORY_SYSTEM_PROMPT,
          userPrompt: [
            `Person: ${options.personName}`,
            `Current summary: ${memory.recentContext.summary}`,
            `Events to fold in (oldest first):`,
            ...merged.overflow
              .slice()
              .reverse()
              .map((e) => `- ${e.at.slice(0, 10)}: ${e.headline} (${e.label}, impact ${e.impact >= 0 ? "+" : ""}${e.impact.toFixed(2)})`),
            `Write the new summary.`,
          ].join("\n"),
          responseFormat: { type: "text" },
        });
        const text = response.text.trim();
        if (text.length > 0) {
          summary = text.slice(0, 600);
          usedLlm = true;
        }
        await deps.onUsage?.(response);
      } catch (error) {
        deps.log?.(`memory summary fell back to deterministic text: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { context: { ...merged.context, summary }, usedLlm, changed: true };
}
