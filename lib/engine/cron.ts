import { authorizeSharedSecret, type SharedSecretAuthResult } from "@/lib/api-auth";
import type { FullTickResult } from "@/lib/engine/run-tick";

/**
 * The Engine heartbeat.
 *
 * Vercel Cron invokes /api/engine/cron once per minute (its finest
 * granularity). To reach the Engine's 30-second cadence, one invocation runs
 * TWO ticks: the first immediately, the second 30 seconds after the first
 * started. A time budget keeps the invocation inside the function's
 * maxDuration: if the first tick ran long, the second is skipped (and logged)
 * rather than risk a timeout, so the cadence degrades to 60 seconds instead
 * of failing.
 *
 * Everything here is orchestration; the tick itself is runFullTick(), the
 * same path the manual /api/engine/tick route uses.
 */

export const CRON_DEFAULTS = {
  /** Ticks per cron invocation (2 => 30-second cadence from a 1-minute schedule). */
  ticksPerInvocation: 2,
  /** Spacing between tick starts within one invocation. */
  spacingMs: 30_000,
  /** Wall-clock budget for the whole invocation, below the route's maxDuration (60 s). */
  budgetMs: 55_000,
  /** Floor for the "how long will the next tick take" estimate. */
  minTickEstimateMs: 5_000,
};

export interface CronTickResult {
  index: number;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  tickNumber?: number;
  peopleUpdated?: number;
  signalsProcessed?: number;
  /** Signals scored by the LLM this tick. */
  llmScored?: number;
  /** Signals that fell back to the rules scorer (LLM error, timeout, cap, refusal). */
  fallbacks?: number;
  narratives?: number;
  postTickErrors?: number;
  error?: string;
}

export interface CronInvocationResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  enabled: boolean;
  status: "skipped" | "ran";
  reason?: string;
  ticksPlanned: number;
  ticksRun: number;
  ticks: CronTickResult[];
  skippedTicks: Array<{ index: number; reason: string }>;
}

export interface ScheduledTicksOptions {
  enabled: boolean;
  runTick: () => Promise<FullTickResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  ticksPerInvocation?: number;
  spacingMs?: number;
  budgetMs?: number;
  minTickEstimateMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultLog = (message: string, data?: Record<string, unknown>) =>
  console.info(JSON.stringify({ at: new Date().toISOString(), source: "engine-cron", message, ...data }));

function summarize(index: number, startedAt: number, durationMs: number, result: FullTickResult): CronTickResult {
  return {
    index,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    ok: true,
    tickNumber: result.tickNumber,
    peopleUpdated: result.peopleUpdated,
    signalsProcessed: result.signalsProcessed,
    llmScored: result.signals.filter((s) => s.scorer === "llm").length,
    fallbacks: result.signals.filter((s) => s.scorer === "rules-fallback").length,
    narratives: result.postTick?.narratives ?? 0,
    postTickErrors: result.postTick?.errors.length ?? 0,
  };
}

export async function runScheduledTicks(options: ScheduledTicksOptions): Promise<CronInvocationResult> {
  const {
    enabled,
    runTick,
    sleep = defaultSleep,
    now = Date.now,
    log = defaultLog,
    ticksPerInvocation = CRON_DEFAULTS.ticksPerInvocation,
    spacingMs = CRON_DEFAULTS.spacingMs,
    budgetMs = CRON_DEFAULTS.budgetMs,
    minTickEstimateMs = CRON_DEFAULTS.minTickEstimateMs,
  } = options;

  const start = now();
  const startedAt = new Date(start).toISOString();

  if (!enabled) {
    log("skipped (disabled)", { enabled: false });
    return {
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      durationMs: 0,
      enabled: false,
      status: "skipped",
      reason: 'ENGINE_CRON_ENABLED is not "true"',
      ticksPlanned: 0,
      ticksRun: 0,
      ticks: [],
      skippedTicks: [],
    };
  }

  const ticks: CronTickResult[] = [];
  const skippedTicks: CronInvocationResult["skippedTicks"] = [];

  for (let index = 0; index < ticksPerInvocation; index += 1) {
    if (index > 0) {
      const previous = ticks[index - 1];
      const elapsed = now() - start;
      const slotOffset = index * spacingMs;
      const wouldStartAt = Math.max(elapsed, slotOffset);
      const estimate = Math.max(previous.durationMs, minTickEstimateMs);
      if (wouldStartAt + estimate > budgetMs) {
        const reason = `not enough time budget: would start at ${Math.round(wouldStartAt / 1000)}s and take ~${Math.round(estimate / 1000)}s of a ${Math.round(budgetMs / 1000)}s budget`;
        skippedTicks.push({ index, reason });
        log("tick skipped", { index, reason });
        break;
      }
      const waitMs = Math.max(0, start + slotOffset - now());
      if (waitMs > 0) await sleep(waitMs);
    }

    const tickStart = now();
    try {
      const result = await runTick();
      const entry = summarize(index, tickStart, now() - tickStart, result);
      ticks.push(entry);
      log("tick ran", { ...entry });
    } catch (error) {
      const entry: CronTickResult = {
        index,
        startedAt: new Date(tickStart).toISOString(),
        durationMs: now() - tickStart,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      ticks.push(entry);
      log("tick failed", { ...entry });
    }
  }

  const finished = now();
  const result: CronInvocationResult = {
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - start,
    enabled: true,
    status: "ran",
    ticksPlanned: ticksPerInvocation,
    ticksRun: ticks.filter((t) => t.ok).length,
    ticks,
    skippedTicks,
  };
  log("invocation finished", {
    ticksPlanned: result.ticksPlanned,
    ticksRun: result.ticksRun,
    signalsProcessed: ticks.reduce((sum, t) => sum + (t.signalsProcessed ?? 0), 0),
    fallbacks: ticks.reduce((sum, t) => sum + (t.fallbacks ?? 0), 0),
    failures: ticks.filter((t) => !t.ok).length,
    skippedTicks: skippedTicks.length,
    durationMs: result.durationMs,
  });
  return result;
}

/**
 * Who may call the cron endpoint: Vercel's cron system (`Authorization:
 * Bearer <CRON_SECRET>`, which Vercel sends automatically once CRON_SECRET is
 * set) or an operator holding ENGINE_SECRET (`x-engine-secret` header or
 * Bearer). Both checks are constant-time.
 */
export function authorizeCronRequest(
  headers: Headers,
  secrets: { cronSecret: string | null; engineSecret: string | null },
): SharedSecretAuthResult {
  if (!secrets.cronSecret && !secrets.engineSecret) {
    return { ok: false, status: 503, message: "Neither CRON_SECRET nor ENGINE_SECRET is configured on the server." };
  }
  if (secrets.cronSecret) {
    const viaCron = authorizeSharedSecret(headers, secrets.cronSecret, { headerName: "x-cron-secret", envName: "CRON_SECRET" });
    if (viaCron.ok) return viaCron;
  }
  if (secrets.engineSecret) {
    const viaEngine = authorizeSharedSecret(headers, secrets.engineSecret, { headerName: "x-engine-secret", envName: "ENGINE_SECRET" });
    if (viaEngine.ok) return viaEngine;
  }
  return { ok: false, status: 401, message: "Unauthorized." };
}
