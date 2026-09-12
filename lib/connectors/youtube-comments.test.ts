import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeFetchRoutes, makePerson, makeSource, youtubeChannelsResponse, youtubeCommentThreadsResponse, youtubePlaylistItemsResponse } from "@/lib/__tests__/fixtures";

import { commentSignal, excerpt, readYouTubeCommentsConfig, youtubeCommentsConnector } from "./youtube-comments";

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

describe("readYouTubeCommentsConfig and excerpt", () => {
  it("has defaults and caps", () => {
    expect(readYouTubeCommentsConfig({})).toEqual({ videos: 3, max_comments_per_video: 10 });
    expect(readYouTubeCommentsConfig({ videos: 50, max_comments_per_video: 500 })).toEqual({ videos: 10, max_comments_per_video: 50 });
    expect(readYouTubeCommentsConfig({ videos: 0 })).toEqual({ videos: 0, max_comments_per_video: 10 });
  });

  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(excerpt("  so   good\n\nlove it ")).toBe("so good love it");
    const long = "word ".repeat(60).trim();
    expect(excerpt(long).length).toBe(160);
    expect(excerpt(long).endsWith("…")).toBe(true);
  });
});

describe("commentSignal", () => {
  it("is an event with the comment's real text, dated by the comment, and no counts", () => {
    const signal = commentSignal({ personName: "MrBeast", videoId: "v1", videoTitle: "I Built 100 Houses", commentId: "c1", text: "This changed my life", publishedAt: "2026-09-06T10:00:00Z", now: NOW })!;
    expect(signal.headline).toBe('A viewer on MrBeast\'s "I Built 100 Houses" writes: "This changed my life"');
    expect(signal.dedupeKey).toBe("youtube_comment:c1");
    expect(signal.occurredAt).toEqual(new Date("2026-09-06T10:00:00Z"));
    expect(signal.rawPayload).toEqual({ kind: "comment", source: "youtube_comments", videoId: "v1", videoTitle: "I Built 100 Houses", commentId: "c1", publishedAt: "2026-09-06T10:00:00Z", text: "This changed my life" });
    expect(commentSignal({ personName: "MrBeast", videoId: "v1", videoTitle: "t", commentId: "c2", text: "   ", publishedAt: null, now: NOW })).toBeNull();
    expect(commentSignal({ personName: "MrBeast", videoId: "v1", videoTitle: "t", commentId: "c3", text: "x", publishedAt: "not a date", now: NOW })!.occurredAt).toBe(NOW);
  });
});

describe("youtubeCommentsConnector", () => {
  const previousKey = process.env.YOUTUBE_API_KEY;
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "test-key";
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previousKey;
  });

  it("reads the top comments of the newest uploads as events, one signal per comment", async () => {
    const fetch = fakeFetchRoutes([
      { match: "/channels?", body: youtubeChannelsResponse({}) },
      { match: "/playlistItems?", body: youtubePlaylistItemsResponse([{ id: "a", title: "Video A" }, { id: "b", title: "Video B" }]) },
      { match: /commentThreads\?.*videoId=a/, body: youtubeCommentThreadsResponse("a", [{ id: "a1", text: "First!" }, { id: "a2", text: "Best video yet" }]) },
      { match: /commentThreads\?.*videoId=b/, body: youtubeCommentThreadsResponse("b", [{ id: "b1", text: "Meh" }]) },
    ]);
    const signals = await youtubeCommentsConnector.fetchForPerson(person, CHANNEL, context(fetch, { videos: 2, max_comments_per_video: 5 }));
    expect(signals.map((s) => s.dedupeKey)).toEqual(["youtube_comment:a1", "youtube_comment:a2", "youtube_comment:b1"]);
    expect(signals[0].headline).toBe('A viewer on MrBeast\'s "Video A" writes: "First!"');
    expect(JSON.stringify(signals)).not.toContain("likeCount");
    const threads = fetch.calls.filter((url) => url.includes("/commentThreads?")).map((url) => new URL(url));
    expect(threads).toHaveLength(2);
    expect(threads[0].searchParams.get("order")).toBe("relevance");
    expect(threads[0].searchParams.get("textFormat")).toBe("plainText");
    expect(threads[0].searchParams.get("maxResults")).toBe("5");
    expect(youtubeCommentsConnector.fetchMetrics).toBeUndefined();
  });

  it("reads nothing when switched off, and is unavailable without the key", async () => {
    const fetch = fakeFetchRoutes([]);
    expect(await youtubeCommentsConnector.fetchForPerson(person, CHANNEL, context(fetch, { videos: 0 }))).toEqual([]);
    expect(fetch.calls).toEqual([]);
    delete process.env.YOUTUBE_API_KEY;
    expect(youtubeCommentsConnector.available!()).toEqual({ ok: false, reason: "YOUTUBE_API_KEY is not set" });
  });
});
