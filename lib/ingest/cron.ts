import { authorizeSharedSecret, type SharedSecretAuthResult } from "@/lib/api-auth";

import type { IngestSummary } from "./runner";

/**
 * The ingestion heartbeat — a DIFFERENT job from the Engine's, on its own
 * schedule behind its own flag.
 *
 * Vercel Cron invokes /api/ingest/cron every fifteen minutes (Phase 13; it was
 * hourly before). Each invocation polls every active source that is DUE — each
 * source keeps its own poll_interval_minutes, so a faster schedule polls the
 * fast sources more often and leaves the quota-bound ones on their hour —
 * exactly as the manual /api/ingest does, and advances no score: ingestion
 * writes snapshots, observations and signals, and the Engine is what turns a
 * signal into a move. So this can run for days with ENGINE_CRON_ENABLED false,
 * filling the baselines, at no LLM cost, and a faster schedule costs nothing
 * but function invocations.
 *
 * Two guards, in this order:
 *   1. the flag. INGEST_CRON_ENABLED must be exactly "true". Checked BEFORE
 *      authentication and before any work, so the endpoint answers honestly
 *      without a secret and can do nothing at all while disabled.
 *   2. overlap. A run still in flight (an ingest_runs row with no finished_at,
 *      started inside the staleness window) makes the next invocation skip
 *      rather than poll everything a second time. Past the window a run is
 *      presumed dead — a crashed invocation never closes its row — and no
 *      longer blocks.
 */

export const INGEST_CRON_DEFAULTS = {
  /**
   * How long an unfinished run blocks the next invocation. Above the route's
   * maxDuration (60 s), so a run that is genuinely still going always wins;
   * below the fifteen-minute schedule, so a crashed run blocks no scheduled
   * poll at all: by the next fire its row is already past the window.
   */
  staleAfterMinutes: 10,
};

export interface IngestCronResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  enabled: boolean;
  status: "skipped" | "ran";
  reason?: string;
  summary?: IngestSummary;
  error?: string;
}

/** A run that was opened and never closed. */
export interface OpenRun {
  id: string;
  startedAt: Date;
}

export interface ScheduledIngestionOptions {
  enabled: boolean;
  /** The open run blocking this invocation, if any; the caller looks it up inside the staleness window. */
  openRun?: OpenRun | null;
  run: () => Promise<IngestSummary>;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const defaultLog = (message: string, data?: Record<string, unknown>) =>
  console.info(JSON.stringify({ at: new Date().toISOString(), source: "ingest-cron", message, ...data }));

export async function runScheduledIngestion(options: ScheduledIngestionOptions): Promise<IngestCronResult> {
  const { enabled, openRun = null, run, now = Date.now, log = defaultLog } = options;
  const start = now();
  const startedAt = new Date(start).toISOString();
  const finish = (result: Omit<IngestCronResult, "startedAt" | "finishedAt" | "durationMs">): IngestCronResult => ({
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    durationMs: now() - start,
    ...result,
  });

  if (!enabled) {
    log("skipped (disabled)", { enabled: false });
    return finish({ enabled: false, status: "skipped", reason: 'INGEST_CRON_ENABLED is not "true"' });
  }

  if (openRun) {
    const reason = `a run started ${new Date(openRun.startedAt).toISOString()} has not finished; skipping rather than polling twice`;
    log("skipped (overlap)", { enabled: true, openRunId: openRun.id, startedAt: openRun.startedAt.toISOString() });
    return finish({ enabled: true, status: "skipped", reason });
  }

  try {
    const summary = await run();
    log("run finished", {
      runId: summary.runId,
      sources: summary.totals.sources,
      signalsCreated: summary.totals.signalsCreated,
      snapshotsRecorded: summary.totals.snapshotsRecorded,
      observations: summary.totals.observations,
      errors: summary.totals.errors,
      durationMs: summary.durationMs,
    });
    return finish({ enabled: true, status: "ran", summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("run failed", { error: message });
    return finish({ enabled: true, status: "ran", error: message });
  }
}

/**
 * Who may call the ingestion cron: Vercel's cron system (`Authorization:
 * Bearer <CRON_SECRET>`, which Vercel sends automatically once CRON_SECRET is
 * set) or an operator holding INGEST_SECRET. No human has to paste a secret
 * into a scheduler; both checks are constant-time.
 */
export function authorizeIngestCronRequest(
  headers: Headers,
  secrets: { cronSecret: string | null; ingestSecret: string | null },
): SharedSecretAuthResult {
  if (!secrets.cronSecret && !secrets.ingestSecret) {
    return { ok: false, status: 503, message: "Neither CRON_SECRET nor INGEST_SECRET is configured on the server." };
  }
  if (secrets.cronSecret) {
    const viaCron = authorizeSharedSecret(headers, secrets.cronSecret, { headerName: "x-cron-secret", envName: "CRON_SECRET" });
    if (viaCron.ok) return viaCron;
  }
  if (secrets.ingestSecret) {
    const viaIngest = authorizeSharedSecret(headers, secrets.ingestSecret, { headerName: "x-ingest-secret", envName: "INGEST_SECRET" });
    if (viaIngest.ok) return viaIngest;
  }
  return { ok: false, status: 401, message: "Unauthorized." };
}
