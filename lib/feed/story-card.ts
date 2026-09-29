import type { CardMedia, SignalDetail } from "./card-copy";
import { outletName, sourceNoun } from "./card-copy";
import type { FeedEntry, FeedEvidence } from "./feed-model";

/**
 * THE STORY CARD (Phase 34): the Feed's card as a story, and the pure rules
 * behind it. Display only. Nothing here decides what a signal is, what it
 * scored or what is stored; it reads an entry the model has already built
 * and says how the card is composed: which KIND of card it is, what SOURCES
 * sit in its strip, what MEDIA it may embed, and which entries are small
 * enough to fold into the "Also moving" rows between the cards.
 *
 * A card is one story today. Its shape (a headline, one line, the move with
 * the score's path across it, a strip of sources with counts) is the shape a
 * multi-source story takes when Phase 31's clustering gives the Feed a
 * persistent story record: the same component, several signals in the
 * strip, the move over the story's life beside the move today.
 *
 * MEDIA RULE. The card embeds only what the platform itself publishes for
 * embedding: a YouTube video through YouTube's own thumbnail and player, a
 * Twitch clip or channel through Twitch's player. No copy of anyone's
 * picture is hosted here, and nothing is scraped from an article. An article
 * card is its outlet, its title and its link, which is what the publisher
 * put on the wire.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * A card whose move is smaller than this, in score points, is an "Also
 * moving" row rather than a full card. Over the seven days to 2026-09-29,
 * signal cards fell 155 under 0.15, 127 under 0.3, 210 under 0.5 and 21 at
 * 0.5 or more; 0.3 makes the full cards the upper half of what moved and
 * folds the routine reads into rows. A narrative is written only for a move
 * of 0.5 or more, so it is always a full card.
 */
export const ALSO_MOVING_BELOW = 0.3;

/** The score's path across a move: this many hours before it, and this many after (or until now). */
export const SPARK_HOURS_BEFORE = 3;
export const SPARK_HOURS_AFTER = 3;

/** The sparkline needs at least this many points to say anything. */
export const SPARK_MIN_POINTS = 3;

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * What kind of card a story is, which decides its composition:
 *   article    the publisher's title, linked, under the outlet
 *   video      a YouTube video the story is about, with its thumbnail
 *   live       a Twitch stream, a moment in one, or its summary
 *   game       a game result, with the scoreboard
 *   narrative  the Engine's own sentence, with what it saw beneath
 *   signal     any other reading: a metric, a filing
 */
export type StoryKind = "article" | "video" | "live" | "game" | "narrative" | "signal";

export function storyKind(entry: Pick<FeedEntry, "kind" | "copy" | "evidence">): StoryKind {
  if (entry.kind === "narrative") return "narrative";
  const detail = entry.evidence[0]?.detail ?? null;
  if (detail?.game) return "game";
  if (detail?.media?.kind === "twitch") return "live";
  if (detail?.media?.kind === "youtube") return "video";
  if (entry.copy.quoted) return "article";
  return "signal";
}

/** The small word above the headline, by kind. An article's is its outlet, which the copy already carries as its label. */
export const KIND_LABELS: Readonly<Record<Exclude<StoryKind, "article">, string>> = {
  video: "YouTube",
  live: "Live on Twitch",
  game: "Game result",
  narrative: "The Engine",
  signal: "Reading",
};

export function storyLabel(entry: Pick<FeedEntry, "kind" | "copy" | "evidence">): string | null {
  const kind = storyKind(entry);
  if (kind === "article") return entry.copy.label;
  if (kind === "game") {
    const week = entry.evidence[0]?.detail?.game?.week;
    return week ? `${KIND_LABELS.game} · ${week}` : KIND_LABELS.game;
  }
  if (kind === "live" && entry.evidence[0]?.detail?.kind === "stream_summary") return "Twitch";
  return KIND_LABELS[kind];
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** One entry in the source strip: a name, the domain behind it (for its icon) and where it links. */
export interface StorySource {
  name: string;
  domain: string | null;
  link: string | null;
  /** How many of the story's signals came from this source; 1 for a single-signal card. */
  count: number;
}

/**
 * What stands before a source's name in the strip (Phase 34b). A platform
 * source shows the platform's own mark (YouTube's icon, Twitch's Glitch, per
 * their brand guidelines); a publisher shows its favicon with its initial as
 * the fallback; a metric or data source ("News coverage", "Game data") shows
 * a neutral glyph, never a letter tile.
 */
export type SourceGlyph = "youtube" | "twitch" | "favicon" | "news" | "game" | "filing" | "metric";

export function sourceGlyph(source: Pick<StorySource, "name" | "domain">): SourceGlyph {
  const name = source.name.toLowerCase();
  const domain = source.domain?.toLowerCase() ?? "";
  if (name.startsWith("youtube") || /(^|\.)youtube\.com$/.test(domain)) return "youtube";
  if (name.startsWith("twitch") || /(^|\.)twitch\.tv$/.test(domain)) return "twitch";
  if (source.domain) return "favicon";
  if (/\bnews\b|\bcoverage\b/.test(name)) return "news";
  if (/\bgame\b/.test(name)) return "game";
  if (/\bfilings?\b/.test(name)) return "filing";
  return "metric";
}

function sourceOf(item: Pick<FeedEvidence, "source" | "detail" | "payload">): StorySource {
  const detail = item.detail;
  if (detail?.kind === "article") {
    const name = outletName(detail.outlet, detail.domain) ?? sourceNoun(item.source);
    return { name, domain: detail.domain?.replace(/^www\./, "") ?? null, link: detail.link, count: 1 };
  }
  const media = detail?.media ?? null;
  if (media?.kind === "youtube") return { name: "YouTube", domain: "youtube.com", link: youtubeWatchUrl(media.videoId), count: 1 };
  if (media?.kind === "twitch") return { name: "Twitch", domain: "twitch.tv", link: twitchChannelUrl(media.channel), count: 1 };
  const metric = typeof item.payload === "object" && item.payload !== null && (item.payload as { kind?: unknown }).kind === "metric";
  return { name: sourceNoun(item.source, metric ? "metric" : detail?.kind), domain: null, link: null, count: 1 };
}

/**
 * The strip: every distinct source behind the story with how many of its
 * signals it supplied, most first. A signal card has one; a narrative has
 * its direct evidence's outlets. The paired person's evidence is not this
 * person's source.
 */
export function storySources(entry: Pick<FeedEntry, "kind" | "evidence" | "sources" | "copy">): StorySource[] {
  const direct = entry.evidence.filter((item) => item.relation === "direct");
  const byName = new Map<string, StorySource>();
  for (const item of direct) {
    const source = sourceOf(item);
    const known = byName.get(source.name);
    if (known) {
      known.count += 1;
      if (!known.link && source.link) known.link = source.link;
    } else byName.set(source.name, source);
  }
  if (byName.size === 0) {
    for (const name of entry.sources) byName.set(sourceNoun(name), { name: sourceNoun(name), domain: null, link: null, count: 1 });
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/** YouTube's own thumbnail for a video: served by YouTube, never copied here. */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

/** The official player, privacy-enhanced domain, started on tap. */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0`;
}

export function twitchChannelUrl(channel: string): string {
  return `https://www.twitch.tv/${encodeURIComponent(channel)}`;
}

export function twitchClipUrl(clip: string): string {
  return `https://clips.twitch.tv/${encodeURIComponent(clip)}`;
}

/**
 * Twitch's official embeds need the embedding page's hostname as `parent`,
 * or the player refuses to load. A clip plays through the clips player; a
 * channel through the live player, muted, which shows the channel's offline
 * screen when nothing is on.
 */
export function twitchEmbedUrl(media: Extract<CardMedia, { kind: "twitch" }>, parent: string): string {
  const host = encodeURIComponent(parent);
  if (media.clip) return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(media.clip)}&parent=${host}&autoplay=true`;
  return `https://player.twitch.tv/?channel=${encodeURIComponent(media.channel)}&parent=${host}&muted=true`;
}

/** Where the media links when it is not embedded (the compact row, a reader who prefers the site). */
export function mediaLink(media: CardMedia): string {
  if (media.kind === "youtube") return youtubeWatchUrl(media.videoId);
  return media.clip ? twitchClipUrl(media.clip) : twitchChannelUrl(media.channel);
}

/**
 * An outlet's icon, from its own domain through the icon service. The strip
 * shows the outlet's initial instead when the icon does not arrive.
 */
export function sourceIconUrl(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain.toLowerCase().replace(/^www\./, ""))}.ico`;
}

export function storyMedia(entry: Pick<FeedEntry, "evidence">): CardMedia | null {
  for (const item of entry.evidence) {
    if (item.relation !== "direct") continue;
    if (item.detail?.media) return item.detail.media;
  }
  return null;
}

export function storyGame(entry: Pick<FeedEntry, "evidence">): NonNullable<SignalDetail["game"]> | null {
  return entry.evidence[0]?.detail?.game ?? null;
}

// ---------------------------------------------------------------------------
// The sparkline
// ---------------------------------------------------------------------------

export interface SparkPoint {
  at: string;
  score: number;
}

/**
 * The score's path across a move: the points from SPARK_HOURS_BEFORE the
 * entry to SPARK_HOURS_AFTER it, oldest first, as plain numbers for the
 * sparkline. Null below SPARK_MIN_POINTS: two points make a line, not a
 * path, and the card says nothing rather than something invented.
 */
export function sparkAcross(series: readonly SparkPoint[], occurredAt: string, hoursBefore = SPARK_HOURS_BEFORE, hoursAfter = SPARK_HOURS_AFTER): number[] | null {
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) return null;
  const from = at - hoursBefore * 3_600_000;
  const to = at + hoursAfter * 3_600_000;
  const points = series
    .map((point) => ({ t: Date.parse(point.at), score: point.score }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.score) && point.t >= from && point.t <= to)
    .sort((a, b) => a.t - b.t)
    .map((point) => point.score);
  return points.length >= SPARK_MIN_POINTS ? points : null;
}

// ---------------------------------------------------------------------------
// The stream: cards and "Also moving" rows
// ---------------------------------------------------------------------------

/** A full card, or a run of small moves folded into rows, in the stream's order. */
export type StreamBlock = { type: "card"; entry: FeedEntry } | { type: "also"; entries: FeedEntry[] };

/** Whether an entry is small enough to be a row: a recorded move under ALSO_MOVING_BELOW. A narrative never is. */
export function isAlsoMoving(entry: Pick<FeedEntry, "kind" | "impact">, threshold = ALSO_MOVING_BELOW): boolean {
  if (entry.kind === "narrative") return false;
  return entry.impact !== null && Math.abs(entry.impact) < threshold;
}

/**
 * The stream as blocks: full cards in order, and each run of consecutive
 * small moves folded into one "Also moving" block where the run began. The
 * order of the stream is not changed; nothing is dropped.
 */
export function groupStream(entries: readonly FeedEntry[], threshold = ALSO_MOVING_BELOW): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  for (const entry of entries) {
    if (isAlsoMoving(entry, threshold)) {
      const last = blocks[blocks.length - 1];
      if (last?.type === "also") last.entries.push(entry);
      else blocks.push({ type: "also", entries: [entry] });
    } else blocks.push({ type: "card", entry });
  }
  return blocks;
}
