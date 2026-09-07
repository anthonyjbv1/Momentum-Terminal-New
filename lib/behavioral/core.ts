import type { TablesInsert } from "@/types/database";
import type { TypedSupabaseClient } from "@/types";

import {
  BEHAVIORAL_LIMITS,
  isUuid,
  validateBehavioralEvent,
  type BehavioralEventInput,
  type ValidatedBehavioralEvent,
} from "./events";

/**
 * The write path shared by the server-side logger (lib/behavioral/log.ts) and
 * the client-facing route (/api/behavioral/log). Pure orchestration: no
 * Next.js request APIs, so it is fully unit-testable. Nothing in here throws
 * at a caller: a failed log is reported in the result and otherwise dropped.
 */

export type BehavioralEventRow = Pick<
  TablesInsert<"behavioral_events">,
  "user_id" | "event_type" | "person_id" | "metadata" | "session_id"
>;

export interface BehavioralEventStore {
  /** Inserts rows that all belong to one user. Resolves to an error message or null. */
  insert(rows: BehavioralEventRow[]): Promise<{ error: string | null }>;
}

export interface DroppedEvent {
  index: number;
  reason: string;
}

export interface LogResult {
  /** Rows written. */
  accepted: number;
  /** Events rejected by validation or the batch cap, by position in the input. */
  dropped: DroppedEvent[];
  /** Set when storage failed: the validated events were lost. */
  error?: string;
}

export type BehavioralLogger = (message: string, data?: Record<string, unknown>) => void;

const defaultLog: BehavioralLogger = (message, data) => {
  console.warn(`[behavioral] ${message}`, data ?? "");
};

export function toRow(userId: string, event: ValidatedBehavioralEvent): BehavioralEventRow {
  return {
    user_id: userId,
    event_type: event.eventType,
    person_id: event.personId,
    metadata: event.metadata,
    session_id: event.sessionId,
  };
}

export interface PrepareOptions {
  /** Fallback session id for events that carry none. */
  sessionId?: string | null;
  maxBatchSize?: number;
}

/** Validates a batch for one user. Events past the batch cap are dropped, not stored. */
export function prepareBehavioralEvents(
  inputs: unknown[],
  userId: string,
  options: PrepareOptions = {},
): { rows: BehavioralEventRow[]; dropped: DroppedEvent[] } {
  const maxBatchSize = options.maxBatchSize ?? BEHAVIORAL_LIMITS.maxBatchSize;
  const rows: BehavioralEventRow[] = [];
  const dropped: DroppedEvent[] = [];

  inputs.forEach((input, index) => {
    if (index >= maxBatchSize) {
      dropped.push({ index, reason: `batch cap: only the first ${maxBatchSize} events of a request are stored` });
      return;
    }
    const result = validateBehavioralEvent(input, { sessionId: options.sessionId ?? null });
    if (result.ok) rows.push(toRow(userId, result.event));
    else dropped.push({ index, reason: result.reason });
  });

  return { rows, dropped };
}

export interface WriteOptions extends PrepareOptions {
  log?: BehavioralLogger;
}

/**
 * Validate + store. Never throws: storage failures come back as `error` with
 * `accepted: 0`, and are logged, because a dropped event is acceptable and a
 * broken user action is not.
 */
export async function writeBehavioralEvents(
  store: BehavioralEventStore,
  userId: string,
  inputs: BehavioralEventInput[] | unknown[],
  options: WriteOptions = {},
): Promise<LogResult> {
  const log = options.log ?? defaultLog;
  const { rows, dropped } = prepareBehavioralEvents(inputs, userId, options);
  if (dropped.length > 0) log("events dropped by validation", { userId, dropped });
  if (rows.length === 0) return { accepted: 0, dropped };

  try {
    const { error } = await store.insert(rows);
    if (error) {
      log("storage failed", { userId, rows: rows.length, error });
      return { accepted: 0, dropped, error };
    }
    return { accepted: rows.length, dropped };
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown.message : String(thrown);
    log("storage threw", { userId, rows: rows.length, error });
    return { accepted: 0, dropped, error };
  }
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/**
 * Supabase-backed store. Pass the cookie-based server client so the insert
 * runs as the signed-in user: Row Level Security then guarantees user_id can
 * only ever be that user, whatever the application layer does.
 */
export function createSupabaseBehavioralStore(client: TypedSupabaseClient): BehavioralEventStore {
  return {
    async insert(rows) {
      const { error } = await client.from("behavioral_events").insert(rows);
      return { error: error ? error.message : null };
    },
  };
}

export interface MemoryBehavioralStore extends BehavioralEventStore {
  rows: BehavioralEventRow[];
  /** Make the next insert fail with this message (returned) or throw (when `throwNext`). */
  failNext: string | null;
  throwNext: boolean;
}

/** In-memory store for tests. */
export function createMemoryBehavioralStore(): MemoryBehavioralStore {
  const store: MemoryBehavioralStore = {
    rows: [],
    failNext: null,
    throwNext: false,
    async insert(rows) {
      if (store.throwNext) {
        store.throwNext = false;
        throw new Error("store exploded");
      }
      if (store.failNext) {
        const error = store.failNext;
        store.failNext = null;
        return { error };
      }
      store.rows.push(...rows);
      return { error: null };
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Rate limiting (per server instance, best effort)
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** True when the key may proceed at `now`. */
  allow(key: string, now: number): boolean;
}

export interface RateLimiterOptions {
  maxPerWindow?: number;
  windowMs?: number;
  /** Keys tracked before old windows are pruned. */
  maxKeys?: number;
}

/**
 * Fixed-window counter per key. It lives in the memory of one server
 * instance, so on serverless it is a guard against a runaway client hitting
 * one instance, not a global quota. The real caps are the batch size, the
 * body size and the client-side debounce; this just stops a tight loop.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const maxPerWindow = options.maxPerWindow ?? 120;
  const windowMs = options.windowMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { startedAt: number; count: number }>();

  return {
    allow(key, now) {
      const current = windows.get(key);
      if (!current || now - current.startedAt >= windowMs) {
        if (windows.size >= maxKeys) {
          for (const [otherKey, window] of windows) {
            if (now - window.startedAt >= windowMs) windows.delete(otherKey);
          }
          if (windows.size >= maxKeys) windows.clear();
        }
        windows.set(key, { startedAt: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= maxPerWindow;
    },
  };
}

// ---------------------------------------------------------------------------
// The HTTP contract of POST /api/behavioral/log
// ---------------------------------------------------------------------------

export interface LogRequestInput {
  /** The verified signed-in user, or null. Never taken from the body. */
  user: { id: string } | null;
  rawBody: string;
  store: BehavioralEventStore;
  /** Session id from the mt_bsid cookie, used for events that carry none. */
  sessionId?: string | null;
  rateLimiter?: RateLimiter;
  now?: () => number;
  log?: BehavioralLogger;
  limits?: Pick<typeof BEHAVIORAL_LIMITS, "maxRequestBytes" | "maxBatchSize">;
}

export interface LogRequestOutput {
  status: 200 | 400 | 401 | 413 | 429 | 500;
  body: LogResult | { error: string };
}

function utf8Length(text: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
  return new TextEncoder().encode(text).length;
}

/**
 * Body shapes accepted:
 *   { events: [event, ...], sessionId? }   (what the client queue sends)
 *   [event, ...]
 *   event
 * Each event is { eventType, personId?, metadata?, sessionId? }.
 */
export async function handleBehavioralLogRequest(input: LogRequestInput): Promise<LogRequestOutput> {
  const { user, rawBody, store } = input;
  const limits = input.limits ?? BEHAVIORAL_LIMITS;
  const now = input.now ?? Date.now;

  if (!user) return { status: 401, body: { error: "Not signed in." } };

  if (input.rateLimiter && !input.rateLimiter.allow(user.id, now())) {
    return { status: 429, body: { error: "Too many logging requests." } };
  }

  if (utf8Length(rawBody) > limits.maxRequestBytes) {
    return { status: 413, body: { error: `Body exceeds ${limits.maxRequestBytes} bytes.` } };
  }

  let parsed: unknown;
  try {
    parsed = rawBody.trim() === "" ? null : JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Body must be JSON." } };
  }

  let events: unknown[];
  let bodySessionId: string | null = null;
  if (Array.isArray(parsed)) {
    events = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events)) {
    const envelope = parsed as { events: unknown[]; sessionId?: unknown };
    events = envelope.events;
    bodySessionId = isUuid(envelope.sessionId) ? envelope.sessionId : null;
  } else if (parsed && typeof parsed === "object") {
    events = [parsed];
  } else {
    return { status: 400, body: { error: "Body must be an event, an array of events, or { events: [...] }." } };
  }

  if (events.length === 0) return { status: 200, body: { accepted: 0, dropped: [] } };

  const result = await writeBehavioralEvents(store, user.id, events, {
    sessionId: bodySessionId ?? input.sessionId ?? null,
    maxBatchSize: limits.maxBatchSize,
    log: input.log,
  });
  return { status: result.error ? 500 : 200, body: result };
}
