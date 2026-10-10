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

export type AvatarSource = "youtube" | "twitch" | "commons" | "apisports" | "sleeper";

/** What is kept about an avatar, on the person's platform mapping. Never the image. */
export interface AvatarRecord {
  url: string;
  source: AvatarSource;
  /** The channel's display name, for the credit. */
  channel: string;
  /** The channel's handle or login, for the credit's link; for a Commons portrait, the file's title; for an API-Sports or Sleeper headshot, the player id. */
  handle: string | null;
  refreshedAt: string;
  /** A Commons portrait's licence, as Commons names it ("CC BY-SA 4.0"), and the licence's page; absent for a platform avatar. */
  license?: string | null;
  licenseUrl?: string | null;
  /** The file's page on Commons, where the licence and the author are stated. */
  pageUrl?: string | null;
}

/** How old a record may be, per platform, before it is read again. */
export const AVATAR_REFRESH_HOURS: Readonly<Record<AvatarSource, number>> = { youtube: 30 * 24, twitch: 24, commons: 30 * 24, apisports: 30 * 24, sleeper: 30 * 24 };

/** The categories whose channels are their own: creators and musicians. */
export const AVATAR_CATEGORIES: ReadonlySet<string> = new Set(["creator", "musician"]);

/** The image hosts the platforms serve avatars from; a URL elsewhere is not an avatar. */
const AVATAR_HOSTS: Readonly<Record<AvatarSource, RegExp>> = {
  youtube: /^https:\/\/(yt3\.ggpht\.com|yt3\.googleusercontent\.com|[a-z0-9-]+\.googleusercontent\.com)\//i,
  twitch: /^https:\/\/static-cdn\.jtvnw\.net\//i,
  // Commons serves originals from upload.wikimedia.org and, since 2026-09, scaled thumbnails from thumb.wikimedia.org.
  commons: /^https:\/\/(upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//i,
  apisports: /^https:\/\/media\.api-sports\.io\//i,
  sleeper: /^https:\/\/sleepercdn\.com\/content\/(nfl|nba)\/players\/[A-Za-z0-9_-]+\.jpg$/i,
};

// ---------------------------------------------------------------------------
// Sleeper headshots (decided 2026-10-10)
// ---------------------------------------------------------------------------

/**
 * ATHLETES: SLEEPER HEADSHOTS (decided 2026-10-10, the operator overriding
 * the "no other image source" rule for athletes). The API-Sports headshots
 * were outdated and small; Sleeper (the fantasy app) serves a current
 * headshot for every player it lists, from its own CDN
 * (`sleepercdn.com/content/<sport>/players/<id>.jpg`), and its player list
 * (`api.sleeper.app/v1/players/<sport>`, no key) names the id. The picture
 * is not copied here: the CDN URL is kept like every other avatar and
 * credited "Sleeper" on the profile. Sleeper asks that the player list be
 * read at most once a day; the refresh reads it once per process per day
 * and only when a pinned athlete's record is stale (30 days).
 *
 * Pinned by slug, with the sport, the name and the position Sleeper lists:
 * the position tells two players of one name apart (there were two Josh
 * Allens), and a name that no longer resolves yields nothing, so the last
 * picture stands. A Sleeper pin outranks every other source.
 */
export type SleeperSport = "nfl" | "nba";

export interface SleeperPin {
  sport: SleeperSport;
  /** The name as Sleeper lists it; matched after lowercasing and dropping everything but letters. */
  name: string;
  position: string;
}

export const SLEEPER_PLAYERS: Readonly<Record<string, SleeperPin>> = {
  "patrick-mahomes": { sport: "nfl", name: "Patrick Mahomes", position: "QB" },
  "josh-allen": { sport: "nfl", name: "Josh Allen", position: "QB" },
  "lamar-jackson": { sport: "nfl", name: "Lamar Jackson", position: "QB" },
  "jamarr-chase": { sport: "nfl", name: "Ja'Marr Chase", position: "WR" },
  "jahmyr-gibbs": { sport: "nfl", name: "Jahmyr Gibbs", position: "RB" },
  "bijan-robinson": { sport: "nfl", name: "Bijan Robinson", position: "RB" },
  "jaxon-smith-njigba": { sport: "nfl", name: "Jaxon Smith-Njigba", position: "WR" },
  "stephen-curry": { sport: "nba", name: "Stephen Curry", position: "G" },
  "lebron-james": { sport: "nba", name: "LeBron James", position: "F" },
  "victor-wembanyama": { sport: "nba", name: "Victor Wembanyama", position: "C" },
  "shai-gilgeous-alexander": { sport: "nba", name: "Shai Gilgeous-Alexander", position: "G" },
};

/** The public fields of a Sleeper player this reads. */
export interface SleeperPlayer {
  player_id?: string | number;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  /** Sleeper's own search key: the full name lowercased with everything but letters removed. */
  search_full_name?: string;
  position?: string | null;
  /** Sleeper lists several positions for some players (NBA guards and forwards); any of them counts. */
  fantasy_positions?: string[] | null;
  team?: string | null;
  active?: boolean;
  status?: string | null;
}

/** A name the way Sleeper's search key spells it: lowercase, letters only ("jamarrchase"). */
export function sleeperNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function playerName(player: SleeperPlayer): string | null {
  const full = text(player.full_name, 200) ?? [player.first_name, player.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
  return full || null;
}

/**
 * Whether a player plays the pinned position. Sleeper's NBA list names the
 * specific spot (PG, SG, SF, PF, C; seen 2026-10-10: Wembanyama matched as
 * C, the three guards and forwards did not), so a one-letter pin (G, F)
 * matches any position that ends in that letter; the NFL's two-letter
 * codes match exactly.
 */
function playsPosition(player: SleeperPlayer, position: string): boolean {
  const wanted = position.toUpperCase();
  const matches = (entry: unknown) => typeof entry === "string" && (entry.toUpperCase() === wanted || (wanted.length === 1 && entry.toUpperCase().endsWith(wanted)));
  if (matches(player.position)) return true;
  return Array.isArray(player.fantasy_positions) && player.fantasy_positions.some(matches);
}

/**
 * The pinned player in Sleeper's list: the name key and the position must
 * match; among several (a retired namesake), an active player on a team
 * wins. Null when nobody matches.
 */
export function findSleeperPlayer(players: Iterable<SleeperPlayer>, pin: SleeperPin): SleeperPlayer | null {
  const key = sleeperNameKey(pin.name);
  const matches: SleeperPlayer[] = [];
  for (const player of players) {
    const name = playerName(player);
    const playerKey = text(player.search_full_name, 200) ?? (name ? sleeperNameKey(name) : "");
    if (playerKey !== key || !playsPosition(player, pin.position)) continue;
    matches.push(player);
  }
  if (matches.length === 0) return null;
  const rank = (player: SleeperPlayer) => (player.active === false ? 0 : 2) + (player.team ? 1 : 0);
  return matches.reduce((best, player) => (rank(player) > rank(best) ? player : best), matches[0]);
}

/** The headshot URL Sleeper's CDN serves for a player. */
export function sleeperAvatarUrl(sport: SleeperSport, playerId: string): string {
  return `https://sleepercdn.com/content/${sport}/players/${encodeURIComponent(playerId)}.jpg`;
}

/** A Sleeper player's headshot on Sleeper's CDN, with the player's name and id. Null without an id or a name. */
export function sleeperAvatarFrom(player: SleeperPlayer | undefined, sport: SleeperSport, now: Date): AvatarRecord | null {
  const id = player?.player_id === undefined || player?.player_id === null ? null : String(player.player_id).trim();
  const channel = player ? playerName(player) : null;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || !channel) return null;
  const url = sleeperAvatarUrl(sport, id);
  if (!isAvatarUrl(url, "sleeper")) return null;
  return { url, source: "sleeper", channel, handle: id, refreshedAt: now.toISOString() };
}

/**
 * ATHLETES: API-SPORTS HEADSHOTS (decided 2026-09-29). An athlete with an
 * API-Sports player mapping (the id the game connector already reads) shows
 * the player headshot API-Sports serves from its own media host, read from
 * the player endpoint of the sport's host and credited "API-Sports" on the
 * profile. Their terms allow the images inside an application that uses
 * the API; the picture is not copied here. Same 30-day refresh as YouTube.
 */
export const APISPORTS_AVATAR_CATEGORIES: ReadonlySet<string> = new Set(["athlete"]);

// ---------------------------------------------------------------------------
// Wikimedia Commons portraits (decided 2026-09-29)
// ---------------------------------------------------------------------------

/**
 * The executives' portraits come from Wikimedia Commons: the lead image of
 * each person's English Wikipedia article, resolved at refresh time, kept
 * only when the file is on Commons under a free licence (below), and
 * credited with its author and licence on the profile. Pinned by article
 * title so the choice of picture is a reviewed constant, not a search
 * result; a title that no longer resolves, or resolves to a file that is
 * not free, yields no picture and the initials stay.
 *
 * A pin outranks a platform channel (decided 2026-10-06, for Drake): a
 * musician or creator on this list shows the Commons portrait, not their
 * channel avatar, so the operator can choose a portrait over a logo.
 */
export const COMMONS_PORTRAITS: Readonly<Record<string, string>> = {
  drake: "Drake (musician)",
  "elon-musk": "Elon Musk",
  "jeff-bezos": "Jeff Bezos",
  "mark-zuckerberg": "Mark Zuckerberg",
  "jensen-huang": "Jensen Huang",
  "larry-ellison": "Larry Ellison",
  "larry-page": "Larry Page",
  "sergey-brin": "Sergey Brin",
  "warren-buffett": "Warren Buffett",
  "michael-dell": "Michael Dell",
};

/** The licences a portrait may carry, as Commons names them in LicenseShortName. Anything else is refused. */
export const COMMONS_ALLOWED_LICENSES = /^(CC0(?: 1\.0)?|Public domain|CC BY(?:-SA)? [1-4]\.0(?: [A-Za-z]+)?|CC-BY(?:-SA)?-[1-4]\.0)$/i;

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
  /** A YouTube channel id, a Twitch login / user id, a Wikipedia article title, an API-Sports player id, or the slug of a Sleeper pin. */
  identifier: string;
  /** The mapping the record is kept on. */
  mappingSource: string;
}

/**
 * The channel a person's avatar comes from: a pinned Sleeper headshot
 * first (SLEEPER_PLAYERS, the athletes), else a pinned Commons portrait
 * (COMMONS_PORTRAITS), both kept on the person's news mapping, which every
 * tracked person has; else their YouTube channel mapping (the channel
 * id), else their Twitch mapping (the login), else the first channel
 * pinned on their YouTube Trending mapping, else an athlete's API-Sports
 * player. Null for anyone outside the creator and musician categories
 * with no pin and no player, and for anyone with no channel of their own.
 */
export function avatarChannelFor(person: { category: string; slug?: string }, mappings: readonly AvatarMapping[]): AvatarChannel | null {
  const home = mappings.find((mapping) => mapping.source === "rss") ?? mappings.find((mapping) => mapping.source === "publisher_rss");
  if (person.slug && SLEEPER_PLAYERS[person.slug] && home) return { source: "sleeper", identifier: person.slug, mappingSource: home.source };
  const title = person.slug ? COMMONS_PORTRAITS[person.slug] : undefined;
  if (title && home) return { source: "commons", identifier: title, mappingSource: home.source };
  const platform = platformChannelFor(person, mappings);
  if (platform) return platform;
  if (APISPORTS_AVATAR_CATEGORIES.has(person.category)) {
    const player = mappings.find((mapping) => mapping.source === "apisports" && /^\d+$/.test(mapping.externalIdentifier.trim()));
    if (player) return { source: "apisports", identifier: player.externalIdentifier.trim(), mappingSource: "apisports" };
  }
  return null;
}

function platformChannelFor(person: { category: string }, mappings: readonly AvatarMapping[]): AvatarChannel | null {
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
  const source = record.source === "youtube" || record.source === "twitch" || record.source === "commons" || record.source === "apisports" || record.source === "sleeper" ? record.source : null;
  const url = text(record.url, 2048);
  const channel = text(record.channel, 200);
  const refreshedAt = text(record.refreshed_at, 40);
  if (!source || !url || !channel || !refreshedAt || !Number.isFinite(Date.parse(refreshedAt)) || !isAvatarUrl(url, source)) return null;
  return {
    url,
    source,
    channel,
    handle: text(record.handle, 300),
    refreshedAt,
    ...(source === "commons" ? { license: text(record.license, 60), licenseUrl: text(record.license_url, 300), pageUrl: text(record.page_url, 600) } : {}),
  };
}

/** The record as it is written to the mapping's config. */
export function avatarRecordJson(record: AvatarRecord): Record<string, Json> {
  return {
    url: record.url,
    source: record.source,
    channel: record.channel,
    handle: record.handle,
    refreshed_at: record.refreshedAt,
    ...(record.source === "commons" ? { license: record.license ?? null, license_url: record.licenseUrl ?? null, page_url: record.pageUrl ?? null } : {}),
  };
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

/** The public fields of an API-Sports player this reads: the id, the name and the headshot. */
export interface ApiSportsPlayer {
  id?: number | string;
  name?: string;
  image?: string;
}

/** An API-Sports player's headshot on their media host, with the player's name. Null without a usable image. */
export function apisportsAvatarFrom(player: ApiSportsPlayer | undefined, now: Date): AvatarRecord | null {
  const url = text(player?.image, 2048);
  const channel = text(player?.name, 200);
  if (!url || !channel || !isAvatarUrl(url, "apisports")) return null;
  const id = player?.id === undefined || player?.id === null ? null : String(player.id);
  return { url, source: "apisports", channel, handle: id, refreshedAt: now.toISOString() };
}

/** What Commons answers about a file: the thumbnail, the file page and the extended metadata this reads. */
export interface CommonsImageInfo {
  thumburl?: string;
  url?: string;
  descriptionurl?: string;
  extmetadata?: Partial<Record<"Artist" | "LicenseShortName" | "LicenseUrl" | "Credit", { value?: string }>>;
}

/** Tags stripped, entities the credit line meets decoded, whitespace collapsed. */
function plainText(html: string | undefined | null, max: number): string | null {
  if (!html) return null;
  const stripped = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped ? stripped.slice(0, max) : null;
}

/**
 * A Commons portrait's record: the thumbnail on Commons' own host, the
 * author and the licence, the file page for the credit. Null unless the
 * file is on Commons under an allowed licence with an author to credit
 * (a public-domain file may name none; "Unknown author" is then written).
 */
export function commonsAvatarFrom(fileTitle: string | null | undefined, info: CommonsImageInfo | undefined, now: Date): AvatarRecord | null {
  // Commons appends utm_* tracking to the URLs it answers with; the picture is the path.
  const url = (info?.thumburl ?? info?.url ?? null)?.replace(/\?.*$/, "") ?? null;
  const license = plainText(info?.extmetadata?.LicenseShortName?.value, 60);
  if (!fileTitle || !url || !license || !isAvatarUrl(url, "commons") || !COMMONS_ALLOWED_LICENSES.test(license)) return null;
  const artist = plainText(info?.extmetadata?.Artist?.value, 120) ?? plainText(info?.extmetadata?.Credit?.value, 120) ?? "Unknown author";
  return {
    url,
    source: "commons",
    channel: artist,
    handle: fileTitle,
    refreshedAt: now.toISOString(),
    license,
    licenseUrl: plainText(info?.extmetadata?.LicenseUrl?.value, 300),
    pageUrl: info?.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(fileTitle.replace(/ /g, "_"))}`,
  };
}

// ---------------------------------------------------------------------------
// The credit
// ---------------------------------------------------------------------------

export interface AvatarCredit {
  platform: "YouTube" | "Twitch" | "Wikimedia Commons" | "API-Sports" | "Sleeper";
  channel: string;
  /** The channel's page on the platform. */
  url: string;
}

/** "Photo: YouTube · MrBeast", linked to the channel; "Photo: Wikimedia Commons · Steve Jurvetson (CC BY 2.0)", linked to the file page; "Photo: API-Sports · Patrick Mahomes", linked to API-Sports; "Photo: Sleeper · Patrick Mahomes", linked to Sleeper. */
export function avatarCredit(record: AvatarRecord | null): AvatarCredit | null {
  if (!record) return null;
  if (record.source === "commons") {
    return { platform: "Wikimedia Commons", channel: record.license ? `${record.channel} (${record.license})` : record.channel, url: record.pageUrl ?? "https://commons.wikimedia.org/" };
  }
  if (record.source === "apisports") return { platform: "API-Sports", channel: record.channel, url: "https://api-sports.io/" };
  if (record.source === "sleeper") return { platform: "Sleeper", channel: record.channel, url: "https://sleeper.com/" };
  if (record.source === "youtube") {
    const url = record.handle ? `https://www.youtube.com/${encodeURIComponent(record.handle)}` : "https://www.youtube.com/";
    return { platform: "YouTube", channel: record.channel, url };
  }
  const url = record.handle ? `https://www.twitch.tv/${encodeURIComponent(record.handle)}` : "https://www.twitch.tv/";
  return { platform: "Twitch", channel: record.channel, url };
}
