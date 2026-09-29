import "server-only";

import { fetchTwitchToken } from "@/lib/connectors/twitch";
import { youtubeGet } from "@/lib/connectors/youtube";
import { getTwitchCredentialsOrNull, getYouTubeApiKeyOrNull } from "@/lib/env";
import type { TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

import {
  avatarChannelFor,
  avatarRecordJson,
  commonsAvatarFrom,
  type CommonsImageInfo,
  isAvatarStale,
  readAvatarRecord,
  twitchAvatarFrom,
  youtubeAvatarFrom,
  type AvatarChannel,
  type AvatarMapping,
  type AvatarRecord,
  type YouTubeChannelSnippet,
} from "./avatar-model";

/**
 * The refresh (server only): for every creator and musician with a channel
 * of their own, read the channel's avatar from its platform, and for every
 * person with a pinned Wikimedia Commons portrait (the executives), the
 * article's lead image with its licence, when the kept record is older
 * than the source's window; write the URL to the person and the record to
 * the mapping (the news mapping, for a portrait). Bounded per call; runs at the end
 * of the ingestion cron. A read that fails leaves the last record and the
 * last URL as they are, and is logged.
 */

const AVATAR_SOURCES = ["youtube", "twitch", "youtube_trending", "rss", "publisher_rss"] as const;

/** Wikimedia's API etiquette asks for a User-Agent that names the caller. */
const WIKIMEDIA_UA = "MomentumTerminal/1.0 (https://momentumterminal.app; info@momentumterminal.app)";
/** The thumbnail width asked of Commons: enough for the largest avatar at 2x. */
const COMMONS_THUMB_WIDTH = 512;

export interface AvatarRefreshResult {
  considered: number;
  refreshed: string[];
  failed: Array<{ slug: string; reason: string }>;
}

interface PersonRow {
  id: string;
  slug: string;
  category: string;
  avatar_url: string | null;
}

interface MappingRow {
  id: string;
  person_id: string;
  external_identifier: string | null;
  config: Json | null;
  data_sources: { name: string } | null;
}

async function readYouTubeAvatar(channel: AvatarChannel, fetchImpl: typeof fetch, now: Date): Promise<AvatarRecord | null> {
  const apiKey = getYouTubeApiKeyOrNull();
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not set");
  const body = await youtubeGet<{ items?: YouTubeChannelSnippet[] }>("channels", { part: "snippet", id: channel.identifier }, apiKey, fetchImpl);
  return youtubeAvatarFrom(body.items?.[0], now);
}

async function readTwitchAvatar(channel: AvatarChannel, fetchImpl: typeof fetch, now: Date): Promise<AvatarRecord | null> {
  const credentials = getTwitchCredentialsOrNull();
  if (!credentials) throw new Error("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set");
  const token = await fetchTwitchToken(credentials, fetchImpl);
  const query = /^\d+$/.test(channel.identifier) ? `id=${encodeURIComponent(channel.identifier)}` : `login=${encodeURIComponent(channel.identifier.toLowerCase())}`;
  const response = await fetchImpl(`https://api.twitch.tv/helix/users?${query}`, {
    headers: { authorization: `Bearer ${token}`, "client-id": credentials.clientId, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Twitch API responded ${response.status} for /users`);
  const body = (await response.json()) as { data?: Array<{ login?: string; display_name?: string; profile_image_url?: string }> };
  return twitchAvatarFrom(body.data?.[0], now);
}

/**
 * A pinned Commons portrait: the lead image of the person's English
 * Wikipedia article (pageimages), then that file's thumbnail, author and
 * licence from Commons itself. A file that is not on Commons (a local
 * non-free image on Wikipedia) is not found there and yields nothing.
 */
async function readCommonsAvatar(channel: AvatarChannel, fetchImpl: typeof fetch, now: Date): Promise<AvatarRecord | null> {
  const headers = { "user-agent": WIKIMEDIA_UA, accept: "application/json" };
  const page = await fetchImpl(`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=pageimages&piprop=name&titles=${encodeURIComponent(channel.identifier)}`, { headers });
  if (!page.ok) throw new Error(`Wikipedia responded ${page.status} for ${channel.identifier}`);
  const pageBody = (await page.json()) as { query?: { pages?: Array<{ title?: string; missing?: boolean; pageimage?: string }> } };
  const article = pageBody.query?.pages?.[0];
  // Each refusal says which step refused, so the reason can be read back from the mapping.
  if (!article || article.missing) throw new AvatarRefused(`no Wikipedia article for "${channel.identifier}"`);
  if (!article.pageimage) throw new AvatarRefused(`the article "${article.title ?? channel.identifier}" has no lead image`);
  const fileTitle = `File:${article.pageimage}`;
  const info = await fetchImpl(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=${COMMONS_THUMB_WIDTH}&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl|Credit&titles=${encodeURIComponent(fileTitle)}`,
    { headers },
  );
  if (!info.ok) throw new Error(`Commons responded ${info.status} for ${fileTitle}`);
  const infoBody = (await info.json()) as { query?: { pages?: Array<{ missing?: boolean; imageinfo?: CommonsImageInfo[] }> } };
  const file = infoBody.query?.pages?.[0];
  if (!file || file.missing) throw new AvatarRefused(`${fileTitle} is not on Commons`);
  const imageinfo = file.imageinfo?.[0];
  const record = commonsAvatarFrom(fileTitle, imageinfo, now);
  if (!record) {
    const license = imageinfo?.extmetadata?.LicenseShortName?.value ?? "no licence stated";
    throw new AvatarRefused(`${fileTitle} refused: licence "${license.replace(/<[^>]+>/g, "").trim()}", url ${imageinfo?.thumburl ?? imageinfo?.url ?? "none"}`);
  }
  return record;
}

/** A source answered, and what it answered is not a picture the rules accept: not an outage, and worth recording on the mapping. */
class AvatarRefused extends Error {}

export async function refreshPersonAvatars(options: { client: TypedSupabaseClient; fetch?: typeof fetch; now?: Date; limit?: number }): Promise<AvatarRefreshResult> {
  const { client } = options;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  const limit = options.limit ?? 5;
  const result: AvatarRefreshResult = { considered: 0, refreshed: [], failed: [] };

  const people = await client.from("people").select("id, slug, category, avatar_url").eq("is_active", true);
  if (people.error) throw new Error(`Could not load people for avatars: ${people.error.message}`);
  const ids = (people.data ?? []).map((row) => row.id);
  if (ids.length === 0) return result;

  const mappings = await client
    .from("person_data_sources")
    .select("id, person_id, external_identifier, config, data_sources!inner(name)")
    .eq("is_active", true)
    .in("person_id", ids)
    .in("data_sources.name", [...AVATAR_SOURCES]);
  if (mappings.error) throw new Error(`Could not load mappings for avatars: ${mappings.error.message}`);
  const rows = (mappings.data ?? []) as unknown as MappingRow[];

  for (const person of (people.data ?? []) as PersonRow[]) {
    if (result.refreshed.length + result.failed.length >= limit) break;
    const own = rows.filter((row) => row.person_id === person.id);
    const asMappings: AvatarMapping[] = own.map((row) => ({ source: row.data_sources?.name ?? "", externalIdentifier: row.external_identifier ?? "", config: (row.config ?? null) as Record<string, Json | undefined> | null }));
    const channel = avatarChannelFor(person, asMappings);
    if (!channel) continue;
    const mapping = own.find((row) => row.data_sources?.name === channel.mappingSource);
    if (!mapping) continue;
    const current = readAvatarRecord((mapping.config ?? null) as Record<string, Json | undefined> | null);
    result.considered += 1;
    if (!isAvatarStale(current, channel, now.getTime()) && person.avatar_url === current?.url) continue;

    try {
      const record =
        channel.source === "youtube" ? await readYouTubeAvatar(channel, fetchImpl, now) : channel.source === "twitch" ? await readTwitchAvatar(channel, fetchImpl, now) : await readCommonsAvatar(channel, fetchImpl, now);
      if (!record) {
        result.failed.push({ slug: person.slug, reason: channel.source === "commons" ? "no free Commons portrait for the article" : "the platform listed no avatar" });
        continue;
      }
      const rest = { ...((mapping.config as Record<string, Json | undefined> | null) ?? {}) };
      delete rest.avatar_error;
      const config = { ...rest, avatar: avatarRecordJson(record) } as Json;
      const wroteMapping = await client.from("person_data_sources").update({ config }).eq("id", mapping.id);
      if (wroteMapping.error) throw new Error(wroteMapping.error.message);
      const wrotePerson = await client.from("people").update({ avatar_url: record.url }).eq("id", person.id);
      if (wrotePerson.error) throw new Error(wrotePerson.error.message);
      result.refreshed.push(person.slug);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[avatars] ${person.slug}: ${reason}`);
      result.failed.push({ slug: person.slug, reason });
      // The last refusal is kept on the mapping (never the picture), so an operator can read why the initials stand.
      const config = { ...((mapping.config as Record<string, Json | undefined> | null) ?? {}), avatar_error: { at: now.toISOString(), reason: reason.slice(0, 400) } } as Json;
      const wrote = await client.from("person_data_sources").update({ config }).eq("id", mapping.id);
      if (wrote.error) console.warn(`[avatars] ${person.slug}: could not record the refusal: ${wrote.error.message}`);
    }
  }
  return result;
}
