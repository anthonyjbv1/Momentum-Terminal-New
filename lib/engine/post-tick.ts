import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { NO_DEADLINE, type TickDeadline } from "@/lib/engine/deadline";
import type { MemoryStore } from "@/lib/engine/memory/store";
import type { MemoryNotableEvent } from "@/lib/engine/memory/types";
import { mergeNotableEvents, refreshRecentContext } from "@/lib/engine/memory/update";
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
 *
 * EVERY PERSON'S MEMORY IS VISITED (Phase 12+), not only those with notable
 * signals this tick: an event expires by age, and a quiet person's memory
 * only ages if someone looks at it. The visit is one read for all active
 * people; a memory with nothing new and nothing expired is left untouched.
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
  /** Notable events that left a verbatim list because of their age this tick. */
  memoryEventsExpired: number;
  errors: string[];
}

export async function runPostTick(summary: TickSummary, deps: PostTickDeps): Promise<PostTickSummary> {
  const config = deps.config ?? DEFAULT_ENGINE_CONFIG;
  const now = deps.now ?? new Date(summary.finishedAt);
  const log = deps.log ?? ((message: string) => console.warn(`[post-tick] ${message}`));
  const deadline = deps.deadline ?? NO_DEADLINE;
  const result: PostTickSummary = { narratives: 0, memoryUpdates: 0, memoryLlmSummaries: 0, memorySummariesDeferred: 0, memoryEventsExpired: 0, errors: [] };

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

  // 2. Memory: remember this tick's notable signals, age everyone's ------------
  const eventsByPerson = new Map<string, MemoryNotableEvent[]>();
  const peopleBySlug = new Map(summary.people.map((p) => [p.slug, p]));
  for (const signal of summary.signals) {
    const notable = Math.abs(signal.impact) >= config.memory.notableImpactThreshold || (signal.anomaly !== undefined && signal.anomaly !== "routine");
    if (!notable) continue;
    const person = peopleBySlug.get(signal.personSlug);
    if (!person) continue;
    const events = eventsByPerson.get(person.id) ?? [];
    events.push({ at: summary.finishedAt, headline: signal.headline, label: signal.label, impact: signal.impact, anomaly: signal.anomaly });
    eventsByPerson.set(person.id, events);
  }

  if (summary.people.length > 0) {
    try {
      const memories = await deps.memoryStore.loadMany(summary.people.map((p) => p.id));
      for (const person of summary.people) {
        const memory = memories.get(person.id);
        if (!memory) continue;
        const events = eventsByPerson.get(person.id) ?? [];
        const mergeOptions = { maxEvents: config.memory.maxRecentEvents, maxEventAgeDays: config.memory.maxEventAgeDays, tickNumber: summary.tickNumber, now };
        // A dry merge first: most people have nothing new and nothing expired, and are skipped without a write.
        const preview = mergeNotableEvents(memory.recentContext, events, mergeOptions);
        if (preview.added === 0 && preview.overflow.length === 0) continue;
        try {
          // The same start gate as a scoring call: a summary call is only
          // started if something needs folding and it can finish in time.
          const wantsCall = preview.overflow.length > 0 && config.memory.llmSummaries && deps.complete !== undefined;
          const canCall = wantsCall && deadline.canStart(config.llm.timeoutMs + CALL_OVERHEAD_MS);
          if (wantsCall && !canCall) result.memorySummariesDeferred += 1;
          const complete = deps.complete;
          const refreshed = await refreshRecentContext(
            memory,
            events,
            { ...mergeOptions, llmSummaries: canCall, personName: person.displayName },
            {
              complete:
                complete === undefined
                  ? undefined
                  : (request) => {
                      const route = resolveRoute("memory");
                      const attempt = { provider: route.providerName, model: route.model ?? "provider-default", taskType: "memory" as const, personId: person.id, tickNumber: summary.tickNumber };
                      const call = () => complete({ ...request, timeoutMs: config.llm.timeoutMs });
                      return deps.usageLogger ? recordedCall(deps.usageLogger, attempt, call) : call();
                    },
              log,
            },
          );
          if (refreshed.changed) {
            await deps.memoryStore.saveRecentContext(person.id, refreshed.context);
            result.memoryUpdates += 1;
            result.memoryEventsExpired += refreshed.expired;
            if (refreshed.usedLlm) result.memoryLlmSummaries += 1;
          }
        } catch (error) {
          const message = `memory update failed for ${person.displayName}: ${error instanceof Error ? error.message : String(error)}`;
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
