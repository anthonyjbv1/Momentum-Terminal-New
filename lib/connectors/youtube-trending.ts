import { getYouTubeApiKeyOrNull } from "@/lib/env";
import { excludeReason, hasRules, readDisambiguation, type Disambiguation, type ExclusionVerdict } from "@/lib/ingest/disambiguation";
import type { Json } from "@/types/database";

import { matchedTerm, readSubjectConfig } from "./publisher-rss";
import { ConnectorError, type ConnectorAvailability, type ConnectorContext, type DataConnector, type RawSignal } from "./types";
import { youtubeGet } from "./youtube";

/**
 * YouTube Trending as a signal (Phase 22).
 *
 * The trending chart is the closest thing to a real-time attention signal
 * that is available legitimately. It refreshes about every half hour, it is
 * national and non-personalised (identical for every observer, which is what
 * makes an appearance reproducible), and YouTube's own ranking already weighs
 * a video's performance RELATIVE TO ITS CHANNEL'S NORM — a creator who
 * usually draws ten thousand views drawing half a million is the strongest
 * input to it. So an appearance is not raw popularity; it is a momentum
 * reading YouTube computed across all of YouTube.
 *
 * OFFICIAL API ONLY. videos.list with chart=mostPopular, one quota unit per
 * call against the 10,000-a-day budget (search.list, which
 * commentary_volume_24h burns, is a hundred). charts.youtube.com has no
 * public API and is not scraped: that is the same category as the follower
 * scrapers the board cut.
 *
 * EVENT, NOT METRIC — and the reason is regulatory, not technical. The
 * platform's posture is that the score is a transparent, rules-based
 * function of public inputs. A trending RANK is the output of an undisclosed
 * algorithm nobody here can explain or audit; a sigma built on it would make
 * part of the methodology "because YouTube said so". An APPEARANCE is a
 * dated, verifiable occurrence: the video was on the chart, anyone can check.
 * So the connector has no fetchMetrics, the rank is never snapshotted,
 * baselined or normalised, and it reaches a reader only as the fact it is
 * ("trending at #3"), the way a viewer count rides on a Twitch broadcast.
 *
 * ONE SIGNAL PER VIDEO PER SUBJECT. The chart is read every half hour and a
 * video sits on it for hours; the dedupe key is the video and the subject it
 * is credited to, as Phase 16 keys a broadcast on its stream id, so six polls
 * that see the same video store it once. The subject is in the key because,
 * unlike a broadcast, one video can be about two people on the board (a
 * collaboration), and the source-level unique constraint would otherwise
 * credit whichever of them polled first.
 *
 * THE CHART IS FETCHED ONCE PER RUN and shared by every subject, a module
 * cache keyed on the run's clock exactly as the publisher feed catalogue and
 * the API-Sports games list are. Sixteen mappings are one upstream request.
 *
 * MATCHING (Phase 22, Part 2). Two routes, in this order, and nothing else:
 *
 *   channel   the video is ON one of the subject's own channels:
 *             snippet.channelId is in the mapping's config.channel_ids.
 *             Unambiguous — a Drake University highlight reel cannot be on
 *             Drake's channel — so no exclusion is consulted. A SET rather
 *             than one id because a musician has both a personal channel and
 *             a label-operated VEVO channel and both trend; either would
 *             otherwise have to be given up. A mapping may instead (or also)
 *             name config.handles, which the connector resolves through
 *             channels.list?forHandle= — one quota unit, cached for the
 *             process, reported through the note channel so an operator can
 *             pin what it found. Pinning stops the lookup. A mapping with
 *             neither has no channel route, which costs recall and nothing
 *             else.
 *   title     the video's TITLE names the subject as whole words, by the
 *             same matcher the publisher feeds use (matchesTerm: "Drake's"
 *             matches, "Drakeford" does not), and the mapping's
 *             disambiguation rules do not refuse it. The rules are the Phase
 *             12+ block on the person_data_sources row — the same
 *             exclusions the two news doors apply, not a second system —
 *             judged over the title, the channel's name and the description.
 *
 * REFUSED, deliberately, because a false positive here is a visible error on
 * a consumer surface where a miss is nothing:
 *   - a match in the DESCRIPTION or the tags alone. Descriptions are keyword
 *     farms ("#drake #kendrick #mrbeast") and list collaborators and
 *     inspirations; a creator who writes "inspired by MrBeast" is not a
 *     MrBeast appearance. The description is read for EXCLUSION only, where
 *     more text means more chances to recognise the wrong entity — the same
 *     asymmetry the disambiguation module states: substring matching is
 *     right for refusing and wrong for admitting.
 *   - a match on the CHANNEL'S NAME alone. "Drake Fan Page" trending is not
 *     Drake trending.
 *   - bare surnames. The publisher mappings admit "Musk", "Bezos", "Kendrick"
 *     because a business-section feed supplies the context; the trending
 *     chart is unscoped, gaming beside cooking beside news, so the seeded
 *     mappings carry no aliases and the title must name the person in full.
 *     An alias is config (match_terms) if an operator ever wants one.
 *   - anything the snippet does not carry: no second request per video is
 *     made to enrich a candidate.
 *
 * A RANK CHANGE IS NOT A SECOND EVENT. The rank is the opaque part, and
 * emitting on "entered the top ten" would make it an input to emission — the
 * exposure Part 1 forbids. It also re-reports the same fact: the video is on
 * the chart. The rank at first sighting travels in the headline and the
 * payload as an observation about a moment; if a later phase wants peak rank
 * and time on chart, the right shape is a retrospective ledger like
 * live_sessions, not a stream of events.
 */

export const YOUTUBE_TRENDING_SOURCE_NAME = "youtube_trending";

/** Signal kind for a trending appearance, so the Engine and the Feed can tell it from an article or a broadcast. */
export const TRENDING_KIND = "trending";

/** videos.list answers at most this many per page; the chart itself runs to about two hundred. */
export const CHART_PAGE_SIZE = 50;
export const CHART_MAX_RESULTS = 200;

/** Per-source options, read from data_sources.config (all optional). */
export interface YouTubeTrendingConfig {
  /** ISO 3166-1 alpha-2 region the chart is read for. Default US: one national, non-personalised chart. */
  region: string;
  /** How deep into the chart to read. Default 50 (one call, one unit); at most 200 (four). */
  max_results: number;
}

const DEFAULT_CONFIG: YouTubeTrendingConfig = { region: "US", max_results: CHART_PAGE_SIZE };

export function readTrendingConfig(config: Record<string, Json | undefined>): YouTubeTrendingConfig {
  const region = typeof config.region === "string" && /^[A-Za-z]{2}$/.test(config.region.trim()) ? config.region.trim().toUpperCase() : DEFAULT_CONFIG.region;
  const max = config.max_results;
  const max_results = typeof max === "number" && Number.isInteger(max) && max > 0 ? Math.min(CHART_MAX_RESULTS, max) : DEFAULT_CONFIG.max_results;
  return { region, max_results };
}

/** The shape of a YouTube channel id: "UC" and twenty-two URL-safe characters. Anything else is not a channel route. */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** A YouTube handle: "@" and 3–30 letters, digits, underscores, hyphens or dots. */
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;

/**
 * The per-subject half: the names a title must carry, and the channels the
 * subject OWNS.
 *
 * MORE THAN ONE CHANNEL, on purpose. A musician typically has both a personal
 * channel and a label-operated VEVO channel, and both trend; a single
 * channel_id would force a choice and send the other down the title route. The
 * channel route matches ANY of the ids, so nothing has to be chosen.
 *
 * IDS ARE PINNED, HANDLES ARE RESOLVED. A pinned id costs nothing and is
 * authoritative. A handle is resolved through channels.list?forHandle= (one
 * quota unit, cached) and reported through the poll's note channel so an
 * operator can pin what it found; pinning stops the lookup. Handles exist
 * because a channel id is not something anyone knows by heart, and because
 * resolution is the only way to learn one WITHOUT scraping a web page.
 */
export interface TrendingSubject {
  /** Whole-word, case-insensitive; the mapping's external_identifier is always the first. */
  terms: string[];
  /** config.channel_ids (or the legacy singular config.channel_id), validated to the channel-id shape. */
  channelIds: string[];
  /**
   * config.handles (or the singular config.handle), normalised to "@name".
   * Every handle named is resolved each poll (cached for the process), so
   * stopping the lookup means pinning what it found in channel_ids AND
   * dropping the handle — which is the two-step an operator follows once a
   * resolution has been read and judged.
   */
  handles: string[];
}

function stringsFrom(value: Json | undefined): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Deduplicates while keeping the order the configuration wrote. */
function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function readTrendingSubject(config: Record<string, Json | undefined> | null | undefined, identifier: string, person: { display_name: string }): TrendingSubject {
  const subject = readSubjectConfig(config, identifier, person);
  const record = config && typeof config === "object" ? config : {};
  const channelIds = unique([...stringsFrom(record.channel_id), ...stringsFrom(record.channel_ids)].map((id) => id.trim()).filter((id) => CHANNEL_ID.test(id)));
  // A handle may be written with or without the "@"; it is stored either way and compared in one shape.
  const handles = unique(
    [...stringsFrom(record.handle), ...stringsFrom(record.handles)]
      .map((handle) => handle.trim())
      .map((handle) => (handle.startsWith("@") ? handle : `@${handle}`))
      .filter((handle) => HANDLE.test(handle)),
  );
  return { terms: subject.terms, channelIds, handles };
}

// ---------------------------------------------------------------------------
// Resolving a handle to a channel id
// ---------------------------------------------------------------------------

/** What channels.list told us about one handle. */
export interface ResolvedChannel {
  handle: string;
  channelId: string;
  title: string;
  /** null when the channel hides it; it is read only to help an operator judge whether this is the person. */
  subscriberCount: number | null;
}

interface YouTubeChannelsByHandleResponse {
  items?: Array<{ id?: string; snippet?: { title?: string }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }>;
}

/**
 * One handle to one channel, through the OFFICIAL route: channels.list with
 * forHandle. One quota unit, whatever parts are asked for. Never a fetch of
 * youtube.com — a handle is resolved by the API or not at all.
 *
 * Returns null when the handle names no channel. That is not an error: an
 * unresolved handle simply leaves the subject on the title route, which works.
 */
export async function resolveChannelHandle(handle: string, apiKey: string, fetchImpl: typeof fetch): Promise<ResolvedChannel | null> {
  const body = await youtubeGet<YouTubeChannelsByHandleResponse>("channels", { part: "snippet,statistics", forHandle: handle }, apiKey, fetchImpl);
  const item = body.items?.[0];
  if (!item?.id || !CHANNEL_ID.test(item.id)) return null;
  const hidden = Boolean(item.statistics?.hiddenSubscriberCount);
  const subscribers = hidden || item.statistics?.subscriberCount === undefined ? null : Number(item.statistics.subscriberCount);
  return {
    handle,
    channelId: item.id,
    title: item.snippet?.title?.trim() || item.id,
    subscriberCount: subscribers !== null && Number.isFinite(subscribers) ? subscribers : null,
  };
}

/**
 * Resolutions already paid for, keyed by handle. A handle maps to a channel
 * for as long as the creator keeps it, so this is cached for the life of the
 * process rather than the run: sixteen subjects polled every twenty-five
 * minutes must not each spend a unit re-deriving a constant. `null` caches a
 * handle that resolved to nothing, so a dead handle costs one unit and not one
 * per poll.
 */
const handleCache = new Map<string, ResolvedChannel | null>();

/** For tests. */
export function resetTrendingHandleCache(): void {
  handleCache.clear();
}

/** Resolves the handles that are not already pinned, at most one upstream call each, cached. */
export async function resolveHandles(handles: string[], apiKey: string, fetchImpl: typeof fetch): Promise<Array<ResolvedChannel | { handle: string; error: string }>> {
  const out: Array<ResolvedChannel | { handle: string; error: string }> = [];
  for (const handle of handles) {
    if (handleCache.has(handle)) {
      const cached = handleCache.get(handle) ?? null;
      if (cached) out.push(cached);
      continue;
    }
    try {
      const resolved = await resolveChannelHandle(handle, apiKey, fetchImpl);
      handleCache.set(handle, resolved);
      if (resolved) out.push(resolved);
      else out.push({ handle, error: "names no channel" });
    } catch (error) {
      // A failed lookup is never a failed poll: the subject keeps the title
      // route and the operator sees why through the note channel.
      out.push({ handle, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

/** One video as the chart lists it. Rank is its 1-based position in the order the API returned. */
export interface TrendingVideo {
  videoId: string;
  rank: number;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string | null;
  categoryId: string | null;
  viewCount: number | null;
}

interface YouTubeChartResponse {
  nextPageToken?: string;
  items?: Array<{
    id?: string;
    snippet?: { publishedAt?: string; channelId?: string; title?: string; description?: string; channelTitle?: string; categoryId?: string };
    statistics?: { viewCount?: string };
  }>;
}

function readVideo(raw: NonNullable<YouTubeChartResponse["items"]>[number], rank: number): TrendingVideo | null {
  const snippet = raw.snippet;
  if (!raw.id || !snippet?.channelId || !snippet.title) return null;
  const views = raw.statistics?.viewCount !== undefined ? Number(raw.statistics.viewCount) : null;
  return {
    videoId: raw.id,
    rank,
    title: snippet.title.trim(),
    description: snippet.description ?? "",
    channelId: snippet.channelId,
    channelTitle: snippet.channelTitle?.trim() || snippet.channelId,
    publishedAt: snippet.publishedAt ?? null,
    categoryId: snippet.categoryId ?? null,
    viewCount: views !== null && Number.isFinite(views) ? views : null,
  };
}

/**
 * videos.list?chart=mostPopular for one region, a page of fifty at a time
 * until `max_results` or the chart ends. One quota unit per page.
 */
export async function fetchTrendingChart(config: YouTubeTrendingConfig, apiKey: string, fetchImpl: typeof fetch): Promise<TrendingVideo[]> {
  const videos: TrendingVideo[] = [];
  let pageToken: string | undefined;
  while (videos.length < config.max_results) {
    const params: Record<string, string> = {
      part: "snippet,statistics",
      chart: "mostPopular",
      regionCode: config.region,
      maxResults: String(Math.min(CHART_PAGE_SIZE, config.max_results - videos.length)),
    };
    if (pageToken) params.pageToken = pageToken;
    const body = await youtubeGet<YouTubeChartResponse>("videos", params, apiKey, fetchImpl);
    const items = body.items ?? [];
    for (const raw of items) {
      const video = readVideo(raw, videos.length + 1);
      if (video) videos.push(video);
    }
    if (!body.nextPageToken || items.length === 0) break;
    pageToken = body.nextPageToken;
  }
  return videos;
}

let chartCache: { key: string; pending: Promise<TrendingVideo[]> } | null = null;

/** For tests. */
export function resetTrendingChartCache(): void {
  chartCache = null;
}

/** The chart as read for this run: once, shared by every subject the runner polls with the same clock. */
export function chartFor(context: ConnectorContext, config: YouTubeTrendingConfig, apiKey: string): Promise<TrendingVideo[]> {
  const key = `${context.source.id}|${context.now.toISOString()}`;
  if (chartCache && chartCache.key === key) return chartCache.pending;
  const pending = fetchTrendingChart(config, apiKey, context.fetch);
  chartCache = { key, pending };
  return pending;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type TrendingRoute = "channel" | "title";

export type TrendingMatch =
  /** The video is on the subject's own channel. */
  | { route: "channel"; term: null }
  /** The title names the subject; `term` is the configured term it carried. */
  | { route: "title"; term: string };

export type TrendingOutcome =
  | { match: TrendingMatch }
  /** The title named the subject and the disambiguation rules refused it. */
  | { refused: ExclusionVerdict; term: string };

/** How many characters of the description the exclusion rules read. Enough for the wrong entity to be named; not the whole essay. */
const DESCRIPTION_EXCLUSION_CHARS = 600;

/**
 * Whether one chart video is the subject's, and by which route. Null when it
 * is not theirs by either route — which is the answer for almost every video
 * on the chart, almost every poll.
 */
export function matchTrendingVideo(video: TrendingVideo, subject: TrendingSubject, rules: Disambiguation): TrendingOutcome | null {
  // Any of the subject's own channels: a personal channel and a VEVO channel
  // are both theirs, and neither has to be chosen over the other.
  if (subject.channelIds.includes(video.channelId)) return { match: { route: "channel", term: null } };

  // Admission is the TITLE and nothing else: not the description, not the
  // tags, not the channel's name (see the module note).
  const term = matchedTerm(video.title, subject.terms);
  if (term === null) return null;

  if (hasRules(rules)) {
    // Exclusion reads wider than admission does: the wrong entity may be
    // named only in the channel's name ("Drake University Athletics") or in
    // the description, and either is reason enough to refuse.
    const haystack = `${video.title} ${video.channelTitle} ${video.description.slice(0, DESCRIPTION_EXCLUSION_CHARS)}`;
    const verdict = excludeReason(haystack, rules);
    if (verdict) return { refused: verdict, term };
  }
  return { match: { route: "title", term } };
}

// ---------------------------------------------------------------------------
// The signal
// ---------------------------------------------------------------------------

/**
 * The event for an appearance. The sentence follows the Phase 21+ rules: no
 * σ (there is none), the person named, "their" and never a guessed pronoun,
 * and the one number in it — the rank — a public fact anyone can check on
 * the chart itself. A video on the subject's own channel is THEIR trending;
 * a video about them is said to be about them, with its channel named, so a
 * reader can tell the two apart at a glance.
 */
export function trendingSignal(person: { display_name: string; slug: string }, video: TrendingVideo, match: TrendingMatch, region: string, now: Date): RawSignal {
  const title = video.title.replace(/"/g, "”");
  const headline =
    match.route === "channel"
      ? `${person.display_name} is trending at #${video.rank} on YouTube: "${title}".`
      : `A video about ${person.display_name} is trending at #${video.rank} on YouTube: "${title}", from ${video.channelTitle}.`;
  return {
    headline,
    // The appearance is what happened, and it happened when the chart showed
    // it — not when the video was uploaded, which may be days earlier.
    occurredAt: now,
    dedupeKey: `${YOUTUBE_TRENDING_SOURCE_NAME}:video:${video.videoId}:${person.slug}`,
    rawPayload: {
      kind: TRENDING_KIND,
      source: YOUTUBE_TRENDING_SOURCE_NAME,
      chart: "mostPopular",
      region,
      video_id: video.videoId,
      rank: video.rank,
      route: match.route,
      matched_term: match.term,
      channel_id: video.channelId,
      // channelTitle / videoTitle / publishedAt are the keys the sentiment
      // prompt's payload allow-list already carries (the comments connector
      // set the convention), so the model sees which channel and which video
      // without the allow-list widening.
      channelTitle: video.channelTitle,
      videoTitle: video.title,
      publishedAt: video.publishedAt,
      category_id: video.categoryId,
      view_count: video.viewCount,
      observed_at: now.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

function availability(): ConnectorAvailability {
  return getYouTubeApiKeyOrNull() ? { ok: true } : { ok: false, reason: "YOUTUBE_API_KEY is not set" };
}

export const youtubeTrendingConnector: DataConnector = {
  name: YOUTUBE_TRENDING_SOURCE_NAME,

  available: availability,

  /**
   * Events only, and no fetchMetrics on purpose: the rank is never a level to
   * baseline. The chart is fetched once for the run; this subject's videos
   * are the ones on their channel or naming them in the title, minus what
   * their disambiguation rules refuse. Chart order, so a subject with two
   * videos up reads highest rank first.
   */
  async fetchForPerson(person, identifier, context): Promise<RawSignal[]> {
    if (typeof window !== "undefined") throw new Error("The YouTube trending connector is server-only.");
    const apiKey = getYouTubeApiKeyOrNull();
    if (!apiKey) throw new ConnectorError("YOUTUBE_API_KEY is not set");

    const config = readTrendingConfig(context.config);
    const declared = readTrendingSubject(context.personConfig, identifier, person);
    const rules = readDisambiguation(context.personConfig);
    const chart = await chartFor(context, config, apiKey);

    // Handles the mapping still names are resolved here, one unit each and
    // cached, and every outcome is reported through the note channel: a
    // resolution so an operator can pin it and stop paying for it, a failure
    // so a handle that has gone stale is visible rather than silently leaving
    // the subject on the title route.
    const resolved = declared.handles.length > 0 ? await resolveHandles(declared.handles, apiKey, context.fetch) : [];
    for (const outcome of resolved) {
      if ("error" in outcome) {
        context.note?.(`handle ${outcome.handle} did not resolve (${outcome.error}); ${person.slug} keeps the title route for it`);
        continue;
      }
      const audience = outcome.subscriberCount === null ? "subscribers hidden" : `${outcome.subscriberCount.toLocaleString("en-US")} subscribers`;
      context.note?.(`handle ${outcome.handle} resolves to ${outcome.channelId} ("${outcome.title}", ${audience}); pin it in config.channel_ids and drop the handle to stop the lookup`);
    }
    const subject: TrendingSubject = {
      ...declared,
      channelIds: unique([...declared.channelIds, ...resolved.flatMap((outcome) => ("error" in outcome ? [] : [outcome.channelId]))]),
    };

    const signals: RawSignal[] = [];
    for (const video of chart) {
      const outcome = matchTrendingVideo(video, subject, rules);
      if (outcome === null) continue;
      if ("refused" in outcome) {
        context.exclude?.({ headline: video.title, reason: outcome.refused.reason, term: outcome.refused.term });
        continue;
      }
      signals.push(trendingSignal(person, video, outcome.match, config.region, context.now));
    }
    return signals;
  },
};
