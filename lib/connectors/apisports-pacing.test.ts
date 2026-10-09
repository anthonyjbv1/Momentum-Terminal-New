import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allowedPerMinute, apiSportsPacing, apiSportsUsage, apiSportsWarnings, fetchApiSportsStatus, mergedApiSportsConfig, readApiSportsConfig, readRateHeaders, resetApiSportsPacing, resetApiSportsStatusCache } from "./apisports";

/**
 * THE REQUEST PACING (2026-10-09): never more than half the per-minute
 * limit, spaced, exponential backoff on 429; the subscription check; the
 * mapping's own statistic map.
 */

function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  apiSportsPacing.now = () => now;
  apiSportsPacing.sleep = async (ms) => {
    sleeps.push(ms);
    now += ms;
  };
  return { sleeps, advance: (ms: number) => (now += ms), at: () => now };
}

const realNow = apiSportsPacing.now;
const realSleep = apiSportsPacing.sleep;

beforeEach(() => resetApiSportsPacing());
afterEach(() => {
  apiSportsPacing.now = realNow;
  apiSportsPacing.sleep = realSleep;
  resetApiSportsPacing();
});

describe("half the limit", () => {
  it("allows half the per-minute limit, at least one, and assumes the Pro rate before a header says otherwise", () => {
    expect(allowedPerMinute(null)).toBe(150);
    expect(allowedPerMinute(300)).toBe(150);
    expect(allowedPerMinute(10)).toBe(5);
    expect(allowedPerMinute(1)).toBe(1);
  });

  it("reads the limits off the headers, whatever their case, and reports them", () => {
    const clock = fakeClock();
    readRateHeaders(new Headers({ "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "299", "x-ratelimit-requests-limit": "7500", "x-ratelimit-requests-remaining": "7312" }));
    expect(apiSportsUsage()).toMatchObject({ minuteLimit: 300, minuteRemaining: 299, dayLimit: 7500, dayRemaining: 7312, readAt: new Date(clock.at()).toISOString() });
    // A response without the headers leaves the last reading in place.
    readRateHeaders(new Headers({}));
    expect(apiSportsUsage().dayLimit).toBe(7500);
  });
});

describe("the subscription check", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  it("warns on a Free plan, an inactive subscription, and an end within five days or past", () => {
    expect(apiSportsWarnings({ plan: "Pro", subscriptionEnd: "2026-11-08T00:00:00Z", subscriptionActive: true }, now)).toEqual([]);
    expect(apiSportsWarnings({ plan: "Free", subscriptionEnd: null, subscriptionActive: true }, now)[0]).toMatch(/plan is Free/);
    expect(apiSportsWarnings({ plan: "Pro", subscriptionEnd: "2026-10-12T00:00:00Z", subscriptionActive: true }, now)[0]).toMatch(/ends 2026-10-12T00:00:00Z \(2\.5 days\)/);
    expect(apiSportsWarnings({ plan: "Pro", subscriptionEnd: "2026-10-01T00:00:00Z", subscriptionActive: false }, now)).toEqual([
      "API-Sports subscription is not active",
      "API-Sports subscription ended 2026-10-01T00:00:00Z; the key is on the Free plan now",
    ]);
    expect(apiSportsWarnings({ plan: null, subscriptionEnd: null, subscriptionActive: null }, now)).toEqual([]);
  });
});

describe("the mapping's own configuration", () => {
  it("lets a mapping override the team, the game statistics and the headline line, and nothing else", () => {
    const source = { host: "h", team_id: 17, game_stats: { game_passing_yards: { group: "Passing", name: "yards" } }, paths: { games: "/g" } };
    const merged = mergedApiSportsConfig(source, { team_id: 29, game_stats: { game_receiving_yards: { group: "Receiving", name: "yards" } }, host: "evil", paths: { games: "/x" }, resolve: { player_search: "x" } });
    expect(merged).toEqual({ host: "h", team_id: 29, game_stats: { game_receiving_yards: { group: "Receiving", name: "yards" } }, paths: { games: "/g" } });
    expect(mergedApiSportsConfig(source, undefined)).toEqual(source);
    expect(mergedApiSportsConfig(source, { team_id: null })).toEqual(source);
  });
});

describe("pacing and backoff through a call", () => {
  const config = readApiSportsConfig({});
  const statusBody = { errors: [], response: { subscription: { plan: "Pro", end: "2026-11-08T00:00:00+00:00", active: true }, requests: { current: 12, limit_day: 7500 } } };
  const responder = (statuses: number[], headers: Record<string, string> = {}) => {
    const calls: number[] = [];
    let index = 0;
    const fetchImpl = (async () => {
      calls.push(apiSportsPacing.now());
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      return new Response(JSON.stringify(statusBody), { status, headers: { "content-type": "application/json", ...headers } });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  beforeEach(() => resetApiSportsStatusCache());

  it("spaces calls so no minute holds more than half the limit, and never closer than the floor", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = responder([200], { "X-RateLimit-Limit": "2", "X-RateLimit-Remaining": "1" });
    // The first call learns the limit is 2 a minute: one call a minute from then on.
    for (let i = 0; i < 3; i += 1) {
      resetApiSportsStatusCache();
      await fetchApiSportsStatus(config, "k", fetchImpl, clock.at());
    }
    expect(calls).toHaveLength(3);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(60_000);
    expect(calls[2] - calls[1]).toBeGreaterThanOrEqual(60_000);
    expect(apiSportsUsage().requests).toBe(3);
  });

  it("retries a 429 with exponential backoff, honouring Retry-After, and raises it as retryable after three", async () => {
    const clock = fakeClock();
    const once = responder([429, 200], { "retry-after": "7" });
    const status = await fetchApiSportsStatus(config, "k", once.fetchImpl, clock.at());
    expect(status).toMatchObject({ plan: "Pro", subscriptionEnd: "2026-11-08T00:00:00+00:00", subscriptionActive: true, requestsToday: 12, dailyLimit: 7500 });
    expect(once.calls).toHaveLength(2);
    expect(clock.sleeps).toContain(7000);

    resetApiSportsStatusCache();
    resetApiSportsPacing();
    const always = responder([429]);
    await expect(fetchApiSportsStatus(config, "k", always.fetchImpl, clock.at())).rejects.toMatchObject({ status: 429, retryable: true });
    expect(always.calls).toHaveLength(4);
    expect(clock.sleeps.slice(-3)).toEqual([1000, 2000, 4000]);
  });
});
