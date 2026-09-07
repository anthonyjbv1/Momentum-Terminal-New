import type { TypedSupabaseClient } from "@/types";

import type { LLMResponse, LLMTaskType } from "./types";

/** One row of llm_usage. */
export interface LLMUsageEntry {
  provider: string;
  model: string;
  taskType: LLMTaskType;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  latencyMs?: number;
  personId?: string | null;
  tickNumber?: number | null;
}

export interface LLMUsageLogger {
  /** Never throws; logging must not break the Engine. */
  log(entry: LLMUsageEntry): Promise<void>;
}

export function usageFromResponse(
  response: LLMResponse,
  meta: { taskType: LLMTaskType; personId?: string | null; tickNumber?: number | null },
): LLMUsageEntry {
  return {
    provider: response.provider,
    model: response.model,
    taskType: meta.taskType,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadInputTokens: response.usage.cacheReadInputTokens,
    cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
    latencyMs: response.latencyMs,
    personId: meta.personId ?? null,
    tickNumber: meta.tickNumber ?? null,
  };
}

export function createSupabaseUsageLogger(client: TypedSupabaseClient): LLMUsageLogger {
  return {
    async log(entry) {
      try {
        const { error } = await client.from("llm_usage").insert({
          provider: entry.provider,
          model: entry.model,
          task_type: entry.taskType,
          input_tokens: entry.inputTokens,
          output_tokens: entry.outputTokens,
          cache_read_input_tokens: entry.cacheReadInputTokens,
          cache_creation_input_tokens: entry.cacheCreationInputTokens,
          latency_ms: entry.latencyMs ?? null,
          person_id: entry.personId ?? null,
          tick_number: entry.tickNumber ?? null,
        });
        if (error) console.warn("[llm] failed to log usage:", error.message);
      } catch (error) {
        console.warn("[llm] failed to log usage:", error instanceof Error ? error.message : error);
      }
    },
  };
}

export interface MemoryUsageLogger extends LLMUsageLogger {
  readonly entries: LLMUsageEntry[];
}

export function createMemoryUsageLogger(): MemoryUsageLogger {
  const entries: LLMUsageEntry[] = [];
  return {
    entries,
    async log(entry) {
      entries.push(entry);
    },
  };
}

export const noopUsageLogger: LLMUsageLogger = { async log() {} };
