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
 *   METRICS — per-game figures, read from the PER-GAME statistics endpoint
 *   one finished game at a time and recorded AT THE GAME'S DATE, so the
 *   baseline's `samples` count games and not hours. Read at 1.8σ above his
 *   own recent form, that is a statement about a performance rather than
 *   about the polling schedule. Which figures, and where each lives in the
 *   response, is config.game_stats on the row: a metric key to a group and
 *   name; each key then needs its own declaration in config.metrics.
 *
 * WHICH FIGURES, AND WHY THESE (Phase 13+). Yards alone is a thin proxy: a
 * 184-yard, 2-TD, 1-INT, 50.2-rating line in a 31-10 win reads as mediocre on
 * yards and as a triumph in the news. Three per-game metrics are registered:
 *   game_passing_yards   volume; polarity +1
 *   game_passer_rating   the performance metric; polarity +1. The league's own
 *                        composite of completion rate, yards per attempt, TD
 *                        rate and INT rate, bounded 0–158.3, so a bad line
 *                        reads negative on its own without a second metric.
 *   game_interceptions   polarity −1. The one axis the rating formula dampens
 *                        (its INT term saturates), discrete, and the failure a
 *                        bad game announces itself with.
 * Passing touchdowns are NOT registered: rating already carries the TD rate
 * and the game-result event already carries the scoring, so a fourth reading
 * would be one more copy of the same performance. Composite values ("15/27",
 * "2-12") are never registered by construction: the parser refuses them.
 *
 * ONE GAME, ONE READING. Three metrics from one game are one performance, not
 * three pieces of evidence; the Signals force folds metric signals from one
 * source that share a moment into one reading (lib/engine/forces/signals.ts).
 *
 * WHAT IS DELIBERATELY NOT REGISTERED. Season cumulative totals — passing
 * yards, touchdowns, completions to date — are monotone step functions: flat
 * for a week, then a jump. Snapshotted hourly, their delta series is 167 zeros
 * and one spike per week, so the standard deviation collapses toward the sd
 * floor and every game emits a maximal signal. That is not a measurement; it is
 * an expensive way of saying "a game happened", which the event says better.
 * The season total IS kept as a raw snapshot (no baseline, no signal), once
 * per change, because it costs nothing and is the fallback if the per-game
 * endpoint ever goes away.
 *
 * WHAT THE METRIC PATH CANNOT SEE. A per-game figure is judged against the
 * player's own trailing games and nothing else: not the score, not the
 * opponent, not whether the team won. The result is the EVENT's to carry.
 * The two meet only in the Signals force, where a poor line in a win and a
 * "commanding win" headline are summed and partly cancel; nothing reconciles
 * them, and that divergence is a limitation to expect, not a defect.
 *
 * PRESEASON DOES NOT COUNT. A preseason game is not a performance sample —
 * starters play a series or two — and a preseason tie is not news. Games
 * whose `stage` is in config.excluded_stages ("Pre Season") produce neither
 * the metric nor an event. Filtered, not down-weighted: there is no honest
 * weight for a game that says nothing, and no mechanism for "half news".
 *
 * REQUEST BUDGET. Per poll: the /status probe (cached six hours), the season
 * statistics, the games list (fetched once and shared by the event and metric
 * reads), and one per-game statistics call for each finished game not yet
 * recorded — one a week in season. Behind the 175-minute poll interval that
 * is about thirty requests a day against a Pro plan's 7,500.
 *
 * THE PATHS ARE CONFIGURATION, AND WHY. api-sports.io is unreachable from the
 * network this was written on — every domain of theirs is refused by the egress
 * proxy — so the endpoint paths and statistic names live in data_sources.config:
 * a name that turns out wrong is a one-row update, not a deploy. Every read
 * validates the envelope and throws naming what actually came back.
 *
 * WHAT THE FIRST LIVE RESPONSES TAUGHT (2026-09-17, run by hand). Statistics
 * on this host are never keyed fields; they are named GROUPS of name/value
 * pairs, in two arrangements:
 *
 *   season   response[0].teams[0].groups[{ name: "Passing", statistics: [{ name: "yards", value: "3,587" }] }]
 *   per game response[team].groups[{ name: "Passing", players: [{ player: { id: 1197 }, statistics: [{ name: "yards", value: "184" }] }] }]
 *
 * One reader handles both: a statistic is addressed by GROUP and NAME (never
 * a dotted path — "yards" repeats under Passing, Rushing and Receiving), and
 * when a group lists players the player id selects among them. Values are
 * STRINGS with thousands separators ("3,587" is 3587, never 3), and some are
 * composite ("15/27", "2-12"): the parser accepts exactly the numeric grammar
 * and refuses the rest out loud, so a composite figure can never be
 * registered by accident. The season endpoint carries LAST season's totals
 * under the current season number until enough of the new season accrues;
 * the games and per-game endpoints are current, which is one more reason the
 * metric comes from the per-game read.
 */

export const APISPORTS_SOURCE_NAME = "apisports";
/** American Football has its own host and its own id space; a key subscribed only to, say, soccer answers here with an errors payload. */
const DEFAULT_HOST = "v1.american-football.api-sports.io";
const STATUS_CACHE_MS = 6 * 3_600_000;

export interface ApiSportsPaths {
  /** Team fixtures. {season} and {team} are substituted. */
  games: string;
  /** Player season statistics. {season} and {player} are substituted. */
  player_statistics: string;
  /** Every player's statistics for one game. {game} is substituted. */
  game_statistics: string;
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
  /** API-Sports team id, when known; otherwise taken from the player's season statistics response. */
  team_id: number | null;
  paths: ApiSportsPaths;
  /** The season passing-yards total in the season endpoint's grouped shape. */
  passing_yards_stat: GroupedStatLookup;
  /** The per-game passing yards in the per-game endpoint's grouped shape. Defaults to passing_yards_stat. The default entry of game_stats. */
  game_passing_yards_stat: GroupedStatLookup;
  /**
   * Every per-game metric read: metric key to where it lives in the per-game
   * response. Each key needs a declaration in config.metrics to emit; without
   * one it is snapshotted only. Absent: game_passing_yards alone.
   */
  game_stats: Record<string, GroupedStatLookup>;
  /** Dotted-path fallbacks for a keyed shape, tried in order when the grouped lookup finds nothing. */
  passing_yards_keys: string[];
  /** How many finished games back to consider, for events and for the metric's first backfill, on one poll. */
  recent_games: number;
  /** Game stages that count for nothing: no event, no metric. Matched ignoring case, spaces and punctuation. */
  excluded_stages: string[];
  /**
   * Dotted paths on the raw game where the host reports a FINAL time, tried
   * in order. Empty by default because the American Football host is not
   * known to report one; if it ever does, naming it here is a row update and
   * the timestamp stops being an observation and becomes a fact.
   */
  game_end_keys: string[];
  /** Status codes that mean the game ran past regulation. Used for the headline and nothing else. */
  overtime_statuses: string[];
  /**
   * Plain-numeric statistics the result headline may quote, by a key this
   * file knows how to phrase. A lookup that finds nothing is OMITTED from the
   * headline and noted — never guessed at — so a name that turns out wrong
   * costs a clause, not a wrong number.
   */
  headline_stats: Record<string, GroupedStatLookup>;
  /**
   * How long after kickoff a FIRST sighting of a finished game may still be
   * treated as having watched it end. Beyond it the game plainly finished
   * while nothing was watching (a backfill, a resumed schedule), and the
   * kickoff is used instead. See gameSignal.
   */
  live_sighting_hours: number;
  /** One poll reports the per-game statistic names and the raw game's keys through the note channel. Off by default. */
  diagnostics: boolean;
}

const DEFAULT_CONFIG: ApiSportsConnectorConfig = {
  host: DEFAULT_HOST,
  season: null,
  team_id: null,
  paths: {
    games: "/games?season={season}&team={team}",
    player_statistics: "/players/statistics?id={player}&season={season}",
    game_statistics: "/games/statistics/players?id={game}",
  },
  passing_yards_stat: { group: "Passing", name: "yards" },
  game_passing_yards_stat: { group: "Passing", name: "yards" },
  game_stats: { game_passing_yards: { group: "Passing", name: "yards" } },
  passing_yards_keys: ["passing.yards", "passing_yards", "yards"],
  recent_games: 5,
  excluded_stages: ["Pre Season"],
  game_end_keys: [],
  overtime_statuses: ["AOT", "OT", "POST-OT", "After Over Time"],
  // Passing yards is the lookup the per-game metric already proves works.
  // The touchdown name is NOT verified — it is here so the headline can use
  // it the moment it is right, and it simply does not appear until then.
  headline_stats: {
    passing_yards: { group: "Passing", name: "yards" },
    passing_touchdowns: { group: "Passing", name: "passing touch downs" },
  },
  live_sighting_hours: 24,
  diagnostics: false,
};

/** The raw snapshot key of the season cumulative figure. Not a metric: no baseline, no signal, never registered. */
export const SEASON_PASSING_YARDS_SNAPSHOT = "season_passing_yards";
/** The default per-game metric: passing yards in one game, recorded at the game's date. The others are config.game_stats. */
export const GAME_PASSING_YARDS_METRIC = "game_passing_yards";

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : fallback;
}

function lookupOr(value: unknown, fallback: GroupedStatLookup): GroupedStatLookup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  return typeof record.group === "string" && record.group.trim() && typeof record.name === "string" && record.name.trim()
    ? { group: record.group.trim(), name: record.name.trim() }
    : fallback;
}

/** config.game_stats as metric key → lookup; malformed entries are dropped, and an empty or absent object means passing yards alone. */
function gameStatsOr(value: unknown, fallback: Record<string, GroupedStatLookup>): Record<string, GroupedStatLookup> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const out: Record<string, GroupedStatLookup> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9_]+$/.test(key)) continue;
    const lookup = lookupOr(entry, { group: "", name: "" });
    if (lookup.group && lookup.name) out[key] = lookup;
  }
  return Object.keys(out).length > 0 ? out : fallback;
}

export function readApiSportsConfig(config: Record<string, unknown>): ApiSportsConnectorConfig {
  const paths = (config.paths ?? {}) as Record<string, unknown>;
  const recent = numberOrNull(config.recent_games);
  const sighting = numberOrNull(config.live_sighting_hours);
  const seasonStat = lookupOr(config.passing_yards_stat, DEFAULT_CONFIG.passing_yards_stat);
  const gameYards = lookupOr(config.game_passing_yards_stat, seasonStat);
  return {
    host: stringOr(config.host, DEFAULT_CONFIG.host),
    season: numberOrNull(config.season),
    team_id: numberOrNull(config.team_id),
    paths: {
      games: stringOr(paths.games, DEFAULT_CONFIG.paths.games),
      player_statistics: stringOr(paths.player_statistics, DEFAULT_CONFIG.paths.player_statistics),
      game_statistics: stringOr(paths.game_statistics, DEFAULT_CONFIG.paths.game_statistics),
    },
    passing_yards_stat: seasonStat,
    game_passing_yards_stat: gameYards,
    game_stats: gameStatsOr(config.game_stats, { [GAME_PASSING_YARDS_METRIC]: gameYards }),
    passing_yards_keys: stringList(config.passing_yards_keys, []).length > 0 ? stringList(config.passing_yards_keys, []) : DEFAULT_CONFIG.passing_yards_keys,
    recent_games: recent !== null && recent > 0 ? Math.floor(recent) : DEFAULT_CONFIG.recent_games,
    excluded_stages: stringList(config.excluded_stages, DEFAULT_CONFIG.excluded_stages),
    game_end_keys: stringList(config.game_end_keys, DEFAULT_CONFIG.game_end_keys),
    overtime_statuses: stringList(config.overtime_statuses, DEFAULT_CONFIG.overtime_statuses),
    headline_stats: gameStatsOr(config.headline_stats, DEFAULT_CONFIG.headline_stats),
    live_sighting_hours: sighting !== null && sighting > 0 ? sighting : DEFAULT_CONFIG.live_sighting_hours,
    diagnostics: config.diagnostics === true,
  };
}

/** An NFL season is named for the year it starts in; January and February belong to the previous season. */
export function seasonFor(now: Date, configured: number | null): number {
  if (configured !== null) return configured;
  const year = now.getUTCFullYear();
  return now.getUTCMonth() <= 1 ? year - 1 : year;
}

/** "Pre Season", "Preseason", "PRE-SEASON" are one stage. */
function stageKey(stage: string): string {
  return stage.toLowerCase().replace(/[^a-z]/g, "");
}

export function isExcludedStage(stage: string | null, config: ApiSportsConnectorConfig): boolean {
  if (stage === null) return false;
  const key = stageKey(stage);
  return config.excluded_stages.some((excluded) => stageKey(excluded) === key);
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
/** The games list, fetched once per poll and shared by the event and metric reads. */
const gamesCache = new Map<string, Promise<ApiSportsGame[]>>();
/**
 * One game's player statistics, fetched once per poll and shared by the event
 * read (which quotes the subject's line in the headline) and the metric read
 * (which records the figures). Without it the two would each spend a request
 * on the same game the week a game lands.
 */
const gameStatsCache = new Map<string, Promise<unknown[]>>();

/** For tests. */
export function resetApiSportsStatusCache(): void {
  cachedStatus = null;
  gamesCache.clear();
  gameStatsCache.clear();
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

/** Follows a dotted path through a nested object, e.g. "passing.yards" or "teams.0.team.id". */
function dig(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value && typeof value === "object" && segment in (value as Record<string, unknown>)) return (value as Record<string, unknown>)[segment];
    return undefined;
  }, source);
}

/**
 * A statistic's value, strictly. The host sends numbers as strings, with
 * thousands separators ("3,587"), sometimes negative ("-10"), sometimes with a
 * decimal ("62.7"), sometimes null, and sometimes COMPOSITE ("15/27" for
 * completions/attempts, "2-12" for sacks/yards lost). This accepts exactly
 * the numeric grammar — an optional sign, digits grouped in threes by commas
 * or ungrouped, an optional decimal part — strips the separators and
 * converts. Anything else is null, never a partial read: "3,587" is 3587 and
 * can never come back as 3, and "15/27" can never be registered as 15.
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
  /** No such group / name. What IS there, so the next config edit is informed, and whether the player appeared at all. */
  | { status: "missing"; groups: string[]; names: string[]; playerSeen: boolean };

interface RawStat {
  name?: unknown;
  value?: unknown;
}

interface RawGroup {
  name?: unknown;
  statistics?: RawStat[];
  players?: Array<{ player?: { id?: unknown }; statistics?: RawStat[] }>;
}

/** The groups of one response entry, whether they sit under `teams[]` (season) or directly on the entry (per game). */
function groupsOf(entry: unknown): RawGroup[] {
  if (!entry || typeof entry !== "object") return [];
  const own = (entry as { groups?: unknown }).groups;
  const teams = (entry as { teams?: unknown }).teams;
  const nested = Array.isArray(teams)
    ? teams.flatMap((team) => {
        const groups = (team as { groups?: unknown } | undefined)?.groups;
        return Array.isArray(groups) ? (groups as RawGroup[]) : [];
      })
    : [];
  return [...(Array.isArray(own) ? (own as RawGroup[]) : []), ...nested];
}

const same = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A statistic in either grouped shape. Group first, because names repeat
 * across groups ("yards" is passing, rushing and receiving yards depending on
 * which one it is under). When a group lists players, `playerId` selects the
 * one whose statistics are read; a group without players is read directly.
 */
export function readGroupedStatistic(entry: unknown, lookup: GroupedStatLookup, playerId?: string | number): GroupedStatResult {
  const groups = groupsOf(entry);
  const wanted = playerId === undefined ? null : String(playerId);
  const statsOf = (group: RawGroup): RawStat[] => {
    if (!Array.isArray(group.players)) return group.statistics ?? [];
    return group.players.filter((entry) => wanted === null || String(entry.player?.id) === wanted).flatMap((entry) => entry.statistics ?? []);
  };
  const playerSeen = groups.some((group) => Array.isArray(group.players) && group.players.some((entry) => wanted === null || String(entry.player?.id) === wanted));

  for (const group of groups) {
    if (!same(group.name, lookup.group)) continue;
    for (const stat of statsOf(group)) {
      if (!same(stat.name, lookup.name)) continue;
      const value = parseStatValue(stat.value);
      return value === null ? { status: "unparseable", raw: stat.value } : { status: "ok", value, raw: stat.value };
    }
  }
  const matched = groups.filter((group) => same(group.name, lookup.group));
  return {
    status: "missing",
    groups: groups.map((group) => (typeof group.name === "string" ? group.name : "?")),
    names: matched.flatMap((group) => statsOf(group).map((stat) => (typeof stat.name === "string" ? stat.name : "?"))),
    playerSeen,
  };
}

export interface ApiSportsGame {
  id: string;
  /** Kickoff. */
  date: Date;
  finished: boolean;
  /** The status code the host reported, verbatim: "FT", "AOT", ... Empty when absent. */
  status: string;
  /** A FINAL time the host reported, if config names where one lives. Null otherwise, which is the case today. */
  endedAt: Date | null;
  /** "Pre Season", "Regular Season", "Post Season" — as the host names them; null when absent. */
  stage: string | null;
  /** "Week 1", "Wild Card", ... as the host names them; null when absent. */
  week: string | null;
  home: { name: string; score: number | null };
  away: { name: string; score: number | null };
}

interface RawGame {
  game?: {
    id?: number | string;
    stage?: unknown;
    week?: unknown;
    date?: { date?: string; time?: string; timezone?: string; timestamp?: number };
    status?: { short?: string; long?: string };
  };
  id?: number | string;
  date?: string | { date?: string; time?: string; timezone?: string; timestamp?: number };
  status?: { short?: string; long?: string };
  teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } };
  scores?: { home?: { total?: number | null }; away?: { total?: number | null } };
}

/** Status codes API-Sports uses for a completed game. */
const FINISHED = new Set(["FT", "AOT", "POST-FT", "Finished", "Final"]);

/**
 * A FINAL time the host reported, from the paths config names. Unix seconds
 * or an ISO-ish string; anything that does not parse, or that lands before
 * kickoff, is refused rather than used. Empty config means the host reports
 * none, which is what the American Football host does today.
 */
export function readReportedEnd(raw: RawGame, keys: string[]): Date | null {
  for (const key of keys) {
    const value = dig(raw, key);
    const at = typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
    if (at && !Number.isNaN(at.getTime())) return at;
  }
  return null;
}

/**
 * Normalises one game. The American Football host nests identifiers under
 * `game` while other hosts hoist them; both spellings are accepted so that a
 * host or version change does not silently yield zero games. The kickoff
 * instant prefers the unix timestamp, then date + time (the host reports them
 * in UTC), then the bare date.
 */
export function readGame(raw: RawGame, config: ApiSportsConnectorConfig = DEFAULT_CONFIG): ApiSportsGame | null {
  const id = raw.game?.id ?? raw.id;
  if (id === undefined || id === null) return null;
  const dateBlock = raw.game?.date ?? (typeof raw.date === "object" ? raw.date : undefined);
  const rawDate = dateBlock?.date ?? (typeof raw.date === "string" ? raw.date : undefined);
  const timestamp = dateBlock?.timestamp;
  let date: Date | null = null;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) date = new Date(timestamp * 1000);
  else if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && typeof dateBlock?.time === "string" && /^\d{2}:\d{2}$/.test(dateBlock.time) && (!dateBlock.timezone || dateBlock.timezone === "UTC")) {
    date = new Date(`${rawDate}T${dateBlock.time}:00Z`);
  } else if (rawDate) date = new Date(rawDate);
  if (!date || Number.isNaN(date.getTime())) return null;
  const short = raw.game?.status?.short ?? raw.status?.short ?? raw.game?.status?.long ?? raw.status?.long ?? "";
  return {
    id: String(id),
    date,
    finished: FINISHED.has(short),
    status: short,
    endedAt: readReportedEnd(raw, config.game_end_keys),
    stage: typeof raw.game?.stage === "string" && raw.game.stage.trim() ? raw.game.stage.trim() : null,
    week: typeof raw.game?.week === "string" && raw.game.week.trim() ? raw.game.week.trim() : null,
    home: { name: raw.teams?.home?.name ?? "the home team", score: numberOrNull(raw.scores?.home?.total) },
    away: { name: raw.teams?.away?.name ?? "the away team", score: numberOrNull(raw.scores?.away?.total) },
  };
}

/** Signal kind for a completed game, so the Feed and the Engine can tell it from an article. */
export const APISPORTS_GAME_KIND = "game_result";

/** One player's line from a finished game, as the headline may quote it. Every figure is a plain number; the parser refuses composites. */
export interface GameLine {
  passing_yards?: number;
  passing_touchdowns?: number;
}

/**
 * HOW EACH HEADLINE STATISTIC IS SAID. Written out per key rather than
 * assembled, for the reason Phase 21+ gives: English does not survive being
 * glued together. A key with no phrase here is not quoted, which is what
 * keeps config from being able to invent a clause.
 */
const HEADLINE_PHRASE: Record<keyof GameLine, (value: number) => string | null> = {
  // Yards are not pluralised at 1 in football usage ("threw for 1 yard" is
  // right but never occurs); the singular is handled anyway.
  passing_yards: (value) => (value > 0 ? `threw for ${round(value)} ${round(value) === 1 ? "yard" : "yards"}` : null),
  // A zero-touchdown game is a real line, and saying "and 0 touchdowns" is
  // worse than saying nothing: the clause is for what happened.
  passing_touchdowns: (value) => (value > 0 ? `${round(value)} ${round(value) === 1 ? "touchdown" : "touchdowns"}` : null),
};

function round(value: number): number {
  return Math.round(value);
}

/**
 * WHEN A GAME RESULT HAPPENED (Phase 24).
 *
 * It was stamped at KICKOFF, which is the one time a result certainly did not
 * happen. The Week 2 result was dated 00:20 UTC and the game ended about
 * 04:00, so the Engine scored it at freshness 0.886 — as if it were 4.2 hours
 * old the moment it arrived — and about 11% of its impact was lost to a
 * convention. Longer games and overtime make it worse.
 *
 * Three sources, in order, and the payload records which one was used:
 *
 *   reported_end   a FINAL time the host published, if config.game_end_keys
 *                  names where it lives. The American Football host is not
 *                  known to publish one; this exists so that naming it later
 *                  is a row update rather than a deploy.
 *   observed_final the first poll that saw the game finished. A real
 *                  observation, bounded by the 40-minute poll interval — the
 *                  Week 2 result would have been stamped 04:30, about half an
 *                  hour late, against four hours and ten minutes early.
 *   kickoff        the fallback, and NOT a guess at a game length: it is used
 *                  when the first sighting is so far after kickoff that
 *                  nothing was plainly watching (a first-contact backfill —
 *                  the Week 1 result was first seen two days after kickoff,
 *                  which is exactly this case).
 *
 * A game's end lies between its kickoff and the first poll that saw it
 * finished, and each of these is one end of that interval or a fact from the
 * host. None of them estimates how long a game takes, which is not something
 * this connector can know.
 */
export function gameEndedAt(game: ApiSportsGame, observedAt: Date, config: ApiSportsConnectorConfig): { at: Date; basis: "reported_end" | "observed_final" | "kickoff" } {
  if (game.endedAt && game.endedAt.getTime() >= game.date.getTime()) return { at: game.endedAt, basis: "reported_end" };
  const lagHours = (observedAt.getTime() - game.date.getTime()) / 3_600_000;
  if (lagHours >= 0 && lagHours <= config.live_sighting_hours) return { at: observedAt, basis: "observed_final" };
  return { at: game.date, basis: "kickoff" };
}

export interface GameSignalOptions {
  /** Now, as the poll sees it: the instant this game was first observed finished. */
  observedAt: Date;
  config: ApiSportsConnectorConfig;
  /** The subject's line, when the per-game statistics were read for this game. */
  line?: GameLine | null;
}

/**
 * THE RESULT, AND WHAT THE SUBJECT DID IN IT (Phase 24).
 *
 * "Week 2: Kansas City Chiefs beat Indianapolis Colts 33-30." was true and
 * said nothing about the 382 yards and three touchdowns that made it the
 * biggest single move the board has recorded. The metric path cannot fix
 * that: a per-game figure is judged against the player's own trailing games
 * and knows nothing of the score, so a mediocre line in a win and a great
 * line in a loss can only be reconciled where a model reads both together —
 * which is the sentiment scorer, reading this headline.
 *
 * Only PLAIN-NUMERIC statistics are quoted (Phase 10): the value parser
 * refuses composites like "15/27" by construction, and a statistic that is
 * not where config says is omitted rather than guessed at. Phase 21+ rules
 * hold — plain words, the person named, no pronoun guessed, no statistic a
 * reader cannot check.
 */
export function gameSignal(person: { display_name: string }, game: ApiSportsGame, source: string, options: GameSignalOptions): RawSignal | null {
  if (!game.finished || game.home.score === null || game.away.score === null) return null;
  const { observedAt, config, line } = options;

  const drawn = game.home.score === game.away.score;
  const [winner, loser] = game.home.score > game.away.score ? [game.home, game.away] : [game.away, game.home];
  const overtime = config.overtime_statuses.some((status) => status.trim().toLowerCase() === game.status.trim().toLowerCase());
  const suffix = overtime ? " in overtime" : "";
  const outcome = drawn
    ? `${game.home.name} and ${game.away.name} finish ${game.home.score}-${game.away.score}${suffix}`
    : `${winner.name} beat ${loser.name} ${winner.score}-${loser.score}${suffix}`;

  // "threw for 382 yards and 3 touchdowns", in a fixed order so the sentence
  // reads the same every week.
  const clauses = (Object.keys(HEADLINE_PHRASE) as Array<keyof GameLine>)
    .map((key) => {
      const value = line?.[key];
      return typeof value === "number" && Number.isFinite(value) ? HEADLINE_PHRASE[key](value) : null;
    })
    .filter((clause): clause is string => clause !== null);

  // The result leads and the line follows, joined by a semicolon rather than
  // by "as". Putting the player first would read better — "Patrick Mahomes
  // threw for 382 yards as THE Kansas City Chiefs beat THE Indianapolis
  // Colts" — and that article is a grammar guess about a team name this
  // connector reads as data. NFL names happen to take one; a host that ever
  // carries "Real Madrid" would not. Two clauses, no guess.
  const sentence = clauses.length > 0 ? `${outcome}; ${person.display_name} ${clauses.join(" and ")}.` : `${outcome}.`;
  const { at, basis } = gameEndedAt(game, observedAt, config);

  return {
    headline: game.week ? `${game.week}: ${sentence}` : sentence,
    occurredAt: at,
    dedupeKey: `${source}:game:${game.id}`,
    rawPayload: {
      kind: APISPORTS_GAME_KIND,
      source,
      game_id: game.id,
      played_at: game.date.toISOString(),
      // Both ends of the interval the true end sits in, and which one was
      // taken, so a stored row can always be read back and judged.
      ended_at: at.toISOString(),
      ended_at_basis: basis,
      observed_final_at: observedAt.toISOString(),
      status: game.status,
      overtime,
      stage: game.stage,
      week: game.week,
      home: game.home.name,
      away: game.away.name,
      home_score: game.home.score,
      away_score: game.away.score,
      subject: person.display_name,
      ...(clauses.length > 0 ? { line: { ...line } } : {}),
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

async function seasonStatistics(config: ApiSportsConnectorConfig, key: string, fetchImpl: typeof fetch, player: string, season: number): Promise<unknown[]> {
  return (await call<unknown>(fill(config.paths.player_statistics, { player, season }), config, key, fetchImpl)).response ?? [];
}

/**
 * The team's games this season, one request per poll: the runner calls the
 * event read and the metric read with the same `now`, and both need the list.
 */
function gamesFor(config: ApiSportsConnectorConfig, key: string, fetchImpl: typeof fetch, season: number, team: number, now: Date): Promise<ApiSportsGame[]> {
  const cacheKey = `${config.host}|${season}|${team}|${now.getTime()}`;
  let pending = gamesCache.get(cacheKey);
  if (!pending) {
    gamesCache.clear();
    pending = call<RawGame>(fill(config.paths.games, { season, team }), config, key, fetchImpl).then((body) =>
      (body.response ?? []).map((raw) => readGame(raw, config)).filter((game): game is ApiSportsGame => game !== null),
    );
    gamesCache.set(cacheKey, pending);
  }
  return pending;
}

/** One game's player statistics, once per poll however many readers ask for them. */
function gameStatisticsFor(config: ApiSportsConnectorConfig, key: string, fetchImpl: typeof fetch, gameId: string, now: Date): Promise<unknown[]> {
  const cacheKey = `${config.host}|${gameId}|${now.getTime()}`;
  let pending = gameStatsCache.get(cacheKey);
  if (!pending) {
    if (gameStatsCache.size > 8) gameStatsCache.clear();
    pending = call<unknown>(fill(config.paths.game_statistics, { game: gameId }), config, key, fetchImpl).then((body) => body.response ?? []);
    gameStatsCache.set(cacheKey, pending);
  }
  return pending;
}

/**
 * The subject's line from a game's statistics, for the headline. A lookup
 * that finds nothing, or a value that is not a plain number, is LEFT OUT:
 * this is a clause in a sentence, not a measurement, and a wrong figure in a
 * headline is worse than a shorter headline. Every omission is returned so
 * the caller can say so on the poll.
 */
export function readGameLine(entries: unknown[], config: ApiSportsConnectorConfig, player: string): { line: GameLine; missing: string[]; names: string[] } {
  const line: GameLine = {};
  const missing: string[] = [];
  const names = new Set<string>();
  for (const [key, lookup] of Object.entries(config.headline_stats)) {
    let found: GroupedStatResult | null = null;
    for (const entry of entries) {
      const result = readGroupedStatistic(entry, lookup, player);
      if (result.status === "missing") {
        for (const name of result.names) names.add(name);
        continue;
      }
      found = result;
      break;
    }
    if (found?.status === "ok" && (key === "passing_yards" || key === "passing_touchdowns")) line[key] = found.value;
    else missing.push(`${key} (group "${lookup.group}", statistic "${lookup.name}")`);
  }
  return { line, missing, names: [...names] };
}

/**
 * Every statistic name and value the host carries for one player in the
 * Passing group, for the diagnostics note. Names AND values, because the
 * question this answers — is "rating" the league's passer rating or ESPN's
 * QBR? — is settled by seeing the figure beside the name.
 */
function describePassing(entries: unknown[], player: string): string {
  const out: string[] = [];
  for (const entry of entries) {
    for (const group of groupsOf(entry)) {
      if (!same(group.name, "Passing")) continue;
      const players = Array.isArray(group.players) ? group.players.filter((row) => String(row.player?.id) === String(player)) : [];
      for (const row of players) for (const stat of row.statistics ?? []) out.push(`${String(stat.name)}=${JSON.stringify(stat.value)}`);
    }
  }
  return out.length > 0 ? out.join(", ") : "none";
}

/** Finished games that count: not in an excluded stage. */
function countedGames(games: ApiSportsGame[], config: ApiSportsConnectorConfig): ApiSportsGame[] {
  return games.filter((game) => game.finished && !isExcludedStage(game.stage, config));
}

async function resolveTeam(config: ApiSportsConnectorConfig, key: string, fetchImpl: typeof fetch, player: string, season: number, status: ApiSportsStatus): Promise<number> {
  if (config.team_id !== null) return config.team_id;
  const statistics = await seasonStatistics(config, key, fetchImpl, player, season);
  const team = teamIdFrom(config, statistics);
  if (team === null) {
    throw new ConnectorError(
      `API-Sports player ${player} yielded no team id on ${config.host} (plan ${status.plan ?? "unknown"}), so the fixture list cannot be addressed. ` +
        `Set config.team_id on the data_sources row, or correct config.paths.player_statistics — the statistics response carried ${statistics.length} entr${statistics.length === 1 ? "y" : "ies"}.`,
    );
  }
  return team;
}

export const apisportsConnector: DataConnector = {
  name: APISPORTS_SOURCE_NAME,

  available() {
    return getApiSportsKeyOrNull() ? { ok: true } : { ok: false, reason: "APISPORTS_API_KEY is not set" };
  },

  /** Events: finished games that count, one signal each, newest first. */
  async fetchForPerson(person, playerId, context): Promise<RawSignal[]> {
    if (typeof window !== "undefined") throw new Error("The API-Sports connector is server-only.");
    const key = requireKey();
    const config = readApiSportsConfig(context.config as Record<string, unknown>);
    const player = requirePlayer(person, playerId);

    const status = await fetchApiSportsStatus(config, key, context.fetch, context.now.getTime());
    const season = seasonFor(context.now, config.season);
    const team = await resolveTeam(config, key, context.fetch, player, season, status);
    const games = await gamesFor(config, key, context.fetch, season, team, context.now);
    const finished = countedGames(games, config).sort((a, b) => b.date.getTime() - a.date.getTime());

    // THE NEWEST finished game is the one whose result is news, so it is the
    // only one whose statistics are read for the headline: one request a
    // poll at most, shared with the metric read through the cache, and zero
    // once the games list stops moving. The older ones in the window were
    // stored weeks ago under a headline that will never be rewritten (the
    // dedupe key ignores duplicates), so reading their lines would buy
    // nothing and spend quota.
    let line: GameLine | null = null;
    const newest = finished[0];
    if (newest) {
      try {
        const entries = await gameStatisticsFor(config, key, context.fetch, newest.id, context.now);
        const read = readGameLine(entries, config, player);
        line = read.line;
        if (read.missing.length > 0) {
          context.note?.(
            `API-Sports game ${newest.id} (${newest.week ?? "week ?"}): no headline statistic for ${read.missing.join("; ")}. ` +
              `His statistics in that group: ${read.names.length > 0 ? read.names.join(", ") : "none"}. ` +
              `The result is reported without the missing clause; correct config.headline_stats on the data_sources row rather than redeploying.`,
          );
        }
        if (config.diagnostics) {
          // THE NOTE CHANNEL AS A MICROSCOPE (the Phase 22 method). The
          // sandbox this is written in cannot reach api-sports.io, so the one
          // place the response can be read is the poll that fetched it.
          context.note?.(
            `[diagnostics] game ${newest.id} status=${JSON.stringify(newest.status)} kickoff=${newest.date.toISOString()} ` +
              `endedAtReported=${newest.endedAt ? newest.endedAt.toISOString() : "none"}; ` +
              `player ${player} statistics in group "Passing": ${describePassing(entries, player)}`,
          );
        }
      } catch (error) {
        // The result is the signal; its garnish is not worth losing it over.
        context.note?.(`API-Sports headline statistics for game ${newest.id} failed: ${error instanceof Error ? error.message : String(error)}. The result is reported without them.`);
      }
    }

    return finished
      .slice(0, config.recent_games)
      .map((game) => gameSignal(person, game, APISPORTS_SOURCE_NAME, { observedAt: context.now, config, line: game === newest ? line : null }))
      .filter((signal): signal is RawSignal => signal !== null);
  },

  /**
   * Metrics. Two reads:
   *
   *   1. The season total, snapshotted RAW once per change under
   *      SEASON_PASSING_YARDS_SNAPSHOT: no observation, no signal (see the
   *      header). Every failure names what came back.
   *   2. The per-game metrics of config.game_stats. Each metric keeps its own
   *      anchor (its last recorded snapshot), so a metric registered later
   *      backfills the games the others already have. For each finished
   *      counted game newer than SOME metric's anchor (up to recent_games,
   *      oldest first), the per-game statistics endpoint is read ONCE and
   *      every metric that needs the game is read from the response, the
   *      player's figures recorded AT THE GAME'S DATE. Older games in a
   *      backfill are queued as snapshots; the newest is the reading the
   *      baseline observes. A game the player did not appear in is skipped;
   *      a game where he appears but a statistic is not where config says
   *      fails loudly, naming the metric, as does a value that is not a plain
   *      number.
   */
  async fetchMetrics(person, playerId, context): Promise<MetricReading[]> {
    if (typeof window !== "undefined") throw new Error("The API-Sports connector is server-only.");
    const key = requireKey();
    const config = readApiSportsConfig(context.config as Record<string, unknown>);
    const player = requirePlayer(person, playerId);

    const status = await fetchApiSportsStatus(config, key, context.fetch, context.now.getTime());
    const season = seasonFor(context.now, config.season);
    const statistics = await seasonStatistics(config, key, context.fetch, player, season);
    const where = `on ${config.host} for season ${season}; plan ${status.plan ?? "unknown"}, ${status.requestsToday ?? "?"} of ${status.dailyLimit ?? "?"} requests used today`;

    // 1. The season total, raw ------------------------------------------------
    //
    // A FALLBACK MUST NOT GATE THE PRODUCT (Phase 16). The season endpoint is
    // the one documented above as unreliable — it carried last season's
    // total under this season's number for a week, switched to this
    // season's at 13:00 on 2026-09-17, and by 20:45 the same day answered
    // with no entries at all, 200 OK, no errors payload, quota untouched.
    // Until this change, that empty answer threw here, before the per-game
    // metrics (the ones that matter) were read, so a data refresh on their
    // side would have silenced every per-game figure for as long as it
    // lasted, with the poll showing "error" and nothing saying which read
    // had failed. Now: a season total that is absent or not where config
    // says is a NOTE on an otherwise ok poll, the snapshot is skipped for
    // the poll, and the per-game read goes ahead (the team id is
    // configuration). A value that is there and not a number still fails
    // loudly: that is the shape moving, not the endpoint blinking.
    let seasonYards: number | null = null;
    if (statistics.length === 0) {
      context.note?.(
        `season statistics answered with no entries for player ${player} ${where}: season total not recorded this poll; per-game metrics read through config.team_id`,
      );
    } else {
      const grouped = readGroupedStatistic(statistics[0], config.passing_yards_stat, player);
      if (grouped.status === "unparseable") {
        throw new ConnectorError(
          `API-Sports player ${player} (${person.slug}) carried a passing-yards value that is not a number: ${JSON.stringify(grouped.raw)} ` +
            `(group "${config.passing_yards_stat.group}", statistic "${config.passing_yards_stat.name}") ${where}. Nothing was recorded.`,
        );
      }
      seasonYards = grouped.status === "ok" ? grouped.value : readStatistic(statistics[0], config.passing_yards_keys);
      if (seasonYards === null) {
        const seen = grouped.status === "missing" ? grouped : { groups: [], names: [] };
        context.note?.(
          `API-Sports player ${player} (${person.slug}) carried no passing yards ${where}: ` +
            `no statistic "${config.passing_yards_stat.name}" in group "${config.passing_yards_stat.group}" ` +
            `(groups present: ${seen.groups.length > 0 ? seen.groups.join(", ") : "none"}; statistics in that group: ${seen.names.length > 0 ? seen.names.join(", ") : "none"}), ` +
            `and none of ${config.passing_yards_keys.join(", ")} as a keyed field. ` +
            `The statistics response held ${statistics.length} entr${statistics.length === 1 ? "y" : "ies"}; the season total was not recorded this poll and the per-game metrics were read regardless. ` +
            `Correct config.passing_yards_stat or config.paths.player_statistics on the data_sources row rather than redeploying.`,
        );
      }
    }
    if (seasonYards !== null) {
      const previousTotal = await context.snapshots.latest(SEASON_PASSING_YARDS_SNAPSHOT);
      if (!previousTotal || previousTotal.value !== seasonYards) context.snapshots.record(SEASON_PASSING_YARDS_SNAPSHOT, seasonYards);
    }

    // 2. Per game, the metric -------------------------------------------------
    const team = teamIdFrom(config, statistics);
    if (team === null) {
      throw new ConnectorError(
        `API-Sports player ${player} yielded no team id on ${config.host} (plan ${status.plan ?? "unknown"}), so the fixture list cannot be addressed. ` +
          `Set config.team_id on the data_sources row, or correct config.paths.player_statistics — the statistics response carried ${statistics.length} entr${statistics.length === 1 ? "y" : "ies"}.`,
      );
    }
    const games = await gamesFor(config, key, context.fetch, season, team, context.now);
    const stats = Object.entries(config.game_stats);
    const anchors = new Map(await Promise.all(stats.map(async ([metricKey]) => [metricKey, await context.snapshots.latest(metricKey)] as const)));
    const needs = (metricKey: string, game: ApiSportsGame) => {
      const latest = anchors.get(metricKey) ?? null;
      return !latest || game.date.getTime() > latest.recordedAt.getTime();
    };
    const wanted = countedGames(games, config)
      .filter((game) => stats.some(([metricKey]) => needs(metricKey, game)))
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(-config.recent_games);

    const when = (game: ApiSportsGame) => `game ${game.id} (${game.week ?? "week ?"}, ${game.date.toISOString().slice(0, 10)})`;
    const readings = new Map<string, Array<{ game: ApiSportsGame; value: number }>>(stats.map(([metricKey]) => [metricKey, []]));
    for (const game of wanted) {
      const entries = await gameStatisticsFor(config, key, context.fetch, game.id, context.now);
      // Absent from every team's sheet: did not play. The check does not
      // depend on which statistic is asked for, only on whether his line is there.
      const playerSeen = entries.some((entry) => {
        const result = readGroupedStatistic(entry, stats[0][1], player);
        return result.status !== "missing" || result.playerSeen;
      });
      if (!playerSeen) continue;

      for (const [metricKey, lookup] of stats) {
        if (!needs(metricKey, game)) continue;
        let found: GroupedStatResult | null = null;
        let lastMissing: Extract<GroupedStatResult, { status: "missing" }> | null = null;
        for (const entry of entries) {
          const result = readGroupedStatistic(entry, lookup, player);
          if (result.status !== "missing") {
            found = result;
            break;
          }
          if (result.playerSeen) lastMissing = result;
        }
        if (!found) {
          // Present but not under the configured group / name: the shape moved, say so.
          throw new ConnectorError(
            `API-Sports ${when(game)} lists player ${player} (${person.slug}) but carries no statistic ` +
              `"${lookup.name}" in group "${lookup.group}" for him (metric ${metricKey}; ` +
              `groups present: ${lastMissing?.groups.join(", ") ?? "none"}; his statistics in that group: ${lastMissing && lastMissing.names.length > 0 ? lastMissing.names.join(", ") : "none"}). ` +
              `Correct config.game_stats.${metricKey} on the data_sources row.`,
          );
        }
        if (found.status === "unparseable") {
          throw new ConnectorError(
            `API-Sports ${when(game)} carried a ${metricKey} value for player ${player} that is not a plain number: ` +
              `${JSON.stringify(found.raw)} (group "${lookup.group}", statistic "${lookup.name}"). ` +
              `Composite figures ("15/27", "2-12") are never registered. Nothing was recorded.`,
          );
        }
        readings.get(metricKey)?.push({ game, value: found.value });
      }
    }

    // Per metric: older games of a backfill are snapshots at their own dates;
    // the newest is the reading this poll observes against the baseline.
    const out: MetricReading[] = [];
    for (const [metricKey, list] of readings) {
      for (const { game, value } of list.slice(0, -1)) context.snapshots.record(metricKey, value, game.date);
      const newest = list.at(-1);
      if (newest) out.push({ metricKey, value: newest.value, recordedAt: newest.game.date });
    }
    return out;
  },
};
