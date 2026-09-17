import { getTwitchCredentialsOrNull } from "@/lib/env";

import { ConnectorError, type ConnectorContext, type DataConnector, type LiveCapability, type LiveClipCount, type LiveStatus, type LiveStream, type MetricReading, type RawSignal } from "./types";

/**
 * Twitch connector — Helix, app access token (Client Credentials), no user auth.
 *
 * external_identifier is the channel login ("kaicenat"); a purely numeric
 * identifier is taken as a user id instead. TWITCH_CLIENT_ID and
 * TWITCH_CLIENT_SECRET come from the server environment; when either is unset
 * the connector reports itself unavailable and the runner marks the source
 * inactive for the run.
 *
 * THE SAMPLING PROBLEM, AND WHAT IT DECIDES.
 *
 * A live stream either is or is not running at the moment we poll. Hourly polls
 * sample that unevenly and without control: a six-hour broadcast is caught six
 * times, a ninety-minute one once or not at all, and concurrent viewers read at
 * an arbitrary minute is one point on a curve that ramps and decays. Fed to the
 * baseline machinery — mean and standard deviation over a trailing window — an
 * instantaneous viewer count yields a distribution dominated by the
 * online/offline mixture rather than by anything about the audience, and its
 * sigma would say more about when the cron happened to fire than about the
 * person. So no instantaneous reading is registered as a metric here.
 *
 * Everything this connector treats as a METRIC is instead either
 *   - CUMULATIVE and monotone (follower_count), where the polling moment
 *     cannot change the answer, or
 *   - a RETROSPECTIVE WINDOW AGGREGATE over the channel's archive of completed
 *     broadcasts (stream_hours_7d, stream_days_7d), which returns the same
 *     value whether it is asked at 03:00 or at 15:00 because it describes a
 *     fixed trailing window rather than the current instant.
 * That is the same shape as news_volume_24h, which is why these can take the
 * ordinary baseline treatment without it meaning something different.
 *
 * The genuinely spiky fact — that the channel is live right now, to this many
 * people — is not discarded; it becomes an EVENT. One signal per broadcast,
 * keyed on the Twitch stream id, so a six-hour stream caught by six consecutive
 * polls stores once. Viewer counts ride in the payload and the headline, where
 * they are an observation about a moment rather than a level pretending to have
 * a baseline.
 *
 * LIVE MODE (Phase 16). The hourly poll above is the wrong instrument for the
 * one thing on this platform that moves minute by minute, so the connector
 * also exposes the reads the live runner (lib/ingest/live) drives every
 * minute while a mapped broadcaster is on air:
 *
 *   detect      GET /streams for up to a hundred logins in ONE request, so
 *               knowing who is live costs one Helix point a minute whatever
 *               the number of broadcasters mapped
 *   countClips  GET /clips for one broadcaster inside a window. Helix ignores
 *               the SECONDS of started_at and ended_at, so the request is
 *               widened to whole minutes on both sides and the clips are
 *               filtered here by their own created_at, exactly; consecutive
 *               windows therefore never double count and never miss a clip
 *               at a boundary. Pages are capped: a window that runs past the
 *               cap reports its count as a floor rather than spending the
 *               minute's budget on one broadcaster.
 *
 * What is measured within a session, and why the Phase 10 objection does not
 * apply to it, is written on the live runner.
 */

export const TWITCH_SOURCE_NAME = "twitch";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.twitch.tv/helix";
/** Refresh the token this long before Twitch says it expires. */
const TOKEN_SAFETY_MS = 60_000;
/** Helix caps `first` at 100 for the video list; one page covers a week of daily streams many times over. */
const ARCHIVE_PAGE_SIZE = 100;

export interface TwitchConnectorConfig {
  /** Trailing window, in hours, for the broadcast aggregates. */
  archive_window_hours: number;
}

const DEFAULT_CONFIG: TwitchConnectorConfig = { archive_window_hours: 168 };

export function readTwitchConfig(config: Record<string, unknown>): TwitchConnectorConfig {
  const hours = config.archive_window_hours;
  return {
    archive_window_hours: typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_CONFIG.archive_window_hours,
  };
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  clientId: string;
}

let cachedToken: CachedToken | null = null;

/** For tests. */
export function resetTwitchTokenCache(): void {
  cachedToken = null;
}

export async function fetchTwitchToken(
  credentials: { clientId: string; clientSecret: string },
  fetchImpl: typeof fetch,
  now = Date.now(),
): Promise<string> {
  if (cachedToken && cachedToken.clientId === credentials.clientId && cachedToken.expiresAt - TOKEN_SAFETY_MS > now) {
    return cachedToken.accessToken;
  }
  const body = new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" });
  const response = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!response.ok) {
    throw new ConnectorError(`Twitch token request responded ${response.status}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const parsed = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) throw new ConnectorError("Twitch token response carried no access token");
  cachedToken = { accessToken: parsed.access_token, expiresAt: now + (parsed.expires_in ?? 3600) * 1000, clientId: credentials.clientId };
  return parsed.access_token;
}

// ---------------------------------------------------------------------------
// Helix reads
// ---------------------------------------------------------------------------

interface HelixAuth {
  clientId: string;
  accessToken: string;
}

async function helix<T>(path: string, auth: HelixAuth, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${auth.accessToken}`, "client-id": auth.clientId, accept: "application/json" },
  });
  if (!response.ok) {
    let detail: string | undefined;
    try {
      detail = ((await response.json()) as { message?: string }).message;
    } catch {
      // the status is enough
    }
    throw new ConnectorError(`Twitch API responded ${response.status} for ${path}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  return (await response.json()) as T;
}

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
}

/** Resolves the channel. A purely numeric identifier is a user id; anything else is a login. */
export async function fetchTwitchUser(identifier: string, auth: HelixAuth, fetchImpl: typeof fetch): Promise<TwitchUser> {
  const query = /^\d+$/.test(identifier) ? `id=${encodeURIComponent(identifier)}` : `login=${encodeURIComponent(identifier.toLowerCase())}`;
  const body = await helix<{ data?: Array<{ id?: string; login?: string; display_name?: string }> }>(`/users?${query}`, auth, fetchImpl);
  const user = body.data?.[0];
  if (!user?.id) throw new ConnectorError(`Twitch channel "${identifier}" not found`, { status: 404 });
  return { id: user.id, login: user.login ?? identifier, displayName: user.display_name ?? user.login ?? identifier };
}

/**
 * Total followers.
 *
 * `/helix/channels/followers` returns the follower LIST only to the broadcaster
 * or to a moderator holding moderator:read:followers. With an app token it
 * answers with an empty `data` array and a populated `total` — which is exactly
 * and only what this connector wants, so the documented degraded response is
 * the happy path here and an empty `data` is never an error.
 */
export async function fetchTwitchFollowerTotal(userId: string, auth: HelixAuth, fetchImpl: typeof fetch): Promise<number | null> {
  const body = await helix<{ total?: number }>(`/channels/followers?broadcaster_id=${encodeURIComponent(userId)}&first=1`, auth, fetchImpl);
  return typeof body.total === "number" ? body.total : null;
}

export interface TwitchStream {
  id: string;
  title: string;
  gameName: string | null;
  viewerCount: number | null;
  startedAt: Date | null;
}

/** The current broadcast, or null when the channel is offline. */
export async function fetchTwitchStream(userId: string, auth: HelixAuth, fetchImpl: typeof fetch): Promise<TwitchStream | null> {
  const body = await helix<{ data?: Array<{ id?: string; title?: string; game_name?: string; viewer_count?: number; started_at?: string }> }>(
    `/streams?user_id=${encodeURIComponent(userId)}`,
    auth,
    fetchImpl,
  );
  const stream = body.data?.[0];
  if (!stream?.id) return null;
  const startedAt = stream.started_at ? new Date(stream.started_at) : null;
  return {
    id: stream.id,
    title: stream.title?.trim() || "(untitled)",
    gameName: stream.game_name?.trim() || null,
    viewerCount: typeof stream.viewer_count === "number" ? stream.viewer_count : null,
    startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
  };
}

/** Helix answers up to this many `user_login` / `user_id` filters on one /streams request. */
export const STREAMS_BATCH_SIZE = 100;
/** Helix caps `first` at 100 on /clips. */
const CLIPS_PAGE_SIZE = 100;
/** Pages of clips read for one window before the count is reported as a floor. */
export const DEFAULT_CLIP_MAX_PAGES = 3;

/** A purely numeric identifier is a user id; anything else is a login. */
function isUserId(identifier: string): boolean {
  return /^\d+$/.test(identifier.trim());
}

function readStream(raw: { id?: string; user_id?: string; user_login?: string; title?: string; game_name?: string; viewer_count?: number; started_at?: string; type?: string }): LiveStream | null {
  // Helix reports type "live" for a broadcast and "" while it is in error; only the former is a stream.
  if (!raw.id || !raw.user_id || raw.type !== "live") return null;
  const startedAt = raw.started_at ? new Date(raw.started_at) : null;
  return {
    id: raw.id,
    broadcasterId: raw.user_id,
    channel: raw.user_login ?? raw.user_id,
    title: raw.title?.trim() || "(untitled)",
    category: raw.game_name?.trim() || null,
    viewerCount: typeof raw.viewer_count === "number" && Number.isFinite(raw.viewer_count) ? raw.viewer_count : null,
    startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
  };
}

/**
 * Which of these channels are live, in batches of a hundred per request.
 * Every identifier asked for is answered; a channel Helix does not list is
 * offline (or does not exist, which for this purpose is the same fact).
 */
export async function fetchTwitchStreams(identifiers: string[], auth: HelixAuth, fetchImpl: typeof fetch): Promise<LiveStatus[]> {
  const wanted = identifiers.map((identifier) => identifier.trim()).filter((identifier) => identifier.length > 0);
  const byLogin = new Map<string, LiveStream>();
  const byId = new Map<string, LiveStream>();
  for (let start = 0; start < wanted.length; start += STREAMS_BATCH_SIZE) {
    const batch = wanted.slice(start, start + STREAMS_BATCH_SIZE);
    const query = batch.map((identifier) => (isUserId(identifier) ? `user_id=${encodeURIComponent(identifier)}` : `user_login=${encodeURIComponent(identifier.toLowerCase())}`)).join("&");
    const body = await helix<{ data?: Array<Parameters<typeof readStream>[0]> }>(`/streams?${query}&first=${STREAMS_BATCH_SIZE}`, auth, fetchImpl);
    for (const raw of body.data ?? []) {
      const stream = readStream(raw);
      if (!stream) continue;
      byLogin.set(stream.channel.toLowerCase(), stream);
      byId.set(stream.broadcasterId, stream);
    }
  }
  return wanted.map((identifier) => ({
    externalIdentifier: identifier,
    stream: (isUserId(identifier) ? byId.get(identifier) : byLogin.get(identifier.toLowerCase())) ?? null,
  }));
}

/** Down to the minute, for a Helix parameter whose seconds are ignored. */
function floorToMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/**
 * Clips of one broadcaster created at or after `from` and before `to`.
 * Requested a minute wide on both sides (Helix ignores the seconds), counted
 * by each clip's own created_at, so the window is exact whatever Helix
 * rounds. Reads at most `maxPages` pages; past that the count is a floor.
 */
export async function countTwitchClips(
  broadcasterId: string,
  from: Date,
  to: Date,
  auth: HelixAuth,
  fetchImpl: typeof fetch,
  options: { maxPages?: number } = {},
): Promise<LiveClipCount> {
  if (!(to.getTime() > from.getTime())) return { count: 0, truncated: false, requests: 0 };
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_CLIP_MAX_PAGES);
  const startedAt = new Date(floorToMinute(from).getTime() - 60_000).toISOString();
  const endedAt = new Date(floorToMinute(to).getTime() + 2 * 60_000).toISOString();
  let count = 0;
  let requests = 0;
  let cursor: string | null = null;
  while (requests < maxPages) {
    const page = `/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}&started_at=${encodeURIComponent(startedAt)}&ended_at=${encodeURIComponent(endedAt)}&first=${CLIPS_PAGE_SIZE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
    const body: { data?: Array<{ id?: string; created_at?: string }>; pagination?: { cursor?: string } } = await helix(page, auth, fetchImpl);
    requests += 1;
    for (const clip of body.data ?? []) {
      if (!clip.id || !clip.created_at) continue;
      const createdAt = Date.parse(clip.created_at);
      if (Number.isFinite(createdAt) && createdAt >= from.getTime() && createdAt < to.getTime()) count += 1;
    }
    cursor = body.pagination?.cursor?.trim() || null;
    if (!cursor || (body.data ?? []).length === 0) return { count, truncated: false, requests };
  }
  return { count, truncated: true, requests };
}

export interface TwitchArchiveEntry {
  id: string;
  createdAt: Date;
  hours: number;
}

/**
 * Helix writes durations as "3h20m5s", "45m10s" or "58s" — never as a count of
 * seconds — so it is parsed rather than cast. An unparseable value yields null
 * and the entry is dropped, which is safer than counting it as zero hours.
 */
export function parseTwitchDurationHours(duration: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration.trim());
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) return null;
  const [, h, m, s] = match;
  return Number(h ?? 0) + Number(m ?? 0) / 60 + Number(s ?? 0) / 3600;
}

/** Completed broadcasts (VODs), newest first. */
export async function fetchTwitchArchive(userId: string, auth: HelixAuth, fetchImpl: typeof fetch): Promise<TwitchArchiveEntry[]> {
  const body = await helix<{ data?: Array<{ id?: string; created_at?: string; duration?: string }> }>(
    `/videos?user_id=${encodeURIComponent(userId)}&type=archive&first=${ARCHIVE_PAGE_SIZE}`,
    auth,
    fetchImpl,
  );
  const entries: TwitchArchiveEntry[] = [];
  for (const video of body.data ?? []) {
    if (!video.id || !video.created_at || !video.duration) continue;
    const createdAt = new Date(video.created_at);
    const hours = parseTwitchDurationHours(video.duration);
    if (Number.isNaN(createdAt.getTime()) || hours === null) continue;
    entries.push({ id: video.id, createdAt, hours });
  }
  return entries;
}

export interface ArchiveWindow {
  /** Total broadcast hours whose stream started inside the window. */
  hours: number;
  /** Distinct UTC calendar days carrying a broadcast inside the window. */
  days: number;
}

/**
 * The trailing-window aggregates. Attributed by START time: a broadcast counts
 * whole in the window it began in, so a stream running across the window's edge
 * is never split between two polls and never counted twice.
 */
export function summariseArchive(entries: TwitchArchiveEntry[], now: Date, windowHours: number): ArchiveWindow {
  const start = now.getTime() - windowHours * 3_600_000;
  const days = new Set<string>();
  let hours = 0;
  for (const entry of entries) {
    const at = entry.createdAt.getTime();
    if (at < start || at > now.getTime()) continue;
    hours += entry.hours;
    days.add(entry.createdAt.toISOString().slice(0, 10));
  }
  return { hours: Number(hours.toFixed(4)), days: days.size };
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

/** Signal kind for a live broadcast, so the Engine and the Feed can tell it from an article. */
export const TWITCH_LIVE_KIND = "stream";

/**
 * The event for a broadcast: one per stream id, whichever of the hourly poll
 * and the live runner sees it first (they build the same key).
 */
export function twitchLiveSignal(person: { display_name: string }, stream: LiveStream, now: Date): RawSignal {
  const viewers = stream.viewerCount === null ? null : Math.round(stream.viewerCount);
  const audience = viewers === null ? "" : ` to ${viewers.toLocaleString("en-US")} viewers`;
  const playing = stream.category ? ` playing ${stream.category}` : "";
  return {
    headline: `${person.display_name} is live on Twitch${playing}${audience}: "${stream.title}".`,
    occurredAt: stream.startedAt ?? now,
    // One per broadcast, not one per poll: the same stream id caught by six
    // consecutive hourly polls stores once.
    dedupeKey: `${TWITCH_SOURCE_NAME}:stream:${stream.id}`,
    rawPayload: {
      kind: TWITCH_LIVE_KIND,
      source: TWITCH_SOURCE_NAME,
      stream_id: stream.id,
      channel: stream.channel,
      title: stream.title,
      game: stream.category,
      viewer_count: viewers,
      started_at: stream.startedAt?.toISOString() ?? null,
      observed_at: now.toISOString(),
    },
  };
}

function liveSignal(person: { display_name: string }, user: TwitchUser, stream: TwitchStream, now: Date): RawSignal {
  return twitchLiveSignal(
    person,
    { id: stream.id, broadcasterId: user.id, channel: user.login, title: stream.title, category: stream.gameName, viewerCount: stream.viewerCount, startedAt: stream.startedAt },
    now,
  );
}

/** Live mode's reads (Phase 16), on the same token and the same 401 retry as the poll. */
const twitchLive: LiveCapability = {
  async detect(identifiers, context) {
    if (typeof window !== "undefined") throw new Error("The Twitch connector is server-only.");
    return withFreshToken(context, (auth) => fetchTwitchStreams(identifiers, auth, context.fetch));
  },
  async countClips(broadcasterId, from, to, context) {
    if (typeof window !== "undefined") throw new Error("The Twitch connector is server-only.");
    const pages = (context.config as Record<string, unknown>).live;
    const maxPages = pages && typeof pages === "object" && typeof (pages as { clip_max_pages?: unknown }).clip_max_pages === "number" ? (pages as { clip_max_pages: number }).clip_max_pages : DEFAULT_CLIP_MAX_PAGES;
    return withFreshToken(context, (auth) => countTwitchClips(broadcasterId, from, to, auth, context.fetch, { maxPages }));
  },
  liveSignal: (person, stream, now) => twitchLiveSignal(person, stream, now),
};

async function authorise(context: ConnectorContext): Promise<HelixAuth> {
  const credentials = getTwitchCredentialsOrNull();
  if (!credentials) throw new ConnectorError("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set");
  return { clientId: credentials.clientId, accessToken: await fetchTwitchToken(credentials, context.fetch) };
}

/** Runs `read`, and on a 401 refreshes the app token once and retries. */
async function withFreshToken<T>(context: ConnectorContext, read: (auth: HelixAuth) => Promise<T>): Promise<T> {
  try {
    return await read(await authorise(context));
  } catch (error) {
    if (error instanceof ConnectorError && error.status === 401) {
      resetTwitchTokenCache();
      return read(await authorise(context));
    }
    throw error;
  }
}

function requireIdentifier(person: { slug: string }, identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) throw new ConnectorError(`No Twitch channel configured for ${person.slug}`);
  return trimmed;
}

export const twitchConnector: DataConnector = {
  name: TWITCH_SOURCE_NAME,
  live: twitchLive,

  available() {
    return getTwitchCredentialsOrNull() ? { ok: true } : { ok: false, reason: "TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set" };
  },

  /** Events: the channel being live, once per broadcast. */
  async fetchForPerson(person, identifier, context): Promise<RawSignal[]> {
    if (typeof window !== "undefined") throw new Error("The Twitch connector is server-only.");
    const channel = requireIdentifier(person, identifier);
    return withFreshToken(context, async (auth) => {
      const user = await fetchTwitchUser(channel, auth, context.fetch);
      const stream = await fetchTwitchStream(user.id, auth, context.fetch);
      return stream ? [liveSignal(person, user, stream, context.now)] : [];
    });
  },

  /** Metrics: the cumulative total and the retrospective window aggregates. */
  async fetchMetrics(person, identifier, context): Promise<MetricReading[]> {
    if (typeof window !== "undefined") throw new Error("The Twitch connector is server-only.");
    const channel = requireIdentifier(person, identifier);
    const config = readTwitchConfig(context.config as Record<string, unknown>);

    const { user, followers, archive } = await withFreshToken(context, async (auth) => {
      const resolved = await fetchTwitchUser(channel, auth, context.fetch);
      const [total, entries] = await Promise.all([
        fetchTwitchFollowerTotal(resolved.id, auth, context.fetch),
        fetchTwitchArchive(resolved.id, auth, context.fetch),
      ]);
      return { user: resolved, followers: total, archive: entries };
    });

    const readings: MetricReading[] = [];
    if (followers !== null) readings.push({ metricKey: "follower_count", value: followers });

    // An EMPTY archive is not the same fact as a quiet week. A channel with
    // VODs turned off, or past its retention, returns no videos at all — and
    // recording that as "0 hours streamed" would write a false level into the
    // baseline and make a busy week read as a collapse. The aggregates are
    // recorded only when there is an archive to aggregate; no archive records
    // nothing and leaves those two metrics at their previous readings.
    if (archive.length > 0) {
      const window = summariseArchive(archive, context.now, config.archive_window_hours);
      readings.push({ metricKey: "stream_hours_7d", value: window.hours });
      readings.push({ metricKey: "stream_days_7d", value: window.days });
    }

    if (readings.length === 0) {
      // Authenticated, the channel resolved, and still nothing readable. Fail
      // the poll with what came back rather than returning nothing and
      // recording as ok — the Spotify lesson from Phase 8+.
      throw new ConnectorError(
        `Twitch channel ${user.login} (id ${user.id}) yielded no metric: the follower total was absent and the broadcast archive was empty. ` +
          `An app access token reads /channels/followers for its total and /videos?type=archive for completed broadcasts; both returning nothing at once points at the app's credentials or at VODs being disabled, neither of which a retry fixes.`,
      );
    }
    return readings;
  },
};
