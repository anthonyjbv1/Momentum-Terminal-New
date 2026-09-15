import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { apisportsConnector, envelopeErrors, readGame, readStatistic, resetApiSportsStatusCache, seasonFor } from "./apisports";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const person = makePerson({ slug: "patrick-mahomes", display_name: "Patrick Mahomes" });
const PLAYER = "1197";
const HOST = "v1.american-football.api-sports.io";

interface Call {
  url: string;
  headers: Record<string, string>;
}

interface Options {
  plan?: string;
  requests?: { current: number; limit_day: number };
  /** Replaces the whole statistics response array. */
  statistics?: unknown[];
  games?: unknown[];
  /** An errors payload for the named path fragment, in either shape API-Sports uses. */
  errorsOn?: { path: string; errors: unknown };
  status?: number;
}

const STATISTICS = [{ team: { id: 21, name: "Kansas City Chiefs" }, passing: { yards: 342, touchdowns: 3 } }];

const GAMES = [
  {
    game: { id: 9001, date: { date: "2026-11-09T18:00:00+00:00" }, status: { short: "FT" } },
    teams: { home: { id: 21, name: "Kansas City Chiefs" }, away: { id: 9, name: "Denver Broncos" } },
    scores: { home: { total: 27 }, away: { total: 20 } },
  },
  {
    game: { id: 9002, date: { date: "2026-11-16T18:00:00+00:00" }, status: { short: "NS" } },
    teams: { home: { id: 4, name: "Buffalo Bills" }, away: { id: 21, name: "Kansas City Chiefs" } },
    scores: { home: { total: null }, away: { total: null } },
  },
];

/** An API-Sports double: one envelope shape, three paths, recorded calls. */
function apisportsFetch(options: Options = {}) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (options.status && options.status !== 200) return Response.json({}, { status: options.status });

    const envelope = (response: unknown[], path: string) =>
      Response.json({
        get: path,
        results: response.length,
        // API-Sports sends an empty ARRAY when there are no errors.
        errors: options.errorsOn && url.includes(options.errorsOn.path) ? options.errorsOn.errors : [],
        response: options.errorsOn && url.includes(options.errorsOn.path) ? [] : response,
      });

    if (url.includes("/status")) {
      return envelope([{ subscription: { plan: options.plan ?? "Free" }, requests: options.requests ?? { current: 12, limit_day: 100 } }], "status");
    }
    if (url.includes("/players/statistics")) return envelope(options.statistics ?? STATISTICS, "players/statistics");
    if (url.includes("/games")) return envelope(options.games ?? GAMES, "games");
    throw new Error(`unexpected url ${url}`);
  };
  return Object.assign(impl, { calls });
}

const context = (fetch: typeof globalThis.fetch, options: { config?: Record<string, unknown>; latest?: number | null } = {}) => ({
  source: makeSource({ name: "apisports" }),
  config: (options.config ?? {}) as Record<string, never>,
  snapshots: {
    latest: async () => (options.latest === undefined || options.latest === null ? null : { metricKey: "game_passing_yards", value: options.latest, recordedAt: NOW }),
    record: () => undefined,
  },
  now: NOW,
  fetch,
});

describe("envelopeErrors", () => {
  it("reads both shapes API-Sports uses, and treats the empty array as no error", () => {
    expect(envelopeErrors([])).toEqual([]);
    expect(envelopeErrors({})).toEqual([]);
    expect(envelopeErrors(undefined)).toEqual([]);
    expect(envelopeErrors({ token: "invalid" })).toEqual(["token: invalid"]);
    expect(envelopeErrors({ requests: "limit reached" })).toEqual(["requests: limit reached"]);
    expect(envelopeErrors(["bad season"])).toEqual(["bad season"]);
  });
});

describe("seasonFor", () => {
  it("names a season for the year it starts in, so January belongs to the previous one", () => {
    expect(seasonFor(new Date("2026-09-15T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2026-12-31T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2027-01-20T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2027-02-08T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2027-03-01T00:00:00Z"), null)).toBe(2027);
    expect(seasonFor(new Date("2027-01-20T00:00:00Z"), 2025)).toBe(2025);
  });
});

describe("readStatistic", () => {
  it("accepts a number or a numeric string, and tries the candidates in order", () => {
    expect(readStatistic({ passing: { yards: 342 } }, ["passing.yards"])).toBe(342);
    expect(readStatistic({ passing_yards: "287" }, ["passing.yards", "passing_yards"])).toBe(287);
    expect(readStatistic({ yards: 0 }, ["passing.yards", "yards"])).toBe(0);
    expect(readStatistic({ passing: { yards: "" } }, ["passing.yards"])).toBeNull();
    expect(readStatistic({}, ["passing.yards"])).toBeNull();
    expect(readStatistic(undefined, ["passing.yards"])).toBeNull();
  });
});

describe("readGame", () => {
  it("reads the nested American Football shape and the hoisted one alike", () => {
    expect(readGame(GAMES[0])?.id).toBe("9001");
    expect(readGame({ id: 77, date: "2026-11-09T18:00:00Z", status: { short: "FT" }, scores: { home: { total: 3 }, away: { total: 0 } } })?.id).toBe("77");
    expect(readGame({ id: 78, date: { timestamp: 1_793_000_000 }, status: { short: "FT" } })?.id).toBe("78");
  });

  it("marks only completed games finished, and refuses one it cannot date", () => {
    expect(readGame(GAMES[0])?.finished).toBe(true);
    expect(readGame(GAMES[1])?.finished).toBe(false);
    expect(readGame({ id: 1, status: { short: "FT" } })).toBeNull();
    expect(readGame({ date: "2026-11-09T18:00:00Z" })).toBeNull();
  });
});

describe("apisportsConnector", () => {
  const saved = process.env.APISPORTS_API_KEY;
  beforeEach(() => {
    resetApiSportsStatusCache();
    process.env.APISPORTS_API_KEY = "test-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.APISPORTS_API_KEY;
    else process.env.APISPORTS_API_KEY = saved;
    resetApiSportsStatusCache();
  });

  it("is unavailable, with a reason, when the key is missing", () => {
    delete process.env.APISPORTS_API_KEY;
    expect(apisportsConnector.available?.()).toEqual({ ok: false, reason: "APISPORTS_API_KEY is not set" });
    process.env.APISPORTS_API_KEY = "test-key";
    expect(apisportsConnector.available?.()).toEqual({ ok: true });
  });

  it("addresses the American Football host and sends the key header", async () => {
    const fetch = apisportsFetch();
    await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch));
    for (const call of fetch.calls) {
      expect(call.url.startsWith(`https://${HOST}/`), call.url).toBe(true);
      expect(call.headers["x-apisports-key"]).toBe("test-key");
    }
  });

  it("probes /status once and caches it, rather than spending the daily quota every poll", async () => {
    const fetch = apisportsFetch();
    await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch));
    await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch, { latest: 342 }));
    expect(fetch.calls.filter((call) => call.url.includes("/status"))).toHaveLength(1);
  });

  it("substitutes the player and season into the configured paths", async () => {
    const fetch = apisportsFetch();
    await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch));
    expect(fetch.calls.some((call) => call.url === `https://${HOST}/players/statistics?id=1197&season=2026`)).toBe(true);
  });

  it("reads per-game passing yards as the one metric", async () => {
    const fetch = apisportsFetch();
    expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch))).toEqual([{ metricKey: "game_passing_yards", value: 342 }]);
  });

  it("samples once per game: an unchanged figure records nothing, so samples count games and not polls", async () => {
    const fetch = apisportsFetch();
    // The same value already snapshotted — a poll between two games.
    expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch, { latest: 342 }))).toEqual([]);
    // A new game moved it.
    expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch, { latest: 201 }))).toEqual([{ metricKey: "game_passing_yards", value: 342 }]);
  });

  it("registers no season cumulative metric — a weekly step function has no usable baseline", async () => {
    const fetch = apisportsFetch();
    const readings = (await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch))) ?? [];
    expect(readings.map((reading) => reading.metricKey)).toEqual(["game_passing_yards"]);
  });

  it("emits one signal per FINISHED game, keyed on the game id, and never for a scheduled one", async () => {
    const fetch = apisportsFetch();
    const signals = await apisportsConnector.fetchForPerson(person, PLAYER, context(fetch));
    expect(signals).toHaveLength(1);
    expect(signals[0].dedupeKey).toBe("apisports:game:9001");
    expect(signals[0].headline).toBe("Kansas City Chiefs beat Denver Broncos 27-20.");
    expect(signals[0].occurredAt.toISOString()).toBe("2026-11-09T18:00:00.000Z");
    expect(signals[0].rawPayload).toMatchObject({ kind: "game_result", game_id: "9001", home_score: 27, away_score: 20 });
  });

  it("says so when a game was drawn", async () => {
    const drawn = [{ ...GAMES[0], scores: { home: { total: 17 }, away: { total: 17 } } }];
    const signals = await apisportsConnector.fetchForPerson(person, PLAYER, context(apisportsFetch({ games: drawn })));
    expect(signals[0].headline).toBe("Kansas City Chiefs and Denver Broncos finish 17-17.");
  });

  it("takes the team id from config when set, and from the statistics response otherwise", async () => {
    const fromResponse = apisportsFetch();
    await apisportsConnector.fetchForPerson(person, PLAYER, context(fromResponse));
    expect(fromResponse.calls.some((call) => call.url.includes("team=21"))).toBe(true);

    const fromConfig = apisportsFetch({ statistics: [{ passing: { yards: 1 } }] });
    await apisportsConnector.fetchForPerson(person, PLAYER, context(fromConfig, { config: { team_id: 99 } }));
    expect(fromConfig.calls.some((call) => call.url.includes("team=99"))).toBe(true);
  });

  it("treats a 200 carrying an errors payload as a failure, not as an empty result", async () => {
    // A wrong key, or a sport the key is not subscribed to, answers 200 with
    // errors. Reading that as "no games" is how a connector goes quiet.
    const fetch = apisportsFetch({ errorsOn: { path: "/status", errors: { token: "Invalid API key" } } });
    await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch))).rejects.toThrow(/refused \/status.*token: Invalid API key/);
  });

  it("names the plan, the quota and the tried keys when the statistic cannot be found", async () => {
    const fetch = apisportsFetch({ statistics: [{ rushing: { yards: 12 } }], plan: "Free", requests: { current: 44, limit_day: 100 } });
    const failure = apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch));
    await expect(failure).rejects.toThrow(/carried no passing yards/);
    await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch))).rejects.toThrow(/plan Free, 44 of 100 requests used today/);
    await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch))).rejects.toThrow(/passing\.yards, passing_yards, yards/);
  });

  it("says what to change when no team id can be resolved", async () => {
    const fetch = apisportsFetch({ statistics: [{ passing: { yards: 5 } }] });
    await expect(apisportsConnector.fetchForPerson(person, PLAYER, context(fetch))).rejects.toThrow(/yielded no team id/);
    await expect(apisportsConnector.fetchForPerson(person, PLAYER, context(fetch))).rejects.toThrow(/Set config\.team_id/);
  });

  it("surfaces a rate limit as retryable rather than as silence", async () => {
    const fetch = apisportsFetch({ status: 429 });
    await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch))).rejects.toThrow(/API-Sports responded 429/);
  });

  it("refuses an empty player id", async () => {
    await expect(apisportsConnector.fetchMetrics?.(person, "  ", context(apisportsFetch()))).rejects.toThrow(/No API-Sports player id configured for patrick-mahomes/);
  });
});
