import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { apiSportsPacing, resetApiSportsPacing, resetApiSportsStatusCache } from "./apisports";
import {
  DEFAULT_NBA_CONFIG,
  apisportsNbaConnector,
  gamesToRead,
  isExcludedNbaStage,
  mergedNbaConfig,
  nbaGameSignal,
  nbaLineClause,
  nbaSeasonFor,
  parseMinutes,
  readNbaConfig,
  readNbaGame,
  readNbaLine,
  resetNbaCaches,
  type NbaGame,
} from "./apisports-nba";

/**
 * THE NBA CONNECTOR, on last season's real box scores (2025-26, as the
 * wire reports and box-score sites published them; the API-NBA host itself
 * is unreachable from this network, so the SHAPES are the documented ones
 * and the FIGURES are the real games). For each of the four: a big game, an
 * ordinary game, and a game he did not play, which must read nothing.
 *
 *   Stephen Curry      big  2025-11-14 at SAS, W 109-108: 49 pts, 4 reb, 2 ast, 36 min
 *                      avg  2025-12-31 at CHA, W 132-125: 26 pts, 2 reb, 4 ast, 33 min
 *                      DNP  2026-02-07 at LAL, L 99-105: out, right knee
 *   LeBron James       big  2026-02-12 vs DAL, W 124-104: 28 pts, 10 reb, 12 ast, 35 min (triple-double)
 *                      avg  2026-02-07 vs GSW, W 105-99: 20 pts, 7 reb, 10 ast (double-double; minutes not in the
 *                           reachable sources, 34 used: his season average)
 *                      DNP  2026-01-07 at SAS, L 91-107: out, foot (arthritis) and sciatica
 *   Victor Wembanyama  big  2026-04-01 at GSW, W 127-113: 41 pts, 18 reb, 3 ast, 3 blk, 29 min
 *                      avg  2025-12-29 vs CLE, L 101-113: 26 pts, 14 reb, 3 ast, 27 min
 *                      DNP  2025-11-16 vs SAC, W 123-110: out, left calf strain
 *   Shai Gilgeous-Alexander
 *                      big  2025-10-23 at IND, W 141-135 (2OT): 55 pts, 8 reb, 5 ast, 45 min
 *                      avg  2025-11-15 vs CHA, W 109-96: 33 pts, 4 reb, 7 ast, 29 min
 *                      DNP  2025-12-07 at UTA, W 131-101: out, left elbow bursitis
 */

const HOST = "v2.nba.api-sports.io";
const SOURCE = makeSource({ name: "apisports_nba", config: null });

interface Player {
  person: ReturnType<typeof makePerson>;
  id: number;
  team: { id: number; name: string };
}
const CURRY: Player = { person: makePerson({ id: "p-curry", slug: "stephen-curry", display_name: "Stephen Curry", category: "athlete" }), id: 124, team: { id: 11, name: "Golden State Warriors" } };
const LEBRON: Player = { person: makePerson({ id: "p-lebron", slug: "lebron-james", display_name: "LeBron James", category: "athlete" }), id: 265, team: { id: 17, name: "Los Angeles Lakers" } };
const WEMBY: Player = { person: makePerson({ id: "p-wemby", slug: "victor-wembanyama", display_name: "Victor Wembanyama", category: "athlete" }), id: 3412, team: { id: 31, name: "San Antonio Spurs" } };
const SGA: Player = { person: makePerson({ id: "p-sga", slug: "shai-gilgeous-alexander", display_name: "Shai Gilgeous-Alexander", category: "athlete" }), id: 882, team: { id: 25, name: "Oklahoma City Thunder" } };

/** A game as API-NBA documents it: numeric status short (3 = finished), `periods.total`, teams under home/visitors, points under scores. */
function game(id: number, start: string, home: { id: number; name: string; points: number | null }, visitors: { id: number; name: string; points: number | null }, options: { periods?: number; finished?: boolean; stage?: number; end?: string | null } = {}) {
  const finished = options.finished ?? true;
  return {
    id,
    league: "standard",
    season: 2025,
    date: { start, end: options.end ?? null, duration: finished ? "2:14" : null },
    stage: options.stage ?? 2,
    status: { clock: null, halftime: false, short: finished ? 3 : 1, long: finished ? "Finished" : "Scheduled" },
    periods: { current: options.periods ?? 4, total: options.periods ?? 4, endOfPeriod: false },
    teams: { visitors: { id: visitors.id, name: visitors.name }, home: { id: home.id, name: home.name } },
    scores: { visitors: { win: 0, loss: 0, points: visitors.points }, home: { win: 0, loss: 0, points: home.points } },
  };
}

/** One player's line as `/players/statistics?game=` returns it: keyed fields, minutes as "mm:ss", `comment` for a DNP. */
function line(player: Player, gameId: number, figures: { points?: number; totReb?: number; assists?: number; min?: string | null; comment?: string | null; blocks?: number }) {
  return {
    player: { id: player.id, firstname: player.person.display_name.split(" ")[0], lastname: player.person.display_name.split(" ").slice(1).join(" ") },
    team: { id: player.team.id, name: player.team.name },
    game: { id: gameId },
    points: figures.points ?? null,
    pos: "G",
    min: figures.min === undefined ? "30:00" : figures.min,
    fgm: null,
    fga: null,
    fgp: null,
    ftm: null,
    fta: null,
    ftp: null,
    tpm: null,
    tpa: null,
    tpp: null,
    offReb: null,
    defReb: null,
    totReb: figures.totReb ?? null,
    assists: figures.assists ?? null,
    pFouls: null,
    steals: null,
    turnovers: null,
    blocks: figures.blocks ?? null,
    plusMinus: null,
    comment: figures.comment ?? null,
  };
}

const OTHER: Player = { person: makePerson({ id: "p-other", slug: "someone-else", display_name: "Someone Else" }), id: 9999, team: { id: 1, name: "Other" } };

/** The fixtures: three games per player, as above. */
const FIXTURES = {
  curry: {
    big: game(14101, "2025-11-15T02:00:00.000Z", { ...WEMBY.team, points: 108 }, { ...CURRY.team, points: 109 }),
    avg: game(14230, "2026-01-01T00:00:00.000Z", { id: 4, name: "Charlotte Hornets", points: 125 }, { ...CURRY.team, points: 132 }),
    dnp: game(14402, "2026-02-08T03:30:00.000Z", { ...LEBRON.team, points: 105 }, { ...CURRY.team, points: 99 }),
  },
  lebron: {
    big: game(14420, "2026-02-13T03:30:00.000Z", { ...LEBRON.team, points: 124 }, { id: 8, name: "Dallas Mavericks", points: 104 }),
    avg: game(14402, "2026-02-08T03:30:00.000Z", { ...LEBRON.team, points: 105 }, { ...CURRY.team, points: 99 }),
    dnp: game(14301, "2026-01-08T01:30:00.000Z", { ...WEMBY.team, points: 107 }, { ...LEBRON.team, points: 91 }),
  },
  wemby: {
    big: game(14690, "2026-04-02T02:00:00.000Z", { ...CURRY.team, points: 113 }, { ...WEMBY.team, points: 127 }),
    avg: game(14222, "2025-12-30T01:00:00.000Z", { ...WEMBY.team, points: 101 }, { id: 6, name: "Cleveland Cavaliers", points: 113 }),
    dnp: game(14105, "2025-11-17T00:00:00.000Z", { ...WEMBY.team, points: 123 }, { id: 30, name: "Sacramento Kings", points: 110 }),
  },
  sga: {
    big: game(14002, "2025-10-23T23:30:00.000Z", { id: 15, name: "Indiana Pacers", points: 135 }, { ...SGA.team, points: 141 }, { periods: 6 }),
    avg: game(14104, "2025-11-16T01:00:00.000Z", { ...SGA.team, points: 109 }, { id: 4, name: "Charlotte Hornets", points: 96 }),
    dnp: game(14215, "2025-12-08T01:00:00.000Z", { id: 40, name: "Utah Jazz", points: 101 }, { ...SGA.team, points: 131 }),
  },
};

const LINES: Record<number, unknown[]> = {
  14101: [line(CURRY, 14101, { points: 49, totReb: 4, assists: 2, min: "36:03" }), line(OTHER, 14101, { points: 24, totReb: 3, assists: 10, min: "35:10" })],
  14230: [line(CURRY, 14230, { points: 26, totReb: 2, assists: 4, min: "33:12" })],
  14402: [line(CURRY, 14402, { min: null, comment: "Injury/Illness - Right Knee" }), line(LEBRON, 14402, { points: 20, totReb: 7, assists: 10, min: "34:00" })],
  14420: [line(LEBRON, 14420, { points: 28, totReb: 10, assists: 12, min: "35:04" })],
  14301: [line(LEBRON, 14301, { min: "0:00", comment: "Injury/Illness - Foot; sciatica" }), line(WEMBY, 14301, { points: 16, totReb: 14, assists: 2, min: "26:11" })],
  14690: [line(WEMBY, 14690, { points: 41, totReb: 18, assists: 3, blocks: 3, min: "28:47" })],
  14222: [line(WEMBY, 14222, { points: 26, totReb: 14, assists: 3, min: "27:20" })],
  // Not on the sheet at all: the host lists only the players who dressed.
  14105: [line(OTHER, 14105, { points: 28, totReb: 3, assists: 11, min: "34:00" })],
  14002: [line(SGA, 14002, { points: 55, totReb: 8, assists: 5, min: "45:12" })],
  14104: [line(SGA, 14104, { points: 33, totReb: 4, assists: 7, min: "29:03" })],
  14215: [line(SGA, 14215, { min: null, comment: "Injury/Illness - Left Elbow; Bursitis" })],
};

interface Call {
  url: string;
}

/** The API-NBA double: /status, /games?season&team, /players/statistics?game=. */
function nbaFetch(games: unknown[], options: { plan?: string; lines?: Record<number, unknown[]> } = {}) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url });
    const envelope = (response: unknown[], path: string) => Response.json({ get: path, parameters: {}, errors: [], results: response.length, response });
    if (url.includes("/status")) return envelope([{ subscription: { plan: options.plan ?? "Pro", end: "2026-11-09T00:00:00+00:00", active: true }, requests: { current: 12, limit_day: 7500 } }], "status");
    if (url.includes("/players/statistics")) {
      const id = Number(new URL(url).searchParams.get("game"));
      return envelope((options.lines ?? LINES)[id] ?? [], "players/statistics");
    }
    if (url.includes("/games")) return envelope(games, "games");
    throw new Error(`unexpected url ${url}`);
  };
  return Object.assign(impl, { calls, urls: (fragment: string) => calls.filter((call) => call.url.includes(fragment)).map((call) => call.url) });
}

function context(fetch: typeof globalThis.fetch, player: Player, options: { now: Date; latest?: Record<string, { value: number; recordedAt: Date }> }) {
  const recorded: Array<{ metricKey: string; value: number; recordedAt?: Date }> = [];
  const details: Record<string, unknown> = {};
  return {
    source: SOURCE,
    config: { host: HOST } as unknown as Record<string, never>,
    personConfig: { team_id: player.team.id } as unknown as Record<string, never>,
    snapshots: {
      latest: async (metricKey: string) => {
        const hit = options.latest?.[metricKey];
        return hit ? { metricKey, value: hit.value, recordedAt: hit.recordedAt } : null;
      },
      record: (metricKey: string, value: number, recordedAt?: Date) => void recorded.push(recordedAt ? { metricKey, value, recordedAt } : { metricKey, value }),
    },
    now: options.now,
    fetch,
    detail: (key: string, value: unknown) => {
      details[key] = value;
    },
    recorded,
    details,
  };
}

describe("the configuration", () => {
  it("has the API-NBA defaults, reads overrides, and takes the mapping's team, figures and threshold", () => {
    expect(readNbaConfig({})).toEqual(DEFAULT_NBA_CONFIG);
    expect(DEFAULT_NBA_CONFIG.host).toBe("v2.nba.api-sports.io");
    expect(DEFAULT_NBA_CONFIG.game_stats).toEqual({ game_points: "points", game_rebounds: "totReb", game_assists: "assists" });
    expect(readNbaConfig({ min_minutes: 12, recent_games: 3, game_stats: { game_points: "points", bad: 1 } })).toMatchObject({ min_minutes: 12, recent_games: 3, game_stats: { game_points: "points" } });
    expect(readNbaConfig(mergedNbaConfig({ host: HOST, min_minutes: 10 }, { team_id: 11, min_minutes: 15, host: "ignored" }))).toMatchObject({ host: HOST, team_id: 11, min_minutes: 15 });
  });

  it("names the season for the year it starts in (October): June belongs to the previous one", () => {
    expect(nbaSeasonFor(new Date("2025-10-21T00:00:00Z"), null)).toBe(2025);
    expect(nbaSeasonFor(new Date("2026-04-01T00:00:00Z"), null)).toBe(2025);
    expect(nbaSeasonFor(new Date("2026-06-10T00:00:00Z"), null)).toBe(2025);
    expect(nbaSeasonFor(new Date("2026-10-09T00:00:00Z"), null)).toBe(2026);
    expect(nbaSeasonFor(new Date("2026-10-09T00:00:00Z"), 2024)).toBe(2024);
  });

  it("excludes preseason by stage number or name", () => {
    expect(isExcludedNbaStage("Pre Season", DEFAULT_NBA_CONFIG)).toBe(true);
    expect(isExcludedNbaStage("preseason", DEFAULT_NBA_CONFIG)).toBe(true);
    expect(isExcludedNbaStage("Regular Season", DEFAULT_NBA_CONFIG)).toBe(false);
    expect(readNbaGame(game(1, "2025-10-05T00:00:00Z", { id: 1, name: "A", points: 1 }, { id: 2, name: "B", points: 2 }, { stage: 1 }))?.stage).toBe("Pre Season");
  });
});

describe("games and lines", () => {
  it("reads a game: tip-off, finished by status, periods, home and visitors with points", () => {
    const read = readNbaGame(FIXTURES.sga.big)!;
    expect(read).toMatchObject({ id: "14002", finished: true, status: "Finished", stage: "Regular Season", periods: 6, home: { name: "Indiana Pacers", score: 135 }, away: { name: "Oklahoma City Thunder", score: 141 } });
    expect(read.date.toISOString()).toBe("2025-10-23T23:30:00.000Z");
    expect(readNbaGame(game(5, "2026-10-10T00:00:00Z", { id: 1, name: "A", points: null }, { id: 2, name: "B", points: null }, { finished: false }))?.finished).toBe(false);
    expect(readNbaGame({ id: 7, date: { start: "not a date" } })).toBeNull();
  });

  it("reads minutes as the host writes them, and never reads a line that is not a plain number", () => {
    expect(parseMinutes("34:12")).toBeCloseTo(34.2, 5);
    expect(parseMinutes("0:00")).toBe(0);
    expect(parseMinutes("")).toBeNull();
    expect(parseMinutes(null)).toBeNull();
    expect(parseMinutes("29")).toBe(29);
    expect(parseMinutes("DNP")).toBeNull();
  });

  it("finds the subject's line among a game's players and judges whether he played: a DNP comment, no minutes, or under the threshold is nothing", () => {
    expect(readNbaLine(LINES[14002], DEFAULT_NBA_CONFIG, "882")).toMatchObject({ status: "played", line: { points: 55, rebounds: 8, assists: 5, minutes: 45.2 } });
    expect(readNbaLine(LINES[14402], DEFAULT_NBA_CONFIG, "124")).toMatchObject({ status: "did_not_play", reason: "Injury/Illness - Right Knee" });
    expect(readNbaLine(LINES[14301], DEFAULT_NBA_CONFIG, "265")).toMatchObject({ status: "did_not_play", reason: "Injury/Illness - Foot; sciatica" });
    expect(readNbaLine(LINES[14105], DEFAULT_NBA_CONFIG, "3412")).toEqual({ status: "absent" });
    // A token appearance: three minutes at the end of a blowout is not a sample.
    expect(readNbaLine([line(SGA, 1, { points: 2, totReb: 0, assists: 1, min: "3:40" })], DEFAULT_NBA_CONFIG, "882")).toMatchObject({ status: "did_not_play", reason: "3.7 minutes, under the 10-minute threshold" });
    expect(readNbaLine([line(SGA, 1, { points: 2, min: null })], DEFAULT_NBA_CONFIG, "882")).toMatchObject({ status: "did_not_play", reason: "no minutes on the sheet" });
  });
});

describe("the headline", () => {
  const observedAt = new Date("2026-10-09T12:00:00.000Z");
  const signal = (fixture: unknown, player: Player, gameId: number) => nbaGameSignal(player.person, readNbaGame(fixture as never)!, (readNbaLine(LINES[gameId], DEFAULT_NBA_CONFIG, String(player.id)) as unknown as { line: never }).line, "apisports_nba", { observedAt, config: DEFAULT_NBA_CONFIG })!;

  it("says the result and the line, names double- and triple-doubles, and the overtime", () => {
    expect(nbaLineClause({ points: 55, rebounds: 8, assists: 5 })).toBe("55 points, 8 rebounds and 5 assists");
    expect(nbaLineClause({ points: 28, rebounds: 10, assists: 12 })).toBe("a triple-double: 28 points, 10 rebounds and 12 assists");
    expect(nbaLineClause({ points: 41, rebounds: 18, assists: 3 })).toBe("a double-double: 41 points, 18 rebounds and 3 assists");
    expect(nbaLineClause({ points: 1, rebounds: null, assists: 1 })).toBe("1 point and 1 assist");
    expect(nbaLineClause({ points: null, rebounds: null, assists: null })).toBe("");
    expect(signal(FIXTURES.sga.big, SGA, 14002).headline).toBe("Oklahoma City Thunder beat Indiana Pacers 141-135 in double overtime; Shai Gilgeous-Alexander had 55 points, 8 rebounds and 5 assists in 45 minutes.");
    expect(signal(FIXTURES.curry.big, CURRY, 14101).headline).toBe("Golden State Warriors beat San Antonio Spurs 109-108; Stephen Curry had 49 points, 4 rebounds and 2 assists in 36 minutes.");
    expect(signal(FIXTURES.lebron.big, LEBRON, 14420).headline).toBe("Los Angeles Lakers beat Dallas Mavericks 124-104; LeBron James had a triple-double: 28 points, 10 rebounds and 12 assists in 35 minutes.");
    expect(signal(FIXTURES.wemby.big, WEMBY, 14690).headline).toBe("San Antonio Spurs beat Golden State Warriors 127-113; Victor Wembanyama had a double-double: 41 points, 18 rebounds and 3 assists in 29 minutes.");
    expect(signal(FIXTURES.wemby.avg, WEMBY, 14222).headline).toBe("Cleveland Cavaliers beat San Antonio Spurs 113-101; Victor Wembanyama had a double-double: 26 points, 14 rebounds and 3 assists in 27 minutes.");
    expect(signal(FIXTURES.lebron.avg, LEBRON, 14402).headline).toBe("Los Angeles Lakers beat Golden State Warriors 105-99; LeBron James had a double-double: 20 points, 7 rebounds and 10 assists in 34 minutes.");
  });

  it("carries the game result payload the Feed reads, with the line, and stamps the end as the NFL does", () => {
    const sga = signal(FIXTURES.sga.big, SGA, 14002);
    expect(sga.dedupeKey).toBe("apisports_nba:game:14002");
    expect(sga.rawPayload).toMatchObject({ kind: "game_result", source: "apisports_nba", game_id: "14002", home: "Indiana Pacers", away: "Oklahoma City Thunder", home_score: 135, away_score: 141, overtime: true, subject: "Shai Gilgeous-Alexander", line: { points: 55, rebounds: 8, assists: 5, minutes: 45.2 }, ended_at_basis: "tipoff" });
    // Seen inside the sighting window: the observation is the end; a reported end wins when the host gives one.
    const soon = nbaGameSignal(SGA.person, readNbaGame(FIXTURES.sga.big)!, { points: 55, rebounds: 8, assists: 5, minutes: 45.2, comment: null }, "apisports_nba", { observedAt: new Date("2025-10-24T03:00:00.000Z"), config: DEFAULT_NBA_CONFIG })!;
    expect(soon.rawPayload).toMatchObject({ ended_at_basis: "observed_final", ended_at: "2025-10-24T03:00:00.000Z" });
    const reported = readNbaGame({ ...FIXTURES.sga.big, date: { start: "2025-10-23T23:30:00.000Z", end: "2025-10-24T02:45:00.000Z" } })!;
    expect(nbaGameSignal(SGA.person, reported, { points: 55, rebounds: 8, assists: 5, minutes: 45.2, comment: null }, "apisports_nba", { observedAt, config: DEFAULT_NBA_CONFIG })!.rawPayload).toMatchObject({ ended_at_basis: "reported_end", ended_at: "2025-10-24T02:45:00.000Z" });
  });
});

describe("the connector, on the four players' seasons", () => {
  const previousKey = process.env.APISPORTS_API_KEY;
  beforeEach(() => {
    process.env.APISPORTS_API_KEY = "test-key";
    resetApiSportsPacing();
    resetApiSportsStatusCache();
    resetNbaCaches();
    apiSportsPacing.sleep = async () => undefined;
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.APISPORTS_API_KEY;
    else process.env.APISPORTS_API_KEY = previousKey;
  });

  /** A season of three games for one player, polled the morning after the last of them. */
  async function poll(player: Player, games: unknown[], now: Date, latest?: Record<string, { value: number; recordedAt: Date }>) {
    const fetch = nbaFetch(games);
    const ctx = context(fetch, player, { now, latest });
    const events = await apisportsNbaConnector.fetchForPerson(player.person, String(player.id), ctx);
    const metrics = await apisportsNbaConnector.fetchMetrics!(player.person, String(player.id), ctx);
    return { fetch, ctx, events, metrics };
  }

  it("Curry: the big game and the ordinary game are each a result and a line; the knee DNP reads nothing", async () => {
    const { fetch, ctx, events, metrics } = await poll(CURRY, [FIXTURES.curry.big, FIXTURES.curry.avg, FIXTURES.curry.dnp], new Date("2026-02-08T14:00:00.000Z"));
    expect(events.map((e) => e.headline)).toEqual([
      "Golden State Warriors beat Charlotte Hornets 132-125; Stephen Curry had 26 points, 2 rebounds and 4 assists in 33 minutes.",
      "Golden State Warriors beat San Antonio Spurs 109-108; Stephen Curry had 49 points, 4 rebounds and 2 assists in 36 minutes.",
    ]);
    expect(events.some((e) => (e.rawPayload as { game_id: string }).game_id === "14402")).toBe(false);
    expect(ctx.details.game_14402).toEqual({ played: false, reason: "Injury/Illness - Right Knee" });
    // The newest PLAYED game is the reading; the older one a snapshot at its date; the DNP neither.
    expect(metrics).toEqual([
      { metricKey: "game_points", value: 26, recordedAt: new Date("2026-01-01T00:00:00.000Z") },
      { metricKey: "game_rebounds", value: 2, recordedAt: new Date("2026-01-01T00:00:00.000Z") },
      { metricKey: "game_assists", value: 4, recordedAt: new Date("2026-01-01T00:00:00.000Z") },
    ]);
    expect(ctx.recorded).toEqual([
      { metricKey: "game_points", value: 49, recordedAt: new Date("2025-11-15T02:00:00.000Z") },
      { metricKey: "game_rebounds", value: 4, recordedAt: new Date("2025-11-15T02:00:00.000Z") },
      { metricKey: "game_assists", value: 2, recordedAt: new Date("2025-11-15T02:00:00.000Z") },
    ]);
    // Requests: one /status, one games list (shared by both reads), one line read per game (shared too).
    expect(fetch.urls("/status")).toHaveLength(1);
    expect(fetch.urls("/games?season=2025&team=11")).toHaveLength(1);
    expect(fetch.urls("/players/statistics?game=")).toHaveLength(3);
    // Five requests for the poll in all; the metric read, second, spent none of its own (every read was cached), and its account is the one that stands.
    expect(fetch.calls).toHaveLength(5);
    expect(ctx.details.apisports_nba).toMatchObject({ plan: "Pro", daily_limit: 7500, requests_this_poll: 0 });
  });

  it("LeBron: the triple-double is named; the Spurs game he sat out reads nothing", async () => {
    const { ctx, events, metrics } = await poll(LEBRON, [FIXTURES.lebron.dnp, FIXTURES.lebron.avg, FIXTURES.lebron.big], new Date("2026-02-13T14:00:00.000Z"));
    expect(events.map((e) => e.headline)).toEqual([
      "Los Angeles Lakers beat Dallas Mavericks 124-104; LeBron James had a triple-double: 28 points, 10 rebounds and 12 assists in 35 minutes.",
      "Los Angeles Lakers beat Golden State Warriors 105-99; LeBron James had a double-double: 20 points, 7 rebounds and 10 assists in 34 minutes.",
    ]);
    expect(ctx.details.game_14301).toEqual({ played: false, reason: "Injury/Illness - Foot; sciatica" });
    expect(metrics.map((m) => [m.metricKey, m.value])).toEqual([
      ["game_points", 28],
      ["game_rebounds", 10],
      ["game_assists", 12],
    ]);
    expect(ctx.recorded.map((r) => [r.metricKey, r.value, r.recordedAt?.toISOString()])).toEqual([
      ["game_points", 20, "2026-02-08T03:30:00.000Z"],
      ["game_rebounds", 7, "2026-02-08T03:30:00.000Z"],
      ["game_assists", 10, "2026-02-08T03:30:00.000Z"],
    ]);
  });

  it("Wembanyama: a game he is not on the sheet for at all reads nothing; the big and ordinary games read", async () => {
    const { ctx, events, metrics } = await poll(WEMBY, [FIXTURES.wemby.dnp, FIXTURES.wemby.avg, FIXTURES.wemby.big], new Date("2026-04-02T14:00:00.000Z"));
    expect(events.map((e) => (e.rawPayload as { game_id: string }).game_id)).toEqual(["14690", "14222"]);
    expect(ctx.details.game_14105).toEqual({ played: false, reason: "not on the sheet" });
    expect(metrics.map((m) => [m.metricKey, m.value])).toEqual([
      ["game_points", 41],
      ["game_rebounds", 18],
      ["game_assists", 3],
    ]);
  });

  it("Gilgeous-Alexander: the 55-point double-overtime game, the ordinary game, and the elbow DNP that reads nothing", async () => {
    const { ctx, events, metrics } = await poll(SGA, [FIXTURES.sga.big, FIXTURES.sga.avg, FIXTURES.sga.dnp], new Date("2025-12-08T14:00:00.000Z"));
    expect(events.map((e) => e.headline)).toEqual([
      "Oklahoma City Thunder beat Charlotte Hornets 109-96; Shai Gilgeous-Alexander had 33 points, 4 rebounds and 7 assists in 29 minutes.",
      "Oklahoma City Thunder beat Indiana Pacers 141-135 in double overtime; Shai Gilgeous-Alexander had 55 points, 8 rebounds and 5 assists in 45 minutes.",
    ]);
    expect(ctx.details.game_14215).toEqual({ played: false, reason: "Injury/Illness - Left Elbow; Bursitis" });
    expect(metrics.map((m) => [m.metricKey, m.value])).toEqual([
      ["game_points", 33],
      ["game_rebounds", 4],
      ["game_assists", 7],
    ]);
  });

  it("reads a game's lines once per poll, and once recorded never again: a DNP is re-read only inside the lookback", async () => {
    const now = new Date("2025-12-08T14:00:00.000Z");
    const anchor = { value: 33, recordedAt: new Date("2025-11-16T01:00:00.000Z") };
    const latest = { game_points: anchor, game_rebounds: anchor, game_assists: anchor };
    // The DNP of 12-07 is newer than the anchor and inside 48 hours: read, found to be a DNP, nothing recorded.
    const first = await poll(SGA, [FIXTURES.sga.big, FIXTURES.sga.avg, FIXTURES.sga.dnp], now, latest);
    expect(first.fetch.urls("/players/statistics?game=")).toEqual([`https://${HOST}/players/statistics?game=14215`]);
    expect(first.events).toEqual([]);
    expect(first.metrics).toEqual([]);
    // Three days on, the DNP is outside the lookback: no line read at all, no request spent.
    const later = await poll(SGA, [FIXTURES.sga.big, FIXTURES.sga.avg, FIXTURES.sga.dnp], new Date("2025-12-11T14:00:00.000Z"), latest);
    expect(later.fetch.urls("/players/statistics?game=")).toEqual([]);
    expect(later.fetch.urls("/games?")).toHaveLength(1);
    // The pure rule: no anchor backfills recent_games whatever their age.
    const games = [FIXTURES.sga.big, FIXTURES.sga.avg, FIXTURES.sga.dnp].map((g) => readNbaGame(g)!) as NbaGame[];
    expect(gamesToRead(games, null, now, DEFAULT_NBA_CONFIG).map((g) => g.id)).toEqual(["14002", "14104", "14215"]);
    expect(gamesToRead(games, anchor.recordedAt, now, DEFAULT_NBA_CONFIG).map((g) => g.id)).toEqual(["14215"]);
  });

  it("refuses to poll without a team id, and names the figure when a line's number is not plain", async () => {
    const fetch = nbaFetch([FIXTURES.sga.big]);
    const ctx = { ...context(fetch, SGA, { now: new Date("2025-10-24T14:00:00.000Z") }), personConfig: {} as Record<string, never> };
    await expect(apisportsNbaConnector.fetchForPerson(SGA.person, "882", ctx)).rejects.toThrow(/No API-NBA team id configured for shai-gilgeous-alexander/);
    const odd = nbaFetch([FIXTURES.sga.big], { lines: { 14002: [line(SGA, 14002, { points: "55/60" as unknown as number, totReb: 8, assists: 5, min: "45:12" })] } });
    await expect(apisportsNbaConnector.fetchMetrics!(SGA.person, "882", context(odd, SGA, { now: new Date("2025-10-24T14:00:00.000Z") }))).rejects.toThrow(/carries no plain-number "points" for him \(metric game_points; value "55\/60"\)/);
  });
});
