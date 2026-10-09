import "server-only";

import { fetchTwitchToken } from "@/lib/connectors/twitch";
import { getApiSportsKeyOrNull, getTwitchCredentialsOrNull, getYouTubeApiKeyOrNull } from "@/lib/env";
import type { TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

/**
 * IDENTITY RESOLUTION (2026-10-09, the roster expansion).
 *
 * A platform id is resolved LIVE, by the platform, at add time: a Twitch
 * login to its broadcaster id and last archive date (Helix), a YouTube
 * handle to its channel id (channels.list forHandle), an NFL player's name
 * to API-Sports' player and team ids (/players, /teams), and a feed address
 * to what it serves right now (items, newest and oldest dates). The keys of
 * the resolve block (login, handle or handles, channel_ids, player_search, probe_url)
 * choose the platforms, not the mapping's source: a streamer's Twitch
 * mapping carries the YouTube handles too, so the trending mapping stays in
 * the Phase 22 seed shape and costs nothing until a channel id is pinned. The
 * operator's console session cannot reach those hosts and holds no keys, so
 * the step runs here, at the end of a scheduled ingestion run, for every
 * mapping whose config carries a `resolve` block, and writes what the
 * platform answered into the mapping's `identity` block for the operator
 * to read back and compare with the prep listing before the mapping goes
 * live. A mapping is resolved once a day unless `resolve.force` is set; a
 * failure is written as `identity.error`, never thrown.
 *
 * Cost: one to three requests per mapping per day. Nothing here touches a
 * score, a signal or the Engine.
 */

const RESOLVE_TTL_MS = 24 * 3_600_000;

export interface IdentityResolveResult {
  considered: number;
  resolved: string[];
  failed: Array<{ slug: string; source: string; reason: string }>;
}

interface MappingRow {
  id: string;
  person_id: string;
  external_identifier: string | null;
  config: Json | null;
  people: { slug: string } | null;
  data_sources: { name: string; config: Json | null } | null;
}

function record(value: Json | null | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`${what} responded ${response.status}`);
  return (await response.json()) as T;
}

async function resolveTwitch(login: string, fetchImpl: typeof fetch): Promise<Json> {
  const credentials = getTwitchCredentialsOrNull();
  if (!credentials) throw new Error("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set");
  const token = await fetchTwitchToken(credentials, fetchImpl);
  const headers = { authorization: `Bearer ${token}`, "client-id": credentials.clientId, accept: "application/json" };
  const users = await json<{ data?: Array<{ id?: string; login?: string; display_name?: string; created_at?: string }> }>(
    await fetchImpl(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login.toLowerCase())}`, { headers }),
    "Twitch /users",
  );
  const user = users.data?.[0];
  if (!user?.id) throw new Error(`Twitch login "${login}" not found`);
  const archive = await json<{ data?: Array<{ created_at?: string; title?: string; duration?: string }> }>(
    await fetchImpl(`https://api.twitch.tv/helix/videos?user_id=${encodeURIComponent(user.id)}&type=archive&first=1`, { headers }),
    "Twitch /videos",
  );
  const last = archive.data?.[0];
  return {
    id: user.id,
    login: user.login ?? login,
    display_name: user.display_name ?? null,
    account_created_at: user.created_at ?? null,
    last_live_at: last?.created_at ?? null,
    last_live_title: last?.title ?? null,
    last_live_duration: last?.duration ?? null,
  };
}

async function resolveYouTube(handle: string, fetchImpl: typeof fetch): Promise<Json> {
  const key = getYouTubeApiKeyOrNull();
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("forHandle", handle.startsWith("@") ? handle : `@${handle}`);
  url.searchParams.set("key", key);
  const body = await json<{ items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string }; statistics?: { subscriberCount?: string; videoCount?: string } }> }>(
    await fetchImpl(url, { headers: { accept: "application/json" } }),
    "YouTube channels.list",
  );
  const item = body.items?.[0];
  if (!item?.id) throw new Error(`YouTube handle "${handle}" not found`);
  return { channel_id: item.id, title: item.snippet?.title ?? null, handle: item.snippet?.customUrl ?? null, subscribers: item.statistics?.subscriberCount ?? null, videos: item.statistics?.videoCount ?? null };
}

/** A channel id the prep listed without a handle: verified by id, so the title and audience can be compared. */
async function resolveYouTubeById(channelId: string, fetchImpl: typeof fetch): Promise<Json> {
  const key = getYouTubeApiKeyOrNull();
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", key);
  const body = await json<{ items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string }; statistics?: { subscriberCount?: string; videoCount?: string } }> }>(
    await fetchImpl(url, { headers: { accept: "application/json" } }),
    "YouTube channels.list",
  );
  const item = body.items?.[0];
  if (!item?.id) throw new Error(`YouTube channel "${channelId}" not found`);
  return { channel_id: item.id, title: item.snippet?.title ?? null, handle: item.snippet?.customUrl ?? null, subscribers: item.statistics?.subscriberCount ?? null, videos: item.statistics?.videoCount ?? null };
}

async function resolveApiSports(host: string, playerSearch: string, teamSearch: string | null, season: number, fetchImpl: typeof fetch): Promise<Json> {
  const key = getApiSportsKeyOrNull();
  if (!key) throw new Error("APISPORTS_API_KEY is not set");
  const headers = { "x-apisports-key": key, accept: "application/json" };
  const get = async (path: string) => json<{ errors?: unknown; response?: unknown[] }>(await fetchImpl(`https://${host}${path}`, { headers }), `API-Sports ${path}`);
  const trim = (entry: unknown): Json => {
    const row = record(entry as Json);
    const out: Record<string, Json> = {};
    for (const field of ["id", "name", "position", "group", "number", "age", "team", "college"]) {
      const value = row[field];
      if (value !== undefined && value !== null) out[field] = typeof value === "object" ? (JSON.stringify(value).slice(0, 200) as Json) : (value as Json);
    }
    return out;
  };
  const errorsOf = (body: { errors?: unknown }): Json =>
    body.errors && typeof body.errors === "object" && !Array.isArray(body.errors) && Object.keys(body.errors).length > 0 ? (JSON.stringify(body.errors) as Json) : null;
  // /players needs a team, so the team is looked up first; the franchise
  // (the lowest id: college programmes sort after the league's teams) is
  // the one the search is scoped to. The search field admits only letters,
  // digits and spaces, so a hyphenated surname is sent with a space.
  const result: Record<string, Json> = { season };
  let teamId: number | null = null;
  if (teamSearch) {
    const teams = await get(`/teams?search=${encodeURIComponent(teamSearch)}`);
    const trimmed = (teams.response ?? []).slice(0, 8).map(trim);
    result.teams = trimmed;
    result.team_errors = errorsOf(teams);
    const ids = trimmed.map((team) => (team as Record<string, Json>).id).filter((id): id is number => typeof id === "number");
    teamId = ids.length > 0 ? Math.min(...ids) : null;
    result.team_id = teamId;
  }
  const search = playerSearch.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const players = await get(`/players?search=${encodeURIComponent(search)}&season=${season}${teamId === null ? "" : `&team=${teamId}`}`);
  result.players = (players.response ?? []).slice(0, 8).map(trim);
  result.player_errors = errorsOf(players);
  return result;
}

async function probeFeed(url: string, fetchImpl: typeof fetch): Promise<Json> {
  const response = await fetchImpl(url, { headers: { accept: "application/rss+xml, application/xml, text/xml" } });
  if (!response.ok) throw new Error(`feed responded ${response.status}`);
  const body = await response.text();
  const items = body.split("<item>").slice(1);
  const dates = items
    .map((item) => /<pubDate>([^<]+)<\/pubDate>/.exec(item)?.[1])
    .map((raw) => (raw ? Date.parse(raw) : Number.NaN))
    .filter((time) => Number.isFinite(time));
  const titles = items.slice(0, 3).map((item) => (/<title>(?:<!\[CDATA\[)?([^<\]]+)/.exec(item)?.[1] ?? "").trim());
  return {
    items: items.length,
    newest_at: dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null,
    oldest_at: dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null,
    newer_than_7d: dates.filter((time) => Date.now() - time < 7 * 86_400_000).length,
    first_titles: titles,
  };
}

export async function resolveIdentities(options: { client: TypedSupabaseClient; fetch?: typeof fetch; now?: Date; limit?: number }): Promise<IdentityResolveResult> {
  const { client } = options;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  const limit = options.limit ?? 8;
  const result: IdentityResolveResult = { considered: 0, resolved: [], failed: [] };

  const mappings = await client
    .from("person_data_sources")
    .select("id, person_id, external_identifier, config, people!inner(slug), data_sources!inner(name, config)")
    .not("config->resolve", "is", null)
    .limit(50);
  if (mappings.error) throw new Error(`Could not load mappings to resolve: ${mappings.error.message}`);

  for (const row of (mappings.data ?? []) as unknown as MappingRow[]) {
    if (result.resolved.length + result.failed.length >= limit) break;
    const config = record(row.config);
    const resolve = record(config.resolve);
    const identity = record(config.identity);
    const slug = row.people?.slug ?? row.person_id;
    const source = row.data_sources?.name ?? "";
    result.considered += 1;
    const resolvedAt = text(identity.resolved_at);
    if (resolve.force !== true && resolvedAt && now.getTime() - Date.parse(resolvedAt) < RESOLVE_TTL_MS) continue;

    const write = async (block: Json | null, error: string | null) => {
      const next = { ...config, identity: { ...(block && typeof block === "object" ? (block as Record<string, Json>) : {}), ...(error ? { error } : {}), resolved_at: now.toISOString() } } as Json;
      const wrote = await client.from("person_data_sources").update({ config: next }).eq("id", row.id);
      if (wrote.error) throw new Error(wrote.error.message);
    };

    try {
      // The keys of the resolve block say which platforms to ask, whatever
      // source the mapping belongs to: a Twitch mapping may carry the
      // person's YouTube handles too, so one row resolves both.
      // Each platform, and each handle, on its own: one that fails is
      // recorded as an error beside the ones that answered.
      const block: Record<string, Json> = {};
      const errors: string[] = [];
      const attempt = async (what: string, run: () => Promise<Json>): Promise<Json | undefined> => {
        try {
          return await run();
        } catch (error) {
          errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      };
      const login = text(resolve.login);
      const handles = [text(resolve.handle), ...(Array.isArray(resolve.handles) ? resolve.handles.map(text) : [])].filter((h): h is string => h !== null);
      const channelIds = (Array.isArray(resolve.channel_ids) ? resolve.channel_ids.map(text) : []).filter((id): id is string => id !== null);
      const playerSearch = text(resolve.player_search);
      const probeUrl = text(resolve.probe_url);
      if (!login && handles.length === 0 && channelIds.length === 0 && !playerSearch && !probeUrl) throw new Error(`nothing to resolve for ${source}: the resolve block names no login, handle(s), channel_ids, player_search or probe_url`);
      if (login) {
        const twitch = await attempt("twitch", () => resolveTwitch(login, fetchImpl));
        if (twitch !== undefined) block.twitch = twitch;
      }
      if (handles.length > 0) {
        const channels: Json[] = [];
        for (const handle of handles) {
          const channel = await attempt(`youtube ${handle}`, () => resolveYouTube(handle, fetchImpl));
          channels.push(channel === undefined ? { handle, error: errors[errors.length - 1] ?? "failed" } : channel);
        }
        block.youtube = channels.length === 1 ? channels[0] : channels;
      }
      if (channelIds.length > 0) {
        const channels: Json[] = [];
        for (const channelId of channelIds) {
          const channel = await attempt(`youtube ${channelId}`, () => resolveYouTubeById(channelId, fetchImpl));
          channels.push(channel === undefined ? { channel_id: channelId, error: errors[errors.length - 1] ?? "failed" } : channel);
        }
        block.youtube_by_id = channels.length === 1 ? channels[0] : channels;
      }
      if (playerSearch) {
        const host = text(record(row.data_sources?.config).host) ?? "v1.american-football.api-sports.io";
        const season = typeof resolve.season === "number" ? resolve.season : now.getUTCFullYear();
        const apisports = await attempt("apisports", () => resolveApiSports(host, playerSearch, text(resolve.team_search), season, fetchImpl));
        if (apisports !== undefined) block.apisports = apisports;
      }
      if (probeUrl) {
        const feed = await attempt("feed", () => probeFeed(probeUrl, fetchImpl));
        if (feed !== undefined) block.feed = feed;
      }
      if (Object.keys(block).length === 0) throw new Error(errors.join("; "));
      await write(block, errors.length > 0 ? errors.join("; ").slice(0, 400) : null);
      result.resolved.push(`${slug}/${source}`);
      continue;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[identity] ${slug}/${source}: ${reason}`);
      result.failed.push({ slug, source, reason });
      try {
        await write(null, reason.slice(0, 400));
      } catch (writeError) {
        console.warn(`[identity] ${slug}/${source}: could not record the failure: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    }
  }
  return result;
}
