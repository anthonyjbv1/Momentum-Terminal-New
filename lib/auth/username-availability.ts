import "server-only";

import { createSupabaseRateLimiter, type RateLimiter } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import type { TypedSupabaseClient } from "@/types";

/**
 * The username check behind sign-up.
 *
 * It runs on the server with the service-role client: the username_available
 * RPC is no longer executable by anon or authenticated, so the only way to
 * ask whether a username is taken is through this function, and this
 * function is rate limited per client IP. A signed-out visitor can still
 * sign up (the form needs no session), but nobody can walk the RPC to
 * enumerate registered usernames.
 *
 * The limit is modest: a person trying a few usernames never meets it.
 */

export const USERNAME_CHECK_LIMIT = 20;
export const USERNAME_CHECK_WINDOW_SECONDS = 600;
export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

export type UsernameAvailability =
  | { ok: true; available: boolean }
  | { ok: false; reason: "invalid" | "rate_limited" | "unavailable"; retryAfterSeconds?: number };

export interface UsernameAvailabilityDeps {
  /** Executes username_available. Defaults to the service-role client. */
  client?: Pick<TypedSupabaseClient, "rpc">;
  limiter?: RateLimiter;
}

/** The client's IP from the proxy headers, or "unknown" (one shared bucket) when none is present. */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  const real = headers.get("x-real-ip")?.trim();
  return real || "unknown";
}

export async function checkUsernameAvailability(username: string, clientIp: string, deps: UsernameAvailabilityDeps = {}): Promise<UsernameAvailability> {
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) return { ok: false, reason: "invalid" };

  let client = deps.client;
  let limiter = deps.limiter;
  try {
    if (!client || !limiter) {
      const admin = createSupabaseAdminClient();
      client ??= admin;
      limiter ??= createSupabaseRateLimiter(admin);
    }
    const decision = await limiter.hit(`username_check:${clientIp}`, USERNAME_CHECK_LIMIT, USERNAME_CHECK_WINDOW_SECONDS);
    if (!decision.allowed) return { ok: false, reason: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds };

    const { data, error } = await client.rpc("username_available", { p_username: normalized });
    if (error) {
      console.error("[signup] username_available RPC failed:", error.message);
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, available: Boolean(data) };
  } catch (error) {
    console.error("[signup] username check failed:", error instanceof Error ? error.message : error);
    return { ok: false, reason: "unavailable" };
  }
}
