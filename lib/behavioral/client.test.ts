import { describe, expect, it, vi } from "vitest";

import { createBehavioralQueue, type BehavioralBatch } from "./client";
import { BEHAVIORAL_LIMITS } from "./events";

const PERSON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

/** Deterministic timer + clock so the debounce can be driven by hand. */
function fakeScheduler() {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; handle: number }> = [];
  let nextHandle = 1;
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.push({ at: now + ms, callback, handle });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index !== -1) timers.splice(index, 1);
    },
    pending: () => timers.length,
    async advance(ms: number) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function setup(overrides: Partial<Parameters<typeof createBehavioralQueue>[0]> = {}) {
  const scheduler = fakeScheduler();
  const sent: Array<{ batch: BehavioralBatch; keepalive: boolean }> = [];
  const send = vi.fn(async (batch: BehavioralBatch, options: { keepalive: boolean }) => {
    sent.push({ batch, keepalive: options.keepalive });
    return true;
  });
  const queue = createBehavioralQueue({
    send,
    getSessionId: () => SESSION,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    ...overrides,
  });
  return { queue, scheduler, send, sent };
}

describe("createBehavioralQueue", () => {
  it("debounces: sends one batch after the flush delay, tagged with the session", async () => {
    const { queue, scheduler, sent } = setup();
    expect(queue.track({ eventType: "view_person", personId: PERSON })).toBe(true);
    expect(queue.track({ eventType: "view_feed" })).toBe(true);
    expect(sent).toHaveLength(0);

    await scheduler.advance(BEHAVIORAL_LIMITS.flushDelayMs - 1);
    expect(sent).toHaveLength(0);
    await scheduler.advance(1);

    expect(sent).toHaveLength(1);
    expect(sent[0].keepalive).toBe(false);
    expect(sent[0].batch.events).toEqual([
      { eventType: "view_person", personId: PERSON, metadata: null, sessionId: SESSION },
      { eventType: "view_feed", personId: null, metadata: null, sessionId: SESSION },
    ]);
    expect(queue.size()).toBe(0);
  });

  it("flushes immediately once flushAtSize events are pending", async () => {
    const { queue, scheduler, sent } = setup();
    for (let index = 0; index < BEHAVIORAL_LIMITS.flushAtSize; index += 1) queue.track({ eventType: "view_feed" });
    await scheduler.advance(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].batch.events).toHaveLength(BEHAVIORAL_LIMITS.flushAtSize);
    expect(scheduler.pending()).toBe(0);
  });

  it("coalesces time_spent for the same person while pending", async () => {
    const { queue, scheduler, sent } = setup();
    queue.track({ eventType: "time_spent", personId: PERSON, metadata: { duration_ms: 800 } });
    queue.track({ eventType: "time_spent", personId: PERSON, metadata: { duration_ms: 700 } });
    queue.track({ eventType: "time_spent", personId: OTHER, metadata: { duration_ms: 100 } });
    queue.track({ eventType: "time_spent", personId: PERSON, metadata: { duration_ms: 50, surface: "feed" } });
    expect(queue.size()).toBe(3);

    await scheduler.advance(BEHAVIORAL_LIMITS.flushDelayMs);
    const events = sent[0].batch.events;
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ personId: PERSON, metadata: { duration_ms: 1500 } });
    expect(events[1]).toMatchObject({ personId: OTHER, metadata: { duration_ms: 100 } });
    expect(events[2]).toMatchObject({ personId: PERSON, metadata: { duration_ms: 50, surface: "feed" } });
  });

  it("drops invalid events without throwing", async () => {
    const log = vi.fn();
    const { queue, scheduler, sent } = setup({ log });
    expect(queue.track({ eventType: "view_person" })).toBe(false);
    expect(queue.track({ eventType: "nope" as never })).toBe(false);
    expect(queue.track({ eventType: "swipe", personId: PERSON, metadata: { action: "left" } })).toBe(true);
    await scheduler.advance(BEHAVIORAL_LIMITS.flushDelayMs);
    expect(sent[0].batch.events).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("caps the pending queue by dropping the oldest", () => {
    const { queue } = setup({ maxQueueLength: 3, flushAtSize: 100 });
    for (let index = 0; index < 5; index += 1) queue.track({ eventType: "search", metadata: { query: `q${index}` } });
    expect(queue.size()).toBe(3);
  });

  it("splits a big flush into batches no larger than maxBatchSize", async () => {
    const { queue, sent } = setup({ flushAtSize: 1000, maxQueueLength: 1000 });
    for (let index = 0; index < 120; index += 1) queue.track({ eventType: "view_feed" });
    await queue.flush();
    expect(sent.map((entry) => entry.batch.events.length)).toEqual([50, 50, 20]);
  });

  it("flush({ keepalive }) passes keepalive through and cancels the pending timer", async () => {
    const { queue, scheduler, sent } = setup();
    queue.track({ eventType: "view_feed" });
    expect(scheduler.pending()).toBe(1);
    await queue.flush({ keepalive: true });
    expect(sent[0].keepalive).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });

  it("swallows send failures and rejections", async () => {
    const log = vi.fn();
    const send = vi
      .fn<(batch: BehavioralBatch, options: { keepalive: boolean }) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("offline"));
    const { queue } = setup({ send, log });
    queue.track({ eventType: "view_feed" });
    await expect(queue.flush()).resolves.toBeUndefined();
    queue.track({ eventType: "view_feed" });
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => call[0])).toEqual(["batch rejected", "batch failed"]);
  });
});
