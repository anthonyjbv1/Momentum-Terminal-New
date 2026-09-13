import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import type { RateLimiter } from "@/lib/rate-limit";

import { checkUsernameAvailability } from "./username-availability";

/**
 * Sign-up against real Postgres: the username check runs the real RPC as
 * the service role through the real rate limiter, the public roles cannot
 * call the RPC at all, and creating the auth user builds the profile. The
 * only piece not here is GoTrue itself, which the auth.users insert stands
 * in for (the on_auth_user_created trigger is what it drives).
 */

let database: TestDatabase;

/** supabase-js's rpc() shape over the test database, so the TypeScript check calls the real SQL functions. */
function rpcOver(db: TestDatabase) {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const names = Object.keys(args);
      const placeholders = names.map((name, index) => `${name} => $${index + 1}`).join(", ");
      try {
        const rows = await db.rows<{ result: unknown }>(`select public.${fn}(${placeholders}) as result`, names.map((name) => args[name]));
        return { data: rows[0]?.result ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}

function limiterOver(db: TestDatabase): RateLimiter {
  const client = rpcOver(db);
  return {
    async hit(key, limit, windowSeconds) {
      const { data, error } = await client.rpc("rate_limit_hit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
      if (error) throw new Error(error.message);
      const record = data as Record<string, unknown>;
      return { allowed: record.allowed === true, remaining: Number(record.remaining), retryAfterSeconds: Number(record.retry_after_seconds) };
    },
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe("username_available", () => {
  it("is executable by the service role only", async () => {
    const [grants] = await database.rows<{ anon: boolean; authenticated: boolean; service: boolean }>(
      "select has_function_privilege('anon', 'public.username_available(text)', 'execute') as anon, has_function_privilege('authenticated', 'public.username_available(text)', 'execute') as authenticated, has_function_privilege('service_role', 'public.username_available(text)', 'execute') as service",
    );
    expect(grants).toEqual({ anon: false, authenticated: false, service: true });
    await database.exec("begin; set local role anon");
    await expect(database.rows("select public.username_available('anyone')")).rejects.toThrow(/permission denied/);
    await database.exec("rollback");
    await database.exec("begin; set local role authenticated");
    await expect(database.rows("select public.username_available('anyone')")).rejects.toThrow(/permission denied/);
    await database.exec("rollback");
  });
});

describe("rate_limit_hit", () => {
  it("counts a fixed window per key, refuses past the limit with a retry time, and starts over when the window ends", async () => {
    const limiter = limiterOver(database);
    for (let i = 1; i <= 3; i += 1) expect(await limiter.hit("t:a", 3, 60)).toEqual({ allowed: true, remaining: 3 - i, retryAfterSeconds: 0 });
    const refused = await limiter.hit("t:a", 3, 60);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(59);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(await limiter.hit("t:b", 3, 60)).toMatchObject({ allowed: true, remaining: 2 });
    // Age the window out and the next hit opens a fresh one.
    await database.exec("update public.rate_limit_buckets set window_started_at = now() - interval '61 seconds' where key = 't:a'");
    expect(await limiter.hit("t:a", 3, 60)).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
    // Bad arguments are refused, and the public roles cannot call it.
    await expect(limiter.hit("", 3, 60)).rejects.toThrow(/key is required/);
    await expect(limiter.hit("t:c", 0, 60)).rejects.toThrow(/positive/);
    const [grants] = await database.rows<{ anon: boolean; authenticated: boolean }>(
      "select has_function_privilege('anon', 'public.rate_limit_hit(text, integer, integer)', 'execute') as anon, has_function_privilege('authenticated', 'public.rate_limit_hit(text, integer, integer)', 'execute') as authenticated",
    );
    expect(grants).toEqual({ anon: false, authenticated: false });
    const [table] = await database.rows<{ anon: boolean; authenticated: boolean }>("select has_table_privilege('anon', 'public.rate_limit_buckets', 'select') as anon, has_table_privilege('authenticated', 'public.rate_limit_buckets', 'select') as authenticated");
    expect(table).toEqual({ anon: false, authenticated: false });
  });
});

describe("a full unauthenticated sign-up", () => {
  const ip = "203.0.113.42";

  it("checks the username, creates the account, and the name is taken from then on", async () => {
    const client = rpcOver(database);
    const limiter = limiterOver(database);

    // 1. The form's username check, signed out, through the real RPC and limiter.
    expect(await checkUsernameAvailability("new_member", ip, { client: client as never, limiter })).toEqual({ ok: true, available: true });
    expect(await checkUsernameAvailability("New_Member", ip, { client: client as never, limiter })).toEqual({ ok: true, available: true });

    // 2. auth.signUp: GoTrue inserts the auth user with the form's metadata; the trigger builds the profile.
    const [{ id }] = await database.rows<{ id: string }>(
      "insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id",
      ["new.member@example.test", JSON.stringify({ username: "new_member", display_name: "New Member" })],
    );
    const [profile] = await database.rows<{ username: string; display_name: string; wallet_balance_cents: string | number; email: string }>(
      "select username, display_name, wallet_balance_cents, email from public.users where id = $1",
      [id],
    );
    expect(profile).toMatchObject({ username: "new_member", display_name: "New Member", email: "new.member@example.test" });
    expect(Number(profile.wallet_balance_cents)).toBe(1_000_000);
    const [deposit] = await database.rows<{ n: string | number }>("select count(*) as n from public.transactions where user_id = $1 and type = 'DEPOSIT'", [id]);
    expect(Number(deposit.n)).toBe(1);

    // 3. The next person asking for that name is told it is taken, in any case.
    expect(await checkUsernameAvailability("new_member", ip, { client: client as never, limiter })).toEqual({ ok: true, available: false });
    expect(await checkUsernameAvailability("NEW_MEMBER", ip, { client: client as never, limiter })).toEqual({ ok: true, available: false });
  });

  it("cannot be walked: the per-IP limit closes after twenty checks in ten minutes", async () => {
    const client = rpcOver(database);
    const limiter = limiterOver(database);
    const walker = "198.51.100.7";
    let allowed = 0;
    for (let i = 0; i < 25; i += 1) {
      const result = await checkUsernameAvailability(`probe_${i}`, walker, { client: client as never, limiter });
      if (result.ok) allowed += 1;
      else expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
    }
    expect(allowed).toBe(20);
    // A different address is unaffected.
    expect(await checkUsernameAvailability("probe_x", "198.51.100.8", { client: client as never, limiter })).toEqual({ ok: true, available: true });
  });
});
