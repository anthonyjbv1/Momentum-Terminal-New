import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { NO_DEADLINE, type TickDeadline } from "@/lib/engine/deadline";
import type { MemoryStore } from "@/lib/engine/memory/store";
import type { MemoryNotableEvent } from "@/lib/engine/memory/types";
import { refreshRecentContext } from "@/lib/engine/memory/update";
import { buildNarratives, type NarrativeStore } from "@/lib/engine/narratives";
import { CALL_OVERHEAD_MS } from "@/lib/engine/sentiment/llm";
import type { TickSummary } from "@/lib/engine/types";
import { resolveRoute, type RoutedRequest } from "@/lib/llm/routing";
import type { LLMResponse } from "@/lib/llm/types";
import { recordedCall, type LLMUsageLogger } from "@/lib/llm/usage";

/**
 * Runs after a tick has been persisted: writes narratives for meaningful
 * moves and evolves per-entity memory from this tick's notable signals.
 * Failures here are reported, never thrown — the tick itself already
 * succeeded.
 *
 * The tick's deadline reaches here too. Narratives are pure and always
 * written; a memory summary is the one model call this step can make, and
 * it is started only if it can finish before the deadline — otherwise the
 * deterministic summary is used, which is what happens on any LLM failure
 * anyway. Nothing after the commit may push the invocation past its budget.
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
  /** The tick's deadline; memory summaries that cannot finish before it are not started. */
  deadline?: TickDeadline;
}

export interface PostTickSummary {
  narratives: number;
  memoryUpdates: number;
  memoryLlmSummaries: number;
  /** Memory summaries that fell back to deterministic text because the deadline left no room for a call. */
  memorySummariesDeferred: number;
  errors: string[];
}

export async function runPostTick(summary: TickSummary, deps: PostTickDeps): Promise<PostTickSummary> {
  const config = deps.config ?? DEFAULT_ENGINE_CONFIG;
  const now = deps.now ?? new Date(summary.finishedAt);
  const log = deps.log ?? ((message: string) => console.warn(`[post-tick] ${message}`));
  const deadline = deps.deadline ?? NO_DEADLINE;
  const result: PostTickSummary = { narratives: 0, memoryUpdates: 0, memoryLlmSummaries: 0, memorySummariesDeferred: 0, errors: [] };

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
          // The same start gate as a scoring call: a summary call is only
          // started if it can finish inside the tick's budget.
          const canCall = config.memory.llmSummaries && deps.complete !== undefined && deadline.canStart(config.llm.timeoutMs + CALL_OVERHEAD_MS);
          if (config.memory.llmSummaries && deps.complete !== undefined && !canCall) result.memorySummariesDeferred += 1;
          const complete = deps.complete;
          const refreshed = await refreshRecentContext(
            memory,
            events,
            { maxEvents: config.memory.maxRecentEvents, tickNumber: summary.tickNumber, now, llmSummaries: canCall, personName: displayName },
            {
              complete:
                complete === undefined
                  ? undefined
                  : (request) => {
                      const route = resolveRoute("memory");
                      const attempt = { provider: route.providerName, model: route.model ?? "provider-default", taskType: "memory" as const, personId, tickNumber: summary.tickNumber };
                      const call = () => complete({ ...request, timeoutMs: config.llm.timeoutMs });
                      return deps.usageLogger ? recordedCall(deps.usageLogger, attempt, call) : call();
                    },
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
