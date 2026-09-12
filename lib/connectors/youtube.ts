import { getYouTubeApiKeyOrNull } from "@/lib/env";
import type { Json } from "@/types/database";

import { ConnectorError, type ConnectorAvailability, type DataConnector, type MetricReading } from "./types";

/**
 * YouTube connector — metrics from the YouTube Data API v3.
 *
 * external_identifier is the channel ID (e.g. UCX6OQ3DkcsbYNE6H8uQQuVA for
 * MrBeast). The API key comes from the server-side YOUTUBE_API_KEY; when it
 * is unset the connector reports itself unavailable and the runner treats
 * the source as inactive. This module is only ever imported by the ingestion
 * runner (server code); nothing under components/ may import it.
 *
 * What it reads, as raw levels the runner snapshots and normalises:
 *   subscriber_count     channels.list statistics (omitted when hidden)
 *   view_count           channels.list statistics
 *   video_count          channels.list statistics; the upload cadence is
 *                        derived from it by the runner (config.derived)
 *   recent_video_views   the summed view count of the newest uploads
 *                        (playlistItems.list on the uploads playlist, then
 *                        videos.list), so the catalogue's recent pull is a
 *                        series of its own
 *   commentary_volume_24h
 *                        how many videos OTHER channels published in the
 *                        trailing window that match the person's name
 *                        (search.list, the person's own channel excluded):
 *                        how much the ecosystem is talking about them,
 *                        distinct from their own upload cadence. Metadata
 *                        only: the count is read, nothing about the videos
 *                        is stored, no transcript is fetched and no
 *                        sentiment pass runs over third-party videos. It is
 *                        a metric, so only the metric scorer ever sees it.
 *                        search.list costs 100 quota units per page and
 *                        returns at most 50 results per page, so the level
 *                        saturates at commentary.max_results; the
 *                        registration sets both.
 *
 * What each level means (polarity, baseline window, minimum sample, scale)
 * is declared on the data_sources row, not here. Comments are a separate
 * source (youtube_comments) because they are events with real text.
 */

export const YOUTUBE_SOURCE_NAME = "youtube";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/** Per-source options, read from data_sources.config (all optional). */
export interface YouTubeConnectorConfig {
  /** How many of the newest uploads make up recent_video_views. Default 10, at most 50. */
  recent_videos: number;
  /** The commentary-volume read; `commentary: false` turns it off. */
  commentary: {
    enabled: boolean;
    /** Trailing window the count covers, in hours. Default 24. */
    window_hours: number;
    /** Ceiling on the count: 50 per search page, 100 quota units per page. Default 50 (one page), at most 200. */
    max_results: number;
  };
}

const DEFAULT_CONFIG: YouTubeConnectorConfig = { recent_videos: 10, commentary: { enabled: true, window_hours: 24, max_results: 50 } };
const SEARCH_PAGE_SIZE = 50;

export function readYouTubeConfig(config: Record<string, Json | undefined>): YouTubeConnectorConfig {
  const recent = config.recent_videos;
  const commentary = config.commentary;
  const commentaryConfig = { ...DEFAULT_CONFIG.commentary };
  if (commentary === false) {
    commentaryConfig.enabled = false;
  } else if (commentary !== null && typeof commentary === "object" && !Array.isArray(commentary)) {
    if (commentary.enabled === false) commentaryConfig.enabled = false;
    if (typeof commentary.window_hours === "number" && commentary.window_hours > 0) commentaryConfig.window_hours = commentary.window_hours;
    if (typeof commentary.max_results === "number" && Number.isInteger(commentary.max_results) && commentary.max_results > 0) {
      commentaryConfig.max_results = Math.min(200, commentary.max_results);
    }
  }
  return {
    recent_videos: typeof recent === "number" && Number.isInteger(recent) && recent >= 0 ? Math.min(50, recent) : DEFAULT_CONFIG.recent_videos,
    commentary: commentaryConfig,
  };
}

/** What we keep from one channels.list response. */
export interface YouTubeChannelStats {
  channelId: string;
  title: string | null;
  /** null when the channel hides its subscriber count. */
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  hiddenSubscriberCount: boolean;
  /** The channel's uploads playlist, for the recent-video reads. */
  uploadsPlaylistId: string | null;
}

export interface YouTubeUpload {
  videoId: string;
  title: string;
  publishedAt: string | null;
}

interface YouTubeErrorBody {
  error?: { code?: number; message?: string };
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One GET against the Data API. Never puts the key in an error message: the
 * key travels as a query parameter, so the URL is never quoted either.
 */
export async function youtubeGet<T>(path: string, params: Record<string, string>, apiKey: string, fetchImpl: typeof fetch): Promise<T> {
  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("key", apiKey);

  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    let detail: string | undefined;
    try {
      detail = ((await response.json()) as YouTubeErrorBody).error?.message;
    } catch {
      // non-JSON error body; the status code is enough
    }
    throw new ConnectorError(`YouTube API ${path} responded ${response.status}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  return (await response.json()) as T;
}

interface YouTubeChannelsResponse {
  items?: Array<{
    id: string;
    snippet?: { title?: string };
    statistics?: { viewCount?: string; subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}

/** channels.list for one channel ID. */
export async function fetchYouTubeChannelStats(channelId: string, apiKey: string, fetchImpl: typeof fetch): Promise<YouTubeChannelStats> {
  const body = await youtubeGet<YouTubeChannelsResponse>("channels", { part: "snippet,statistics,contentDetails", id: channelId }, apiKey, fetchImpl);
  const item = body.items?.[0];
  if (!item) throw new ConnectorError(`YouTube channel ${channelId} not found`, { status: 404 });

  const statistics = item.statistics ?? {};
  const hidden = Boolean(statistics.hiddenSubscriberCount);
  return {
    channelId: item.id,
    title: item.snippet?.title ?? null,
    subscriberCount: hidden ? null : parseCount(statistics.subscriberCount),
    viewCount: parseCount(statistics.viewCount),
    videoCount: parseCount(statistics.videoCount),
    hiddenSubscriberCount: hidden,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
  };
}

interface YouTubePlaylistItemsResponse {
  items?: Array<{ snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } } }>;
}

/** The newest uploads on a playlist, newest first. */
export async function fetchRecentUploads(playlistId: string, max: number, apiKey: string, fetchImpl: typeof fetch): Promise<YouTubeUpload[]> {
  if (max <= 0) return [];
  const body = await youtubeGet<YouTubePlaylistItemsResponse>("playlistItems", { part: "snippet", playlistId, maxResults: String(Math.min(50, max)) }, apiKey, fetchImpl);
  return (body.items ?? []).flatMap((item) => {
    const videoId = item.snippet?.resourceId?.videoId;
    return videoId ? [{ videoId, title: item.snippet?.title ?? videoId, publishedAt: item.snippet?.publishedAt ?? null }] : [];
  });
}

interface YouTubeVideosResponse {
  items?: Array<{ id: string; statistics?: { viewCount?: string } }>;
}

/** View counts for a set of video IDs (one call, up to 50). */
export async function fetchVideoViews(videoIds: string[], apiKey: string, fetchImpl: typeof fetch): Promise<Map<string, number>> {
  const views = new Map<string, number>();
  if (videoIds.length === 0) return views;
  const body = await youtubeGet<YouTubeVideosResponse>("videos", { part: "statistics", id: videoIds.slice(0, 50).join(",") }, apiKey, fetchImpl);
  for (const item of body.items ?? []) {
    const count = parseCount(item.statistics?.viewCount);
    if (count !== null) views.set(item.id, count);
  }
  return views;
}

interface YouTubeSearchResponse {
  nextPageToken?: string;
  items?: Array<{ id?: { videoId?: string }; snippet?: { channelId?: string } }>;
}

/**
 * Videos published since `publishedAfter` whose metadata matches the query,
 * excluding the person's own channel. Counts only: nothing about the videos
 * is kept. Reads at most `maxResults` results, a page of 50 at a time.
 */
export async function fetchCommentaryVolume(
  input: { query: string; excludeChannelId: string; publishedAfter: Date; maxResults: number },
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ count: number; saturated: boolean }> {
  let count = 0;
  let pageToken: string | undefined;
  let fetched = 0;
  while (fetched < input.maxResults) {
    const pageSize = Math.min(SEARCH_PAGE_SIZE, input.maxResults - fetched);
    const params: Record<string, string> = {
      part: "snippet",
      type: "video",
      order: "date",
      q: input.query,
      publishedAfter: input.publishedAfter.toISOString().replace(/\.\d{3}Z$/, "Z"),
      maxResults: String(pageSize),
    };
    if (pageToken) params.pageToken = pageToken;
    const body = await youtubeGet<YouTubeSearchResponse>("search", params, apiKey, fetchImpl);
    const items = body.items ?? [];
    fetched += items.length;
    count += items.filter((item) => item.snippet?.channelId !== input.excludeChannelId).length;
    if (!body.nextPageToken || items.length < pageSize) return { count, saturated: false };
    pageToken = body.nextPageToken;
  }
  return { count, saturated: true };
}

function availability(): ConnectorAvailability {
  return getYouTubeApiKeyOrNull() ? { ok: true } : { ok: false, reason: "YOUTUBE_API_KEY is not set" };
}

export const youtubeConnector: DataConnector = {
  name: YOUTUBE_SOURCE_NAME,

  available: availability,

  /** Metrics only: the channel's events (comments) are the youtube_comments source. */
  async fetchForPerson() {
    return [];
  },

  async fetchMetrics(person, channelId, context) {
    if (typeof window !== "undefined") {
      throw new Error("The YouTube connector is server-only.");
    }
    const apiKey = getYouTubeApiKeyOrNull();
    if (!apiKey) throw new ConnectorError("YOUTUBE_API_KEY is not set");
    const identifier = channelId.trim();
    if (!identifier) throw new ConnectorError(`No YouTube channel ID configured for ${person.slug}`);

    const config = readYouTubeConfig(context.config);
    const channel = await fetchYouTubeChannelStats(identifier, apiKey, context.fetch);

    const readings: MetricReading[] = [];
    if (channel.subscriberCount !== null) readings.push({ metricKey: "subscriber_count", value: channel.subscriberCount });
    if (channel.viewCount !== null) readings.push({ metricKey: "view_count", value: channel.viewCount });
    if (channel.videoCount !== null) readings.push({ metricKey: "video_count", value: channel.videoCount });

    if (channel.uploadsPlaylistId && config.recent_videos > 0) {
      const uploads = await fetchRecentUploads(channel.uploadsPlaylistId, config.recent_videos, apiKey, context.fetch);
      if (uploads.length > 0) {
        const views = await fetchVideoViews(uploads.map((u) => u.videoId), apiKey, context.fetch);
        if (views.size > 0) {
          readings.push({ metricKey: "recent_video_views", value: [...views.values()].reduce((sum, v) => sum + v, 0) });
        }
      }
    }

    if (config.commentary.enabled) {
      const { count } = await fetchCommentaryVolume(
        {
          query: `"${person.display_name}"`,
          excludeChannelId: channel.channelId,
          publishedAfter: new Date(context.now.getTime() - config.commentary.window_hours * 3_600_000),
          maxResults: config.commentary.max_results,
        },
        apiKey,
        context.fetch,
      );
      readings.push({ metricKey: "commentary_volume_24h", value: count });
    }

    return readings;
  },
};
