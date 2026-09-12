import { getYouTubeApiKeyOrNull } from "@/lib/env";
import type { Json } from "@/types/database";

import { ConnectorError, type DataConnector, type RawSignal } from "./types";
import { fetchRecentUploads, fetchYouTubeChannelStats, youtubeGet } from "./youtube";

/**
 * YouTube comments connector — EVENTS with real text, from the Data API v3.
 *
 * Its own source (youtube_comments) rather than part of youtube, because it
 * is a different kind of evidence with a different tier: viewer comments are
 * unofficial, noisy text, weighed low; channel statistics are an official
 * count, weighed higher. Same channel ID as external_identifier, same key.
 *
 * Per poll: the channel's newest `videos` uploads, then the top
 * `max_comments_per_video` comment threads of each (commentThreads.list,
 * order=relevance, plain text). One signal per comment, deduplicated by
 * comment id, so a re-poll only stores what is new. Like counts and reply
 * counts are deliberately not read: a comment is a sentence, not a number.
 */

export const YOUTUBE_COMMENTS_SOURCE_NAME = "youtube_comments";

export interface YouTubeCommentsConfig {
  /** Newest uploads to read comments from. Default 3, at most 10. */
  videos: number;
  /** Comment threads per video. Default 10, at most 50. */
  max_comments_per_video: number;
}

const DEFAULT_CONFIG: YouTubeCommentsConfig = { videos: 3, max_comments_per_video: 10 };
const MAX_HEADLINE_TEXT = 160;

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

/** Collapses whitespace and trims a comment for a one-line headline. */
export function excerpt(text: string, max = MAX_HEADLINE_TEXT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export function commentSignal(input: { personName: string; videoId: string; videoTitle: string; commentId: string; text: string; publishedAt: string | null; now: Date }): RawSignal | null {
  const text = excerpt(input.text);
  if (!text) return null;
  const publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  return {
    headline: `A viewer on ${input.personName}'s "${excerpt(input.videoTitle, 80)}" writes: "${text}"`,
    occurredAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : input.now,
    dedupeKey: `youtube_comment:${input.commentId}`,
    rawPayload: {
      kind: "comment",
      source: YOUTUBE_COMMENTS_SOURCE_NAME,
      videoId: input.videoId,
      videoTitle: input.videoTitle,
      commentId: input.commentId,
      publishedAt: input.publishedAt,
      text,
    },
  };
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

    const channel = await fetchYouTubeChannelStats(identifier, apiKey, context.fetch);
    if (!channel.uploadsPlaylistId) return [];
    const uploads = await fetchRecentUploads(channel.uploadsPlaylistId, config.videos, apiKey, context.fetch);

    const signals: RawSignal[] = [];
    for (const upload of uploads) {
      const body = await youtubeGet<CommentThreadsResponse>(
        "commentThreads",
        { part: "snippet", videoId: upload.videoId, order: "relevance", textFormat: "plainText", maxResults: String(config.max_comments_per_video) },
        apiKey,
        context.fetch,
      );
      for (const thread of body.items ?? []) {
        const top = thread.snippet?.topLevelComment;
        const text = top?.snippet?.textOriginal ?? top?.snippet?.textDisplay ?? "";
        const signal = commentSignal({
          personName: person.display_name,
          videoId: upload.videoId,
          videoTitle: upload.title,
          commentId: top?.id ?? thread.id,
          text,
          publishedAt: top?.snippet?.publishedAt ?? null,
          now: context.now,
        });
        if (signal) signals.push(signal);
      }
    }
    return signals;
  },
};
