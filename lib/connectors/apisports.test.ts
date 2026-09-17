import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import {
  GAME_PASSING_YARDS_METRIC,
  SEASON_PASSING_YARDS_SNAPSHOT,
  apisportsConnector,
  envelopeErrors,
  isExcludedStage,
  parseStatValue,
  readApiSportsConfig,
  readGame,
  readGroupedStatistic,
  readStatistic,
  resetApiSportsStatusCache,
  seasonFor,
} from "./apisports";

const NOW = new Date("2026-09-17T12:00:00.000Z");
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
  /** Replaces the whole season statistics response array. */
  statistics?: unknown[];
  games?: unknown[];
  /** Per-game statistics responses by game id. */
  gameStats?: Record<string, unknown[]>;
  /** An errors payload for the named path fragment, in either shape API-Sports uses. */
  errorsOn?: { path: string; errors: unknown };
  status?: number;
}

/**
 * The season statistics entry exactly as the host returned it for player
 * 1197 on 2026-09-17: named groups of name/value pairs, values as strings
 * with thousands separators, "yards" repeated across groups.
 */
function seasonEntry(passingYards: string | null = "3,587") {
  return {
    player: { id: 1197, name: "Patrick Mahomes" },
    teams: [
      {
        team: { id: 17, name: "Kansas City Chiefs" },
        groups: [
          {
            name: "Passing",
            statistics: [
              { name: "passing attempts", value: "502" },
              { name: "completions", value: "315" },
              { name: "completion pct", value: "62.7" },
              { name: "yards", value: passingYards },
              { name: "yards per game", value: "256.2" },
              { name: "passing touchdowns pct", value: null },
              { name: "quaterback rating", value: "89.6" },
            ],
          },
          { name: "Rushing", statistics: [{ name: "rushing attempts", value: "64" }, { name: "yards", value: "422" }] },
          { name: "Receiving", statistics: [{ name: "receiving yards", value: "-10" }] },
        ],
      },
    ],
  };
}

const STATISTICS = [seasonEntry()];

/** The games list as the host returned it for team 17, season 2026 (abridged): three preseason, one regular-season result, one scheduled. */
function game(id: number, stage: string, week: string, date: string, time: string, timestamp: number | undefined, short: string, home: [number, string, number | null], away: [number, string, number | null]) {
  return {
    game: { id, stage, week, date: { timezone: "UTC", date, time, timestamp }, venue: { name: "x", city: "y" }, status: { short, long: short === "FT" ? "Finished" : "Not Started", timer: null } },
    league: { id: 1, name: "NFL", season: "2026" },
    teams: { home: { id: home[0], name: home[1] }, away: { id: away[0], name: away[1] } },
    scores: { home: { total: home[2] }, away: { total: away[2] } },
  };
}
const KC: [number, string] = [17, "Kansas City Chiefs"];
const GAMES = [
  game(21477, "Pre Season", "Week 1", "2026-08-15", "20:00", 1786824000, "FT", [...KC, 12], [31, "Los Angeles Rams", 20]),
  game(21508, "Pre Season", "Week 3", "2026-08-29", "20:00", undefined, "FT", [...KC, 9], [28, "Seattle Seahawks", 9]),
  game(21528, "Regular Season", "Week 1", "2026-09-15", "20:00", undefined, "FT", [...KC, 31], [9, "Denver Broncos", 10]),
  game(21543, "Regular Season", "Week 2", "2026-09-21", "20:00", undefined, "NS", [...KC, null], [12, "Indianapolis Colts", null]),
];
const WEEK1_KICKOFF = "2026-09-15T20:00:00.000Z";

/** Per-game player statistics for game 21528, as the host returned them: groups of PLAYERS, one entry per team. */
function mahomesLine(yards: string = "184", { rating = "50.2", interceptions = "1" }: { rating?: string; interceptions?: string } = {}) {
  return {
    player: { id: 1197, name: "Patrick Mahomes" },
    statistics: [
      { name: "comp att", value: "15/27" },
      { name: "yards", value: yards },
      { name: "average", value: "6.8" },
      { name: "passing touch downs", value: "2" },
      { name: "interceptions", value: interceptions },
      { name: "sacks", value: "2-12" },
      { name: "rating", value: rating },
      { name: "two pt", value: "0" },
    ],
  };
}
function gameStats(yards: string | null = "184", { withMahomes = true, rating, interceptions }: { withMahomes?: boolean; rating?: string; interceptions?: string } = {}) {
  return [
    {
      team: { id: 17, name: "Kansas City Chiefs" },
      groups: [
        { name: "Passing", players: withMahomes ? [mahomesLine(yards as string, { rating, interceptions })] : [{ player: { id: 900, name: "Gardner Minshew" }, statistics: [{ name: "yards", value: "41" }] }] },
        {
          name: "Rushing",
          players: [
            ...(withMahomes ? [{ player: { id: 1197, name: "Patrick Mahomes" }, statistics: [{ name: "total rushes", value: "7" }, { name: "yards", value: "23" }] }] : []),
            { player: { id: 555, name: "Isiah Pacheco" }, statistics: [{ name: "total rushes", value: "18" }, { name: "yards", value: "88" }] },
          ],
        },
      ],
    },
    { team: { id: 9, name: "Denver Broncos" }, groups: [{ name: "Passing", players: [{ player: { id: 777, name: "Bo Nix" }, statistics: [{ name: "yards", value: "201" }] }] }] },
  ];
}
const GAME_STATS: Record<string, unknown[]> = { "21528": gameStats() };

/** The three per-game metrics as the production row registers them (Phase 13+). */
const THREE_METRICS = {
  game_stats: {
    game_passing_yards: { group: "Passing", name: "yards" },
    game_passer_rating: { group: "Passing", name: "rating" },
    game_interceptions: { group: "Passing", name: "interceptions" },
  },
};

/** An API-Sports double: one envelope shape, four paths, recorded calls. */
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
    if (url.includes("/games/statistics/players")) {
      const id = new URL(url).searchParams.get("id") ?? "";
      return envelope((options.gameStats ?? GAME_STATS)[id] ?? [], "games/statistics/players");
    }
    if (url.includes("/games")) return envelope(options.games ?? GAMES, "games");
    throw new Error(`unexpected url ${url}`);
  };
  return Object.assign(impl, { calls, urls: (fragment: string) => calls.filter((call) => call.url.includes(fragment)).map((call) => call.url) });
}

const context = (fetch: typeof globalThis.fetch, options: { config?: Record<string, unknown>; latest?: Record<string, { value: number; recordedAt: Date }> } = {}) => {
  const recorded: Array<{ metricKey: string; value: number; recordedAt?: Date }> = [];
  const notes: string[] = [];
  return {
    source: makeSource({ name: "apisports" }),
    config: (options.config ?? {}) as Record<string, never>,
    snapshots: {
      latest: async (metricKey: string) => {
        const hit = options.latest?.[metricKey];
        return hit ? { metricKey, value: hit.value, recordedAt: hit.recordedAt } : null;
      },
      record: (metricKey: string, value: number, recordedAt?: Date) => void recorded.push(recordedAt ? { metricKey, value, recordedAt } : { metricKey, value }),
    },
    now: NOW,
    fetch,
    note: (message: string) => void notes.push(message),
    recorded,
    notes,
  };
};

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
  it("names a season for the year it starts in (verified: season=2026 lists the 2026-27 fixtures, 2027 is empty), so January belongs to the previous one", () => {
    expect(seasonFor(new Date("2026-09-15T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2026-12-31T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2027-01-20T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2027-02-08T00:00:00Z"), null)).toBe(2026);
    expect(seasonFor(new Date("2027-03-01T00:00:00Z"), null)).toBe(2027);
    expect(seasonFor(new Date("2027-01-20T00:00:00Z"), 2025)).toBe(2025);
  });
});

describe("parseStatValue", () => {
  it("reads the host's strings exactly: thousands separators, signs, decimals — and nothing looser", () => {
    expect(parseStatValue("3,587")).toBe(3587);
    expect(parseStatValue("1,234,567")).toBe(1234567);
    expect(parseStatValue("422")).toBe(422);
    expect(parseStatValue("-10")).toBe(-10);
    expect(parseStatValue("62.7")).toBe(62.7);
    expect(parseStatValue("-10.0")).toBe(-10);
    expect(parseStatValue(" 89.6 ")).toBe(89.6);
    expect(parseStatValue(0)).toBe(0);
    expect(parseStatValue(342)).toBe(342);
  });

  it("refuses anything that is not that grammar — composites included — and never returns a partial number", () => {
    // The failure this guards against: a lenient parser reading "3,587" as 3, or "15/27" as 15.
    for (const bad of ["3,58", "3,5878", ",587", "3,,587", "3 587", "3587 yards", "15/27", "2-12", "", "  ", "n/a", "NaN", "Infinity", "1e3", "0x10", "--10"]) {
      expect(parseStatValue(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseStatValue(null)).toBeNull();
    expect(parseStatValue(undefined)).toBeNull();
    expect(parseStatValue(Number.NaN)).toBeNull();
    expect(parseStatValue({ value: "3,587" })).toBeNull();
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
    // Array indices in a dotted path, which is how the team id is reached in the real shape.
    expect(readStatistic(seasonEntry(), ["team.id", "teams.0.team.id"])).toBe(17);
  });
});

describe("readGroupedStatistic", () => {
  it("reads the SEASON shape (groups of statistics) by group AND name: 'yards' is passing yards only under Passing", () => {
    expect(readGroupedStatistic(seasonEntry(), { group: "Passing", name: "yards" })).toEqual({ status: "ok", value: 3587, raw: "3,587" });
    expect(readGroupedStatistic(seasonEntry(), { group: "Rushing", name: "yards" })).toEqual({ status: "ok", value: 422, raw: "422" });
    expect(readGroupedStatistic(seasonEntry(), { group: "Receiving", name: "receiving yards" })).toEqual({ status: "ok", value: -10, raw: "-10" });
    // Case does not matter, the host's own spelling does. A player id is harmless where there are no players.
    expect(readGroupedStatistic(seasonEntry(), { group: "passing", name: "YARDS" }, 1197)).toMatchObject({ status: "ok", value: 3587 });
  });

  it("reads the PER-GAME shape (groups of players) with the player id selecting the line — the same lookup, no special case", () => {
    const [chiefs, broncos] = gameStats();
    expect(readGroupedStatistic(chiefs, { group: "Passing", name: "yards" }, 1197)).toEqual({ status: "ok", value: 184, raw: "184" });
    expect(readGroupedStatistic(chiefs, { group: "Rushing", name: "yards" }, "1197")).toEqual({ status: "ok", value: 23, raw: "23" });
    expect(readGroupedStatistic(chiefs, { group: "Rushing", name: "yards" }, 555)).toEqual({ status: "ok", value: 88, raw: "88" });
    // The other team's sheet does not list him at all.
    expect(readGroupedStatistic(broncos, { group: "Passing", name: "yards" }, 1197)).toEqual({ status: "missing", groups: ["Passing"], names: [], playerSeen: false });
    // Composite figures are refused, never partially read.
    expect(readGroupedStatistic(chiefs, { group: "Passing", name: "comp att" }, 1197)).toEqual({ status: "unparseable", raw: "15/27" });
    expect(readGroupedStatistic(chiefs, { group: "Passing", name: "sacks" }, 1197)).toEqual({ status: "unparseable", raw: "2-12" });
  });

  it("reports an unparseable value as such, and a missing one with what is there and whether the player appeared", () => {
    expect(readGroupedStatistic(seasonEntry("3,58"), { group: "Passing", name: "yards" })).toEqual({ status: "unparseable", raw: "3,58" });
    expect(readGroupedStatistic(seasonEntry(null), { group: "Passing", name: "yards" })).toEqual({ status: "unparseable", raw: null });
    expect(readGroupedStatistic(seasonEntry(), { group: "Passing", name: "air yards" })).toEqual({
      status: "missing",
      groups: ["Passing", "Rushing", "Receiving"],
      names: ["passing attempts", "completions", "completion pct", "yards", "yards per game", "passing touchdowns pct", "quaterback rating"],
      playerSeen: false,
    });
    expect(readGroupedStatistic(gameStats()[0], { group: "Passing", name: "air yards" }, 1197)).toEqual({
      status: "missing",
      groups: ["Passing", "Rushing"],
      names: ["comp att", "yards", "average", "passing touch downs", "interceptions", "sacks", "rating", "two pt"],
      playerSeen: true,
    });
    expect(readGroupedStatistic({ passing: { yards: 342 } }, { group: "Passing", name: "yards" })).toEqual({ status: "missing", groups: [], names: [], playerSeen: false });
    expect(readGroupedStatistic(undefined, { group: "Passing", name: "yards" })).toEqual({ status: "missing", groups: [], names: [], playerSeen: false });
  });
});

describe("readGame", () => {
  it("reads the host's shape: the unix timestamp first, else date + time in UTC, else the bare date; stage and week carried", () => {
    const stamped = readGame(GAMES[0])!;
    expect(stamped).toMatchObject({ id: "21477", finished: true, stage: "Pre Season", week: "Week 1" });
    expect(stamped.date.toISOString()).toBe("2026-08-15T20:00:00.000Z");
    expect(readGame(GAMES[2])!.date.toISOString()).toBe(WEEK1_KICKOFF);
    expect(readGame({ id: 77, date: "2026-11-09T18:00:00Z", status: { short: "FT" }, scores: { home: { total: 3 }, away: { total: 0 } } })).toMatchObject({ id: "77", stage: null, week: null });
    expect(readGame({ id: 78, date: { timestamp: 1_793_000_000 }, status: { short: "FT" } })?.id).toBe("78");
    expect(readGame({ game: { id: 79, date: { date: "2026-09-15" }, status: { short: "FT" } } })!.date.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("marks only completed games finished, and refuses one it cannot date", () => {
    expect(readGame(GAMES[2])?.finished).toBe(true);
    expect(readGame(GAMES[3])?.finished).toBe(false);
    expect(readGame({ id: 1, status: { short: "FT" } })).toBeNull();
    expect(readGame({ date: "2026-11-09T18:00:00Z" })).toBeNull();
  });
});

describe("readApiSportsConfig", () => {
  it("reads the lookups and stages from the row and falls back to the verified defaults", () => {
    const defaults = readApiSportsConfig({});
    expect(defaults.passing_yards_stat).toEqual({ group: "Passing", name: "yards" });
    expect(defaults.game_passing_yards_stat).toEqual({ group: "Passing", name: "yards" });
    expect(defaults.paths.game_statistics).toBe("/games/statistics/players?id={game}");
    expect(defaults.excluded_stages).toEqual(["Pre Season"]);
    expect(readApiSportsConfig({ passing_yards_stat: { group: " Passing ", name: "yards per game" } }).passing_yards_stat).toEqual({ group: "Passing", name: "yards per game" });
    // The per-game lookup follows the season one unless set on its own.
    expect(readApiSportsConfig({ passing_yards_stat: { group: "Passing", name: "yds" } }).game_passing_yards_stat).toEqual({ group: "Passing", name: "yds" });
    expect(readApiSportsConfig({ game_passing_yards_stat: { group: "QB", name: "yards" } }).game_passing_yards_stat).toEqual({ group: "QB", name: "yards" });
    expect(readApiSportsConfig({ passing_yards_stat: "Passing.yards" }).passing_yards_stat).toEqual({ group: "Passing", name: "yards" });
    // The per-game metrics: absent, passing yards alone, following the per-game lookup.
    expect(defaults.game_stats).toEqual({ [GAME_PASSING_YARDS_METRIC]: { group: "Passing", name: "yards" } });
    expect(readApiSportsConfig({ game_passing_yards_stat: { group: "QB", name: "yards" } }).game_stats).toEqual({ [GAME_PASSING_YARDS_METRIC]: { group: "QB", name: "yards" } });
    expect(readApiSportsConfig(THREE_METRICS).game_stats).toEqual(THREE_METRICS.game_stats);
    // A malformed entry is dropped; a key that is not a metric key is dropped; nothing usable means the default.
    expect(readApiSportsConfig({ game_stats: { game_passer_rating: { group: "Passing", name: " rating " }, broken: { group: "Passing" }, "Bad Key": { group: "Passing", name: "yards" } } }).game_stats).toEqual({
      game_passer_rating: { group: "Passing", name: "rating" },
    });
    expect(readApiSportsConfig({ game_stats: {} }).game_stats).toEqual({ [GAME_PASSING_YARDS_METRIC]: { group: "Passing", name: "yards" } });
    expect(readApiSportsConfig({ game_stats: "Passing" }).game_stats).toEqual({ [GAME_PASSING_YARDS_METRIC]: { group: "Passing", name: "yards" } });
    expect(readApiSportsConfig({ excluded_stages: [] }).excluded_stages).toEqual([]);
    expect(readApiSportsConfig({ excluded_stages: "Pre Season" }).excluded_stages).toEqual(["Pre Season"]);
  });

  it("matches stages ignoring case, spaces and punctuation", () => {
    const config = readApiSportsConfig({});
    for (const spelling of ["Pre Season", "Preseason", "PRE-SEASON", "pre season"]) expect(isExcludedStage(spelling, config), spelling).toBe(true);
    expect(isExcludedStage("Regular Season", config)).toBe(false);
    expect(isExcludedStage("Post Season", config)).toBe(false);
    expect(isExcludedStage(null, config)).toBe(false);
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
    await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch));
    expect(fetch.urls("/status")).toHaveLength(1);
  });

  it("substitutes the player, season, team and game into the configured paths", async () => {
    const fetch = apisportsFetch();
    await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch));
    expect(fetch.urls("/players/statistics")).toEqual([`https://${HOST}/players/statistics?id=1197&season=2026`]);
    expect(fetch.urls("/games?")).toEqual([`https://${HOST}/games?season=2026&team=17`]);
    expect(fetch.urls("/games/statistics/players")).toEqual([`https://${HOST}/games/statistics/players?id=21528`]);
  });

  describe("the season total", () => {
    it("is read from the grouped shape, '3,587' as 3587, and snapshotted RAW: never a metric reading", async () => {
      const ctx = context(apisportsFetch());
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(ctx.recorded).toContainEqual({ metricKey: SEASON_PASSING_YARDS_SNAPSHOT, value: 3587 });
      expect(readings?.map((r) => r.metricKey)).not.toContain(SEASON_PASSING_YARDS_SNAPSHOT);
    });

    it("snapshots once per change, not once per poll", async () => {
      const unchanged = context(apisportsFetch(), { latest: { [SEASON_PASSING_YARDS_SNAPSHOT]: { value: 3587, recordedAt: NOW }, [GAME_PASSING_YARDS_METRIC]: { value: 184, recordedAt: new Date(WEEK1_KICKOFF) } } });
      await apisportsConnector.fetchMetrics?.(person, PLAYER, unchanged);
      expect(unchanged.recorded).toEqual([]);
      const moved = context(apisportsFetch(), { latest: { [SEASON_PASSING_YARDS_SNAPSHOT]: { value: 3301, recordedAt: NOW }, [GAME_PASSING_YARDS_METRIC]: { value: 184, recordedAt: new Date(WEEK1_KICKOFF) } } });
      await apisportsConnector.fetchMetrics?.(person, PLAYER, moved);
      expect(moved.recorded).toEqual([{ metricKey: SEASON_PASSING_YARDS_SNAPSHOT, value: 3587 }]);
    });

    it("fails LOUDLY on a value that is not a number, recording nothing, rather than reading '3,58' as 3", async () => {
      const ctx = context(apisportsFetch({ statistics: [seasonEntry("3,58")] }));
      await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, ctx)).rejects.toThrow(/carried a passing-yards value that is not a number: "3,58" \(group "Passing", statistic "yards"\)/);
      expect(ctx.recorded).toEqual([]);
      await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, context(apisportsFetch({ statistics: [seasonEntry(null)] })))).rejects.toThrow(/not a number: null/);
    });

    it("is a NOTE, not a failure, when it cannot be found: the plan, the quota, the groups and statistics present, and the tried keys are named, and the per-game metrics are still read (Phase 16)", async () => {
      const fetch = apisportsFetch({ statistics: [{ teams: [{ team: { id: 17 }, groups: [{ name: "Rushing", statistics: [{ name: "yards", value: "12" }] }] }] }], plan: "Free", requests: { current: 44, limit_day: 100 } });
      const ctx = context(fetch);
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(ctx.notes).toHaveLength(1);
      expect(ctx.notes[0]).toMatch(/carried no passing yards/);
      expect(ctx.notes[0]).toMatch(/plan Free, 44 of 100 requests used today/);
      expect(ctx.notes[0]).toMatch(/no statistic "yards" in group "Passing" \(groups present: Rushing; statistics in that group: none\)/);
      expect(ctx.notes[0]).toMatch(/passing\.yards, passing_yards, yards/);
      expect(ctx.notes[0]).toMatch(/per-game metrics were read regardless/);
      // Nothing false recorded for the season, and the per-game figure is there: the fallback did not gate the product.
      expect(ctx.recorded.map((r) => r.metricKey)).not.toContain(SEASON_PASSING_YARDS_SNAPSHOT);
      expect(readings?.map((r) => r.metricKey)).toEqual([GAME_PASSING_YARDS_METRIC]);
    });

    it("an EMPTY season response (what the host answered from 20:45 UTC on 2026-09-17) is a note on an ok poll: the per-game metrics are read through config.team_id", async () => {
      const fetch = apisportsFetch({ statistics: [], plan: "Pro", requests: { current: 293, limit_day: 7500 } });
      const ctx = context(fetch, { config: { team_id: 17 } });
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(ctx.notes).toEqual([
        expect.stringMatching(/season statistics answered with no entries for player 1197 on v1\.american-football\.api-sports\.io for season 2026; plan Pro, 293 of 7500 requests used today: season total not recorded this poll; per-game metrics read through config\.team_id/),
      ]);
      expect(ctx.recorded.map((r) => r.metricKey)).not.toContain(SEASON_PASSING_YARDS_SNAPSHOT);
      expect(readings).toEqual([{ metricKey: GAME_PASSING_YARDS_METRIC, value: 184, recordedAt: new Date(WEEK1_KICKOFF) }]);
      expect(fetch.urls("/games/statistics/players")).toHaveLength(1);
      // Without a configured team the fixtures cannot be addressed at all, and THAT is still loud.
      await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, context(apisportsFetch({ statistics: [] })))).rejects.toThrow(/yielded no team id/);
    });

    it("still reads a keyed shape through the dotted fallbacks", async () => {
      const ctx = context(apisportsFetch({ statistics: [{ team: { id: 17 }, passing: { yards: 342 } }] }));
      await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(ctx.recorded).toContainEqual({ metricKey: SEASON_PASSING_YARDS_SNAPSHOT, value: 342 });
    });
  });

  describe("the per-game metric (the Phase 10 definition of game_passing_yards)", () => {
    it("reads the one finished regular-season game from the per-game endpoint and records it AT THE GAME'S DATE", async () => {
      const fetch = apisportsFetch();
      const ctx = context(fetch);
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(readings).toEqual([{ metricKey: GAME_PASSING_YARDS_METRIC, value: 184, recordedAt: new Date(WEEK1_KICKOFF) }]);
      // Only the counted finished game was fetched: not the preseason ones, not the scheduled one.
      expect(fetch.urls("/games/statistics/players")).toEqual([`https://${HOST}/games/statistics/players?id=21528`]);
    });

    it("never records a game twice: a game at or before the last recorded date is not fetched again", async () => {
      const fetch = apisportsFetch();
      const ctx = context(fetch, { latest: { [GAME_PASSING_YARDS_METRIC]: { value: 184, recordedAt: new Date(WEEK1_KICKOFF) } } });
      expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx)).toEqual([]);
      expect(fetch.urls("/games/statistics/players")).toEqual([]);
    });

    it("backfills several finished games oldest first: older ones queued as snapshots at their dates, the newest observed", async () => {
      const games = [
        ...GAMES,
        game(21543, "Regular Season", "Week 2", "2026-09-21", "20:00", undefined, "FT", [...KC, 24], [12, "Indianapolis Colts", 17]),
        game(21550, "Regular Season", "Week 3", "2026-09-27", "20:00", undefined, "FT", [10, "Miami Dolphins", 20], [...KC, 27]),
      ].filter((g) => g.game.id !== 21543 || g.game.status.short === "FT");
      const stats = { "21528": gameStats("184"), "21543": gameStats("301"), "21550": gameStats("266") };
      const fetch = apisportsFetch({ games, gameStats: stats });
      const ctx = context(fetch);
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(fetch.urls("/games/statistics/players")).toEqual([
        `https://${HOST}/games/statistics/players?id=21528`,
        `https://${HOST}/games/statistics/players?id=21543`,
        `https://${HOST}/games/statistics/players?id=21550`,
      ]);
      expect(ctx.recorded.filter((r) => r.metricKey === GAME_PASSING_YARDS_METRIC)).toEqual([
        { metricKey: GAME_PASSING_YARDS_METRIC, value: 184, recordedAt: new Date(WEEK1_KICKOFF) },
        { metricKey: GAME_PASSING_YARDS_METRIC, value: 301, recordedAt: new Date("2026-09-21T20:00:00.000Z") },
      ]);
      expect(readings).toEqual([{ metricKey: GAME_PASSING_YARDS_METRIC, value: 266, recordedAt: new Date("2026-09-27T20:00:00.000Z") }]);
      // Next poll, with the newest recorded: nothing to fetch.
      const again = context(apisportsFetch({ games, gameStats: stats }), { latest: { [GAME_PASSING_YARDS_METRIC]: { value: 266, recordedAt: new Date("2026-09-27T20:00:00.000Z") } } });
      expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, again)).toEqual([]);
    });

    it("refuses a composite value LOUDLY, naming the game and the value, and records nothing for it", async () => {
      const ctx = context(apisportsFetch({ gameStats: { "21528": gameStats("15/27") } }));
      await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, ctx)).rejects.toThrow(
        /game 21528 \(Week 1, 2026-09-15\) carried a game_passing_yards value for player 1197 that is not a plain number: "15\/27" \(group "Passing", statistic "yards"\)\. Composite figures/,
      );
      expect(ctx.recorded.some((r) => r.metricKey === GAME_PASSING_YARDS_METRIC)).toBe(false);
    });

    it("skips a game the player did not appear in, without error, and fails loudly when he appears but the statistic is not where config says", async () => {
      const dnp = context(apisportsFetch({ gameStats: { "21528": gameStats("184", { withMahomes: false }) } }));
      expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, dnp)).toEqual([]);
      const renamed = context(apisportsFetch(), { config: { game_passing_yards_stat: { group: "Passing", name: "air yards" } } });
      await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, renamed)).rejects.toThrow(
        /game 21528 \(Week 1, 2026-09-15\) lists player 1197 \(patrick-mahomes\) but carries no statistic "air yards" in group "Passing" for him \(metric game_passing_yards; groups present: Passing, Rushing; his statistics in that group: comp att, yards, average, passing touch downs, interceptions, sacks, rating, two pt\)\. Correct config\.game_stats\.game_passing_yards/,
      );
    });

    it("handles both grouped shapes through one config-driven lookup: the per-game name can differ from the season name", async () => {
      const ctx = context(apisportsFetch(), { config: { game_passing_yards_stat: { group: "Rushing", name: "yards" } } });
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(readings).toEqual([{ metricKey: GAME_PASSING_YARDS_METRIC, value: 23, recordedAt: new Date(WEEK1_KICKOFF) }]);
      expect(ctx.recorded).toContainEqual({ metricKey: SEASON_PASSING_YARDS_SNAPSHOT, value: 3587 });
    });
  });

  describe("several per-game metrics from one game (Phase 13+: config.game_stats)", () => {
    it("reads every configured figure from ONE per-game request, each recorded at the game's date under its own key", async () => {
      const fetch = apisportsFetch();
      const ctx = context(fetch, { config: THREE_METRICS });
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(readings).toEqual([
        { metricKey: "game_passing_yards", value: 184, recordedAt: new Date(WEEK1_KICKOFF) },
        { metricKey: "game_passer_rating", value: 50.2, recordedAt: new Date(WEEK1_KICKOFF) },
        { metricKey: "game_interceptions", value: 1, recordedAt: new Date(WEEK1_KICKOFF) },
      ]);
      // Three metrics, one request: the response is read three times, not fetched three times.
      expect(fetch.urls("/games/statistics/players")).toEqual([`https://${HOST}/games/statistics/players?id=21528`]);
    });

    it("keeps a separate anchor per metric: a metric registered later backfills the games the others already have", async () => {
      // Yards already recorded for Week 1; rating and interceptions have never been read.
      const fetch = apisportsFetch();
      const ctx = context(fetch, { config: THREE_METRICS, latest: { game_passing_yards: { value: 184, recordedAt: new Date(WEEK1_KICKOFF) } } });
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(readings).toEqual([
        { metricKey: "game_passer_rating", value: 50.2, recordedAt: new Date(WEEK1_KICKOFF) },
        { metricKey: "game_interceptions", value: 1, recordedAt: new Date(WEEK1_KICKOFF) },
      ]);
      expect(fetch.urls("/games/statistics/players")).toEqual([`https://${HOST}/games/statistics/players?id=21528`]);
      expect(ctx.recorded.filter((r) => r.metricKey !== SEASON_PASSING_YARDS_SNAPSHOT)).toEqual([]);
      // All three anchored at Week 1: nothing to fetch, nothing read.
      const caughtUp = apisportsFetch();
      const done = context(caughtUp, {
        config: THREE_METRICS,
        latest: {
          game_passing_yards: { value: 184, recordedAt: new Date(WEEK1_KICKOFF) },
          game_passer_rating: { value: 50.2, recordedAt: new Date(WEEK1_KICKOFF) },
          game_interceptions: { value: 1, recordedAt: new Date(WEEK1_KICKOFF) },
        },
      });
      expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, done)).toEqual([]);
      expect(caughtUp.urls("/games/statistics/players")).toEqual([]);
    });

    it("backfills each metric on its own: older games as snapshots at their dates, the newest as the reading, per key", async () => {
      const games = [
        ...GAMES.filter((g) => g.game.id !== 21543),
        game(21543, "Regular Season", "Week 2", "2026-09-21", "20:00", undefined, "FT", [...KC, 24], [12, "Indianapolis Colts", 17]),
      ];
      const stats = { "21528": gameStats("184"), "21543": gameStats("301", { rating: "118.4", interceptions: "0" }) };
      const week2 = new Date("2026-09-21T20:00:00.000Z");
      // Yards is anchored at Week 1, so it needs Week 2 only; the other two need both games.
      const ctx = context(apisportsFetch({ games, gameStats: stats }), { config: THREE_METRICS, latest: { game_passing_yards: { value: 184, recordedAt: new Date(WEEK1_KICKOFF) } } });
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(ctx.recorded.filter((r) => r.metricKey !== SEASON_PASSING_YARDS_SNAPSHOT)).toEqual([
        { metricKey: "game_passer_rating", value: 50.2, recordedAt: new Date(WEEK1_KICKOFF) },
        { metricKey: "game_interceptions", value: 1, recordedAt: new Date(WEEK1_KICKOFF) },
      ]);
      expect(readings).toEqual([
        { metricKey: "game_passing_yards", value: 301, recordedAt: week2 },
        { metricKey: "game_passer_rating", value: 118.4, recordedAt: week2 },
        { metricKey: "game_interceptions", value: 0, recordedAt: week2 },
      ]);
    });

    it("skips a game the player did not appear in for EVERY metric, without error", async () => {
      const fetch = apisportsFetch({ gameStats: { "21528": gameStats("184", { withMahomes: false }) } });
      const ctx = context(fetch, { config: THREE_METRICS });
      expect(await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx)).toEqual([]);
      expect(ctx.recorded.filter((r) => r.metricKey !== SEASON_PASSING_YARDS_SNAPSHOT)).toEqual([]);
    });

    it("names the metric when one figure is not where config says, and records nothing for the game", async () => {
      const ctx = context(apisportsFetch(), { config: { game_stats: { ...THREE_METRICS.game_stats, game_passer_rating: { group: "Passing", name: "qb rating" } } } });
      await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, ctx)).rejects.toThrow(
        /carries no statistic "qb rating" in group "Passing" for him \(metric game_passer_rating; groups present: Passing, Rushing; his statistics in that group: comp att, yards, .*rating, two pt\)\. Correct config\.game_stats\.game_passer_rating on the data_sources row\./,
      );
      expect(ctx.recorded.filter((r) => r.metricKey !== SEASON_PASSING_YARDS_SNAPSHOT)).toEqual([]);
    });

    it("refuses a composite figure LOUDLY under whatever key it is registered: 'comp att' (15/27) and 'sacks' (2-12) can never become metrics", async () => {
      for (const [metricKey, name, raw] of [
        ["game_completions", "comp att", "15/27"],
        ["game_sacks", "sacks", "2-12"],
      ] as const) {
        const ctx = context(apisportsFetch(), { config: { game_stats: { ...THREE_METRICS.game_stats, [metricKey]: { group: "Passing", name } } } });
        await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, ctx)).rejects.toThrow(
          new RegExp(`carried a ${metricKey} value for player 1197 that is not a plain number: "${raw}" \\(group "Passing", statistic "${name}"\\)\\. Composite figures \\("15/27", "2-12"\\) are never registered\\. Nothing was recorded\\.`),
        );
        expect(ctx.recorded.filter((r) => r.metricKey !== SEASON_PASSING_YARDS_SNAPSHOT)).toEqual([]);
      }
    });

    it("reads a zero as a reading, not as missing: a clean game is 0 interceptions", async () => {
      const ctx = context(apisportsFetch({ gameStats: { "21528": gameStats("184", { interceptions: "0" }) } }), { config: THREE_METRICS });
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(readings?.find((r) => r.metricKey === "game_interceptions")).toEqual({ metricKey: "game_interceptions", value: 0, recordedAt: new Date(WEEK1_KICKOFF) });
    });
  });

  describe("preseason does not count", () => {
    it("excludes preseason games from the metric AND from the events, by stage, whatever their date", async () => {
      const fetch = apisportsFetch();
      const signals = await apisportsConnector.fetchForPerson(person, PLAYER, context(fetch));
      expect(signals.map((s) => s.dedupeKey)).toEqual(["apisports:game:21528"]);
      const readings = await apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch));
      expect(readings?.map((r) => r.value)).toEqual([184]);
      expect(fetch.urls("/games/statistics/players")).not.toContain(`https://${HOST}/games/statistics/players?id=21477`);
    });

    it("is configuration: an empty exclusion list counts them, a different list excludes something else", async () => {
      const all = await apisportsConnector.fetchForPerson(person, PLAYER, context(apisportsFetch(), { config: { excluded_stages: [] } }));
      expect(all.map((s) => s.dedupeKey)).toEqual(["apisports:game:21528", "apisports:game:21508", "apisports:game:21477"]);
      expect(all[1].headline).toBe("Week 3: Kansas City Chiefs and Seattle Seahawks finish 9-9.");
      const inverted = await apisportsConnector.fetchForPerson(person, PLAYER, context(apisportsFetch(), { config: { excluded_stages: ["regular-season"] } }));
      expect(inverted.map((s) => s.dedupeKey)).toEqual(["apisports:game:21508", "apisports:game:21477"]);
    });
  });

  describe("events", () => {
    it("emits one signal per FINISHED counted game, keyed on the game id, with the week in the headline and the stage in the payload", async () => {
      const signals = await apisportsConnector.fetchForPerson(person, PLAYER, context(apisportsFetch()));
      expect(signals).toHaveLength(1);
      expect(signals[0].dedupeKey).toBe("apisports:game:21528");
      expect(signals[0].headline).toBe("Week 1: Kansas City Chiefs beat Denver Broncos 31-10.");
      expect(signals[0].occurredAt.toISOString()).toBe(WEEK1_KICKOFF);
      expect(signals[0].rawPayload).toMatchObject({ kind: "game_result", game_id: "21528", stage: "Regular Season", week: "Week 1", home_score: 31, away_score: 10 });
    });

    it("fetches the games list once per poll, shared by the event and metric reads", async () => {
      const fetch = apisportsFetch();
      const ctx = context(fetch);
      await apisportsConnector.fetchForPerson(person, PLAYER, ctx);
      await apisportsConnector.fetchMetrics?.(person, PLAYER, ctx);
      expect(fetch.urls("/games?")).toHaveLength(1);
    });

    it("takes the team id from config when set — and then spends no season-statistics request on the event read", async () => {
      const fromConfig = apisportsFetch();
      await apisportsConnector.fetchForPerson(person, PLAYER, context(fromConfig, { config: { team_id: 99 } }));
      expect(fromConfig.urls("/games?")).toEqual([`https://${HOST}/games?season=2026&team=99`]);
      expect(fromConfig.urls("/players/statistics")).toEqual([]);
      // Otherwise from the grouped statistics response.
      const fromResponse = apisportsFetch();
      await apisportsConnector.fetchForPerson(person, PLAYER, context(fromResponse));
      expect(fromResponse.urls("/games?")).toEqual([`https://${HOST}/games?season=2026&team=17`]);
    });
  });

  it("treats a 200 carrying an errors payload as a failure, not as an empty result", async () => {
    // A wrong key, or a sport the key is not subscribed to, answers 200 with
    // errors. Reading that as "no games" is how a connector goes quiet.
    const fetch = apisportsFetch({ errorsOn: { path: "/status", errors: { token: "Invalid API key" } } });
    await expect(apisportsConnector.fetchMetrics?.(person, PLAYER, context(fetch))).rejects.toThrow(/refused \/status.*token: Invalid API key/);
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
