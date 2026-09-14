import { getSpotifyCredentialsOrNull } from "@/lib/env";

import { ConnectorError, type DataConnector, type MetricReading } from "./types";

/**
 * Spotify connector — metrics from the Spotify Web API, public artist data
 * through the Client Credentials flow (no user, no scopes).
 *
 * external_identifier is the Spotify artist ID (3TVXtAsR1Inumwj472S9r4 for
 * Drake). SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET come from the server
 * environment; when either is unset the connector reports itself unavailable
 * and the runner treats the source as inactive.
 *
 * Levels read, snapshotted and normalised by the runner:
 *   popularity      Spotify's 0–100 artist popularity index
 *   follower_count  followers.total
 *
 * NEVER SILENT. The first two production runs polled this connector, reported
 * "ok" in 130 ms and produced nothing: no snapshot, no observation, no error.
 * The only path to that was an artist response carrying an id but neither
 * popularity nor followers, which returned an empty reading list. A connector
 * that can produce nothing without saying why cannot be diagnosed from the
 * ledger, so an artist that yields no level now throws, naming the fields the
 * response did carry, and the poll is recorded as an error with that reason.
 */

export const SPOTIFY_SOURCE_NAME = "spotify";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
/** Refresh the token this long before Spotify says it expires. */
const TOKEN_SAFETY_MS = 60_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  clientId: string;
}

let cachedToken: CachedToken | null = null;

/** For tests. */
export function resetSpotifyTokenCache(): void {
  cachedToken = null;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export async function fetchSpotifyToken(credentials: { clientId: string; clientSecret: string }, fetchImpl: typeof fetch, now = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.clientId === credentials.clientId && cachedToken.expiresAt - TOKEN_SAFETY_MS > now) {
    return cachedToken.accessToken;
  }
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) {
    throw new ConnectorError(`Spotify token request responded ${response.status}`, { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }
  const body = (await response.json()) as TokenResponse;
  if (!body.access_token) throw new ConnectorError("Spotify token response carried no access token");
  cachedToken = { accessToken: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000, clientId: credentials.clientId };
  return body.access_token;
}

export interface SpotifyArtist {
  id: string;
  name: string | null;
  popularity: number | null;
  followers: number | null;
  /** Top-level keys the artist response carried, for diagnosing a response that yields no level. */
  fields: string[];
  /** The endpoint path the object came from, so the error names where it was read. */
  endpoint: string;
}

interface ArtistResponse {
  id?: string;
  name?: string;
  popularity?: number;
  followers?: { total?: number };
  error?: { status?: number; message?: string };
}

async function readArtist(url: string, accessToken: string, fetchImpl: typeof fetch, pick: (body: unknown) => ArtistResponse | undefined): Promise<SpotifyArtist> {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (!response.ok) {
    let detail: string | undefined;
    try {
      detail = ((await response.json()) as ArtistResponse).error?.message;
    } catch {
      // the status is enough
    }
    throw new ConnectorError(`Spotify API responded ${response.status}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const body = pick(await response.json());
  if (!body?.id) throw new ConnectorError(`Spotify artist not found at ${new URL(url).pathname}`, { status: 404 });
  return {
    id: body.id,
    name: body.name ?? null,
    popularity: typeof body.popularity === "number" ? body.popularity : null,
    followers: typeof body.followers?.total === "number" ? body.followers.total : null,
    /** The keys the response actually carried, so a missing level can be diagnosed from the error alone. */
    fields: Object.keys(body).sort(),
    endpoint: new URL(url).pathname,
  };
}

/** Does this artist object carry either level the connector reads? */
function hasLevel(artist: SpotifyArtist): boolean {
  return artist.popularity !== null || artist.followers !== null;
}

/**
 * One artist, read from the FULL artist object.
 *
 * `GET /v1/artists/{id}` is the documented source of `popularity` and
 * `followers.total` and is tried first. In production it answered 200 with
 * `external_urls, href, id, images, name, type, uri` — the full object minus
 * exactly its three computed fields (followers, genres, popularity) — so a
 * 200 from the documented endpoint is not a guarantee that the documented
 * fields are present. When that happens the plural form
 * (`GET /v1/artists?ids=`) is tried once as a second, independent code path
 * on Spotify's side; if it too carries no level, the caller raises with the
 * fields both attempts returned, because an app whose access mode withholds
 * those fields is a credential problem no amount of retrying fixes.
 */
export async function fetchSpotifyArtist(artistId: string, accessToken: string, fetchImpl: typeof fetch): Promise<SpotifyArtist> {
  const single = await readArtist(`${API_BASE}/artists/${encodeURIComponent(artistId)}`, accessToken, fetchImpl, (body) => body as ArtistResponse);
  if (hasLevel(single)) return single;

  const plural = await readArtist(
    `${API_BASE}/artists?ids=${encodeURIComponent(artistId)}`,
    accessToken,
    fetchImpl,
    (body) => (body as { artists?: ArtistResponse[] } | undefined)?.artists?.[0],
  );
  return hasLevel(plural) ? plural : { ...plural, fields: [...new Set([...single.fields, ...plural.fields])].sort(), endpoint: `${single.endpoint} and ${plural.endpoint}` };
}

export const spotifyConnector: DataConnector = {
  name: SPOTIFY_SOURCE_NAME,

  available() {
    return getSpotifyCredentialsOrNull() ? { ok: true } : { ok: false, reason: "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set" };
  },

  /** Metrics only. */
  async fetchForPerson() {
    return [];
  },

  async fetchMetrics(person, artistId, context): Promise<MetricReading[]> {
    if (typeof window !== "undefined") throw new Error("The Spotify connector is server-only.");
    const credentials = getSpotifyCredentialsOrNull();
    if (!credentials) throw new ConnectorError("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set");
    const identifier = artistId.trim();
    if (!identifier) throw new ConnectorError(`No Spotify artist ID configured for ${person.slug}`);

    let artist: SpotifyArtist;
    try {
      artist = await fetchSpotifyArtist(identifier, await fetchSpotifyToken(credentials, context.fetch), context.fetch);
    } catch (error) {
      // An expired or revoked token: fetch a fresh one and try once more.
      if (error instanceof ConnectorError && error.status === 401) {
        resetSpotifyTokenCache();
        artist = await fetchSpotifyArtist(identifier, await fetchSpotifyToken(credentials, context.fetch), context.fetch);
      } else {
        throw error;
      }
    }

    const readings: MetricReading[] = [];
    if (artist.popularity !== null) readings.push({ metricKey: "popularity", value: artist.popularity });
    if (artist.followers !== null) readings.push({ metricKey: "follower_count", value: artist.followers });
    if (readings.length === 0) {
      // Authenticated, the artist resolved, and still no level: the response
      // shape is not what this connector reads. Fail the poll loudly with the
      // keys that came back rather than returning nothing and reading as ok.
      throw new ConnectorError(
        `Spotify artist ${identifier}${artist.name ? ` (${artist.name})` : ""} carried neither popularity nor follower count from ${artist.endpoint}; response fields: ${artist.fields.join(", ") || "none"}. ` +
          `The full artist object includes followers, genres and popularity; an app whose access mode withholds them returns exactly this shape, which is a credential problem no retry fixes.`,
      );
    }
    return readings;
  },
};
