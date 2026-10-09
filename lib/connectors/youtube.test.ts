import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeFetch, fakeFetchRoutes, makePerson, makeSource, youtubeChannelsResponse, youtubePlaylistItemsResponse, youtubeVideosResponse } from "@/lib/__tests__/fixtures";

import { ConnectorError } from "./types";
import { fetchCommentaryVolume, fetchYouTubeChannelStats, readYouTubeConfig, youtubeConnector } from "./youtube";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const CHANNEL = "UCX6OQ3DkcsbYNE6H8uQQuVA";
const person = makePerson();

function context(fetch: typeof globalThis.fetch, config: Record<string, never> | Record<string, unknown> = {}, personConfig?: Record<string, unknown>) {
  return { source: makeSource(), config: config as Record<string, never>, snapshots: { latest: async () => null, record: () => undefined }, now: NOW, fetch, ...(personConfig ? { personConfig: personConfig as Record<string, never> } : {}) };
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

  it("lets the mapping switch commentary off for its channel alone (2026-10-09): channel statistics, no search.list", async () => {
    const fetch = fullRoutes();
    const readings = await youtubeConnector.fetchMetrics!(person, CHANNEL, context(fetch, {}, { commentary: false }));
    expect(readings.map((r) => r.metricKey)).not.toContain("commentary_volume_24h");
    expect(fetch.calls.some((call) => String(call).includes("/search?"))).toBe(false);
    // The source's own setting still applies to a mapping that says nothing.
    const all = fullRoutes();
    const everything = await youtubeConnector.fetchMetrics!(person, CHANNEL, context(all, {}));
    expect(everything.map((r) => r.metricKey)).toContain("commentary_volume_24h");
  });

  it("fails the poll, not the run, on an API error, without the key in the message", async () => {
    const fetch = fakeFetchRoutes([{ match: "/channels?", body: { error: { code: 403, message: "quotaExceeded" } }, status: 403 }]);
    await expect(youtubeConnector.fetchMetrics!(person, CHANNEL, context(fetch))).rejects.toMatchObject({ name: "ConnectorError", status: 403, message: expect.not.stringContaining("test-key") });
    await expect(youtubeConnector.fetchMetrics!(person, "   ", context(fetch))).rejects.toThrow(/No YouTube channel ID/);
  });
});

describe("the age-matched pace (YOUTUBE_PACE_AGE_MATCHED_ENABLED, 2026-10-09)", () => {
  const previousKey = process.env.YOUTUBE_API_KEY;
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "test-key";
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previousKey;
  });
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  /** Four uploads: the newest three days old, three peers a week apart. */
  const playlist = youtubePlaylistItemsResponse([
    { id: "a", title: "A", publishedAt: iso(3) },
    { id: "b", title: "B", publishedAt: iso(10) },
    { id: "c", title: "C", publishedAt: iso(17) },
    { id: "d", title: "D", publishedAt: iso(24) },
  ]);
  const routes = () =>
    fakeFetchRoutes([
      { match: "/youtube/v3/channels?", body: youtubeChannelsResponse({}) },
      { match: "/youtube/v3/playlistItems?", body: playlist },
      { match: "/youtube/v3/videos?", body: youtubeVideosResponse({ a: "1000000", b: "2500000", c: "2600000", d: "2400000" }) },
      { match: "/youtube/v3/search?", body: searchResponse(7, { own: 2 }) },
    ]);
  /** The peers' ledger at two and four days old: every peer at 1,000,000 views at three days, so the newest reads 0. */
  const history = ["b", "c", "d"].flatMap((videoId, i) => {
    const publishedAt = new Date(NOW.getTime() - (10 + 7 * i) * DAY);
    return [48, 96].map((age) => ({ videoId, publishedAt, views: age === 48 ? 800_000 : 1_200_000, recordedAt: new Date(publishedAt.getTime() + age * HOUR) }));
  });
  function ledger(rows = history) {
    const recorded: Array<{ videoId: string; publishedAt: Date | null; views: number; recordedAt: Date }> = [];
    const asked: Array<[number, number]> = [];
    return {
      recorded,
      asked,
      ledger: {
        aroundAge: async (from: number, to: number) => {
          asked.push([from, to]);
          return rows;
        },
        record: (batch: typeof recorded) => recorded.push(...batch),
      },
    };
  }

  it("off: the readings are byte-identical to today, and the ledger is recorded either way", async () => {
    const plain = await youtubeConnector.fetchMetrics!(person, CHANNEL, context(routes()));
    const { ledger: videoViews, recorded, asked } = ledger();
    const withLedger = await youtubeConnector.fetchMetrics!(person, CHANNEL, { ...context(routes()), videoViews, paceAgeMatched: false });
    expect(withLedger).toEqual(plain);
    expect(plain.map((r) => r.metricKey)).toEqual(["subscriber_count", "view_count", "video_count", "recent_video_views", "commentary_volume_24h"]);
    expect(plain.find((r) => r.metricKey === "recent_video_views")).toEqual({ metricKey: "recent_video_views", value: 8_500_000 });
    // Four rows, one per upload, this poll's views and the publication time; the ledger is not read while the switch is off.
    expect(recorded).toEqual([
      { videoId: "a", publishedAt: new Date(iso(3)), views: 1_000_000, recordedAt: NOW },
      { videoId: "b", publishedAt: new Date(iso(10)), views: 2_500_000, recordedAt: NOW },
      { videoId: "c", publishedAt: new Date(iso(17)), views: 2_600_000, recordedAt: NOW },
      { videoId: "d", publishedAt: new Date(iso(24)), views: 2_400_000, recordedAt: NOW },
    ]);
    expect(asked).toEqual([]);
  });

  it("on: the newest upload at its own age replaces the summed basket, read from the ledger around that age, and is silent when the ledger cannot judge it", async () => {
    const { ledger: videoViews, asked } = ledger();
    const details: Record<string, unknown> = {};
    const readings = await youtubeConnector.fetchMetrics!(person, CHANNEL, { ...context(routes()), videoViews, paceAgeMatched: true, detail: (key, value) => (details[key] = value) });
    expect(readings.map((r) => r.metricKey)).toEqual(["subscriber_count", "view_count", "video_count", "video_pace_age_matched", "commentary_volume_24h"]);
    expect(readings.find((r) => r.metricKey === "video_pace_age_matched")).toEqual({ metricKey: "video_pace_age_matched", value: 0 });
    expect(asked).toEqual([[24, 120]]);
    expect(details.video_pace).toEqual({ video_id: "a", age_hours: 72, peers: 3, reading: 0 });
    // No history yet (the day the switch is flipped, for a channel whose peers have not reached the age): no pace reading, and no basket reading either.
    const empty = ledger([]);
    const silent = await youtubeConnector.fetchMetrics!(person, CHANNEL, { ...context(routes()), videoViews: empty.ledger, paceAgeMatched: true, detail: (key, value) => (details[key] = value) });
    expect(silent.map((r) => r.metricKey)).toEqual(["subscriber_count", "view_count", "video_count", "commentary_volume_24h"]);
    expect(details.video_pace).toEqual({ reading: null });
    // On, but no ledger in the context (the live runner's, a test's): the basket reading stands.
    const noLedger = await youtubeConnector.fetchMetrics!(person, CHANNEL, { ...context(routes()), paceAgeMatched: true });
    expect(noLedger.map((r) => r.metricKey)).toContain("recent_video_views");
  });
});
