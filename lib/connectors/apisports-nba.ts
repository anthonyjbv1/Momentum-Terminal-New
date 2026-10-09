import { getApiSportsKeyOrNull } from "@/lib/env";

import { APISPORTS_GAME_KIND, apiSportsRequest, apiSportsUsage, fetchApiSportsStatus, parseStatValue, recordApiSportsUsage, type ApiSportsStatus } from "./apisports";
import { ConnectorError, type DataConnector, type MetricReading, type RawSignal } from "./types";

/**
 * API-Sports NBA connector (2026-10-09), through the API-NBA host
 * (v2.nba.api-sports.io), modelled on the NFL connector: the same key, the
 * same pacing ledger (half the per-minute rate, backoff on 429, no bursts),
 * the same daily /status check and quota record, the same post-game shape.
 *
 * WHICH API. API-Sports sells API-NBA and API-Basketball separately. Both
 * carry per-player, per-game lines for the NBA: API-NBA's
 * `/players/statistics` (filters id, game, team, season) and
 * API-Basketball's `/games/statistics/players` (filters ids, player, season;
 * added in its 1.5.6 release, coverage flagged per league season). API-NBA is
 * the one built against: it is the NBA-specific product, its player ids are
 * stable across seasons, its line carries the minutes played and a `comment`
 * field that names a DNP, and every id it answers with is the NBA's own
 * structure (one league, no coverage flag to check). The paths and field
 * names live in data_sources.config, as the NFL connector's do, because the
 * documentation host is unreachable from the network this was written on: a
 * name that turns out wrong is a row update, not a deploy, and every read
 * says what came back.
 *
 * THE SHAPE, as API-NBA documents it. Games: `{ id, season, date: { start,
 * end }, stage, status: { short, long }, periods: { total }, teams: { home,
 * visitors: { id, name } }, scores: { home, visitors: { points } } }`, status
 * long "Finished" when final. Lines: one entry per player per game under
 * `/players/statistics?game=<id>`: `{ player: { id, firstname, lastname },
 * team: { id, name }, game: { id }, points, min ("34:12"), fgm, fga, fgp,
 * ftm, fta, ftp, tpm, tpa, tpp, offReb, defReb, totReb, assists, pFouls,
 * steals, turnovers, blocks, plusMinus, comment }`. Keyed fields, not the
 * NFL host's named groups, so the lookups here are dotted paths.
 *
 * POST-GAME ONLY, LIKE THE NFL. One result event per finished game the
 * player PLAYED, keyed on the game id; three per-game metrics (points,
 * rebounds, assists) recorded AT THE GAME'S DATE and judged against the
 * player's own trailing games. A game the player did not play in produces
 * NOTHING: no event, no metric, no snapshot. A DNP, a rest day, an injury
 * absence is not a performance (absence is not evidence; injury news arrives
 * through the news sources), and the minutes threshold (config.min_minutes,
 * ten) keeps a token appearance out of the baseline for the same reason. A
 * back-to-back is the schedule, not a pattern: nothing here reads the
 * calendar. Preseason games are excluded by stage, as the NFL's are.
 *
 * REQUEST BUDGET, per player per poll: /status (cached six hours per host,
 * so once per host, not per player), the team's games list (one), and one
 * line read per finished game not yet recorded (one on the day after a game,
 * none otherwise). See the README for the daily figures.
 */

export const APISPORTS_NBA_SOURCE_NAME = "apisports_nba";
const DEFAULT_HOST = "v2.nba.api-sports.io";

export interface NbaPaths {
  /** The team's games of a season. {season} and {team} are substituted. */
  games: string;
  /** Every player's line for one game. {game} is substituted. */
  game_statistics: string;
}

export interface NbaConnectorConfig {
  host: string;
  /** Season as API-NBA names it (the year it starts in); null derives it from the calendar. */
  season: number | null;
  /** The player's team id, from the mapping (resolved team first); required to address the games list. */
  team_id: number | null;
  paths: NbaPaths;
  /** Per-game metric key to the dotted path of the figure on the player's line. Each needs a declaration in config.metrics to emit. */
  game_stats: Record<string, string>;
  /** Dotted path of the minutes field, and the fewest minutes that count as having played. */
  minutes_field: string;
  min_minutes: number;
  /** Dotted path of the DNP comment; a non-empty comment means the player did not play. */
  comment_field: string;
  /** Dotted paths of the player id on a line, tried in order. */
  player_id_keys: string[];
  /** Status texts that mean the game is final. */
  finished_statuses: string[];
  /** Stages that count for nothing. Matched ignoring case, spaces and punctuation. */
  excluded_stages: string[];
  /** Regulation periods; more than this is overtime. */
  regulation_periods: number;
  /** How many finished games back to consider on one poll. */
  recent_games: number;
  /** As the NFL connector: how long after tip-off a first sighting of a finished game still counts as having watched it end. */
  live_sighting_hours: number;
  /**
   * Once a metric has an anchor, a game's lines are read only while the game
   * is newer than the anchor AND younger than this: a game the player did not
   * play advances no anchor, and without the bound its sheet would be re-read
   * every poll until his next played game. The first contact (no anchor)
   * backfills recent_games whatever their age.
   */
  line_lookback_hours: number;
}

export const DEFAULT_NBA_CONFIG: NbaConnectorConfig = {
  host: DEFAULT_HOST,
  season: null,
  team_id: null,
  paths: {
    games: "/games?season={season}&team={team}",
    game_statistics: "/players/statistics?game={game}",
  },
  game_stats: { game_points: "points", game_rebounds: "totReb", game_assists: "assists" },
  minutes_field: "min",
  min_minutes: 10,
  comment_field: "comment",
  player_id_keys: ["player.id"],
  finished_statuses: ["Finished", "FT", "AOT", "Final"],
  excluded_stages: ["Pre Season", "Preseason"],
  regulation_periods: 4,
  recent_games: 5,
  live_sighting_hours: 24,
  line_lookback_hours: 48,
};

export const GAME_POINTS_METRIC = "game_points";
export const GAME_REBOUNDS_METRIC = "game_rebounds";
export const GAME_ASSISTS_METRIC = "game_assists";

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string") ? (value as string[]) : fallback;
}
function statPaths(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const out: Record<string, string> = {};
  for (const [key, path] of Object.entries(value as Record<string, unknown>)) if (/^[a-z0-9_]+$/.test(key) && typeof path === "string" && path.trim()) out[key] = path.trim();
  return Object.keys(out).length > 0 ? out : fallback;
}

export function readNbaConfig(config: Record<string, unknown>): NbaConnectorConfig {
  const paths = (config.paths ?? {}) as Record<string, unknown>;
  const d = DEFAULT_NBA_CONFIG;
  const recent = numberOrNull(config.recent_games);
  const minMinutes = numberOrNull(config.min_minutes);
  const periods = numberOrNull(config.regulation_periods);
  const sighting = numberOrNull(config.live_sighting_hours);
  const lookback = numberOrNull(config.line_lookback_hours);
  return {
    host: stringOr(config.host, d.host),
    season: numberOrNull(config.season),
    team_id: numberOrNull(config.team_id),
    paths: { games: stringOr(paths.games, d.paths.games), game_statistics: stringOr(paths.game_statistics, d.paths.game_statistics) },
    game_stats: statPaths(config.game_stats, d.game_stats),
    minutes_field: stringOr(config.minutes_field, d.minutes_field),
    min_minutes: minMinutes !== null && minMinutes >= 0 ? minMinutes : d.min_minutes,
    comment_field: stringOr(config.comment_field, d.comment_field),
    player_id_keys: stringList(config.player_id_keys, d.player_id_keys),
    finished_statuses: stringList(config.finished_statuses, d.finished_statuses),
    excluded_stages: stringList(config.excluded_stages, d.excluded_stages),
    regulation_periods: periods !== null && periods > 0 ? periods : d.regulation_periods,
    recent_games: recent !== null && recent > 0 ? Math.floor(recent) : d.recent_games,
    live_sighting_hours: sighting !== null && sighting > 0 ? sighting : d.live_sighting_hours,
    line_lookback_hours: lookback !== null && lookback > 0 ? lookback : d.line_lookback_hours,
  };
}

/** The mapping's own overrides: the team, the figures, the window. */
export function mergedNbaConfig(sourceConfig: Record<string, unknown>, personConfig: Record<string, unknown> | undefined): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const key of ["team_id", "game_stats", "recent_games", "min_minutes"]) {
    if (personConfig && personConfig[key] !== undefined && personConfig[key] !== null) overrides[key] = personConfig[key];
  }
  return { ...sourceConfig, ...overrides };
}

/** An NBA season is named for the year it starts in (October); January to September belong to the previous one. */
export function nbaSeasonFor(now: Date, configured: number | null): number {
  if (configured !== null) return configured;
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 9 ? year : year - 1;
}

function stageKey(stage: string): string {
  return stage.toLowerCase().replace(/[^a-z]/g, "");
}

export function isExcludedNbaStage(stage: string | null, config: NbaConnectorConfig): boolean {
  return stage !== null && config.excluded_stages.some((excluded) => stageKey(excluded) === stageKey(stage));
}

function dig(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => (value && typeof value === "object" && segment in (value as Record<string, unknown>) ? (value as Record<string, unknown>)[segment] : undefined), source);
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export interface NbaGame {
  id: string;
  /** Tip-off. */
  date: Date;
  /** The end the host reported, when it did. */
  endedAt: Date | null;
  finished: boolean;
  status: string;
  stage: string | null;
  /** Periods played; more than regulation is overtime. */
  periods: number | null;
  home: { id: number | null; name: string; score: number | null };
  away: { id: number | null; name: string; score: number | null };
}

interface RawNbaGame {
  id?: number | string;
  stage?: unknown;
  date?: { start?: string; end?: string | null };
  status?: { short?: unknown; long?: unknown };
  periods?: { total?: unknown; current?: unknown };
  teams?: { home?: { id?: number; name?: string }; visitors?: { id?: number; name?: string } };
  scores?: { home?: { points?: number | null }; visitors?: { points?: number | null } };
}

/** The host's stage field is a number (1 preseason, 2 regular season, 3 playoffs) or a name; both are read. */
function stageName(stage: unknown): string | null {
  if (typeof stage === "string" && stage.trim()) return stage.trim();
  if (stage === 1) return "Pre Season";
  if (stage === 2) return "Regular Season";
  if (stage === 3) return "Play Offs";
  return null;
}

export function readNbaGame(raw: RawNbaGame, config: NbaConnectorConfig = DEFAULT_NBA_CONFIG): NbaGame | null {
  const id = raw.id;
  if (id === undefined || id === null) return null;
  const start = typeof raw.date?.start === "string" ? new Date(raw.date.start) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = typeof raw.date?.end === "string" ? new Date(raw.date.end) : null;
  const long = typeof raw.status?.long === "string" ? raw.status.long : "";
  const short = raw.status?.short;
  const finished = config.finished_statuses.some((status) => status.toLowerCase() === long.toLowerCase()) || short === 3 || short === "3";
  const periods = numberOrNull(raw.periods?.total) ?? numberOrNull(raw.periods?.current);
  return {
    id: String(id),
    date: start,
    endedAt: end && !Number.isNaN(end.getTime()) && end.getTime() >= start.getTime() ? end : null,
    finished,
    status: long || String(short ?? ""),
    stage: stageName(raw.stage),
    periods,
    home: { id: numberOrNull(raw.teams?.home?.id), name: raw.teams?.home?.name ?? "the home team", score: numberOrNull(raw.scores?.home?.points) },
    away: { id: numberOrNull(raw.teams?.visitors?.id), name: raw.teams?.visitors?.name ?? "the away team", score: numberOrNull(raw.scores?.visitors?.points) },
  };
}

// ---------------------------------------------------------------------------
// The player's line
// ---------------------------------------------------------------------------

/** Minutes as the host writes them: "34:12" is 34.2, "0:00" is 0, "" or null is null (did not play). */
export function parseMinutes(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const clock = /^(\d{1,3}):(\d{2})$/.exec(text);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  const plain = parseStatValue(text);
  return plain !== null && plain >= 0 ? plain : null;
}

export interface NbaLine {
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  minutes: number | null;
  /** The host's DNP note, when any. */
  comment: string | null;
}

export type NbaLineRead =
  /** The player's entry is on the sheet and he played at least min_minutes. */
  | { status: "played"; line: NbaLine; entry: unknown }
  /** On the sheet with a DNP comment, no minutes, or under the threshold: nothing is read from it. */
  | { status: "did_not_play"; reason: string; entry: unknown }
  /** Not on any sheet. */
  | { status: "absent" };

/** The subject's entry among a game's lines, and whether it counts. Minutes first, comment second: "DNP - Coach's Decision" with 0:00 reads as a DNP either way. */
export function readNbaLine(entries: unknown[], config: NbaConnectorConfig, player: string): NbaLineRead {
  const entry = entries.find((candidate) => config.player_id_keys.some((key) => String(dig(candidate, key)) === String(player)));
  if (entry === undefined) return { status: "absent" };
  const comment = dig(entry, config.comment_field);
  const minutes = parseMinutes(dig(entry, config.minutes_field));
  if (typeof comment === "string" && comment.trim()) return { status: "did_not_play", reason: comment.trim(), entry };
  if (minutes === null) return { status: "did_not_play", reason: "no minutes on the sheet", entry };
  if (minutes < config.min_minutes) return { status: "did_not_play", reason: `${Math.round(minutes * 10) / 10} minutes, under the ${config.min_minutes}-minute threshold`, entry };
  const figure = (key: string) => (key in config.game_stats ? parseStatValue(dig(entry, config.game_stats[key])) : null);
  return { status: "played", line: { points: figure(GAME_POINTS_METRIC), rebounds: figure(GAME_REBOUNDS_METRIC), assists: figure(GAME_ASSISTS_METRIC), minutes, comment: null }, entry };
}

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

const count = (value: number, one: string, many: string) => `${Math.round(value)} ${Math.round(value) === 1 ? one : many}`;

/** "a triple-double: 28 points, 10 rebounds and 12 assists" / "a double-double: ..." / "55 points, 8 rebounds and 5 assists". Figures that are not plain numbers are left out. */
export function nbaLineClause(line: Pick<NbaLine, "points" | "rebounds" | "assists">): string {
  const parts: string[] = [];
  if (line.points !== null) parts.push(count(line.points, "point", "points"));
  if (line.rebounds !== null) parts.push(count(line.rebounds, "rebound", "rebounds"));
  if (line.assists !== null) parts.push(count(line.assists, "assist", "assists"));
  if (parts.length === 0) return "";
  const joined = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const doubles = [line.points, line.rebounds, line.assists].filter((value) => value !== null && value >= 10).length;
  if (doubles >= 3) return `a triple-double: ${joined}`;
  if (doubles === 2) return `a double-double: ${joined}`;
  return joined;
}

function overtimeSuffix(game: NbaGame, config: NbaConnectorConfig): string {
  if (game.periods === null || game.periods <= config.regulation_periods) return "";
  const extra = game.periods - config.regulation_periods;
  return extra === 1 ? " in overtime" : extra === 2 ? " in double overtime" : extra === 3 ? " in triple overtime" : ` after ${extra} overtimes`;
}

/** When the result happened: the host's end, else the first sighting inside the window, else tip-off (the NFL rule). */
export function nbaGameEndedAt(game: NbaGame, observedAt: Date, config: NbaConnectorConfig): { at: Date; basis: "reported_end" | "observed_final" | "tipoff" } {
  if (game.endedAt) return { at: game.endedAt, basis: "reported_end" };
  const lagHours = (observedAt.getTime() - game.date.getTime()) / 3_600_000;
  if (lagHours >= 0 && lagHours <= config.live_sighting_hours) return { at: observedAt, basis: "observed_final" };
  return { at: game.date, basis: "tipoff" };
}

/**
 * THE RESULT, AND THE SUBJECT'S LINE: "Thunder beat Pacers 141-135 in double
 * overtime; Shai Gilgeous-Alexander had 55 points, 8 rebounds and 5 assists
 * in 45 minutes." Never written for a game he did not play.
 */
export function nbaGameSignal(person: { display_name: string }, game: NbaGame, line: NbaLine, source: string, options: { observedAt: Date; config: NbaConnectorConfig }): RawSignal | null {
  if (!game.finished || game.home.score === null || game.away.score === null) return null;
  const { observedAt, config } = options;
  const suffix = overtimeSuffix(game, config);
  const drawn = game.home.score === game.away.score;
  const [winner, loser] = game.home.score > game.away.score ? [game.home, game.away] : [game.away, game.home];
  const outcome = drawn ? `${game.home.name} and ${game.away.name} finish ${game.home.score}-${game.away.score}${suffix}` : `${winner.name} beat ${loser.name} ${winner.score}-${loser.score}${suffix}`;
  const clause = nbaLineClause(line);
  const minutes = line.minutes !== null ? ` in ${Math.round(line.minutes)} minutes` : "";
  const sentence = clause ? `${outcome}; ${person.display_name} had ${clause}${minutes}.` : `${outcome}.`;
  const { at, basis } = nbaGameEndedAt(game, observedAt, config);
  return {
    headline: sentence,
    occurredAt: at,
    dedupeKey: `${source}:game:${game.id}`,
    rawPayload: {
      kind: APISPORTS_GAME_KIND,
      source,
      game_id: game.id,
      played_at: game.date.toISOString(),
      ended_at: at.toISOString(),
      ended_at_basis: basis,
      observed_final_at: observedAt.toISOString(),
      status: game.status,
      overtime: suffix !== "",
      stage: game.stage,
      home: game.home.name,
      away: game.away.name,
      home_score: game.home.score,
      away_score: game.away.score,
      subject: person.display_name,
      line: { points: line.points, rebounds: line.rebounds, assists: line.assists, minutes: line.minutes === null ? null : Math.round(line.minutes * 10) / 10 },
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

function requireTeam(config: NbaConnectorConfig, person: { slug: string }, status: ApiSportsStatus): number {
  if (config.team_id === null) {
    throw new ConnectorError(`No API-NBA team id configured for ${person.slug} (plan ${status.plan ?? "unknown"}): set config.team_id on the mapping from identity.apisports.team_id; the games list is addressed by team.`);
  }
  return config.team_id;
}

/** The games list and each game's lines, fetched once per poll and shared by the event and metric reads. */
const gamesCache = new Map<string, Promise<NbaGame[]>>();
const linesCache = new Map<string, Promise<unknown[]>>();

/** For tests. */
export function resetNbaCaches(): void {
  gamesCache.clear();
  linesCache.clear();
}

function gamesFor(config: NbaConnectorConfig, key: string, fetchImpl: typeof fetch, season: number, team: number, now: Date): Promise<NbaGame[]> {
  const cacheKey = `${config.host}|${season}|${team}|${now.getTime()}`;
  let pending = gamesCache.get(cacheKey);
  if (!pending) {
    if (gamesCache.size > 8) gamesCache.clear();
    pending = apiSportsRequest<RawNbaGame>(fill(config.paths.games, { season, team }), config.host, key, fetchImpl).then((body) => (body.response ?? []).map((raw) => readNbaGame(raw, config)).filter((game): game is NbaGame => game !== null));
    gamesCache.set(cacheKey, pending);
  }
  return pending;
}

function linesFor(config: NbaConnectorConfig, key: string, fetchImpl: typeof fetch, gameId: string, now: Date): Promise<unknown[]> {
  const cacheKey = `${config.host}|${gameId}|${now.getTime()}`;
  let pending = linesCache.get(cacheKey);
  if (!pending) {
    if (linesCache.size > 16) linesCache.clear();
    pending = apiSportsRequest<unknown>(fill(config.paths.game_statistics, { game: gameId }), config.host, key, fetchImpl).then((body) => body.response ?? []);
    linesCache.set(cacheKey, pending);
  }
  return pending;
}

function countedGames(games: NbaGame[], config: NbaConnectorConfig): NbaGame[] {
  return games.filter((game) => game.finished && !isExcludedNbaStage(game.stage, config));
}

/**
 * The finished games whose lines this poll reads, oldest first: with no
 * anchor yet, the newest recent_games (the first contact's backfill); with
 * one, the games newer than it and inside line_lookback_hours. Both reads
 * use it, so a game's sheet is requested at most once a poll and, once
 * recorded, never again.
 */
export function gamesToRead(games: NbaGame[], anchorAt: Date | null, now: Date, config: NbaConnectorConfig): NbaGame[] {
  const counted = countedGames(games, config).sort((a, b) => a.date.getTime() - b.date.getTime());
  if (anchorAt === null) return counted.slice(-config.recent_games);
  const since = now.getTime() - config.line_lookback_hours * 3_600_000;
  return counted.filter((game) => game.date.getTime() > anchorAt.getTime() && game.date.getTime() >= since).slice(-config.recent_games);
}

/** The newest anchor across the per-game metrics: the last game any of them recorded. */
async function newestAnchor(context: { snapshots: { latest(metricKey: string): Promise<{ recordedAt: Date } | null> } }, config: NbaConnectorConfig): Promise<Date | null> {
  let newest: Date | null = null;
  for (const metricKey of Object.keys(config.game_stats)) {
    const latest = await context.snapshots.latest(metricKey);
    if (latest && (newest === null || latest.recordedAt.getTime() > newest.getTime())) newest = latest.recordedAt;
  }
  return newest;
}

export const apisportsNbaConnector: DataConnector = {
  name: APISPORTS_NBA_SOURCE_NAME,

  available() {
    return getApiSportsKeyOrNull() ? { ok: true } : { ok: false, reason: "APISPORTS_API_KEY is not set" };
  },

  /** Events: the newest finished games the player PLAYED, one result each; a game he did not play is nothing. */
  async fetchForPerson(person, playerId, context): Promise<RawSignal[]> {
    if (typeof window !== "undefined") throw new Error("The API-NBA connector is server-only.");
    const key = requireKey();
    const config = readNbaConfig(mergedNbaConfig(context.config as Record<string, unknown>, context.personConfig as Record<string, unknown> | undefined));
    const player = playerId.trim();
    if (!player) throw new ConnectorError(`No API-NBA player id configured for ${person.slug}`);
    const requestsBefore = apiSportsUsage().requests;
    const status = await fetchApiSportsStatus(config, key, context.fetch, context.now.getTime());
    const season = nbaSeasonFor(context.now, config.season);
    const team = requireTeam(config, person, status);
    const games = await gamesFor(config, key, context.fetch, season, team, context.now);
    const wanted = gamesToRead(games, await newestAnchor(context, config), context.now, config).sort((a, b) => b.date.getTime() - a.date.getTime());

    const signals: RawSignal[] = [];
    for (const game of wanted) {
      const read = readNbaLine(await linesFor(config, key, context.fetch, game.id, context.now), config, player);
      if (read.status === "played") {
        const signal = nbaGameSignal(person, game, read.line, APISPORTS_NBA_SOURCE_NAME, { observedAt: context.now, config });
        if (signal) signals.push(signal);
      } else {
        context.detail?.(`game_${game.id}`, { played: false, reason: read.status === "absent" ? "not on the sheet" : read.reason });
      }
    }
    recordApiSportsUsage(context, status, requestsBefore, "apisports_nba");
    return signals;
  },

  /**
   * Metrics: the per-game figures of config.game_stats for each finished
   * counted game newer than the metric's anchor (its last snapshot), oldest
   * first, each read once from the game's lines and recorded AT THE GAME'S
   * DATE; the newest is the reading the baseline observes. A game the player
   * did not play (absent, a DNP comment, no minutes, under the threshold)
   * records nothing and never enters the baseline.
   */
  async fetchMetrics(person, playerId, context): Promise<MetricReading[]> {
    if (typeof window !== "undefined") throw new Error("The API-NBA connector is server-only.");
    const key = requireKey();
    const config = readNbaConfig(mergedNbaConfig(context.config as Record<string, unknown>, context.personConfig as Record<string, unknown> | undefined));
    const player = playerId.trim();
    if (!player) throw new ConnectorError(`No API-NBA player id configured for ${person.slug}`);
    const requestsBefore = apiSportsUsage().requests;
    const status = await fetchApiSportsStatus(config, key, context.fetch, context.now.getTime());
    const season = nbaSeasonFor(context.now, config.season);
    const team = requireTeam(config, person, status);
    const games = await gamesFor(config, key, context.fetch, season, team, context.now);

    const stats = Object.entries(config.game_stats);
    const anchors = new Map(await Promise.all(stats.map(async ([metricKey]) => [metricKey, await context.snapshots.latest(metricKey)] as const)));
    const needs = (metricKey: string, game: NbaGame) => {
      const latest = anchors.get(metricKey) ?? null;
      return !latest || game.date.getTime() > latest.recordedAt.getTime();
    };
    const newest = [...anchors.values()].reduce<Date | null>((best, latest) => (latest && (best === null || latest.recordedAt.getTime() > best.getTime()) ? latest.recordedAt : best), null);
    const wanted = gamesToRead(games, newest, context.now, config).filter((game) => stats.some(([metricKey]) => needs(metricKey, game)));

    const readings = new Map<string, Array<{ game: NbaGame; value: number }>>(stats.map(([metricKey]) => [metricKey, []]));
    for (const game of wanted) {
      const read = readNbaLine(await linesFor(config, key, context.fetch, game.id, context.now), config, player);
      if (read.status !== "played") continue;
      for (const [metricKey, path] of stats) {
        if (!needs(metricKey, game)) continue;
        const raw = dig(read.entry, path);
        const value = parseStatValue(raw);
        if (value === null) {
          throw new ConnectorError(
            `API-NBA game ${game.id} (${game.date.toISOString().slice(0, 10)}) lists player ${player} (${person.slug}) but carries no plain-number "${path}" for him (metric ${metricKey}; value ${JSON.stringify(raw)}). ` +
              `Correct config.game_stats.${metricKey} on the data_sources row or the mapping.`,
          );
        }
        readings.get(metricKey)?.push({ game, value });
      }
    }
    const out: MetricReading[] = [];
    for (const [metricKey, list] of readings) {
      for (const { game, value } of list.slice(0, -1)) context.snapshots.record(metricKey, value, game.date);
      const newest = list.at(-1);
      if (newest) out.push({ metricKey, value: newest.value, recordedAt: newest.game.date });
    }
    recordApiSportsUsage(context, status, requestsBefore, "apisports_nba");
    return out;
  },
};
