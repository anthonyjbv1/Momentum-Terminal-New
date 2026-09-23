import type { RateLimiter } from "@/lib/rate-limit";

/**
 * Joining the waitlist: what the route accepts, what it refuses, and what it
 * tells the visitor — as pure logic over injected dependencies, so the four
 * cases the phase has to show (new, duplicate, honeypot, rate limit) are
 * tests rather than claims.
 *
 * IDEMPOTENT AND NON-ENUMERATING. A known address and a new one get the same
 * success. The honeypot gets the same success too (minus the position, which
 * would have to be invented) so a bot learns nothing from the difference.
 * Only the server's own log records which it was.
 */

export const WAITLIST_SOURCES = ["landing_hero", "landing_footer"] as const;
export type WaitlistSource = (typeof WAITLIST_SOURCES)[number];

/** Per IP: five attempts in ten minutes. Enough for a typo, not for a list. */
export const WAITLIST_RATE_LIMIT = { limit: 5, windowSeconds: 600 } as const;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL = 254;
const MAX_UTM = 128;
const MAX_REFERRER = 512;

export interface WaitlistSubmission {
  email: string;
  source: WaitlistSource;
  utm: Partial<Record<"source" | "medium" | "campaign" | "content" | "term", string>>;
  referrer: string | null;
  /** The honeypot's value. Anything at all means a bot filled the hidden field. */
  honeypot: string;
}

export function isValidEmail(value: string): boolean {
  return value.length <= MAX_EMAIL && EMAIL.test(value);
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** The request body → a submission, or the sentence to refuse it with. */
export function parseWaitlistBody(body: unknown): WaitlistSubmission | string {
  if (typeof body !== "object" || body === null) return "The request must be a JSON object.";
  const record = body as Record<string, unknown>;
  const email = clean(record.email, MAX_EMAIL + 1)?.toLowerCase() ?? "";
  if (!isValidEmail(email)) return "invalid";
  const source = (WAITLIST_SOURCES as readonly string[]).includes(String(record.source)) ? (record.source as WaitlistSource) : "landing_hero";
  const utmRecord = typeof record.utm === "object" && record.utm !== null ? (record.utm as Record<string, unknown>) : {};
  const utm: WaitlistSubmission["utm"] = {};
  for (const key of ["source", "medium", "campaign", "content", "term"] as const) {
    const value = clean(utmRecord[key], MAX_UTM);
    if (value) utm[key] = value;
  }
  return {
    email,
    source,
    utm,
    referrer: clean(record.referrer, MAX_REFERRER),
    // A honeypot that is missing is fine (an older page); one that is filled is not.
    honeypot: typeof record.website === "string" ? record.website : "",
  };
}

export type WaitlistOutcome =
  | { ok: true; position: number | null }
  | { ok: false; code: "invalid" | "rate_limited" | "unavailable"; retryAfterSeconds?: number };

/** What the server logs about a submission — never shown to the visitor. */
export type WaitlistDisposition = "new" | "existing" | "dropped" | "rate_limited" | "invalid" | "failed";

export interface JoinResult {
  created: boolean;
  position: number;
}

export interface WaitlistDeps {
  limiter: RateLimiter;
  /** The join_waitlist() call. Throws on a database error. */
  join: (submission: WaitlistSubmission) => Promise<JoinResult>;
  /** The caller's address, for the limit. */
  ip: string;
}

export async function joinWaitlist(submission: WaitlistSubmission, deps: WaitlistDeps): Promise<{ outcome: WaitlistOutcome; disposition: WaitlistDisposition }> {
  // THE HONEYPOT FIRST, before the limit and before the database: a bot that
  // filled the hidden field costs nothing and learns nothing.
  if (submission.honeypot.trim() !== "") {
    return { outcome: { ok: true, position: null }, disposition: "dropped" };
  }

  let decision;
  try {
    decision = await deps.limiter.hit(`waitlist:${deps.ip}`, WAITLIST_RATE_LIMIT.limit, WAITLIST_RATE_LIMIT.windowSeconds);
  } catch {
    // The limiter is the database; if it is down the join is too.
    return { outcome: { ok: false, code: "unavailable" }, disposition: "failed" };
  }
  if (!decision.allowed) {
    return { outcome: { ok: false, code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds }, disposition: "rate_limited" };
  }

  try {
    const result = await deps.join(submission);
    return { outcome: { ok: true, position: result.position }, disposition: result.created ? "new" : "existing" };
  } catch {
    return { outcome: { ok: false, code: "unavailable" }, disposition: "failed" };
  }
}

/** The one shape the route answers with, so a new and a known address are indistinguishable. */
export function toWaitlistResponse(outcome: WaitlistOutcome): { body: Record<string, unknown>; status: number; headers: Record<string, string> } {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (outcome.ok) return { body: { ok: true, position: outcome.position }, status: 200, headers };
  if (outcome.code === "rate_limited") {
    if (outcome.retryAfterSeconds) headers["retry-after"] = String(outcome.retryAfterSeconds);
    return { body: { ok: false, code: outcome.code }, status: 429, headers };
  }
  return { body: { ok: false, code: outcome.code }, status: outcome.code === "invalid" ? 400 : 503, headers };
}
