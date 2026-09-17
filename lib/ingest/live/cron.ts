import type { LiveRunSummary } from "./runner";

/**
 * The live heartbeat (Phase 16): /api/ingest/live, once a minute.
 *
 * Behind INGEST_CRON_ENABLED, the same switch as the fifteen-minute
 * ingestion: live mode IS ingestion (it writes signals, snapshots and
 * observations and advances no score), and a second flag for the same job
 * would be one more thing to leave alone. The finer switch is configuration:
 * a source's config.live.enabled, off by a row update with no deploy.
 */

export const LIVE_CRON_DEFAULTS = {
  /**
   * The fire's wall-clock budget, under the route's 60 s maxDuration. An
   * idle fire is one Helix request and a few reads; a busy one is one clip
   * request per live broadcaster due for a sample, sequential, so the
   * budget only bites with dozens live at once, and then a sample waits
   * a minute.
   */
  budgetMs: 40_000,
  fetchTimeoutMs: 10_000,
};

export interface LiveCronResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  enabled: boolean;
  status: "skipped" | "ran";
  reason?: string;
  summary?: LiveRunSummary;
  error?: string;
}

export interface ScheduledLiveOptions {
  enabled: boolean;
  run: () => Promise<LiveRunSummary>;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const defaultLog = (message: string, data?: Record<string, unknown>) => console.info(JSON.stringify({ at: new Date().toISOString(), source: "live-cron", message, ...data }));

export async function runScheduledLiveCheck(options: ScheduledLiveOptions): Promise<LiveCronResult> {
  const { enabled, run, now = Date.now, log = defaultLog } = options;
  const start = now();
  const startedAt = new Date(start).toISOString();
  const finish = (result: Omit<LiveCronResult, "startedAt" | "finishedAt" | "durationMs">): LiveCronResult => ({ startedAt, finishedAt: new Date(now()).toISOString(), durationMs: now() - start, ...result });

  if (!enabled) {
    log("skipped (disabled)", { enabled: false });
    return finish({ enabled: false, status: "skipped", reason: 'INGEST_CRON_ENABLED is not "true"' });
  }
  try {
    const summary = await run();
    // An idle minute is not logged as a run; the runner's check lines say what it saw.
    if (summary.totals.live > 0 || summary.totals.sessionsClosed > 0 || summary.totals.errors > 0) {
      log("fire finished", { live: summary.totals.live, samples: summary.totals.samples, signalsCreated: summary.totals.signalsCreated, sessionsOpened: summary.totals.sessionsOpened, sessionsClosed: summary.totals.sessionsClosed, errors: summary.totals.errors, durationMs: summary.durationMs });
    }
    return finish({ enabled: true, status: "ran", summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("fire failed", { error: message });
    return finish({ enabled: true, status: "ran", error: message });
  }
}
