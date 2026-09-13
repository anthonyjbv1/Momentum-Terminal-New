import type { TypedSupabaseClient } from "@/types";

/**
 * A fixed-window rate limiter keyed by string (an IP, a user, a route), for
 * the few public entry points that can be walked: the username check on
 * sign-up is the first.
 *
 * The production limiter lives in the database (rate_limit_hit, service
 * role only), so the count holds across serverless instances; an
 * in-memory one serves tests. Both answer the same question: is this hit
 * allowed, how many remain in the window, and if not, when to retry.
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
}

function toDecision(value: unknown): RateLimitDecision {
  const record = (value ?? {}) as Record<string, unknown>;
  const allowed = record.allowed === true;
  const remaining = typeof record.remaining === "number" ? record.remaining : 0;
  const retry = typeof record.retry_after_seconds === "number" ? record.retry_after_seconds : 0;
  return { allowed, remaining: Math.max(0, remaining), retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(retry)) };
}

/** Counts in the database through the service-role RPC. Throws on a database error; callers decide what a failure means. */
export function createSupabaseRateLimiter(client: TypedSupabaseClient): RateLimiter {
  return {
    async hit(key, limit, windowSeconds) {
      const { data, error } = await client.rpc("rate_limit_hit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
      if (error) throw new Error(`rate_limit_hit failed: ${error.message}`);
      return toDecision(data);
    },
  };
}

export interface MemoryRateLimiter extends RateLimiter {
  readonly buckets: Map<string, { windowStartedAt: number; hits: number }>;
}

/** The same arithmetic in memory, with an injectable clock, for tests and local runs. */
export function createMemoryRateLimiter(now: () => number = Date.now): MemoryRateLimiter {
  const buckets = new Map<string, { windowStartedAt: number; hits: number }>();
  return {
    buckets,
    async hit(key, limit, windowSeconds) {
      const time = now();
      const windowMs = windowSeconds * 1000;
      const bucket = buckets.get(key);
      const fresh = !bucket || bucket.windowStartedAt + windowMs <= time;
      const next = fresh ? { windowStartedAt: time, hits: 1 } : { windowStartedAt: bucket.windowStartedAt, hits: bucket.hits + 1 };
      buckets.set(key, next);
      const allowed = next.hits <= limit;
      return {
        allowed,
        remaining: Math.max(0, limit - next.hits),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((next.windowStartedAt + windowMs - time) / 1000)),
      };
    },
  };
}
