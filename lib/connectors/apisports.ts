import { getApiSportsKeyOrNull } from "@/lib/env";

import { ConnectorError, type DataConnector, type MetricReading, type RawSignal } from "./types";

/**
 * API-Sports connector — NFL, through the American Football host.
 *
 * external_identifier is the API-Sports PLAYER id (1197 for Patrick Mahomes).
 * APISPORTS_API_KEY comes from the server environment; when it is unset the
 * connector reports itself unavailable and the runner marks the source inactive
 * for the run.
 *
 * A DIFFERENT DATA SHAPE, AND WHAT IT DECIDES.
 *
 * Everything the platform has ingested so far is continuous and ambiguous: a
 * subscriber count drifts, a news volume rises, and what counts as "a lot" is
 * only ever relative to the person's own past. A football season is neither. A
 * game happens on a known date or it does not; a team wins or loses; a
 * quarterback throws for a number of yards that is final the moment the game
 * ends. The split below follows from that:
 *
 *   EVENTS — game results. Discrete, dated, outcome-bearing, and already
 *   expressed in language the sentiment path reads. One signal per game, keyed
 *   on the game id, so re-polling a finished game never stores it twice.
 *
 *   METRIC — per-game passing yards, and only that. It is sampled ONCE PER
 *   GAME rather than once per poll: the connector returns a reading only when
 *   the figure has moved, so the baseline's `samples` count games and not
 *   hours. Read at 1.8σ above his own recent form, that is a statement about a
 *   performance rather than about the polling schedule.
 *
 * WHAT IS DELIBERATELY NOT REGISTERED. Season cumulative totals — passing
 * yards, touchdowns, completions to date — are monotone step functions: flat
 * for a week, then a jump. Snapshotted hourly, their delta series is 167 zeros
 * and one spike per week, so the standard deviation collapses toward the sd
 * floor and every game emits a maximal signal. That is not a measurement; it is
 * an expensive way of saying "a game happened", which the event says better.
 * Season completion percentage has the mirror-image problem: as a running
 * aggregate over hundreds of attempts it barely moves off its own mean, so it
 * would never leave the band no matter how the games went.
 *
 * REQUEST BUDGET. The free plan allows 100 requests per day. This connector
 * makes at most two per poll (player statistics, fixtures) plus a /status probe
 * cached per process, and its data_sources row carries a 175-minute poll
 * interval, so it polls eight times a day: about sixteen requests, against a
 * weekly event cadence that would not reward more.
 *
 * THE PATHS ARE CONFIGURATION, AND WHY. api-sports.io is unreachable from the
 * network this was written on — every domain of theirs is refused by the egress
 * proxy — so the endpoint paths and statistic field names live in
 * data_sources.config: a path that turns out wrong is a one-row update, not a
 * deploy. Every read validates the envelope and throws naming what actually
 * came back, so a wrong guess writes the truth into source_polls instead of
 * going quiet.
 *
 * WHAT THE FIRST LIVE RESPONSE TAUGHT (2026-09-17, run by hand). Player
 * statistics on the American Football host are not keyed fields. They come
 * back as named GROUPS of name/value pairs:
 *
 *   response[0].teams[0].groups[{ name: "Passing", statistics: [{ name: "yards", value: "3,587" }, ...] }, { name: "Rushing", statistics: [{ name: "yards", value: "422" }] }, ...]
 *
 * Three things follow. A statistic is addressed by GROUP and NAME, never by a
 * dotted path — "yards" alone is ambiguous across Passing, Rushing and
 * Receiving. Values are STRINGS with thousands separators, so the parser
 * accepts exactly that grammar and refuses anything else out loud ("3,587" is
 * 3587; it is never 3). And the figure is the SEASON CUMULATIVE total, which
 * this connector deliberately does not register as a metric (see above): it
 * is snapshotted raw, once per change, under `season_passing_yards`, and the
 * per-game figure `game_passing_yards` waits on a decision recorded outside
 * this file — the per-game endpoint, or a difference of the cumulative.
 */

export const APISPORTS_SOURCE_NAME = "apisports";
/** American Football has its own host and its own id space; a key subscribed only to, say, soccer answers here with an errors payload. */
const DEFAULT_HOST = "v1.american-football.api-sports.io";
const STATUS_CACHE_MS = 6 * 3_600_000;

export interface ApiSportsPaths {
  /** Team fixtures. {season} and {team} are substituted. */
  games: string;
  /** Player season / per-game statistics. {season} and {player} are substituted. */
  player_statistics: string;
}

/** Where a statistic lives in the grouped shape: the group's name and the statistic's name, both matched case-insensitively. */
export interface GroupedStatLookup {
  group: string;
  name: string;
}

export interface ApiSportsConnectorConfig {
  host: string;
  /** Season year. Null means derive it from the calendar. */
  season: number | null;
  /** API-Sports team id, when known; otherwise taken from the player's statistics response. */
  team_id: number | null;
  paths: ApiSportsPaths;
  /** The season passing-yards statistic in the grouped shape the American Football host returns. */
  passing_yards_stat: GroupedStatLookup;
  /** Dotted-path fallbacks for a keyed shape, tried in order when the grouped lookup finds nothing. */
  passing_yards_keys: string[];
  /** How many finished games back to consider for events on one poll. */
  recent_games: number;
}

const DEFAULT_CONFIG: ApiSportsConnectorConfig = {
  host: DEFAULT_HOST,
  season: null,
  team_id: null,
  paths: {
    games: "/games?season={season}&team={team}",
    player_statistics: "/players/statistics?id={player}&season={season}",
  },
  passing_yards_stat: { group: "Passing", name: "yards" },
  passing_yards_keys: ["passing.yards", "passing_yards", "yards"],
  recent_games: 5,
};

/** The raw snapshot key of the season cumulative figure. Not a metric: no baseline, no signal, never registered. */
export const SEASON_PASSING_YARDS_SNAPSHOT = "season_passing_yards";

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lookupOr(value: unknown, fallback: GroupedStatLookup): GroupedStatLookup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  return typeof record.group === "string" && record.group.trim() && typeof record.name === "string" && record.name.trim()
    ? { group: record.group.trim(), name: record.name.trim() }
    : fallback;
}

export function readApiSportsConfig(config: Record<string, unknown>): ApiSportsConnectorConfig {
  const paths = (config.paths ?? {}) as Record<string, unknown>;
  const keys = config.passing_yards_keys;
  const recent = numberOrNull(config.recent_games);
  return {
    host: stringOr(config.host, DEFAULT_CONFIG.host),
    season: numberOrNull(config.season),
    team_id: numberOrNull(config.team_id),
    paths: {
      games: stringOr(paths.games, DEFAULT_CONFIG.paths.games),
      player_statistics: stringOr(paths.player_statistics, DEFAULT_CONFIG.paths.player_statistics),
    },
    passing_yards_stat: lookupOr(config.passing_yards_stat, DEFAULT_CONFIG.passing_yards_stat),
    passing_yards_keys:
      Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === "string") ? (keys as string[]) : DEFAULT_CONFIG.passing_yards_keys,
    recent_games: recent !== null && recent > 0 ? Math.floor(recent) : DEFAULT_CONFIG.recent_games,
  };
}

/** An NFL season is named for the year it starts in; January and February belong to the previous season. */
export function seasonFor(now: Date, configured: number | null): number {
  if (configured !== null) return configured;
  const year = now.getUTCFullYear();
  return now.getUTCMonth() <= 1 ? year - 1 : year;
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * Every API-Sports endpoint answers with the same wrapper. `errors` is an empty
 * ARRAY when there are none and an OBJECT of messages when there are, which is
 * why it is normalised rather than trusted.
 */
export interface ApiSportsEnvelope<T> {
  get?: string;
  results?: number;
  errors?: unknown;
  response?: T[];
}

/** The messages in an `errors` payload, in either shape it takes. Empty means none. */
export function envelopeErrors(errors: unknown): string[] {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (typeof errors === "object") return Object.entries(errors as Record<string, unknown>).map(([key, value]) => `${key}: ${String(value)}`);
  return typeof errors === "string" ? [errors] : [];
}

async function call<T>(path: string, config: ApiSportsConnectorConfig, key: string, fetchImpl: typeof fetch): Promise<ApiSportsEnvelope<T>> {
  const response = await fetchImpl(`https://${config.host}${path}`, { headers: { "x-apisports-key": key, accept: "application/json" } });
  if (!response.ok) {
    throw new ConnectorError(`API-Sports responded ${response.status} for ${path} on ${config.host}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const body = (await response.json()) as ApiSportsEnvelope<T>;
  const errors = envelopeErrors(body.errors);
  if (errors.length > 0) {
    // API-Sports answers 200 with an errors payload for a wrong token, an
    // unsubscribed sport or a malformed parameter. Reading that as success is
    // how a connector goes quiet, so it raises here.
    throw new ConnectorError(`API-Sports refused ${path} on ${config.host}: ${errors.join("; ")}`, { status: 200 });
  }
  return body;
}

// ---------------------------------------------------------------------------
// Status: what this key is actually subscribed to
// ---------------------------------------------------------------------------

export interface ApiSportsStatus {
  plan: string | null;
  requestsToday: number | null;
  dailyLimit: number | null;
}

let cachedStatus: { at: number; host: string; status: ApiSportsStatus } | null = null;

/** For tests. */
export function resetApiSportsStatusCache(): void {
  cachedStatus = null;
}

/**
 * The subscription probe. Cheap, identical across API-Sports hosts, and the
 * only way to tell "this key is not subscribed to American Football" from "this
 * player id does not exist" — the two failures that look alike from a player
 * endpoint. Cached per process so it does not spend the daily quota every poll.
 */
export async function fetchApiSportsStatus(
  config: ApiSportsConnectorConfig,
  key: string,
  fetchImpl: typeof fetch,
  now = Date.now(),
): Promise<ApiSportsStatus> {
  if (cachedStatus && cachedStatus.host === config.host && now - cachedStatus.at < STATUS_CACHE_MS) return cachedStatus.status;
  const body = await call<unknown>("/status", config, key, fetchImpl);
  const first = (Array.isArray(body.response) ? body.response[0] : body.response) as
    | { subscription?: { plan?: string }; requests?: { current?: number; limit_day?: number } }
    | undefined;
  const status: ApiSportsStatus = {
    plan: typeof first?.subscription?.plan === "string" ? first.subscription.plan : null,
    requestsToday: numberOrNull(first?.requests?.current),
    dailyLimit: numberOrNull(first?.requests?.limit_day),
  };
  cachedStatus = { at: now, host: config.host, status };
  return status;
}

// ---------------------------------------------------------------------------
// Reading the shapes
// ---------------------------------------------------------------------------

/** Follows a dotted path through a nested object, e.g. "passing.yards". */
function dig(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value && typeof value === "object" && segment in (value as Record<string, unknown>)) return (value as Record<string, unknown>)[segment];
    return undefined;
  }, source);
}

/**
 * A statistic's value, strictly. The host sends numbers as strings, with
 * thousands separators ("3,587"), sometimes negative ("-10"), sometimes with a
 * decimal ("62.7"), sometimes null. This accepts exactly that grammar — an
 * optional sign, digits grouped in threes by commas or ungrouped, an optional
 * decimal part — strips the separators and converts. Anything else is null,
 * never a partial read: "3,587" is 3587, and it can never come back as 3.
 */
const STAT_VALUE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

export function parseStatValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!STAT_VALUE.test(text)) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** A statistic that may arrive as a number or as a numeric string ("342"), addressed by dotted path. */
export function readStatistic(source: unknown, candidates: string[]): number | null {
  for (const candidate of candidates) {
    const value = parseStatValue(dig(source, candidate));
    if (value !== null) return value;
  }
  return null;
}

export type GroupedStatResult =
  | { status: "ok"; value: number; raw: unknown }
  /** The statistic is there and its value is not a number: say so, never guess. */
  | { status: "unparseable"; raw: unknown }
  /** No such group / name; what IS there, so the next config edit is informed. */
  | { status: "missing"; groups: string[]; names: string[] };

interface RawGroup {
  name?: unknown;
  statistics?: Array<{ name?: unknown; value?: unknown }>;
}

function groupsOf(entry: unknown): RawGroup[] {
  const teams = (entry as { teams?: unknown } | undefined)?.teams;
  if (!Array.isArray(teams)) return [];
  return teams.flatMap((team) => {
    const groups = (team as { groups?: unknown } | undefined)?.groups;
    return Array.isArray(groups) ? (groups as RawGroup[]) : [];
  });
}

const same = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A statistic in the grouped shape: `teams[].groups[name].statistics[name].value`.
 * Group first, because names repeat across groups ("yards" is passing,
 * rushing and receiving yards depending on which one it is under).
 */
export function readGroupedStatistic(entry: unknown, lookup: GroupedStatLookup): GroupedStatResult {
  const groups = groupsOf(entry);
  for (const group of groups) {
    if (!same(group.name, lookup.group)) continue;
    for (const stat of group.statistics ?? []) {
      if (!same(stat.name, lookup.name)) continue;
      const value = parseStatValue(stat.value);
      return value === null ? { status: "unparseable", raw: stat.value } : { status: "ok", value, raw: stat.value };
    }
  }
  const matched = groups.filter((group) => same(group.name, lookup.group));
  return {
    status: "missing",
    groups: groups.map((group) => (typeof group.name === "string" ? group.name : "?")),
    names: matched.flatMap((group) => (group.statistics ?? []).map((stat) => (typeof stat.name === "string" ? stat.name : "?"))),
  };
}

export interface ApiSportsGame {
  id: string;
  date: Date;
  finished: boolean;
  home: { name: string; score: number | null };
  away: { name: string; score: number | null };
}

interface RawGame {
  game?: { id?: number | string; date?: { date?: string; timestamp?: number }; status?: { short?: string; long?: string } };
  id?: number | string;
  date?: string | { date?: string; timestamp?: number };
  status?: { short?: string; long?: string };
  teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } };
  scores?: { home?: { total?: number | null }; away?: { total?: number | null } };
}

/** Status codes API-Sports uses for a completed game. */
const FINISHED = new Set(["FT", "AOT", "POST-FT", "Finished", "Final"]);

/**
 * Normalises one game. The American Football host nests identifiers under
 * `game` while other hosts hoist them; both spellings are accepted so that a
 * host or version change does not silently yield zero games.
 */
export function readGame(raw: RawGame): ApiSportsGame | null {
  const id = raw.game?.id ?? raw.id;
  if (id === undefined || id === null) return null;
  const rawDate = raw.game?.date?.date ?? (typeof raw.date === "string" ? raw.date : raw.date?.date);
  const timestamp = raw.game?.date?.timestamp ?? (typeof raw.date === "object" ? raw.date?.timestamp : undefined);
  const date = rawDate ? new Date(rawDate) : typeof timestamp === "number" ? new Date(timestamp * 1000) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const short = raw.game?.status?.short ?? raw.status?.short ?? raw.game?.status?.long ?? raw.status?.long ?? "";
  return {
    id: String(id),
    date,
    finished: FINISHED.has(short),
    home: { name: raw.teams?.home?.name ?? "the home team", score: numberOrNull(raw.scores?.home?.total) },
    away: { name: raw.teams?.away?.name ?? "the away team", score: numberOrNull(raw.scores?.away?.total) },
  };
}

/** Signal kind for a completed game, so the Feed and the Engine can tell it from an article. */
export const APISPORTS_GAME_KIND = "game_result";

export function gameSignal(person: { display_name: string }, game: ApiSportsGame, source: string): RawSignal | null {
  if (!game.finished || game.home.score === null || game.away.score === null) return null;
  const drawn = game.home.score === game.away.score;
  const [winner, loser] = game.home.score > game.away.score ? [game.home, game.away] : [game.away, game.home];
  return {
    headline: drawn
      ? `${game.home.name} and ${game.away.name} finish ${game.home.score}-${game.away.score}.`
      : `${winner.name} beat ${loser.name} ${winner.score}-${loser.score}.`,
    occurredAt: game.date,
    dedupeKey: `${source}:game:${game.id}`,
    rawPayload: {
      kind: APISPORTS_GAME_KIND,
      source,
      game_id: game.id,
      played_at: game.date.toISOString(),
      home: game.home.name,
      away: game.away.name,
      home_score: game.home.score,
      away_score: game.away.score,
      subject: person.display_name,
    },
  };
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

function requireKey(): string {
  const key = getApiSportsKeyOrNull();
  if (!key) throw new ConnectorError("APISPORTS_API_KEY is not set");
  return key;
}

function fill(path: string, values: Record<string, string | number>): string {
  return path.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/** The team whose fixtures carry this player, from config or from the statistics response. */
function teamIdFrom(config: ApiSportsConnectorConfig, statistics: unknown[]): number | null {
  if (config.team_id !== null) return config.team_id;
  for (const entry of statistics) {
    const id = readStatistic(entry, ["team.id", "teams.0.team.id"]);
    if (id !== null) return id;
  }
  return null;
}

function requirePlayer(person: { slug: string }, playerId: string): string {
  const trimmed = playerId.trim();
  if (!trimmed) throw new ConnectorError(`No API-Sports player id configured for ${person.slug}`);
  return trimmed;
}

export const apisportsConnector: DataConnector = {
  name: APISPORTS_SOURCE_NAME,

  available() {
    return getApiSportsKeyOrNull() ? { ok: true } : { ok: false, reason: "APISPORTS_API_KEY is not set" };
  },

  /** Events: finished games, one signal each. */
  async fetchForPerson(person, playerId, context): Promise<RawSignal[]> {
    if (typeof window !== "undefined") throw new Error("The API-Sports connector is server-only.");
    const key = requireKey();
    const config = readApiSportsConfig(context.config as Record<string, unknown>);
    const player = requirePlayer(person, playerId);

    const status = await fetchApiSportsStatus(config, key, context.fetch, context.now.getTime());
    const season = seasonFor(context.now, config.season);

    const statistics = (await call<unknown>(fill(config.paths.player_statistics, { player, season }), config, key, context.fetch)).response ?? [];
    const team = teamIdFrom(config, statistics);
    if (team === null) {
      throw new ConnectorError(
        `API-Sports player ${player} yielded no team id on ${config.host} (plan ${status.plan ?? "unknown"}), so the fixture list cannot be addressed. ` +
          `Set config.team_id on the data_sources row, or correct config.paths.player_statistics — the statistics response carried ${statistics.length} entr${statistics.length === 1 ? "y" : "ies"}.`,
      );
    }

    const games = (await call<RawGame>(fill(config.paths.games, { season, team }), config, key, context.fetch)).response ?? [];
    return games
      .map(readGame)
      .filter((game): game is ApiSportsGame => game !== null && game.finished)
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, config.recent_games)
      .map((game) => gameSignal(person, game, APISPORTS_SOURCE_NAME))
      .filter((signal): signal is RawSignal => signal !== null);
  },

  /**
   * The season passing-yards figure, read strictly and snapshotted RAW once
   * per change. It is the season cumulative total — the shape this connector
   * refuses to register as a metric (a monotone step function has no usable
   * baseline) — so it goes to raw_source_snapshots only, with no observation
   * and no signal, under SEASON_PASSING_YARDS_SNAPSHOT. The per-game metric,
   * `game_passing_yards`, is not produced here until its source is settled:
   * either the per-game statistics endpoint or a difference of this total.
   *
   * Every failure is loud and names what came back: a value that is not a
   * number, or a group / statistic that is not there and the ones that are.
   */
  async fetchMetrics(person, playerId, context): Promise<MetricReading[]> {
    if (typeof window !== "undefined") throw new Error("The API-Sports connector is server-only.");
    const key = requireKey();
    const config = readApiSportsConfig(context.config as Record<string, unknown>);
    const player = requirePlayer(person, playerId);

    const status = await fetchApiSportsStatus(config, key, context.fetch, context.now.getTime());
    const season = seasonFor(context.now, config.season);
    const statistics = (await call<unknown>(fill(config.paths.player_statistics, { player, season }), config, key, context.fetch)).response ?? [];
    const where = `on ${config.host} for season ${season}; plan ${status.plan ?? "unknown"}, ${status.requestsToday ?? "?"} of ${status.dailyLimit ?? "?"} requests used today`;

    const grouped = readGroupedStatistic(statistics[0], config.passing_yards_stat);
    if (grouped.status === "unparseable") {
      throw new ConnectorError(
        `API-Sports player ${player} (${person.slug}) carried a passing-yards value that is not a number: ${JSON.stringify(grouped.raw)} ` +
          `(group "${config.passing_yards_stat.group}", statistic "${config.passing_yards_stat.name}") ${where}. Nothing was recorded.`,
      );
    }
    const yards = grouped.status === "ok" ? grouped.value : readStatistic(statistics[0], config.passing_yards_keys);
    if (yards === null) {
      const seen = grouped.status === "missing" ? grouped : { groups: [], names: [] };
      throw new ConnectorError(
        `API-Sports player ${player} (${person.slug}) carried no passing yards ${where}: ` +
          `no statistic "${config.passing_yards_stat.name}" in group "${config.passing_yards_stat.group}" ` +
          `(groups present: ${seen.groups.length > 0 ? seen.groups.join(", ") : "none"}; statistics in that group: ${seen.names.length > 0 ? seen.names.join(", ") : "none"}), ` +
          `and none of ${config.passing_yards_keys.join(", ")} as a keyed field. ` +
          `The statistics response held ${statistics.length} entr${statistics.length === 1 ? "y" : "ies"}; correct config.passing_yards_stat or config.paths.player_statistics on the data_sources row rather than redeploying.`,
      );
    }

    // Once per change, not once per poll: the total is the same number until
    // a new game is played, and a row per hour would be a row about the cron.
    const previous = await context.snapshots.latest(SEASON_PASSING_YARDS_SNAPSHOT);
    if (!previous || previous.value !== yards) context.snapshots.record(SEASON_PASSING_YARDS_SNAPSHOT, yards);
    return [];
  },
};
