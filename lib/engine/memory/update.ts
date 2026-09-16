import type { LLMResponse } from "@/lib/llm/types";
import type { RoutedRequest } from "@/lib/llm/routing";

import type { MemoryNotableEvent, MemoryRecentContext, PersonMemory } from "./types";

/**
 * Cheap, evolving memory. After a tick, notable signals are merged into the
 * person's recent_context: the newest events are kept verbatim (capped), and
 * events that fall off the end are folded into a short prose summary — by the
 * LLM when enabled (one small call), otherwise deterministically. Raw logs are
 * never accumulated.
 *
 * TWO WAYS OFF THE LIST (Phase 12+). An event leaves the verbatim list when
 * newer events push it past maxEvents (a size cap), OR when it is older than
 * maxEventAgeDays (a clock). Before the clock existed, a quiet subject kept
 * one dramatic event as "recent" for months, and the model judged every new
 * signal against it. Folded events keep their dates, and the summary prompt
 * is told today's date and the horizon, so what is old is written as history.
 */

export interface MergeOptions {
  maxEvents: number;
  /** Events older than this leave the list whatever the count. Omit for no expiry. */
  maxEventAgeDays?: number;
  tickNumber?: number;
  now?: Date;
}

export interface MergeResult {
  context: MemoryRecentContext;
  /** Events that no longer fit or have expired and should be folded into the summary. */
  overflow: MemoryNotableEvent[];
  added: number;
  /** How many of the overflow left because of their age. */
  expired: number;
}

function sameEvent(a: MemoryNotableEvent, b: MemoryNotableEvent): boolean {
  return a.headline.trim().toLowerCase() === b.headline.trim().toLowerCase();
}

function ageDays(event: MemoryNotableEvent, now: Date): number {
  const at = Date.parse(event.at);
  return Number.isFinite(at) ? (now.getTime() - at) / 86_400_000 : 0;
}

/** True when the event is past the expiry horizon. Undated or malformed events never expire by age. */
export function isExpiredEvent(event: MemoryNotableEvent, now: Date, maxEventAgeDays: number | undefined): boolean {
  return maxEventAgeDays !== undefined && ageDays(event, now) > maxEventAgeDays;
}

export function deterministicSummary(previousSummary: string, folded: MemoryNotableEvent[]): string {
  if (folded.length === 0) return previousSummary;
  const parts = folded
    .slice(0, 6)
    .map((e) => `${e.headline} (${e.at.slice(0, 10)}, ${e.impact >= 0 ? "+" : ""}${e.impact.toFixed(2)})`);
  const line = `Earlier: ${parts.join("; ")}.`;
  const base = previousSummary && !previousSummary.startsWith("No notable events") ? previousSummary : "";
  return `${base} ${line}`.trim().slice(0, 1200);
}

export function mergeNotableEvents(context: MemoryRecentContext, incoming: MemoryNotableEvent[], options: MergeOptions): MergeResult {
  const now = options.now ?? new Date();
  const fresh = incoming.filter((event) => !context.notable_events.some((existing) => sameEvent(existing, event)));
  const merged = [...fresh, ...context.notable_events].sort((a, b) => b.at.localeCompare(a.at));
  const current = merged.filter((event) => !isExpiredEvent(event, now, options.maxEventAgeDays));
  const expired = merged.filter((event) => isExpiredEvent(event, now, options.maxEventAgeDays));
  const kept = current.slice(0, options.maxEvents);
  const overflow = [...current.slice(options.maxEvents), ...expired];
  return {
    context: {
      ...context,
      notable_events: kept,
      last_updated_tick: options.tickNumber ?? context.last_updated_tick,
      updated_at: now.toISOString(),
    },
    overflow,
    added: fresh.length,
    expired: expired.length,
  };
}

export interface RefreshDeps {
  /** LLM completion for the "memory" task; omit to use the deterministic summary only. */
  complete?: (request: RoutedRequest) => Promise<LLMResponse>;
  onUsage?: (response: LLMResponse) => Promise<void> | void;
  log?: (message: string) => void;
}

export const MEMORY_SYSTEM_PROMPT = `You maintain a compact memory of recent events for one public figure, used by a scoring engine.
Rewrite the memory summary in at most two plain sentences (max 60 words): keep what still matters for judging whether future news is routine or unusual for this person, drop trivia.
Today's date is given and every event is dated. An event older than the stated horizon is HISTORY: if you keep it, write it as past context with its month ("in June, ..."), never as the current picture. No markdown, no preamble.`;

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
): Promise<{ context: MemoryRecentContext; usedLlm: boolean; changed: boolean; expired: number }> {
  const now = options.now ?? new Date();
  const merged = mergeNotableEvents(memory.recentContext, incoming, { ...options, now });
  if (merged.added === 0 && merged.overflow.length === 0) {
    return { context: memory.recentContext, usedLlm: false, changed: false, expired: 0 };
  }

  let summary = memory.recentContext.summary;
  let usedLlm = false;

  if (merged.overflow.length > 0) {
    summary = deterministicSummary(summary, merged.overflow);
    if (options.llmSummaries && deps.complete) {
      try {
        const horizon = options.maxEventAgeDays !== undefined ? `Events older than ${options.maxEventAgeDays} days are history, not current context.` : "Treat every folded event as past context.";
        const response = await deps.complete({
          taskType: "memory",
          systemPrompt: MEMORY_SYSTEM_PROMPT,
          userPrompt: [
            `Person: ${options.personName}`,
            `Today: ${now.toISOString().slice(0, 10)}`,
            `Horizon: ${horizon}`,
            `Current summary: ${memory.recentContext.summary}`,
            `Events to fold in (oldest first):`,
            ...merged.overflow
              .slice()
              .sort((a, b) => a.at.localeCompare(b.at))
              .map((e) => `- ${e.at.slice(0, 10)} (${Math.round(ageDays(e, now))} days ago): ${e.headline} (${e.label}, impact ${e.impact >= 0 ? "+" : ""}${e.impact.toFixed(2)})`),
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

  return { context: { ...merged.context, summary }, usedLlm, changed: true, expired: merged.expired };
}
