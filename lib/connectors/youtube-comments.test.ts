import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeFetchRoutes, makePerson, makeSource, youtubeChannelsResponse, youtubeCommentThreadsResponse, youtubePlaylistItemsResponse, youtubeVideoStatisticsResponse } from "@/lib/__tests__/fixtures";

import { readYouTubeCommentsConfig, resetUploadsCache, youtubeCommentsConnector } from "./youtube-comments";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const CHANNEL = "UCX6OQ3DkcsbYNE6H8uQQuVA";
const person = makePerson();

const context = (fetch: typeof globalThis.fetch, config: Record<string, unknown> = {}) => ({
  source: makeSource({ name: "youtube_comments", tier: 4 }),
  config: config as Record<string, never>,
  snapshots: { latest: async () => null, record: () => undefined },
  now: NOW,
  fetch,
});

describe("readYouTubeCommentsConfig", () => {
  it("has defaults and caps", () => {
    expect(readYouTubeCommentsConfig({})).toEqual({ videos: 3, max_comments_per_video: 10 });
    expect(readYouTubeCommentsConfig({ videos: 50, max_comments_per_video: 500 })).toEqual({ videos: 10, max_comments_per_video: 50 });
    expect(readYouTubeCommentsConfig({ videos: 0 })).toEqual({ videos: 0, max_comments_per_video: 10 });
  });
});

describe("youtubeCommentsConnector", () => {
  const previousKey = process.env.YOUTUBE_API_KEY;
  beforeEach(() => {
    resetUploadsCache();
    process.env.YOUTUBE_API_KEY = "test-key";
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previousKey;
  });

  // Extras come first: fakeFetchRoutes takes the first matching route, so an override must precede the defaults.
  const feed = (extra: Array<{ match: string | RegExp; body: unknown }> = []) =>
    fakeFetchRoutes([
      ...extra,
      { match: "/channels?", body: youtubeChannelsResponse({}) },
      { match: "/playlistItems?", body: youtubePlaylistItemsResponse([{ id: "a", title: "Video A" }, { id: "b", title: "Video B" }]) },
      {
        match: /commentThreads\?.*videoId=a/,
        body: youtubeCommentThreadsResponse("a", [
          { id: "a1", text: "Best video yet, incredible" },
          { id: "a2", text: "This is a record breaking win" },
          { id: "a3", text: "the cameramen carried this" },
        ]),
      },
      { match: /commentThreads\?.*videoId=b/, body: youtubeCommentThreadsResponse("b", [{ id: "b1", text: "a disaster, total flop and a scandal" }]) },
    ]);

  it("aggregates a video's sampled comments into ONE digest carrying the distribution and the sample size", async () => {
    const fetch = feed();
    const signals = await youtubeCommentsConnector.fetchForPerson(person, CHANNEL, context(fetch, { videos: 2, max_comments_per_video: 5 }));

    // One signal per video, never one per comment.
    expect(signals).toHaveLength(2);
    expect(signals[0].headline).toBe('Comments on MrBeast\'s "Video A" lean positive, 3 sampled.');
    expect(signals[1].headline).toBe('Comments on MrBeast\'s "Video B" lean negative, 1 sampled.');
    expect(signals[0].rawPayload).toMatchObject({ kind: "comment_digest", source: "youtube_comments", videoId: "a", videoTitle: "Video A", sampled: 3, lean: "positive" });
    // The comments survive as evidence in the payload, never as the headline.
    expect(signals[0].rawPayload.comments).toHaveLength(3);
    for (const signal of signals) expect(signal.headline).not.toContain("cameramen");
    expect(JSON.stringify(signals)).not.toContain("likeCount");

    const threads = fetch.calls.filter((url) => url.includes("/commentThreads?")).map((url) => new URL(url));
    expect(threads).toHaveLength(2);
    expect(threads[0].searchParams.get("order")).toBe("relevance");
    expect(threads[0].searchParams.get("textFormat")).toBe("plainText");
    expect(threads[0].searchParams.get("maxResults")).toBe("5");
  });

  it("stores one digest per video per poll, and nothing again when the same comments come back", async () => {
    const first = await youtubeCommentsConnector.fetchForPerson(person, CHANNEL, context(feed(), { videos: 2 }));
    resetUploadsCache();
    const again = await youtubeCommentsConnector.fetchForPerson(person, CHANNEL, context(feed(), { videos: 2 }));
    // The dedupe key fingerprints the sampled comment ids, so an unchanged sample is the same key and the store skips it.
    expect(again.map((s) => s.dedupeKey)).toEqual(first.map((s) => s.dedupeKey));

    resetUploadsCache();
    const moved = await youtubeCommentsConnector.fetchForPerson(
      person,
      CHANNEL,
      context(feed([{ match: /commentThreads\?.*videoId=a/, body: youtubeCommentThreadsResponse("a", [{ id: "a1", text: "Best video yet, incredible" }, { id: "a9", text: "brand new comment" }]) }]), { videos: 2 }),
    );
    expect(moved[0].dedupeKey).not.toBe(first[0].dedupeKey);
  });

  it("reads comment volume as the real total across the newest uploads, not the sample", async () => {
    // 3 comments were sampled from video A; the metric reads 40,000 + 2,500 from videos.list.
    const fetch = feed([{ match: "/videos?", body: youtubeVideoStatisticsResponse({ a: { commentCount: "40000" }, b: { commentCount: "2500" } }) }]);
    const readings = await youtubeCommentsConnector.fetchMetrics!(person, CHANNEL, context(fetch, { videos: 2 }));
    expect(readings).toEqual([{ metricKey: "comment_volume", value: 42_500 }]);
  });

  it("reads the channel once for both the digests and the metric within a run", async () => {
    const fetch = feed([{ match: "/videos?", body: youtubeVideoStatisticsResponse({ a: { commentCount: "10" }, b: { commentCount: "20" } }) }]);
    const shared = context(fetch, { videos: 2 });
    await youtubeCommentsConnector.fetchForPerson(person, CHANNEL, shared);
    await youtubeCommentsConnector.fetchMetrics!(person, CHANNEL, shared);
    expect(fetch.calls.filter((url) => url.includes("/channels?"))).toHaveLength(1);
    expect(fetch.calls.filter((url) => url.includes("/playlistItems?"))).toHaveLength(1);
  });

  it("reads nothing when switched off, and is unavailable without the key", async () => {
    const fetch = fakeFetchRoutes([]);
    expect(await youtubeCommentsConnector.fetchForPerson(person, CHANNEL, context(fetch, { videos: 0 }))).toEqual([]);
    expect(await youtubeCommentsConnector.fetchMetrics!(person, CHANNEL, context(fetch, { videos: 0 }))).toEqual([]);
    expect(fetch.calls).toEqual([]);
    delete process.env.YOUTUBE_API_KEY;
    expect(youtubeCommentsConnector.available!()).toEqual({ ok: false, reason: "YOUTUBE_API_KEY is not set" });
  });
});
