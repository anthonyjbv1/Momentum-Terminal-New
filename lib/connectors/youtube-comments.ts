import { getYouTubeApiKeyOrNull } from "@/lib/env";
import { scoreHeadline } from "@/lib/engine/sentiment/rules";
import { commentDigestSignal, type CommentLexicon, type SampledComment } from "@/lib/ingest/comments";
import type { Json } from "@/types/database";

import { ConnectorError, type DataConnector, type MetricReading, type RawSignal } from "./types";
import { fetchRecentUploads, fetchVideoCommentCounts, fetchYouTubeChannelStats, youtubeGet } from "./youtube";

/**
 * YouTube comments connector — audience reaction, from the Data API v3.
 *
 * Its own source (youtube_comments) rather than part of youtube, because it
 * is a different kind of evidence with a different tier: viewer comments are
 * unofficial, noisy text, weighed low; channel statistics are an official
 * count, weighed higher. Same channel ID as external_identifier, same key.
 *
 * Two kinds of evidence from one poll, measuring different things:
 *
 *   events   ONE digest per video (lib/ingest/comments.ts): the newest
 *            `videos` uploads, the top `max_comments_per_video` comment
 *            threads of each, aggregated into a single signal carrying the
 *            distribution and the sample size. Never one signal per comment:
 *            a comment is one viewer's reaction to one video, and a force
 *            built from thousands of them measures editing, not momentum.
 *   metric   comment_volume, the REAL total comment count across those
 *            uploads (videos.list statistics, not the capped sample), a raw
 *            level. OBSERVE-ONLY since Phase 21 — recorded, and scoring
 *            nothing. See below.
 *
 * Like counts and reply counts are deliberately not read: a comment is a
 * sentence, not a number.
 *
 * WHY comment_volume DOES NOT SCORE (Phase 21). The figure is a sum over a
 * CHANGING BASKET: it totals the `videos` newest uploads, so when a new video
 * replaces the oldest of the three the total steps by the difference between
 * them and nothing about the audience has changed. MrBeast's stepped from
 * 179,354 to 88,049 on 2026-09-18 for exactly that reason, and every hourly
 * poll afterwards was judged against the mean of a basket that no longer
 * existed: it emitted on 78.2% of its observations, the highest rate on the
 * board, every one a negative reading of a person whose comment volume had
 * not fallen. Not thin data (104 samples against a declared minimum of 24)
 * and not a threshold problem: the level moves every poll, so emit-on-change
 * never fires, and the 2σ deadband only delays the emission while the old
 * basket ages out of the window.
 *
 * The fix is a BASKET-STABLE definition, and it belongs here rather than in
 * the source configuration: comments per video (each upload its own series
 * with its own baseline), or a fixed cohort of videos followed over time.
 * Either is a new metric with a new baseline to fill, so until it is written
 * the key stays in the source row's `config.observe_only` and the reading is
 * recorded and goes no further.
 */

export const YOUTUBE_COMMENTS_SOURCE_NAME = "youtube_comments";

export interface YouTubeCommentsConfig {
  /** Newest uploads to read comments from. Default 3, at most 10. */
  videos: number;
  /** Comment threads sampled per video. Default 10, at most 50. */
  max_comments_per_video: number;
}

const DEFAULT_CONFIG: YouTubeCommentsConfig = { videos: 3, max_comments_per_video: 10 };

/** The Engine's own keyword lexicon, counting each comment's direction. Never a variant of it. */
const COMMENT_LEXICON: CommentLexicon = (text) => scoreHeadline(text).direction;

export function readYouTubeCommentsConfig(config: Record<string, Json | undefined>): YouTubeCommentsConfig {
  const integer = (value: Json | undefined, fallback: number, max: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(max, value) : fallback;
  return {
    videos: integer(config.videos, DEFAULT_CONFIG.videos, 10),
    max_comments_per_video: integer(config.max_comments_per_video, DEFAULT_CONFIG.max_comments_per_video, 50),
  };
}

interface CommentThreadsResponse {
  items?: Array<{
    id: string;
    snippet?: {
      videoId?: string;
      topLevelComment?: { id?: string; snippet?: { textDisplay?: string; textOriginal?: string; publishedAt?: string; authorDisplayName?: string } };
    };
  }>;
}

// One upload lookup serves both fetchForPerson and fetchMetrics within a run,
// so the digests and the volume metric cost one channel call between them.
const UPLOADS_CACHE_TTL_MS = 10 * 60_000;
const uploadsCache = new Map<string, { at: number; uploads: Awaited<ReturnType<typeof fetchRecentUploads>> }>();

/** For tests. */
export function resetUploadsCache(): void {
  uploadsCache.clear();
}

/** The newest uploads of a channel, or an empty list when it has none. */
async function recentUploads(channelId: string, count: number, apiKey: string, context: { fetch: typeof fetch; now: Date }) {
  const key = `${channelId}|${count}|${context.now.toISOString()}`;
  const cached = uploadsCache.get(key);
  if (cached && Date.now() - cached.at < UPLOADS_CACHE_TTL_MS) return cached.uploads;
  for (const [k, entry] of uploadsCache) if (Date.now() - entry.at >= UPLOADS_CACHE_TTL_MS) uploadsCache.delete(k);

  const channel = await fetchYouTubeChannelStats(channelId, apiKey, context.fetch);
  const uploads = channel.uploadsPlaylistId ? await fetchRecentUploads(channel.uploadsPlaylistId, count, apiKey, context.fetch) : [];
  uploadsCache.set(key, { at: Date.now(), uploads });
  return uploads;
}

/** The sampled top-level comments of one video. */
export async function fetchVideoComments(videoId: string, max: number, apiKey: string, fetchImpl: typeof fetch): Promise<SampledComment[]> {
  const body = await youtubeGet<CommentThreadsResponse>(
    "commentThreads",
    { part: "snippet", videoId, order: "relevance", textFormat: "plainText", maxResults: String(max) },
    apiKey,
    fetchImpl,
  );
  const comments: SampledComment[] = [];
  for (const thread of body.items ?? []) {
    const top = thread.snippet?.topLevelComment;
    const text = top?.snippet?.textOriginal ?? top?.snippet?.textDisplay ?? "";
    if (!text.trim()) continue;
    comments.push({ id: top?.id ?? thread.id, text, publishedAt: top?.snippet?.publishedAt ?? null });
  }
  return comments;
}

export const youtubeCommentsConnector: DataConnector = {
  name: YOUTUBE_COMMENTS_SOURCE_NAME,

  available() {
    return getYouTubeApiKeyOrNull() ? { ok: true } : { ok: false, reason: "YOUTUBE_API_KEY is not set" };
  },

  async fetchForPerson(person, channelId, context) {
    if (typeof window !== "undefined") {
      throw new Error("The YouTube comments connector is server-only.");
    }
    const apiKey = getYouTubeApiKeyOrNull();
    if (!apiKey) throw new ConnectorError("YOUTUBE_API_KEY is not set");
    const identifier = channelId.trim();
    if (!identifier) throw new ConnectorError(`No YouTube channel ID configured for ${person.slug}`);

    const config = readYouTubeCommentsConfig(context.config);
    if (config.videos === 0 || config.max_comments_per_video === 0) return [];

    const uploads = await recentUploads(identifier, config.videos, apiKey, context);
    const signals: RawSignal[] = [];
    for (const upload of uploads) {
      const comments = await fetchVideoComments(upload.videoId, config.max_comments_per_video, apiKey, context.fetch);
      const signal = commentDigestSignal({
        sourceName: YOUTUBE_COMMENTS_SOURCE_NAME,
        personName: person.display_name,
        videoId: upload.videoId,
        videoTitle: upload.title,
        comments,
        lexicon: COMMENT_LEXICON,
        now: context.now,
      });
      if (signal) signals.push(signal);
    }
    return signals;
  },

  async fetchMetrics(person, channelId, context): Promise<MetricReading[]> {
    const apiKey = getYouTubeApiKeyOrNull();
    if (!apiKey) throw new ConnectorError("YOUTUBE_API_KEY is not set");
    const identifier = channelId.trim();
    if (!identifier) throw new ConnectorError(`No YouTube channel ID configured for ${person.slug}`);

    const config = readYouTubeCommentsConfig(context.config);
    if (config.videos === 0) return [];

    const uploads = await recentUploads(identifier, config.videos, apiKey, context);
    if (uploads.length === 0) return [];
    const counts = await fetchVideoCommentCounts(
      uploads.map((upload) => upload.videoId),
      apiKey,
      context.fetch,
    );
    if (counts.size === 0) return [];
    let total = 0;
    for (const count of counts.values()) total += count;
    return [{ metricKey: "comment_volume", value: total }];
  },
};
