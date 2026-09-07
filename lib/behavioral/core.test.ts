import { describe, expect, it, vi } from "vitest";

import {
  createMemoryBehavioralStore,
  createRateLimiter,
  handleBehavioralLogRequest,
  prepareBehavioralEvents,
  writeBehavioralEvents,
} from "./core";
import { BEHAVIORAL_LIMITS } from "./events";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSON = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

const silent = () => {};

describe("prepareBehavioralEvents", () => {
  it("stamps the acting user on every row and never the one in the payload", () => {
    const { rows, dropped } = prepareBehavioralEvents(
      [
        { eventType: "view_person", personId: PERSON, userId: OTHER, user_id: OTHER },
        { eventType: "search", metadata: { query: "drake" } },
      ],
      USER,
      { sessionId: SESSION },
    );
    expect(dropped).toEqual([]);
    expect(rows).toEqual([
      { user_id: USER, event_type: "view_person", person_id: PERSON, metadata: null, session_id: SESSION },
      { user_id: USER, event_type: "search", person_id: null, metadata: { query: "drake" }, session_id: SESSION },
    ]);
  });

  it("reports invalid events by index and keeps the valid ones", () => {
    const { rows, dropped } = prepareBehavioralEvents(
      [{ eventType: "view_person" }, { eventType: "view_feed" }, { eventType: "nope" }, "garbage"],
      USER,
    );
    expect(rows.map((row) => row.event_type)).toEqual(["view_feed"]);
    expect(dropped).toEqual([
      { index: 0, reason: "view_person requires personId" },
      { index: 2, reason: 'unknown eventType "nope"' },
      { index: 3, reason: "event must be an object" },
    ]);
  });

  it("applies the batch cap", () => {
    const inputs = Array.from({ length: BEHAVIORAL_LIMITS.maxBatchSize + 5 }, () => ({ eventType: "view_feed" }));
    const { rows, dropped } = prepareBehavioralEvents(inputs, USER);
    expect(rows).toHaveLength(BEHAVIORAL_LIMITS.maxBatchSize);
    expect(dropped).toHaveLength(5);
    expect(dropped[0]).toEqual({ index: BEHAVIORAL_LIMITS.maxBatchSize, reason: expect.stringContaining("batch cap") });
  });
});

describe("writeBehavioralEvents", () => {
  it("writes valid rows and reports the rest", async () => {
    const store = createMemoryBehavioralStore();
    const result = await writeBehavioralEvents(store, USER, [{ eventType: "view_feed" }, { eventType: "view_person" }], { log: silent });
    expect(result).toEqual({ accepted: 1, dropped: [{ index: 1, reason: "view_person requires personId" }] });
    expect(store.rows).toHaveLength(1);
  });

  it("does not touch the store when nothing is valid", async () => {
    const store = createMemoryBehavioralStore();
    const insert = vi.spyOn(store, "insert");
    const result = await writeBehavioralEvents(store, USER, [{ eventType: "swipe", personId: PERSON }], { log: silent });
    expect(result.accepted).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("never throws: a failing or exploding store becomes a result with error", async () => {
    const store = createMemoryBehavioralStore();
    const log = vi.fn();

    store.failNext = "connection refused";
    const failed = await writeBehavioralEvents(store, USER, [{ eventType: "view_feed" }], { log });
    expect(failed).toEqual({ accepted: 0, dropped: [], error: "connection refused" });

    store.throwNext = true;
    const threw = await writeBehavioralEvents(store, USER, [{ eventType: "view_feed" }], { log });
    expect(threw).toEqual({ accepted: 0, dropped: [], error: "store exploded" });

    expect(log).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(0);
  });
});

describe("createRateLimiter", () => {
  it("allows up to maxPerWindow per key per window, then resets", () => {
    const limiter = createRateLimiter({ maxPerWindow: 3, windowMs: 1000 });
    expect([1, 2, 3, 4].map((n) => limiter.allow("u1", n))).toEqual([true, true, true, false]);
    expect(limiter.allow("u2", 5)).toBe(true);
    expect(limiter.allow("u1", 1001)).toBe(true);
  });
});

describe("handleBehavioralLogRequest", () => {
  const events = [
    { eventType: "view_person", personId: PERSON },
    { eventType: "time_spent", personId: PERSON, metadata: { duration_ms: 1500 } },
  ];

  it("rejects anonymous callers before reading the body", async () => {
    const store = createMemoryBehavioralStore();
    const result = await handleBehavioralLogRequest({ user: null, rawBody: JSON.stringify({ events }), store, log: silent });
    expect(result).toEqual({ status: 401, body: { error: "Not signed in." } });
    expect(store.rows).toHaveLength(0);
  });

  it("stores a batch as the signed-in user, defaulting the session from the cookie", async () => {
    const store = createMemoryBehavioralStore();
    const result = await handleBehavioralLogRequest({
      user: { id: USER },
      rawBody: JSON.stringify({ events: [...events, { eventType: "view_feed", userId: OTHER }] }),
      store,
      sessionId: SESSION,
      log: silent,
    });
    expect(result).toEqual({ status: 200, body: { accepted: 3, dropped: [] } });
    expect(store.rows.every((row) => row.user_id === USER && row.session_id === SESSION)).toBe(true);
  });

  it("prefers the envelope's sessionId over the cookie", async () => {
    const store = createMemoryBehavioralStore();
    const other = "33333333-3333-4333-8333-333333333333";
    await handleBehavioralLogRequest({
      user: { id: USER },
      rawBody: JSON.stringify({ events: [{ eventType: "view_feed" }], sessionId: other }),
      store,
      sessionId: SESSION,
      log: silent,
    });
    expect(store.rows[0].session_id).toBe(other);
  });

  it("accepts a bare array and a single event", async () => {
    const store = createMemoryBehavioralStore();
    const asArray = await handleBehavioralLogRequest({ user: { id: USER }, rawBody: JSON.stringify(events), store, log: silent });
    const single = await handleBehavioralLogRequest({ user: { id: USER }, rawBody: JSON.stringify(events[0]), store, log: silent });
    expect(asArray.body).toEqual({ accepted: 2, dropped: [] });
    expect(single.body).toEqual({ accepted: 1, dropped: [] });
  });

  it("returns 400 on malformed bodies and 200 on an empty batch", async () => {
    const store = createMemoryBehavioralStore();
    const base = { user: { id: USER }, store, log: silent };
    expect((await handleBehavioralLogRequest({ ...base, rawBody: "{not json" })).status).toBe(400);
    expect((await handleBehavioralLogRequest({ ...base, rawBody: "42" })).status).toBe(400);
    expect((await handleBehavioralLogRequest({ ...base, rawBody: "" })).status).toBe(400);
    expect(await handleBehavioralLogRequest({ ...base, rawBody: JSON.stringify({ events: [] }) })).toEqual({
      status: 200,
      body: { accepted: 0, dropped: [] },
    });
  });

  it("returns 413 for oversized bodies and 429 when the limiter says no", async () => {
    const store = createMemoryBehavioralStore();
    const big = await handleBehavioralLogRequest({
      user: { id: USER },
      rawBody: JSON.stringify({ events: [{ eventType: "view_feed", metadata: { note: "x".repeat(200) } }] }),
      store,
      limits: { maxRequestBytes: 100, maxBatchSize: 50 },
      log: silent,
    });
    expect(big.status).toBe(413);

    const limited = await handleBehavioralLogRequest({
      user: { id: USER },
      rawBody: JSON.stringify(events),
      store,
      rateLimiter: { allow: () => false },
      log: silent,
    });
    expect(limited.status).toBe(429);
    expect(store.rows).toHaveLength(0);
  });

  it("caps the batch and reports the overflow", async () => {
    const store = createMemoryBehavioralStore();
    const many = Array.from({ length: 60 }, () => ({ eventType: "view_feed" }));
    const result = await handleBehavioralLogRequest({ user: { id: USER }, rawBody: JSON.stringify(many), store, log: silent });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: BEHAVIORAL_LIMITS.maxBatchSize });
    expect((result.body as { dropped: unknown[] }).dropped).toHaveLength(10);
  });

  it("returns 500 with the result when storage fails", async () => {
    const store = createMemoryBehavioralStore();
    store.failNext = "db down";
    const result = await handleBehavioralLogRequest({ user: { id: USER }, rawBody: JSON.stringify(events), store, log: silent });
    expect(result).toEqual({ status: 500, body: { accepted: 0, dropped: [], error: "db down" } });
  });
});
