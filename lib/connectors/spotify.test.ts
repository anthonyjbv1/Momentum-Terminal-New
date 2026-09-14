import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { fetchSpotifyToken, resetSpotifyTokenCache, spotifyConnector } from "./spotify";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const person = makePerson({ slug: "drake", display_name: "Drake" });
const ARTIST = "3TVXtAsR1Inumwj472S9r4";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A Spotify double: records every call with its headers, answers the token and artist endpoints. */
function spotifyFetch(options: { artistStatus?: number[]; tokenStatus?: number; popularity?: number; followers?: number; artistBody?: Record<string, unknown>; pluralBody?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const artistStatuses = [...(options.artistStatus ?? [])];
  let tokens = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
    if (url.includes("accounts.spotify.com/api/token")) {
      tokens += 1;
      if (options.tokenStatus && options.tokenStatus !== 200) return new Response("{}", { status: options.tokenStatus });
      return Response.json({ access_token: `token-${tokens}`, token_type: "Bearer", expires_in: 3600 });
    }
    const status = artistStatuses.shift() ?? 200;
    if (status !== 200) return Response.json({ error: { status, message: status === 401 ? "The access token expired" : "nope" } }, { status });
    const full = { id: ARTIST, name: "Drake", popularity: options.popularity ?? 93, followers: { href: null, total: options.followers ?? 98_000_000 } };
    // The plural endpoint wraps the same object in an artists array.
    if (url.includes("/artists?ids=")) return Response.json({ artists: [options.pluralBody ?? full] });
    if (options.artistBody) return Response.json(options.artistBody);
    return Response.json(full);
  };
  return Object.assign(impl, { calls });
}

const context = (fetch: typeof globalThis.fetch) => ({
  source: makeSource({ name: "spotify" }),
  config: {} as Record<string, never>,
  snapshots: { latest: async () => null, record: () => undefined },
  now: NOW,
  fetch,
});

describe("spotifyConnector", () => {
  const saved = { id: process.env.SPOTIFY_CLIENT_ID, secret: process.env.SPOTIFY_CLIENT_SECRET };
  beforeEach(() => {
    resetSpotifyTokenCache();
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
  });
  afterEach(() => {
    if (saved.id === undefined) delete process.env.SPOTIFY_CLIENT_ID;
    else process.env.SPOTIFY_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.SPOTIFY_CLIENT_SECRET;
    else process.env.SPOTIFY_CLIENT_SECRET = saved.secret;
  });

  it("is available only with both credentials, and produces no events", async () => {
    expect(spotifyConnector.available!()).toEqual({ ok: true });
    delete process.env.SPOTIFY_CLIENT_SECRET;
    expect(spotifyConnector.available!()).toEqual({ ok: false, reason: "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set" });
    expect(await spotifyConnector.fetchForPerson(person, ARTIST, context(spotifyFetch()))).toEqual([]);
  });

  it("gets a client-credentials token with Basic auth, then reads popularity and followers as raw levels", async () => {
    const fetch = spotifyFetch({ popularity: 94, followers: 98_123_456 });
    const readings = await spotifyConnector.fetchMetrics!(person, ARTIST, context(fetch));
    expect(readings).toEqual([
      { metricKey: "popularity", value: 94 },
      { metricKey: "follower_count", value: 98_123_456 },
    ]);
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]).toMatchObject({ url: "https://accounts.spotify.com/api/token", method: "POST", body: "grant_type=client_credentials" });
    expect(fetch.calls[0].headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(fetch.calls[1]).toMatchObject({ url: `https://api.spotify.com/v1/artists/${ARTIST}`, method: "GET" });
    expect(fetch.calls[1].headers.authorization).toBe("Bearer token-1");
  });

  it("reuses the token until it is about to expire", async () => {
    const fetch = spotifyFetch();
    const credentials = { clientId: "client-id", clientSecret: "client-secret" };
    expect(await fetchSpotifyToken(credentials, fetch, 0)).toBe("token-1");
    expect(await fetchSpotifyToken(credentials, fetch, 30 * 60_000)).toBe("token-1");
    expect(await fetchSpotifyToken(credentials, fetch, 59.5 * 60_000)).toBe("token-2");
    expect(fetch.calls).toHaveLength(2);
  });

  it("retries once with a fresh token when Spotify says the token expired", async () => {
    const fetch = spotifyFetch({ artistStatus: [401] });
    const readings = await spotifyConnector.fetchMetrics!(person, ARTIST, context(fetch));
    expect(readings[0]).toEqual({ metricKey: "popularity", value: 93 });
    expect(fetch.calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["POST", "/api/token"],
      ["GET", `/v1/artists/${ARTIST}`],
      ["POST", "/api/token"],
      ["GET", `/v1/artists/${ARTIST}`],
    ]);
    expect(fetch.calls[3].headers.authorization).toBe("Bearer token-2");
  });

  it("reads the FULL artist object from /v1/artists/{id}, the documented source of both levels", async () => {
    const fetch = spotifyFetch();
    await spotifyConnector.fetchMetrics!(person, ARTIST, context(fetch));
    // One artist call, to the singular path, and no second attempt when the first carries the levels.
    const artistCalls = fetch.calls.filter((c) => c.url.includes("/artists"));
    expect(artistCalls.map((c) => new URL(c.url).pathname)).toEqual([`/v1/artists/${ARTIST}`]);
  });

  it("falls back to the plural endpoint when the singular one answers 200 without the computed fields", async () => {
    // Exactly what production returned: the full object minus followers, genres and popularity.
    const simplified = { external_urls: {}, href: "h", id: ARTIST, images: [], name: "Drake", type: "artist", uri: `spotify:artist:${ARTIST}` };
    const fetch = spotifyFetch({ artistBody: simplified });
    expect(await spotifyConnector.fetchMetrics!(person, ARTIST, context(fetch))).toEqual([
      { metricKey: "popularity", value: 93 },
      { metricKey: "follower_count", value: 98_000_000 },
    ]);
    expect(fetch.calls.filter((c) => c.url.includes("/artists")).map((c) => new URL(c.url).pathname)).toEqual([`/v1/artists/${ARTIST}`, "/v1/artists"]);
  });

  it("never returns nothing quietly: when neither endpoint carries a level the poll fails and names the fields that came back", async () => {
    // The production failure: two runs reported "ok" in 130 ms with no snapshot, no observation and no error,
    // because an artist response with neither field produced an empty reading list. It is now an error with its cause.
    const simplified = { external_urls: {}, href: "h", id: ARTIST, images: [], name: "Drake", type: "artist", uri: `spotify:artist:${ARTIST}` };
    const fetch = spotifyFetch({ artistBody: simplified, pluralBody: simplified });
    await expect(spotifyConnector.fetchMetrics!(person, ARTIST, context(fetch))).rejects.toMatchObject({
      name: "ConnectorError",
      message: expect.stringContaining("carried neither popularity nor follower count"),
    });
    await expect(spotifyConnector.fetchMetrics!(person, ARTIST, context(spotifyFetch({ artistBody: simplified, pluralBody: simplified })))).rejects.toMatchObject({
      message: expect.stringContaining("response fields: external_urls, href, id, images, name, type, uri"),
    });

    // One level is enough to keep the poll alive: a partial response is not a silent one.
    resetSpotifyTokenCache();
    const partial = spotifyFetch({ artistBody: { id: ARTIST, name: "Drake", popularity: 93 } });
    expect(await spotifyConnector.fetchMetrics!(person, ARTIST, context(partial))).toEqual([{ metricKey: "popularity", value: 93 }]);
  });

  it("fails the poll on other errors without the secret in the message", async () => {
    await expect(spotifyConnector.fetchMetrics!(person, ARTIST, context(spotifyFetch({ artistStatus: [429] })))).rejects.toMatchObject({ name: "ConnectorError", status: 429, retryable: true, message: expect.not.stringContaining("client-secret") });
    // The token from the call above is still cached; a fresh double needs a fresh token request to fail.
    resetSpotifyTokenCache();
    await expect(spotifyConnector.fetchMetrics!(person, ARTIST, context(spotifyFetch({ tokenStatus: 400 })))).rejects.toMatchObject({ name: "ConnectorError", status: 400, message: expect.not.stringContaining("client-secret") });
    await expect(spotifyConnector.fetchMetrics!(person, " ", context(spotifyFetch()))).rejects.toThrow(/No Spotify artist ID/);
  });
});
