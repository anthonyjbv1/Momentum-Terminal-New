import type { DataSource, Person } from "@/types";

/** Shared fixtures for connector and runner tests. */

export function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "mrbeast",
    display_name: "MrBeast",
    full_name: "James Stephen Donaldson",
    bio: null,
    avatar_url: null,
    category: "creator",
    current_score: 50,
    base_score: 50,
    revert_target: 68,
    max_allocation_cents: 9000000,
    spread: 0.5,
    partnership_status: "unverified",
    consent_tier: 0,
    is_active: true,
    created_at: "2026-09-05T00:00:00.000Z",
    last_tick_at: null,
    buy_price: 50.5,
    sell_price: 49.5,
    ...overrides,
  };
}

export function makeSource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "youtube",
    display_name: "YouTube",
    tier: 2,
    poll_interval_minutes: 60,
    is_active: true,
    config: null,
    created_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

export function youtubeChannelsResponse(stats: {
  subscriberCount?: string;
  viewCount?: string;
  videoCount?: string;
  hiddenSubscriberCount?: boolean;
  uploads?: string | null;
}) {
  const { uploads = "UUX6OQ3DkcsbYNE6H8uQQuVA", ...statistics } = stats;
  return {
    kind: "youtube#channelListResponse",
    items: [
      {
        kind: "youtube#channel",
        id: "UCX6OQ3DkcsbYNE6H8uQQuVA",
        snippet: { title: "MrBeast", customUrl: "@mrbeast" },
        statistics: {
          viewCount: "90000000000",
          subscriberCount: "516000000",
          hiddenSubscriberCount: false,
          videoCount: "900",
          ...statistics,
        },
        contentDetails: uploads === null ? {} : { relatedPlaylists: { uploads } },
      },
    ],
  };
}

export function youtubePlaylistItemsResponse(videos: Array<{ id: string; title: string; publishedAt?: string }>) {
  return {
    kind: "youtube#playlistItemListResponse",
    items: videos.map((video) => ({
      kind: "youtube#playlistItem",
      snippet: { title: video.title, publishedAt: video.publishedAt ?? "2026-09-10T15:00:00Z", resourceId: { kind: "youtube#video", videoId: video.id } },
    })),
  };
}

export function youtubeVideosResponse(views: Record<string, string>) {
  return {
    kind: "youtube#videoListResponse",
    items: Object.entries(views).map(([id, viewCount]) => ({ kind: "youtube#video", id, statistics: { viewCount } })),
  };
}

export function youtubeCommentThreadsResponse(videoId: string, comments: Array<{ id: string; text: string; publishedAt?: string }>) {
  return {
    kind: "youtube#commentThreadListResponse",
    items: comments.map((comment) => ({
      kind: "youtube#commentThread",
      id: comment.id,
      snippet: {
        videoId,
        topLevelComment: { id: comment.id, snippet: { textOriginal: comment.text, textDisplay: comment.text, publishedAt: comment.publishedAt ?? "2026-09-11T09:00:00Z", likeCount: 12 } },
      },
    })),
  };
}

/** A fetch stub that returns the given JSON body (or a failure) and records calls. */
export function fakeFetch(body: unknown, init: { status?: number } = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return Object.assign(impl, { calls });
}

export interface FakeRoute {
  /** Substring or pattern of the URL. First match wins. */
  match: string | RegExp;
  /** A string is returned as text (XML); anything else as JSON. A function sees the URL. */
  body: unknown | ((url: string) => unknown);
  status?: number;
  contentType?: string;
}

/** A fetch stub that answers by URL, for connectors that make more than one call. Unmatched URLs get a 404. */
export function fakeFetchRoutes(routes: FakeRoute[]) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = routes.find((r) => (typeof r.match === "string" ? url.includes(r.match) : r.match.test(url)));
    if (!route) return new Response(JSON.stringify({ error: { message: `no fake route for ${url}` } }), { status: 404, headers: { "content-type": "application/json" } });
    const body = typeof route.body === "function" ? (route.body as (url: string) => unknown)(url) : route.body;
    const isText = typeof body === "string";
    return new Response(isText ? body : JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? (isText ? "application/xml" : "application/json") },
    });
  };
  return Object.assign(impl, { calls });
}
