import { describe, expect, it } from "vitest";

import { checkUsernameAvailability, clientIpFrom, USERNAME_CHECK_LIMIT, USERNAME_CHECK_WINDOW_SECONDS } from "./auth/username-availability";
import { createMemoryRateLimiter } from "./rate-limit";

/** The fixed-window limiter's arithmetic, and the username check's use of it. */

describe("createMemoryRateLimiter", () => {
  it("allows up to the limit in a window, then refuses with a retry time, per key", async () => {
    let now = 1_000_000;
    const limiter = createMemoryRateLimiter(() => now);
    for (let i = 1; i <= 3; i += 1) {
      expect(await limiter.hit("ip:a", 3, 60)).toEqual({ allowed: true, remaining: 3 - i, retryAfterSeconds: 0 });
    }
    now += 10_000;
    expect(await limiter.hit("ip:a", 3, 60)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 50 });
    expect(await limiter.hit("ip:b", 3, 60)).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
    // A new window starts once the old one has run out.
    now += 50_000;
    expect(await limiter.hit("ip:a", 3, 60)).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
  });
});

describe("clientIpFrom", () => {
  it("takes the first forwarded address, then x-real-ip, then a shared bucket", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIpFrom(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIpFrom(new Headers())).toBe("unknown");
  });
});

describe("checkUsernameAvailability", () => {
  const taken = new Set(["drake_fan", "mrbeast"]);
  const client = {
    calls: [] as string[],
    async rpc(_fn: string, args: { p_username: string }) {
      client.calls.push(args.p_username);
      return { data: !taken.has(args.p_username), error: null };
    },
  };

  it("answers taken or free, normalising case and whitespace, and never touches the limiter for an invalid name", async () => {
    const limiter = createMemoryRateLimiter();
    expect(await checkUsernameAvailability("  NewPerson ", "1.1.1.1", { client: client as never, limiter })).toEqual({ ok: true, available: true });
    expect(await checkUsernameAvailability("Drake_Fan", "1.1.1.1", { client: client as never, limiter })).toEqual({ ok: true, available: false });
    expect(client.calls).toEqual(["newperson", "drake_fan"]);
    expect(await checkUsernameAvailability("no spaces", "1.1.1.1", { client: client as never, limiter })).toEqual({ ok: false, reason: "invalid" });
    expect(await checkUsernameAvailability("ab", "1.1.1.1", { client: client as never, limiter })).toEqual({ ok: false, reason: "invalid" });
    expect(limiter.buckets.get("username_check:1.1.1.1")?.hits).toBe(2);
  });

  it("refuses beyond the per-IP limit without asking the database, and other addresses are unaffected", async () => {
    expect(USERNAME_CHECK_LIMIT).toBe(20);
    expect(USERNAME_CHECK_WINDOW_SECONDS).toBe(600);
    const limiter = createMemoryRateLimiter();
    client.calls.length = 0;
    for (let i = 0; i < USERNAME_CHECK_LIMIT; i += 1) {
      expect((await checkUsernameAvailability(`probe_${i}`, "2.2.2.2", { client: client as never, limiter })).ok).toBe(true);
    }
    const refused = await checkUsernameAvailability("probe_more", "2.2.2.2", { client: client as never, limiter });
    expect(refused).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((refused as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(client.calls).toHaveLength(USERNAME_CHECK_LIMIT);
    expect(await checkUsernameAvailability("probe_more", "3.3.3.3", { client: client as never, limiter })).toEqual({ ok: true, available: true });
  });

  it("reports a database failure as unavailable rather than guessing", async () => {
    const failing = { async rpc() { return { data: null, error: { message: "Invalid API key" } }; } };
    const result = await checkUsernameAvailability("someone", "4.4.4.4", { client: failing as never, limiter: createMemoryRateLimiter() });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
