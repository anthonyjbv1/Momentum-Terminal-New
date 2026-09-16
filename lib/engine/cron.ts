import { authorizeSharedSecret, type SharedSecretAuthResult } from "@/lib/api-auth";
import type { FullTickResult } from "@/lib/engine/run-tick";

/**
 * The Engine heartbeat.
 *
 * Vercel Cron invokes /api/engine/cron once per minute (its finest
 * granularity). To reach the Engine's 30-second cadence, one invocation runs
 * TWO ticks: the first immediately, the second 30 seconds after the first
 * started. The invocation has a wall-clock budget under the route's
 * maxDuration, and EVERY tick is handed its own slice of it as a deadline:
 * the time left in the invocation when the tick starts, less a reserve for
 * the commit that follows scoring. The tick bounds itself to that (no model
 * call starts that cannot finish inside it), so a tick cannot outlive the
 * invocation, and the second tick is skipped only when its slice would be
 * too small to be worth starting.
 *
 * This replaced a scheduler whose budget was checked only before the second
 * tick, while the first ran with no deadline at all — and was killed at
 * maxDuration every minute, having committed nothing.
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
  /** Kept out of every tick's deadline for the commit and the post-tick that follow its scoring. */
  commitReserveMs: 2_000,
  /** A tick is not started with less than this to work in. */
  minTickBudgetMs: 5_000,
};

/** What the scheduler tells a tick when it starts it. */
export interface TickSlot {
  index: number;
  /** Wall-clock budget for this tick's scoring, in ms. */
  budgetMs: number;
}

export interface CronTickResult {
  index: number;
  startedAt: string;
  durationMs: number;
  /** The deadline this tick was given. */
  budgetMs: number;
  ok: boolean;
  tickNumber?: number;
  peopleUpdated?: number;
  signalsProcessed?: number;
  /** Signals sent to the model this tick (scored by it or fallen back). */
  attempted?: number;
  /** Signals scored by the LLM this tick. */
  llmScored?: number;
  /** Signals that fell back to the rules scorer after a failed attempt. */
  fallbacks?: number;
  /** Signals selected but not attempted: left unprocessed for a later tick. */
  deferred?: number;
  /** Model calls made this tick. */
  llmCalls?: number;
  /** Unprocessed signals left after this tick. */
  backlogAfter?: number;
  /** True when the tick left signals unprocessed. */
  partial?: boolean;
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
  runTick: (slot: TickSlot) => Promise<FullTickResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  ticksPerInvocation?: number;
  spacingMs?: number;
  budgetMs?: number;
  commitReserveMs?: number;
  minTickBudgetMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultLog = (message: string, data?: Record<string, unknown>) =>
  console.info(JSON.stringify({ at: new Date().toISOString(), source: "engine-cron", message, ...data }));

function summarize(slot: TickSlot, startedAt: number, durationMs: number, result: FullTickResult): CronTickResult {
  return {
    index: slot.index,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    budgetMs: slot.budgetMs,
    ok: true,
    tickNumber: result.tickNumber,
    peopleUpdated: result.peopleUpdated,
    signalsProcessed: result.signalsProcessed,
    attempted: result.scoring.attempted,
    llmScored: result.scoring.llmScored,
    fallbacks: result.scoring.fallbacks,
    deferred: result.scoring.deferred,
    llmCalls: result.scoring.llmCalls,
    backlogAfter: result.scoring.backlogAfter,
    partial: result.scoring.partial,
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
    commitReserveMs = CRON_DEFAULTS.commitReserveMs,
    minTickBudgetMs = CRON_DEFAULTS.minTickBudgetMs,
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
      const waitMs = Math.max(0, start + index * spacingMs - now());
      if (waitMs > 0) await sleep(waitMs);
    }

    // The tick's slice: whatever the invocation has left, less the reserve.
    const tickStart = now();
    const slot: TickSlot = { index, budgetMs: budgetMs - (tickStart - start) - commitReserveMs };
    if (slot.budgetMs < minTickBudgetMs) {
      const reason = `not enough time budget: ${Math.round(Math.max(0, slot.budgetMs) / 1000)}s left of ${Math.round(budgetMs / 1000)}s, a tick needs at least ${Math.round(minTickBudgetMs / 1000)}s`;
      skippedTicks.push({ index, reason });
      log("tick skipped", { index, reason });
      break;
    }

    try {
      const result = await runTick(slot);
      const entry = summarize(slot, tickStart, now() - tickStart, result);
      ticks.push(entry);
      log("tick ran", { ...entry });
    } catch (error) {
      const entry: CronTickResult = {
        index,
        startedAt: new Date(tickStart).toISOString(),
        durationMs: now() - tickStart,
        budgetMs: slot.budgetMs,
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
  const last = [...ticks].reverse().find((t) => t.ok);
  log("invocation finished", {
    ticksPlanned: result.ticksPlanned,
    ticksRun: result.ticksRun,
    signalsProcessed: ticks.reduce((sum, t) => sum + (t.signalsProcessed ?? 0), 0),
    attempted: ticks.reduce((sum, t) => sum + (t.attempted ?? 0), 0),
    fallbacks: ticks.reduce((sum, t) => sum + (t.fallbacks ?? 0), 0),
    deferred: ticks.reduce((sum, t) => sum + (t.deferred ?? 0), 0),
    llmCalls: ticks.reduce((sum, t) => sum + (t.llmCalls ?? 0), 0),
    backlogAfter: last?.backlogAfter ?? null,
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
