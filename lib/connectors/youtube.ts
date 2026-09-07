import { getYouTubeApiKey } from "@/lib/env";
import { formatCompactNumber, formatInteger, formatSignedPercent, joinNaturally } from "@/lib/format";
import type { Person } from "@/types";
import type { Json } from "@/types/database";

import { ConnectorError, type DataConnector, type RawSignal, type SnapshotValue } from "./types";

/**
 * YouTube connector — the reference implementation of the connector pattern.
 *
 * Source of truth: YouTube Data API v3, `channels.list` with
 * part=snippet,statistics. external_identifier is the channel ID
 * (e.g. UCX6OQ3DkcsbYNE6H8uQQuVA for MrBeast).
 *
 * The API key comes from the server-side YOUTUBE_API_KEY env var. This module
 * is only ever imported by the ingestion runner (server code); nothing under
 * components/ or a Client Component may import it.
 *
 * Channel statistics are cumulative, so the SIGNAL is the change, not the
 * number. Every run records the fresh values as source_snapshots and compares
 * them with the newest previous snapshot:
 *   - first contact          -> one "baseline" signal describing the channel
 *   - subscriber / view count -> "crosses <milestone>" when a round-number
 *                                boundary is crossed, otherwise a "gains /
 *                                loses" signal when the relative change since
 *                                the last snapshot is large enough
 *   - video count            -> "uploads N new videos" when it increases
 */

export const YOUTUBE_SOURCE_NAME = "youtube";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export type YouTubeMetricKey = "subscriber_count" | "view_count" | "video_count";

/** Per-source options, read from data_sources.config (all optional). */
export interface YouTubeConnectorConfig {
  /** Emit a "gains/loses subscribers" signal when |Δ| / previous ≥ this. Default 0.005 (0.5%). */
  subscriber_min_relative_change: number;
  /** Emit an "adds views" signal when |Δ| / previous ≥ this. Default 0.01 (1%). */
  view_min_relative_change: number;
}

const DEFAULT_CONFIG: YouTubeConnectorConfig = {
  subscriber_min_relative_change: 0.005,
  view_min_relative_change: 0.01,
};

/** What we keep from one channels.list response. */
export interface YouTubeChannelStats {
  channelId: string;
  title: string | null;
  /** null when the channel hides its subscriber count. */
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  hiddenSubscriberCount: boolean;
  /** The raw `items[0]` object from the API. */
  raw: unknown;
}

interface YouTubeChannelsResponse {
  items?: Array<{
    id: string;
    snippet?: { title?: string; customUrl?: string };
    statistics?: {
      viewCount?: string;
      subscriberCount?: string;
      hiddenSubscriberCount?: boolean;
      videoCount?: string;
    };
  }>;
  error?: { code?: number; message?: string };
}

interface CumulativeMetricSpec {
  key: "subscriber_count" | "view_count";
  kind: "cumulative";
  /** Smallest milestone step, so small channels do not fire on every poll. */
  minStep: number;
  configKey: keyof YouTubeConnectorConfig;
}

interface CountMetricSpec {
  key: "video_count";
  kind: "count";
}

const METRICS: ReadonlyArray<CumulativeMetricSpec | CountMetricSpec> = [
  { key: "subscriber_count", kind: "cumulative", minStep: 1_000, configKey: "subscriber_min_relative_change" },
  { key: "view_count", kind: "cumulative", minStep: 100_000, configKey: "view_min_relative_change" },
  { key: "video_count", kind: "count" },
];

// ---------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------

function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Calls channels.list for one channel ID. Never puts the API key in an error message. */
export async function fetchYouTubeChannelStats(
  channelId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<YouTubeChannelStats> {
  const url = new URL(`${YOUTUBE_API_BASE}/channels`);
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", apiKey);

  const response = await fetchImpl(url, { headers: { accept: "application/json" } });

  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = (await response.json()) as YouTubeChannelsResponse;
      detail = body.error?.message;
    } catch {
      // non-JSON error body; the status code is enough
    }
    throw new ConnectorError(`YouTube API responded ${response.status}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  const body = (await response.json()) as YouTubeChannelsResponse;
  const item = body.items?.[0];
  if (!item) {
    throw new ConnectorError(`YouTube channel ${channelId} not found`, { status: 404 });
  }

  const statistics = item.statistics ?? {};
  const hidden = Boolean(statistics.hiddenSubscriberCount);

  return {
    channelId: item.id,
    title: item.snippet?.title ?? null,
    subscriberCount: hidden ? null : parseCount(statistics.subscriberCount),
    viewCount: parseCount(statistics.viewCount),
    videoCount: parseCount(statistics.videoCount),
    hiddenSubscriberCount: hidden,
    raw: item,
  };
}

// ---------------------------------------------------------------------------
// Delta detection (pure — unit tested without the network)
// ---------------------------------------------------------------------------

/**
 * Milestone granularity for a cumulative counter: one hundredth of the
 * value's order of magnitude, floored at minStep. 516M -> 1M steps,
 * 45M -> 100K steps, 2.3B -> 10M steps.
 */
export function milestoneStep(value: number, minStep: number): number {
  if (!Number.isFinite(value) || value < 10) return minStep;
  const magnitude = Math.floor(Math.log10(value));
  return Math.max(minStep, 10 ** (magnitude - 2));
}

export function readYouTubeConfig(config: Record<string, Json | undefined>): YouTubeConnectorConfig {
  const read = (key: keyof YouTubeConnectorConfig): number => {
    const value = config[key];
    return typeof value === "number" && value >= 0 ? value : DEFAULT_CONFIG[key];
  };
  return {
    subscriber_min_relative_change: read("subscriber_min_relative_change"),
    view_min_relative_change: read("view_min_relative_change"),
  };
}

export interface YouTubeDeltaInput {
  person: Pick<Person, "id" | "slug" | "display_name">;
  channel: YouTubeChannelStats;
  /** Newest previous snapshot per metric; null / missing on first contact. */
  previous: Partial<Record<YouTubeMetricKey, SnapshotValue | null>>;
  now: Date;
  config: YouTubeConnectorConfig;
}

function currentValues(channel: YouTubeChannelStats): Partial<Record<YouTubeMetricKey, number>> {
  const values: Partial<Record<YouTubeMetricKey, number>> = {};
  if (channel.subscriberCount !== null) values.subscriber_count = channel.subscriberCount;
  if (channel.viewCount !== null) values.view_count = channel.viewCount;
  if (channel.videoCount !== null) values.video_count = channel.videoCount;
  return values;
}

/** Turns fresh channel stats + previous snapshots into RawSignals. */
export function detectYouTubeSignals(input: YouTubeDeltaInput): RawSignal[] {
  const { person, channel, previous, now, config } = input;
  const name = person.display_name;
  const current = currentValues(channel);
  const metricKeys = Object.keys(current) as YouTubeMetricKey[];
  if (metricKeys.length === 0) return [];

  const basePayload = {
    source: YOUTUBE_SOURCE_NAME,
    channelId: channel.channelId,
    channelTitle: channel.title,
    hiddenSubscriberCount: channel.hiddenSubscriberCount,
    metrics: current,
    fetchedAt: now.toISOString(),
  };

  // First contact: nothing to diff against, so describe where the channel stands.
  const isFirstContact = metricKeys.every((key) => !previous[key]);
  if (isFirstContact) {
    const parts: string[] = [];
    if (current.subscriber_count !== undefined) parts.push(`${formatCompactNumber(current.subscriber_count)} subscribers`);
    if (current.view_count !== undefined) parts.push(`${formatCompactNumber(current.view_count)} total views`);
    if (current.video_count !== undefined) parts.push(`${formatInteger(current.video_count)} videos`);
    return [
      {
        headline: `${name} stands at ${joinNaturally(parts)} on YouTube`,
        occurredAt: now,
        dedupeKey: `youtube:${channel.channelId}:baseline`,
        rawPayload: { ...basePayload, kind: "baseline", statistics: channel.raw },
      },
    ];
  }

  const signals: RawSignal[] = [];

  for (const spec of METRICS) {
    const value = current[spec.key];
    const prior = previous[spec.key];
    if (value === undefined || !prior) continue; // metric newly visible: snapshot only, no signal yet

    const delta = value - prior.value;
    const relativeChange = prior.value === 0 ? 0 : delta / prior.value;
    const payload = {
      ...basePayload,
      metric: spec.key,
      previous: prior.value,
      previousRecordedAt: prior.recordedAt.toISOString(),
      current: value,
      delta,
      relativeChange,
    };

    if (spec.kind === "count") {
      if (delta > 0) {
        signals.push({
          headline: `${name} uploads ${delta === 1 ? "a new video" : `${delta} new videos`} on YouTube (${formatInteger(value)} total)`,
          occurredAt: now,
          dedupeKey: `youtube:${channel.channelId}:video_count:${value}`,
          rawPayload: { ...payload, kind: "upload" },
        });
      }
      continue;
    }

    const step = milestoneStep(Math.max(prior.value, value), spec.minStep);
    const previousBucket = Math.floor(prior.value / step);
    const currentBucket = Math.floor(value / step);
    const isSubscribers = spec.key === "subscriber_count";

    if (currentBucket > previousBucket) {
      const milestone = currentBucket * step;
      signals.push({
        headline: isSubscribers
          ? `${name} crosses ${formatCompactNumber(milestone)} subscribers on YouTube`
          : `${name}'s YouTube channel passes ${formatCompactNumber(milestone)} total views`,
        occurredAt: now,
        dedupeKey: `youtube:${channel.channelId}:${spec.key}:milestone:${milestone}`,
        rawPayload: { ...payload, kind: "milestone", milestone, milestoneStep: step },
      });
      continue;
    }

    if (currentBucket < previousBucket) {
      const floor = previousBucket * step;
      signals.push({
        headline: isSubscribers
          ? `${name} drops below ${formatCompactNumber(floor)} subscribers on YouTube`
          : `${name}'s YouTube channel falls below ${formatCompactNumber(floor)} total views`,
        occurredAt: now,
        dedupeKey: `youtube:${channel.channelId}:${spec.key}:below:${floor}:${value}`,
        rawPayload: { ...payload, kind: "milestone_lost", milestone: floor, milestoneStep: step },
      });
      continue;
    }

    if (Math.abs(relativeChange) >= config[spec.configKey] && delta !== 0) {
      const magnitude = formatCompactNumber(Math.abs(delta));
      const percent = formatSignedPercent(relativeChange);
      signals.push({
        headline: isSubscribers
          ? `${name} ${delta > 0 ? "gains" : "loses"} ${magnitude} YouTube subscribers (${percent}) since last check`
          : `${name}'s YouTube channel ${delta > 0 ? "adds" : "loses"} ${magnitude} views (${percent}) since last check`,
        occurredAt: now,
        dedupeKey: `youtube:${channel.channelId}:${spec.key}:delta:${prior.value}:${value}`,
        rawPayload: { ...payload, kind: "change" },
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

export const youtubeConnector: DataConnector = {
  name: YOUTUBE_SOURCE_NAME,

  async fetchForPerson(person, channelId, context) {
    if (typeof window !== "undefined") {
      throw new Error("The YouTube connector is server-only.");
    }
    const identifier = channelId.trim();
    if (!identifier) {
      throw new ConnectorError(`No YouTube channel ID configured for ${person.slug}`);
    }

    const channel = await fetchYouTubeChannelStats(identifier, getYouTubeApiKey(), context.fetch);
    const current = currentValues(channel);

    const previous: YouTubeDeltaInput["previous"] = {};
    for (const key of Object.keys(current) as YouTubeMetricKey[]) {
      previous[key] = await context.snapshots.latest(key);
      context.snapshots.record(key, current[key] as number, context.now);
    }

    return detectYouTubeSignals({
      person,
      channel,
      previous,
      now: context.now,
      config: readYouTubeConfig(context.config),
    });
  },
};
