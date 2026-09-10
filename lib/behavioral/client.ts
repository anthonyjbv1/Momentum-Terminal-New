import {
  BEHAVIORAL_LIMITS,
  validateBehavioralEvent,
  type BehavioralEventInput,
  type ValidatedBehavioralEvent,
} from "./events";
import { getBehavioralSessionId } from "./session";

/**
 * Client-side logging: what Client Components call.
 *
 *   trackEvent({ eventType: "view_person", personId })
 *   const stop = startDwell({ personId }); ... stop();   // logs time_spent
 *
 * Events are validated, queued and sent to POST /api/behavioral/log in
 * batches: after a 2-second lull, once 20 are pending, or when the tab is
 * hidden / unloaded (with keepalive, so the request outlives the page).
 * time_spent events for the same person are merged while they wait, so a
 * user hopping between cards produces one row per person per batch, not a
 * stream of tiny ones. Nothing here throws or awaits network on the caller's
 * side: a lost batch is acceptable, a broken screen is not.
 *
 * Keep this module free of server-only imports; it ships to the browser.
 */

export const BEHAVIORAL_LOG_ENDPOINT = "/api/behavioral/log";

export interface BehavioralBatch {
  events: ValidatedBehavioralEvent[];
}

export type BehavioralSender = (batch: BehavioralBatch, options: { keepalive: boolean }) => Promise<boolean> | boolean;

export interface BehavioralQueueOptions {
  send: BehavioralSender;
  /** Session id attached to events that carry none. */
  getSessionId?: () => string | null;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  flushDelayMs?: number;
  flushAtSize?: number;
  maxBatchSize?: number;
  maxQueueLength?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface BehavioralQueue {
  /** Validates and queues one event. Returns false (and logs why) when it was dropped. Never throws. */
  track(input: BehavioralEventInput): boolean;
  /** Sends everything pending now. Resolves when the sends settle; never rejects. */
  flush(options?: { keepalive?: boolean }): Promise<void>;
  size(): number;
}

const noopLog = () => {};

function coalesceKey(event: ValidatedBehavioralEvent): string {
  const surface = typeof event.metadata?.surface === "string" ? event.metadata.surface : "";
  // Dwell on one feed entry stays distinct from dwell on another entry about the same person.
  const entry = typeof event.metadata?.entry_id === "string" ? event.metadata.entry_id : "";
  return `${event.personId}|${event.sessionId ?? ""}|${surface}|${entry}`;
}

export function createBehavioralQueue(options: BehavioralQueueOptions): BehavioralQueue {
  const {
    send,
    getSessionId = () => null,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    flushDelayMs = BEHAVIORAL_LIMITS.flushDelayMs,
    flushAtSize = BEHAVIORAL_LIMITS.flushAtSize,
    maxBatchSize = BEHAVIORAL_LIMITS.maxBatchSize,
    maxQueueLength = BEHAVIORAL_LIMITS.maxQueueLength,
    log = noopLog,
  } = options;

  const pending: ValidatedBehavioralEvent[] = [];
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const flush = (flushOptions: { keepalive?: boolean } = {}): Promise<void> => {
    cancelTimer();
    if (pending.length === 0) return inFlight ?? Promise.resolve();

    const batch = pending.splice(0, pending.length);
    const keepalive = flushOptions.keepalive ?? false;
    const run = (async () => {
      for (let start = 0; start < batch.length; start += maxBatchSize) {
        const events = batch.slice(start, start + maxBatchSize);
        try {
          const ok = await send({ events }, { keepalive });
          if (!ok) log("batch rejected", { events: events.length });
        } catch (error) {
          log("batch failed", { events: events.length, error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    inFlight = run;
    void run.then(() => {
      if (inFlight === run) inFlight = null;
    });
    return run;
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, flushDelayMs);
  };

  return {
    track(input) {
      try {
        const sessionId = input.sessionId ?? getSessionId() ?? null;
        const result = validateBehavioralEvent({ ...input, sessionId });
        if (!result.ok) {
          log("event dropped", { eventType: input?.eventType, reason: result.reason });
          return false;
        }
        const event = result.event;

        if (event.eventType === "time_spent") {
          const key = coalesceKey(event);
          const existing = pending.find((candidate) => candidate.eventType === "time_spent" && coalesceKey(candidate) === key);
          if (existing && existing.metadata && event.metadata) {
            const total = Number(existing.metadata.duration_ms ?? 0) + Number(event.metadata.duration_ms ?? 0);
            existing.metadata.duration_ms = Math.min(total, BEHAVIORAL_LIMITS.maxDurationMs);
            schedule();
            return true;
          }
        }

        if (pending.length >= maxQueueLength) {
          pending.shift();
          log("queue full, dropped oldest event");
        }
        pending.push(event);

        if (pending.length >= flushAtSize) void flush();
        else schedule();
        return true;
      } catch (error) {
        log("track failed", { error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    flush,
    size: () => pending.length,
  };
}

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

async function sendToApi(batch: BehavioralBatch, { keepalive }: { keepalive: boolean }): Promise<boolean> {
  const body = JSON.stringify(batch);

  // During unload, sendBeacon is the most reliable delivery; the route parses
  // the body as JSON whatever the content type.
  if (keepalive && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(BEHAVIORAL_LOG_ENDPOINT, new Blob([body], { type: "application/json" }))) return true;
    } catch {
      // fall through to fetch
    }
  }

  const response = await fetch(BEHAVIORAL_LOG_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body,
    keepalive,
  });
  return response.ok;
}

let browserQueue: BehavioralQueue | null = null;

function getBrowserQueue(): BehavioralQueue | null {
  if (typeof window === "undefined") return null;
  if (browserQueue) return browserQueue;

  browserQueue = createBehavioralQueue({
    send: sendToApi,
    getSessionId: getBehavioralSessionId,
    log: process.env.NODE_ENV === "development" ? (message, data) => console.debug(`[behavioral] ${message}`, data ?? "") : noopLog,
  });

  const flushForUnload = () => {
    void browserQueue?.flush({ keepalive: true });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushForUnload();
  });
  window.addEventListener("pagehide", flushForUnload);

  return browserQueue;
}

/**
 * Log one client-side interaction. Fire-and-forget: returns immediately,
 * never throws, and is a no-op on the server.
 */
export function trackEvent(input: BehavioralEventInput): void {
  try {
    getBrowserQueue()?.track(input);
  } catch {
    // never let logging break the UI
  }
}

/** Sends pending events now (e.g. before a client-side navigation you care about). */
export function flushBehavioralEvents(): Promise<void> {
  try {
    return getBrowserQueue()?.flush() ?? Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/**
 * Dwell-time helper. Call when a person becomes visible, call the returned
 * function when they stop being visible; a time_spent event is logged if the
 * dwell was at least 500 ms. In a Client Component:
 *
 *   useEffect(() => startDwell({ personId, surface: "profile" }), [personId]);
 */
export function startDwell(options: {
  personId: string;
  surface?: string;
  /** Extra metadata carried on the time_spent event (e.g. the feed entry the dwell belongs to). */
  metadata?: Record<string, unknown>;
  now?: () => number;
}): () => void {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const duration = now() - startedAt;
    if (duration < BEHAVIORAL_LIMITS.minDwellMs) return;
    trackEvent({
      eventType: "time_spent",
      personId: options.personId,
      metadata: {
        ...(options.metadata ?? {}),
        ...(options.surface ? { surface: options.surface } : {}),
        duration_ms: duration,
      },
    });
  };
}
