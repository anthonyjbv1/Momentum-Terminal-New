import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import type { MemoryStore } from "@/lib/engine/memory/store";
import type { MemoryNotableEvent } from "@/lib/engine/memory/types";
import { refreshRecentContext } from "@/lib/engine/memory/update";
import { buildNarratives, type NarrativeStore } from "@/lib/engine/narratives";
import type { TickSummary } from "@/lib/engine/types";
import type { RoutedRequest } from "@/lib/llm/routing";
import type { LLMResponse } from "@/lib/llm/types";
import { usageFromResponse, type LLMUsageLogger } from "@/lib/llm/usage";

/**
 * Runs after a tick has been persisted: writes narratives for meaningful
 * moves and evolves per-entity memory from this tick's notable signals.
 * Failures here are reported, never thrown — the tick itself already
 * succeeded.
 */

export interface PostTickDeps {
  narrativeStore: NarrativeStore;
  memoryStore: MemoryStore;
  /** LLM completion for memory summaries; omit to keep summaries deterministic. */
  complete?: (request: RoutedRequest) => Promise<LLMResponse>;
  usageLogger?: LLMUsageLogger;
  config?: EngineConfig;
  now?: Date;
  log?: (message: string) => void;
}

export interface PostTickSummary {
  narratives: number;
  memoryUpdates: number;
  memoryLlmSummaries: number;
  errors: string[];
}

export async function runPostTick(summary: TickSummary, deps: PostTickDeps): Promise<PostTickSummary> {
  const config = deps.config ?? DEFAULT_ENGINE_CONFIG;
  const now = deps.now ?? new Date(summary.finishedAt);
  const log = deps.log ?? ((message: string) => console.warn(`[post-tick] ${message}`));
  const result: PostTickSummary = { narratives: 0, memoryUpdates: 0, memoryLlmSummaries: 0, errors: [] };

  if (summary.dryRun) return result;

  // 1. Narratives for meaningful moves -----------------------------------------
  try {
    const rows = buildNarratives(summary, config.narratives);
    result.narratives = await deps.narrativeStore.insert(rows);
  } catch (error) {
    const message = `narratives failed: ${error instanceof Error ? error.message : String(error)}`;
    result.errors.push(message);
    log(message);
  }

  // 2. Memory: remember this tick's notable signals ----------------------------
  const eventsByPerson = new Map<string, { slug: string; displayName: string; events: MemoryNotableEvent[] }>();
  const peopleBySlug = new Map(summary.people.map((p) => [p.slug, p]));
  for (const signal of summary.signals) {
    const notable = Math.abs(signal.impact) >= config.memory.notableImpactThreshold || (signal.anomaly !== undefined && signal.anomaly !== "routine");
    if (!notable) continue;
    const person = peopleBySlug.get(signal.personSlug);
    if (!person) continue;
    const entry = eventsByPerson.get(person.id) ?? { slug: person.slug, displayName: person.displayName, events: [] };
    entry.events.push({
      at: summary.finishedAt,
      headline: signal.headline,
      label: signal.label,
      impact: signal.impact,
      anomaly: signal.anomaly,
    });
    eventsByPerson.set(person.id, entry);
  }

  if (eventsByPerson.size > 0) {
    try {
      const memories = await deps.memoryStore.loadMany([...eventsByPerson.keys()]);
      for (const [personId, { displayName, events }] of eventsByPerson) {
        const memory = memories.get(personId);
        if (!memory) continue;
        try {
          const refreshed = await refreshRecentContext(
            memory,
            events,
            { maxEvents: config.memory.maxRecentEvents, tickNumber: summary.tickNumber, now, llmSummaries: config.memory.llmSummaries, personName: displayName },
            {
              complete: deps.complete,
              onUsage: (response) => deps.usageLogger?.log(usageFromResponse(response, { taskType: "memory", personId, tickNumber: summary.tickNumber })),
              log,
            },
          );
          if (refreshed.changed) {
            await deps.memoryStore.saveRecentContext(personId, refreshed.context);
            result.memoryUpdates += 1;
            if (refreshed.usedLlm) result.memoryLlmSummaries += 1;
          }
        } catch (error) {
          const message = `memory update failed for ${displayName}: ${error instanceof Error ? error.message : String(error)}`;
          result.errors.push(message);
          log(message);
        }
      }
    } catch (error) {
      const message = `memory load failed: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(message);
      log(message);
    }
  }

  return result;
}
