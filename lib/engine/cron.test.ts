import { describe, expect, it, vi } from "vitest";

import { CRON_DEFAULTS, authorizeCronRequest, runScheduledTicks } from "./cron";
import type { FullTickResult } from "./run-tick";

/** A fake clock the scheduler and the fake ticks share. */
function clock(startMs = 1_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function tickResult(tickNumber: number, overrides: Partial<FullTickResult> = {}): FullTickResult {
  return {
    tickNumber,
    dryRun: false,
    trigger: "cron",
    startedAt: "2026-09-07T12:00:00.000Z",
    finishedAt: "2026-09-07T12:00:01.000Z",
    durationMs: 1000,
    mood: 0,
    peopleUpdated: 16,
    signalsProcessed: 2,
    people: [],
    signals: [
      { id: "a", personSlug: "drake", headline: "x", label: "positive", confidence: 0.8, direction: 1, impact: 1.2, scorer: "llm" },
      { id: "b", personSlug: "mrbeast", headline: "y", label: "neutral", confidence: 0, direction: 0, impact: 0, scorer: "rules-fallback" },
    ],
    scorer: "llm",
    postTick: { narratives: 1, memoryUpdates: 1, memoryLlmSummaries: 0, errors: [] },
    ...overrides,
  };
}

describe("runScheduledTicks", () => {
  it("returns immediately and logs 'skipped (disabled)' when the switch is off", async () => {
    const runTick = vi.fn();
    const log = vi.fn();
    const result = await runScheduledTicks({ enabled: false, runTick, log });

    expect(runTick).not.toHaveBeenCalled();
    expect(result).toMatchObject({ enabled: false, status: "skipped", reason: 'ENGINE_CRON_ENABLED is not "true"', ticksPlanned: 0, ticksRun: 0, ticks: [] });
    expect(log).toHaveBeenCalledWith("skipped (disabled)", { enabled: false });
  });

  it("runs two ticks 30 seconds apart when enabled, through the injected tick path", async () => {
    const c = clock();
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      c.advance(ms);
    });
    let tick = 0;
    const runTick = vi.fn(async () => {
      c.advance(4_000); // each tick takes 4 s
      tick += 1;
      return tickResult(tick);
    });
    const log = vi.fn();

    const result = await runScheduledTicks({ enabled: true, runTick, sleep, now: c.now, log });

    expect(runTick).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([26_000]); // second tick starts 30 s after the first STARTED
    expect(result).toMatchObject({ enabled: true, status: "ran", ticksPlanned: 2, ticksRun: 2, skippedTicks: [] });
    expect(result.ticks.map((t) => t.tickNumber)).toEqual([1, 2]);
    expect(result.ticks[0]).toMatchObject({ ok: true, durationMs: 4_000, signalsProcessed: 2, llmScored: 1, fallbacks: 1, narratives: 1 });
    expect(result.durationMs).toBe(34_000);
    expect(log).toHaveBeenCalledWith("invocation finished", expect.objectContaining({ ticksRun: 2, signalsProcessed: 4, fallbacks: 2 }));
  });

  it("skips the second tick when the first ran too long for the time budget", async () => {
    const c = clock();
    const sleep = vi.fn(async (ms: number) => c.advance(ms));
    const runTick = vi.fn(async () => {
      c.advance(35_000); // slow first tick
      return tickResult(1);
    });
    const log = vi.fn();

    const result = await runScheduledTicks({ enabled: true, runTick, sleep, now: c.now, log });

    expect(runTick).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.ticksRun).toBe(1);
    expect(result.skippedTicks).toEqual([{ index: 1, reason: expect.stringContaining("not enough time budget") }]);
    expect(log).toHaveBeenCalledWith("tick skipped", expect.objectContaining({ index: 1 }));
  });

  it("still attempts the second tick after a failed first one and reports the failure", async () => {
    const c = clock();
    const sleep = vi.fn(async (ms: number) => c.advance(ms));
    const runTick = vi
      .fn<() => Promise<FullTickResult>>()
      .mockImplementationOnce(async () => {
        c.advance(2_000);
        throw new Error("database unreachable");
      })
      .mockImplementationOnce(async () => {
        c.advance(2_000);
        return tickResult(7);
      });

    const result = await runScheduledTicks({ enabled: true, runTick, sleep, now: c.now, log: vi.fn() });

    expect(runTick).toHaveBeenCalledTimes(2);
    expect(result.ticks[0]).toMatchObject({ ok: false, error: "database unreachable" });
    expect(result.ticks[1]).toMatchObject({ ok: true, tickNumber: 7 });
    expect(result.ticksRun).toBe(1);
  });

  it("honours a single-tick configuration (60-second cadence fallback)", async () => {
    const c = clock();
    const runTick = vi.fn(async () => tickResult(1));
    const result = await runScheduledTicks({ enabled: true, runTick, now: c.now, log: vi.fn(), ticksPerInvocation: 1 });
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(result.ticksPlanned).toBe(1);
  });

  it("uses a 55-second budget under the route's 60-second maxDuration", () => {
    expect(CRON_DEFAULTS).toEqual({ ticksPerInvocation: 2, spacingMs: 30_000, budgetMs: 55_000, minTickEstimateMs: 5_000 });
  });
});

describe("authorizeCronRequest", () => {
  const secrets = { cronSecret: "vercel-cron-secret", engineSecret: "engine-secret" };

  it("accepts Vercel's bearer token or the engine secret", () => {
    expect(authorizeCronRequest(new Headers({ authorization: "Bearer vercel-cron-secret" }), secrets)).toEqual({ ok: true });
    expect(authorizeCronRequest(new Headers({ "x-engine-secret": "engine-secret" }), secrets)).toEqual({ ok: true });
    expect(authorizeCronRequest(new Headers({ authorization: "Bearer engine-secret" }), secrets)).toEqual({ ok: true });
  });

  it("rejects the public", () => {
    expect(authorizeCronRequest(new Headers(), secrets)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeCronRequest(new Headers({ authorization: "Bearer nope" }), secrets)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeCronRequest(new Headers({ "x-engine-secret": "vercel-cron-secret" }), secrets)).toMatchObject({ ok: false, status: 401 });
  });

  it("works with only one of the two secrets configured, and fails closed with none", () => {
    expect(authorizeCronRequest(new Headers({ authorization: "Bearer engine-secret" }), { cronSecret: null, engineSecret: "engine-secret" })).toEqual({ ok: true });
    expect(authorizeCronRequest(new Headers({ authorization: "Bearer vercel-cron-secret" }), { cronSecret: "vercel-cron-secret", engineSecret: null })).toEqual({ ok: true });
    expect(authorizeCronRequest(new Headers({ authorization: "Bearer anything" }), { cronSecret: null, engineSecret: null })).toMatchObject({ ok: false, status: 503 });
  });
});
