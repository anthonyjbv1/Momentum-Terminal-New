import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeFetch, fakeFetchRoutes, makePerson, makeSource, youtubeChannelsResponse, youtubePlaylistItemsResponse, youtubeVideosResponse } from "@/lib/__tests__/fixtures";

import { ConnectorError } from "./types";
import { fetchCommentaryVolume, fetchYouTubeChannelStats, readYouTubeConfig, youtubeConnector } from "./youtube";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const CHANNEL = "UCX6OQ3DkcsbYNE6H8uQQuVA";
const person = makePerson();

function context(fetch: typeof globalThis.fetch, config: Record<string, never> | Record<string, unknown> = {}) {
  return { source: makeSource(), config: config as Record<string, never>, snapshots: { latest: async () => null, record: () => undefined }, now: NOW, fetch };
}

function searchResponse(count: number, options: { own?: number; nextPageToken?: string } = {}) {
  return {
    nextPageToken: options.nextPageToken,
    items: Array.from({ length: count }, (_, i) => ({ id: { videoId: `v${i}` }, snippet: { channelId: i < (options.own ?? 0) ? CHANNEL : `UCother${i}` } })),
  };
}

/** The full set of calls a poll makes, in order: channel, uploads playlist, video views, commentary search. */
function fullRoutes(overrides: { search?: unknown } = {}) {
  return fakeFetchRoutes([
    { match: "/youtube/v3/channels?", body: youtubeChannelsResponse({}) },
    { match: "/youtube/v3/playlistItems?", body: youtubePlaylistItemsResponse([{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }]) },
    { match: "/youtube/v3/videos?", body: youtubeVideosResponse({ a: "1000000", b: "2500000", c: "400000" }) },
    { match: "/youtube/v3/search?", body: overrides.search ?? searchResponse(7, { own: 2 }) },
  ]);
}

describe("readYouTubeConfig", () => {
  it("has defaults and accepts overrides, including switching commentary off", () => {
    expect(readYouTubeConfig({})).toEqual({ recent_videos: 10, commentary: { enabled: true, window_hours: 24, max_results: 50 } });
    expect(readYouTubeConfig({ recent_videos: 3, commentary: { window_hours: 48, max_results: 500 } })).toEqual({ recent_videos: 3, commentary: { enabled: true, window_hours: 48, max_results: 200 } });
    expect(readYouTubeConfig({ commentary: false }).commentary.enabled).toBe(false);
    expect(readYouTubeConfig({ commentary: { enabled: false } }).commentary.enabled).toBe(false);
    expect(readYouTubeConfig({ recent_videos: -1 }).recent_videos).toBe(10);
  });
});

describe("fetchYouTubeChannelStats", () => {
  it("reads statistics and the uploads playlist, hiding a hidden subscriber count", async () => {
    const stats = await fetchYouTubeChannelStats(CHANNEL, "k", fakeFetch(youtubeChannelsResponse({})));
    expect(stats).toMatchObject({ channelId: CHANNEL, title: "MrBeast", subscriberCount: 516_000_000, viewCount: 90_000_000_000, videoCount: 900, uploadsPlaylistId: "UUX6OQ3DkcsbYNE6H8uQQuVA" });
    const hidden = await fetchYouTubeChannelStats(CHANNEL, "k", fakeFetch(youtubeChannelsResponse({ hiddenSubscriberCount: true })));
    expect(hidden.subscriberCount).toBeNull();
    expect(hidden.hiddenSubscriberCount).toBe(true);
  });

  it("throws a ConnectorError on API failures without leaking the key, and when the channel does not exist", async () => {
    await expect(fetchYouTubeChannelStats(CHANNEL, "secret-key", fakeFetch({ error: { code: 403, message: "quotaExceeded" } }, { status: 403 }))).rejects.toMatchObject({
      name: "ConnectorError",
      status: 403,
      message: expect.not.stringContaining("secret-key"),
    });
    await expect(fetchYouTubeChannelStats("UCnope", "k", fakeFetch({ items: [] }))).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe("fetchCommentaryVolume", () => {
  it("counts videos from other channels since the window start, one page by default", async () => {
    const fetch = fakeFetchRoutes([{ match: "/search?", body: searchResponse(7, { own: 2 }) }]);
    const result = await fetchCommentaryVolume({ query: '"MrBeast"', excludeChannelId: CHANNEL, publishedAfter: new Date(NOW.getTime() - 86_400_000), maxResults: 50 }, "k", fetch);
    expect(result).toEqual({ count: 5, saturated: false });
    expect(fetch.calls).toHaveLength(1);
    const url = new URL(fetch.calls[0]);
    expect(url.searchParams.get("q")).toBe('"MrBeast"');
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("publishedAfter")).toBe("2026-09-06T12:00:00Z");
    expect(url.searchParams.get("part")).toBe("snippet");
  });

  it("stops at max_results and reports saturation; pages when allowed", async () => {
    const paged = fakeFetchRoutes([
      { match: /search\?(?!.*pageToken)/, body: searchResponse(50, { nextPageToken: "p2" }) },
      { match: /pageToken=p2/, body: searchResponse(20) },
    ]);
    expect(await fetchCommentaryVolume({ query: "q", excludeChannelId: CHANNEL, publishedAfter: NOW, maxResults: 50 }, "k", paged)).toEqual({ count: 50, saturated: true });
    expect(paged.calls).toHaveLength(1);
    expect(await fetchCommentaryVolume({ query: "q", excludeChannelId: CHANNEL, publishedAfter: NOW, maxResults: 100 }, "k", paged)).toEqual({ count: 70, saturated: false });
    expect(paged.calls).toHaveLength(3);
  });
});

describe("youtubeConnector", () => {
  const previousKey = process.env.YOUTUBE_API_KEY;
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "test-key";
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previousKey;
  });

  it("is available only with a key, and produces no events of its own", async () => {
    expect(youtubeConnector.available!()).toEqual({ ok: true });
    delete process.env.YOUTUBE_API_KEY;
    expect(youtubeConnector.available!()).toEqual({ ok: false, reason: "YOUTUBE_API_KEY is not set" });
    expect(await youtubeConnector.fetchForPerson(person, CHANNEL, context(fakeFetch({})))).toEqual([]);
  });

  it("reads the channel levels, the recent-video views and the commentary volume as raw readings", async () => {
    const fetch = fullRoutes();
    const readings = await youtubeConnector.fetchMetrics!(person, CHANNEL, context(fetch));
    expect(readings).toEqual([
      { metricKey: "subscriber_count", value: 516_000_000 },
      { metricKey: "view_count", value: 90_000_000_000 },
      { metricKey: "video_count", value: 900 },
      { metricKey: "recent_video_views", value: 3_900_000 },
      { metricKey: "commentary_volume_24h", value: 5 },
    ]);
    expect(fetch.calls.map((url) => new URL(url).pathname)).toEqual(["/youtube/v3/channels", "/youtube/v3/playlistItems", "/youtube/v3/videos", "/youtube/v3/search"]);
    expect(fetch.calls.every((url) => url.includes("key=test-key"))).toBe(true);
    const search = new URL(fetch.calls[3]);
    expect(search.searchParams.get("q")).toBe('"MrBeast"');
    expect(search.searchParams.get("maxResults")).toBe("50");
  });

  it("skips a hidden subscriber count, the recent-video read when there are no uploads, and commentary when switched off", async () => {
    const fetch = fakeFetchRoutes([
      { match: "/channels?", body: youtubeChannelsResponse({ hiddenSubscriberCount: true, uploads: null }) },
    ]);
    const readings = await youtubeConnector.fetchMetrics!(person, CHANNEL, context(fetch, { commentary: false }));
    expect(readings.map((r) => r.metricKey)).toEqual(["view_count", "video_count"]);
    expect(fetch.calls).toHaveLength(1);
  });

  it("fails the poll, not the run, on an API error, without the key in the message", async () => {
    const fetch = fakeFetchRoutes([{ match: "/channels?", body: { error: { code: 403, message: "quotaExceeded" } }, status: 403 }]);
    await expect(youtubeConnector.fetchMetrics!(person, CHANNEL, context(fetch))).rejects.toMatchObject({ name: "ConnectorError", status: 403, message: expect.not.stringContaining("test-key") });
    await expect(youtubeConnector.fetchMetrics!(person, "   ", context(fetch))).rejects.toThrow(/No YouTube channel ID/);
  });
});
