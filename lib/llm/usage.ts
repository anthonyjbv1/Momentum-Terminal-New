import type { TypedSupabaseClient } from "@/types";

import type { LLMResponse, LLMTaskType } from "./types";

/**
 * THE USAGE LEDGER, written in two halves.
 *
 * A row used to be inserted only after a call returned. That made the ledger
 * exact in steady state and blind in the one situation it most needed to
 * report: when the function was killed with calls in flight, Anthropic billed
 * them and nothing recorded them. The incident that motivated this cost
 * ~$0.42–0.65 against a dashboard reading $0.16.
 *
 * So a call is now written BEFORE it is made (status "started", no tokens)
 * and updated when it returns ("completed", with usage) or throws ("failed",
 * with the reason). A row that stays "started" is a call the process died
 * inside — billed, unlogged before, visible now. A "failed" row is a timeout
 * or provider error that previously left no trace either.
 *
 * Logging never affects scoring: every method swallows its own errors, and a
 * begin() that could not insert returns a handle whose updates are no-ops.
 */

export type LLMUsageStatus = "started" | "completed" | "failed";

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

/** What is known about a call before it is made. */
export interface LLMAttempt {
  provider: string;
  /** The model the route asked for; the echoed model replaces it on completion. */
  model: string;
  taskType: LLMTaskType;
  personId?: string | null;
  tickNumber?: number | null;
}

export interface LLMAttemptHandle {
  /** The call returned: record its usage against the started row. */
  complete(entry: LLMUsageEntry): Promise<void>;
  /** The call threw: record why against the started row. */
  fail(reason: string): Promise<void>;
}

export interface LLMUsageLogger {
  /** A completed call in one write, for callers that do not need the in-flight half. Never throws. */
  log(entry: LLMUsageEntry): Promise<void>;
  /** The in-flight half: write the row first, settle it later. Never throws. */
  begin(attempt: LLMAttempt): Promise<LLMAttemptHandle>;
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

const NOOP_HANDLE: LLMAttemptHandle = { async complete() {}, async fail() {} };

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name === "LLMError" ? `${(error as { kind?: string }).kind ?? "error"}: ` : ""}${error.message}` : String(error);
}

/**
 * One call, on the ledger in both halves: the started row before the call,
 * settled with usage when it returns or with the reason when it throws. The
 * error is rethrown untouched so the caller's fallback logic is unchanged.
 */
export async function recordedCall(logger: LLMUsageLogger, attempt: LLMAttempt, call: () => Promise<LLMResponse>): Promise<LLMResponse> {
  const handle = await logger.begin(attempt);
  let response: LLMResponse;
  try {
    response = await call();
  } catch (error) {
    await handle.fail(describeError(error));
    throw error;
  }
  await handle.complete(usageFromResponse(response, attempt));
  return response;
}

function warn(what: string, error: unknown): void {
  console.warn(`[llm] failed to ${what}:`, error instanceof Error ? error.message : error);
}

export function createSupabaseUsageLogger(client: TypedSupabaseClient): LLMUsageLogger {
  const completedRow = (entry: LLMUsageEntry) => ({
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
    status: "completed" as const,
  });

  return {
    async log(entry) {
      try {
        const { error } = await client.from("llm_usage").insert(completedRow(entry));
        if (error) warn("log usage", error.message);
      } catch (error) {
        warn("log usage", error);
      }
    },

    async begin(attempt) {
      let id: string | null = null;
      try {
        const { data, error } = await client
          .from("llm_usage")
          .insert({
            provider: attempt.provider,
            model: attempt.model,
            task_type: attempt.taskType,
            person_id: attempt.personId ?? null,
            tick_number: attempt.tickNumber ?? null,
            status: "started",
            started_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (error) warn("record a started call", error.message);
        else id = data.id;
      } catch (error) {
        warn("record a started call", error);
      }
      if (!id) return NOOP_HANDLE;
      const rowId = id;

      return {
        async complete(entry) {
          try {
            const { error } = await client.from("llm_usage").update(completedRow(entry)).eq("id", rowId);
            if (error) warn("complete a started call", error.message);
          } catch (error) {
            warn("complete a started call", error);
          }
        },
        async fail(reason) {
          try {
            const { error } = await client.from("llm_usage").update({ status: "failed", error: reason.slice(0, 500) }).eq("id", rowId);
            if (error) warn("record a failed call", error.message);
          } catch (error) {
            warn("record a failed call", error);
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory ledger (tests)
// ---------------------------------------------------------------------------

export interface MemoryUsageRow extends Partial<LLMUsageEntry> {
  provider: string;
  model: string;
  taskType: LLMTaskType;
  status: LLMUsageStatus;
  error?: string;
}

export interface MemoryUsageLogger extends LLMUsageLogger {
  /** Every row, in the order it was begun or logged. */
  readonly rows: MemoryUsageRow[];
  /** Completed rows only, the shape the old ledger had. */
  readonly entries: LLMUsageEntry[];
}

export function createMemoryUsageLogger(): MemoryUsageLogger {
  const rows: MemoryUsageRow[] = [];
  return {
    rows,
    get entries() {
      return rows.filter((row): row is MemoryUsageRow & LLMUsageEntry => row.status === "completed") as LLMUsageEntry[];
    },
    async log(entry) {
      rows.push({ ...entry, status: "completed" });
    },
    async begin(attempt) {
      const row: MemoryUsageRow = { ...attempt, status: "started" };
      rows.push(row);
      return {
        async complete(entry) {
          Object.assign(row, entry, { status: "completed" });
        },
        async fail(reason) {
          row.status = "failed";
          row.error = reason;
        },
      };
    },
  };
}

export const noopUsageLogger: LLMUsageLogger = { async log() {}, async begin() { return NOOP_HANDLE; } };
