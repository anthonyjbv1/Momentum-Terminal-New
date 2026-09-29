import type { Json } from "@/types/database";

/**
 * PROFILE IMAGES FOR TRACKED PEOPLE (2026-09-29). Display only.
 *
 * A creator or musician with a mapped YouTube or Twitch channel shows that
 * channel's official avatar, read from the platform's API and credited on
 * the profile. Everyone else keeps their initials. No other image source:
 * nothing is scraped, nothing is copied from an article, no search result
 * is used. The picture itself is never stored here: the platform's own URL
 * is kept (`people.avatar_url`) with where it came from and when it was
 * read (the mapping's `config.avatar`), and refreshed on the platform's
 * terms. It is never shown on a marketing surface (the landing page, the
 * Open Graph image), which render no avatars at all.
 *
 * REFRESH. YouTube's API Services Terms allow cached API data for up to 30
 * days before it must be refreshed or discarded; Twitch's developer terms
 * are read conservatively at 24 hours. A record older than its platform's
 * window is read again on the next ingestion cron; while a read fails, the
 * last record stands (and the card falls back to initials if the image
 * itself no longer loads).
 */

export type AvatarSource = "youtube" | "twitch";

/** What is kept about an avatar, on the person's platform mapping. Never the image. */
export interface AvatarRecord {
  url: string;
  source: AvatarSource;
  /** The channel's display name, for the credit. */
  channel: string;
  /** The channel's handle or login, for the credit's link. */
  handle: string | null;
  refreshedAt: string;
}

/** How old a record may be, per platform, before it is read again. */
export const AVATAR_REFRESH_HOURS: Readonly<Record<AvatarSource, number>> = { youtube: 30 * 24, twitch: 24 };

/** The categories whose channels are their own: creators and musicians. */
export const AVATAR_CATEGORIES: ReadonlySet<string> = new Set(["creator", "musician"]);

/** The image hosts the platforms serve avatars from; a URL elsewhere is not an avatar. */
const AVATAR_HOSTS: Readonly<Record<AvatarSource, RegExp>> = {
  youtube: /^https:\/\/(yt3\.ggpht\.com|yt3\.googleusercontent\.com|[a-z0-9-]+\.googleusercontent\.com)\//i,
  twitch: /^https:\/\/static-cdn\.jtvnw\.net\//i,
};

export function isAvatarUrl(url: string, source: AvatarSource): boolean {
  return AVATAR_HOSTS[source].test(url);
}

// ---------------------------------------------------------------------------
// Which channel
// ---------------------------------------------------------------------------

export interface AvatarMapping {
  /** The data source's name: youtube, twitch, youtube_trending, youtube_comments. */
  source: string;
  externalIdentifier: string;
  config: Record<string, Json | undefined> | null;
}

export interface AvatarChannel {
  source: AvatarSource;
  /** A YouTube channel id, or a Twitch login / user id. */
  identifier: string;
  /** The mapping the record is kept on. */
  mappingSource: string;
}

/**
 * The channel a person's avatar comes from: their YouTube channel mapping
 * first (the channel id), else their Twitch mapping (the login), else the
 * first channel pinned on their YouTube Trending mapping. Null for anyone
 * outside the creator and musician categories, and for anyone with no
 * channel of their own.
 */
export function avatarChannelFor(person: { category: string }, mappings: readonly AvatarMapping[]): AvatarChannel | null {
  if (!AVATAR_CATEGORIES.has(person.category)) return null;
  const youtube = mappings.find((mapping) => mapping.source === "youtube" && mapping.externalIdentifier.trim());
  if (youtube) return { source: "youtube", identifier: youtube.externalIdentifier.trim(), mappingSource: "youtube" };
  const twitch = mappings.find((mapping) => mapping.source === "twitch" && mapping.externalIdentifier.trim());
  if (twitch) return { source: "twitch", identifier: twitch.externalIdentifier.trim(), mappingSource: "twitch" };
  const trending = mappings.find((mapping) => mapping.source === "youtube_trending");
  const pinned = trending?.config?.channel_ids;
  if (Array.isArray(pinned)) {
    const first = pinned.find((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (first) return { source: "youtube", identifier: first.trim(), mappingSource: "youtube_trending" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Reads the record off a mapping's config; null when absent or malformed. */
export function readAvatarRecord(config: Record<string, Json | undefined> | null | undefined): AvatarRecord | null {
  const block = config?.avatar;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const record = block as Record<string, Json | undefined>;
  const source = record.source === "youtube" || record.source === "twitch" ? record.source : null;
  const url = text(record.url, 2048);
  const channel = text(record.channel, 200);
  const refreshedAt = text(record.refreshed_at, 40);
  if (!source || !url || !channel || !refreshedAt || !Number.isFinite(Date.parse(refreshedAt)) || !isAvatarUrl(url, source)) return null;
  return { url, source, channel, handle: text(record.handle, 120), refreshedAt };
}

/** The record as it is written to the mapping's config. */
export function avatarRecordJson(record: AvatarRecord): Record<string, Json> {
  return { url: record.url, source: record.source, channel: record.channel, handle: record.handle, refreshed_at: record.refreshedAt };
}

/** Whether a record is older than its platform's window (or absent, or from another platform than the channel now mapped). */
export function isAvatarStale(record: AvatarRecord | null, channel: AvatarChannel, now: number): boolean {
  if (!record || record.source !== channel.source) return true;
  return now - Date.parse(record.refreshedAt) > AVATAR_REFRESH_HOURS[channel.source] * 3_600_000;
}

// ---------------------------------------------------------------------------
// What the platforms answer
// ---------------------------------------------------------------------------

/** The public fields of a YouTube channels.list item this reads: the title, the handle and the thumbnails. */
export interface YouTubeChannelSnippet {
  id?: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: Partial<Record<"default" | "medium" | "high", { url?: string }>> };
}

/** The largest thumbnail YouTube lists for the channel, with its title and handle. Null without a usable thumbnail. */
export function youtubeAvatarFrom(item: YouTubeChannelSnippet | undefined, now: Date): AvatarRecord | null {
  const thumbnails = item?.snippet?.thumbnails;
  const url = thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null;
  const channel = text(item?.snippet?.title, 200);
  if (!url || !channel || !isAvatarUrl(url, "youtube")) return null;
  const handle = text(item?.snippet?.customUrl, 120);
  return { url, source: "youtube", channel, handle: handle ? handle.replace(/^@?/, "@") : null, refreshedAt: now.toISOString() };
}

/** A Twitch user's profile image, display name and login. Null without a usable image. */
export function twitchAvatarFrom(user: { login?: string; display_name?: string; profile_image_url?: string } | undefined, now: Date): AvatarRecord | null {
  const url = text(user?.profile_image_url, 2048);
  const channel = text(user?.display_name, 200) ?? text(user?.login, 120);
  if (!url || !channel || !isAvatarUrl(url, "twitch")) return null;
  return { url, source: "twitch", channel, handle: text(user?.login, 120), refreshedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// The credit
// ---------------------------------------------------------------------------

export interface AvatarCredit {
  platform: "YouTube" | "Twitch";
  channel: string;
  /** The channel's page on the platform. */
  url: string;
}

/** "Photo: YouTube · MrBeast", linked to the channel. */
export function avatarCredit(record: AvatarRecord | null): AvatarCredit | null {
  if (!record) return null;
  if (record.source === "youtube") {
    const url = record.handle ? `https://www.youtube.com/${encodeURIComponent(record.handle)}` : "https://www.youtube.com/";
    return { platform: "YouTube", channel: record.channel, url };
  }
  const url = record.handle ? `https://www.twitch.tv/${encodeURIComponent(record.handle)}` : "https://www.twitch.tv/";
  return { platform: "Twitch", channel: record.channel, url };
}
