import { describe, expect, it } from "vitest";

import { createMemoryRateLimiter } from "@/lib/rate-limit";

import { WAITLIST_RATE_LIMIT, WAITLIST_SOURCES, joinWaitlist, parseWaitlistBody, toWaitlistResponse, type WaitlistSubmission } from "./waitlist";

/**
 * The waitlist's logic (Phase 28), the four cases the phase has to show:
 * a new address, a duplicate, a honeypot-filled submission, the rate limit.
 * Pure: the limiter is in memory and the join is a fake; the SQL behind the
 * real one is tested in waitlist.db.test.ts.
 */

function submission(overrides: Partial<WaitlistSubmission> = {}): WaitlistSubmission {
  return { email: "person@example.com", source: "landing_hero", utm: {}, referrer: null, honeypot: "", ...overrides };
}

describe("parseWaitlistBody", () => {
  it("lowercases and trims the address, refuses anything that is not one", () => {
    expect(parseWaitlistBody(null)).toBe("The request must be a JSON object.");
    expect(parseWaitlistBody("person@example.com")).toBe("The request must be a JSON object.");
    expect(parseWaitlistBody({})).toBe("invalid");
    expect(parseWaitlistBody({ email: "nope" })).toBe("invalid");
    expect(parseWaitlistBody({ email: "a@b" })).toBe("invalid");
    expect(parseWaitlistBody({ email: "a b@example.com" })).toBe("invalid");
    expect(parseWaitlistBody({ email: `${"a".repeat(250)}@example.com` })).toBe("invalid");
    const parsed = parseWaitlistBody({ email: "  Person@Example.COM " });
    expect(parsed).toMatchObject({ email: "person@example.com", source: "landing_hero", utm: {}, referrer: null, honeypot: "" });
  });

  it("keeps a known form name, defaults an unknown one, and bounds the campaign fields", () => {
    expect(WAITLIST_SOURCES).toEqual(["landing_hero", "landing_footer"]);
    expect(parseWaitlistBody({ email: "p@example.com", source: "landing_footer" })).toMatchObject({ source: "landing_footer" });
    expect(parseWaitlistBody({ email: "p@example.com", source: "admin_import" })).toMatchObject({ source: "landing_hero" });
    const parsed = parseWaitlistBody({
      email: "p@example.com",
      utm: { source: " x ", medium: "", campaign: "c".repeat(200), junk: "dropped", term: 5 },
      referrer: `https://news.example/${"p".repeat(600)}`,
      website: "http://spam.example",
    }) as WaitlistSubmission;
    expect(parsed.utm).toEqual({ source: "x", campaign: "c".repeat(128) });
    expect(parsed.referrer).toHaveLength(512);
    expect(parsed.honeypot).toBe("http://spam.example");
  });
});

describe("joinWaitlist", () => {
  const deps = (join = async () => ({ created: true, position: 1 })) => {
    let clock = 0;
    const limiter = createMemoryRateLimiter(() => clock);
    const calls: WaitlistSubmission[] = [];
    return {
      limiter,
      calls,
      ip: "203.0.113.7",
      join: async (input: WaitlistSubmission) => {
        calls.push(input);
        return join();
      },
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };

  it("a new address: joined, with its real position", async () => {
    const d = deps(async () => ({ created: true, position: 42 }));
    const result = await joinWaitlist(submission(), d);
    expect(result).toEqual({ outcome: { ok: true, position: 42 }, disposition: "new" });
    expect(d.calls).toHaveLength(1);
  });

  it("a duplicate: the same success as a new one, with the position it already holds", async () => {
    const d = deps(async () => ({ created: false, position: 7 }));
    const result = await joinWaitlist(submission(), d);
    expect(result).toEqual({ outcome: { ok: true, position: 7 }, disposition: "existing" });
    // The visitor cannot tell: the response bodies are identical in shape.
    expect(Object.keys(toWaitlistResponse(result.outcome).body)).toEqual(Object.keys(toWaitlistResponse({ ok: true, position: 42 }).body));
  });

  it("a honeypot-filled submission: dropped before the limit and the database, behind a success that gives nothing away", async () => {
    const d = deps();
    const result = await joinWaitlist(submission({ honeypot: "http://spam.example" }), d);
    expect(result).toEqual({ outcome: { ok: true, position: null }, disposition: "dropped" });
    expect(d.calls).toHaveLength(0);
    expect(d.limiter.buckets.size).toBe(0);
    expect(toWaitlistResponse(result.outcome)).toMatchObject({ status: 200, body: { ok: true, position: null } });
  });

  it("the rate limit: five in ten minutes per address, then 429 with a retry-after, then open again", async () => {
    expect(WAITLIST_RATE_LIMIT).toEqual({ limit: 5, windowSeconds: 600 });
    const d = deps();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await joinWaitlist(submission({ email: `p${attempt}@example.com` }), d);
      expect(result.disposition, `attempt ${attempt}`).toBe("new");
    }
    const sixth = await joinWaitlist(submission({ email: "p6@example.com" }), d);
    expect(sixth.disposition).toBe("rate_limited");
    expect(sixth.outcome).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 600 });
    expect(d.calls).toHaveLength(5);
    const response = toWaitlistResponse(sixth.outcome);
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("600");
    expect(response.headers["cache-control"]).toBe("no-store");
    // Another address is not affected; the same one is free again after the window.
    const other = await joinWaitlist(submission(), { ...d, ip: "198.51.100.9" });
    expect(other.disposition).toBe("new");
    d.advance(600_000);
    expect((await joinWaitlist(submission(), d)).disposition).toBe("new");
  });

  it("a database failure is 503 and 'nothing was saved', whether the limiter or the join threw", async () => {
    const broken = deps(async () => {
      throw new Error("connection refused");
    });
    const joinFailed = await joinWaitlist(submission(), broken);
    expect(joinFailed).toEqual({ outcome: { ok: false, code: "unavailable" }, disposition: "failed" });
    expect(toWaitlistResponse(joinFailed.outcome)).toMatchObject({ status: 503, body: { ok: false, code: "unavailable" } });

    const limiterFailed = await joinWaitlist(submission(), {
      ...deps(),
      limiter: {
        hit: async () => {
          throw new Error("rate_limit_hit failed");
        },
      },
    });
    expect(limiterFailed).toEqual({ outcome: { ok: false, code: "unavailable" }, disposition: "failed" });
  });

  it("an invalid address is 400", () => {
    expect(toWaitlistResponse({ ok: false, code: "invalid" })).toMatchObject({ status: 400, body: { ok: false, code: "invalid" } });
  });
});
