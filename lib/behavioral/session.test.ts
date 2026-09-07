import { describe, expect, it } from "vitest";

import {
  BEHAVIORAL_SESSION_IDLE_MS,
  createSessionTracker,
  parseSessionCookie,
  serializeSessionCookie,
  sessionIdFromCookieValue,
  generateUuid,
  type SessionCookieStore,
} from "./session";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function memoryCookies(initial: string | null = null): SessionCookieStore & { value: string | null; writes: number } {
  const jar = {
    value: initial,
    writes: 0,
    read: () => jar.value,
    write: (value: string) => {
      jar.value = value;
      jar.writes += 1;
    },
  };
  return jar;
}

describe("session cookie format", () => {
  it("round-trips <uuid>.<lastActiveMs>", () => {
    const value = serializeSessionCookie({ id: ID_A, lastActiveAt: 1_700_000_000_000 });
    expect(value).toBe(`${ID_A}.1700000000000`);
    expect(parseSessionCookie(value)).toEqual({ id: ID_A, lastActiveAt: 1_700_000_000_000 });
  });

  it("rejects malformed values", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
    expect(parseSessionCookie(ID_A)).toBeNull();
    expect(parseSessionCookie("not-a-uuid.123")).toBeNull();
    expect(parseSessionCookie(`${ID_A}.soon`)).toBeNull();
  });

  it("sessionIdFromCookieValue honours the idle window", () => {
    const now = 10_000_000;
    expect(sessionIdFromCookieValue(`${ID_A}.${now - 1000}`, now)).toBe(ID_A);
    expect(sessionIdFromCookieValue(`${ID_A}.${now - BEHAVIORAL_SESSION_IDLE_MS - 1}`, now)).toBeNull();
    expect(sessionIdFromCookieValue(undefined, now)).toBeNull();
  });

  it("generateUuid produces v4 UUIDs", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const id = generateUuid();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
});

describe("createSessionTracker", () => {
  it("mints an id on first use and reuses it while active", () => {
    let now = 1_000_000;
    const ids = [ID_A, ID_B];
    const cookies = memoryCookies();
    const tracker = createSessionTracker({ cookies, now: () => now, randomUUID: () => ids.shift() ?? "" });

    expect(tracker.getSessionId()).toBe(ID_A);
    expect(cookies.value).toBe(`${ID_A}.1000000`);

    now += 5 * 60 * 1000;
    expect(tracker.getSessionId()).toBe(ID_A);
    expect(cookies.writes).toBe(2); // activity stamp refreshed after the touch interval
  });

  it("does not rewrite the cookie on every call", () => {
    let now = 1_000_000;
    const cookies = memoryCookies();
    const tracker = createSessionTracker({ cookies, now: () => now, randomUUID: () => ID_A });
    tracker.getSessionId();
    now += 1000;
    tracker.getSessionId();
    now += 1000;
    tracker.getSessionId();
    expect(cookies.writes).toBe(1);
  });

  it("rotates after the idle window and on reset", () => {
    let now = 1_000_000;
    const ids = [ID_A, ID_B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
    const cookies = memoryCookies();
    const tracker = createSessionTracker({ cookies, now: () => now, randomUUID: () => ids.shift() ?? "" });

    expect(tracker.getSessionId()).toBe(ID_A);
    now += BEHAVIORAL_SESSION_IDLE_MS + 1;
    expect(tracker.getSessionId()).toBe(ID_B);
    expect(tracker.reset()).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("adopts an existing fresh cookie (e.g. from another tab)", () => {
    const now = 5_000_000;
    const cookies = memoryCookies(`${ID_B}.${now - 60_000}`);
    const tracker = createSessionTracker({ cookies, now: () => now, randomUUID: () => ID_A });
    expect(tracker.getSessionId()).toBe(ID_B);
  });

  it("keeps a stable id in memory when cookies are blocked", () => {
    const blocked: SessionCookieStore = {
      read: () => {
        throw new Error("cookies disabled");
      },
      write: () => {
        throw new Error("cookies disabled");
      },
    };
    const tracker = createSessionTracker({ cookies: blocked, now: () => 1, randomUUID: generateUuid });
    const first = tracker.getSessionId();
    expect(tracker.getSessionId()).toBe(first);
  });
});
