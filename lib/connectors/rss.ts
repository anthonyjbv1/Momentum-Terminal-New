import { XMLParser, XMLValidator } from "fast-xml-parser";

import { EMPTY_DISAMBIGUATION, applyQueryExclusions, excludeReason, hasRules, obituaryReason, readDisambiguation, subjectNames, type ExclusionVerdict } from "@/lib/ingest/disambiguation";
import { publisherDomainOf, type PublisherPolicy } from "@/lib/ingest/publishers";
import { collapseStories, personNames, storyTokens, stripOutletSuffix } from "@/lib/ingest/stories";
import type { Person } from "@/types";
import type { Json } from "@/types/database";

import { ConnectorError, type ConnectorContext, type ConnectorQuality, type DataConnector, type MetricReading, type RawSignal } from "./types";

/**
 * RSS connector — a curated, person-scoped news feed.
 *
 * Every person_data_sources row for this source holds a feed URL that is
 * ABOUT that person (a Google News RSS query for their name, an outlet's
 * tag feed), or a bare search term from which the Google News query is
 * built. Needs no credentials. The fetch happens inside the ingestion
 * runner, server to server, so browser CORS never applies; never fetch a
 * feed from client code.
 *
 * Two kinds of evidence from one fetch:
 *   events    one signal per new item: the headline as the outlet wrote it
 *             (the outlet suffix Google News appends removed), keyed by guid
 *             or link, dated by pubDate; the sentiment scorer reads the
 *             text. Each item names its PUBLISHER DOMAIN, from the feed's
 *             source element (Google News wraps every link in its own
 *             redirect and names the publisher in `<source url=...>`) or
 *             else the link's host, and its STORY text, so the runner can
 *             resolve a credibility tier per item through the publisher
 *             allowlist and collapse syndicated copies of one story into one
 *             signal. The connector itself weighs nothing.
 *   metric    news_volume_24h, how many DISTINCT, non-blocked stories the
 *             feed carries from the trailing volume window, a raw level the
 *             runner normalises against the person's own trailing weeks; the
 *             viral-moment frequency is derived from its spikes
 *             (config.derived)
 */

export const RSS_SOURCE_NAME = "rss";
/**
 * The story family the two news connectors share (Phase 13): a story the
 * publisher's own feed delivered is the same story when the aggregator
 * surfaces it later, so the runner deduplicates across both.
 */
export const NEWS_STORY_FAMILY = "news";

export interface RssConnectorConfig {
  /** Newest items stored per poll. Default 30, at most 100. */
  max_items: number;
  /** The news_volume window, in hours. Default 24. */
  volume_window_hours: number;
}

const DEFAULT_CONFIG: RssConnectorConfig = { max_items: 30, volume_window_hours: 24 };

export function readRssConfig(config: Record<string, Json | undefined>): RssConnectorConfig {
  const items = config.max_items;
  const hours = config.volume_window_hours;
  return {
    max_items: typeof items === "number" && Number.isInteger(items) && items > 0 ? Math.min(100, items) : DEFAULT_CONFIG.max_items,
    volume_window_hours: typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_CONFIG.volume_window_hours,
  };
}

/** A search term becomes a Google News RSS query; a URL is used as it is. */
export function feedUrlFor(identifier: string): string {
  const trimmed = identifier.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  return url.toString();
}

export interface FeedItem {
  /** The title as the feed carries it (Google News: "Headline - Outlet"). */
  title: string;
  link: string | null;
  guid: string | null;
  publishedAt: Date | null;
  outlet: string | null;
  /** The publisher's site as the feed names it (`<source url="...">` in Google News RSS, the source link in Atom), or null. */
  sourceUrl: string | null;
  /** Whether the item carries a description or body beyond its headline. Read for feed health only; the text itself is never kept. */
  hasDescription?: boolean;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "#cdata", trimValues: true });

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return text(record["#cdata"]) ?? text(record["#text"]) ?? text(record["@_href"]) ?? null;
  }
  return null;
}

/** An element's attribute, when the element was parsed as an object carrying it. */
function attribute(value: unknown, name: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[`@_${name}`];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function date(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parses RSS 2.0 or Atom into items in the order the feed lists them. */
export function parseFeed(xml: string): { title: string | null; items: FeedItem[] } {
  const validity = XMLValidator.validate(xml);
  if (validity !== true) {
    throw new ConnectorError(`Feed is not well-formed XML: ${validity.err.msg}`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new ConnectorError(`Feed is not well-formed XML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rss = doc.rss as { channel?: Record<string, unknown> } | undefined;
  if (rss?.channel) {
    const channel = rss.channel;
    const channelTitle = text(channel.title);
    const items = asArray(channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined).flatMap((item) => {
      const title = text(item.title);
      if (!title) return [];
      return [
        {
          title,
          link: text(item.link),
          guid: text(item.guid),
          publishedAt: date(item.pubDate) ?? date(item["dc:date"]),
          outlet: text(item.source) ?? channelTitle,
          sourceUrl: attribute(item.source, "url"),
          hasDescription: (text(item.description) ?? text(item["content:encoded"])) !== null,
        },
      ];
    });
    return { title: channelTitle, items };
  }

  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    const feedTitle = text(feed.title);
    const items = asArray(feed.entry as Record<string, unknown> | Record<string, unknown>[] | undefined).flatMap((entry) => {
      const title = text(entry.title);
      if (!title) return [];
      const links = asArray(entry.link as Record<string, unknown> | Record<string, unknown>[] | undefined);
      const alternate = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
      const source = entry.source as Record<string, unknown> | undefined;
      const sourceLinks = asArray(source?.link as Record<string, unknown> | Record<string, unknown>[] | undefined);
      const sourceLink = sourceLinks.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? sourceLinks[0];
      return [
        {
          title,
          link: alternate ? text(alternate) : null,
          guid: text(entry.id),
          publishedAt: date(entry.published) ?? date(entry.updated),
          outlet: text(source?.title) ?? feedTitle,
          sourceUrl: sourceLink ? text(sourceLink) : null,
          hasDescription: (text(entry.summary) ?? text(entry.content)) !== null,
        },
      ];
    });
    return { title: feedTitle, items };
  }

  throw new ConnectorError("Feed is neither RSS 2.0 nor Atom");
}

/**
 * A DATE WE CAN BELIEVE (Phase 18++).
 *
 * Two holes, opposite in direction, both closed here. An item with no date at
 * all used to be stamped with the poll's own clock, which made it maximally
 * FRESH — the worst possible reading for something we know nothing about. And
 * an item whose date parsed to the epoch was taken at face value: Google News
 * emits `Thu, 01 Jan 1970 00:00:00 GMT` for an entry that has no publication
 * date, such as a publisher's standing profile page, and one of those
 * ("Sergey Brin - Forbes", forbes.com) reached production on 2026-09-17 dated
 * 1970-01-01.
 *
 * publisher_rss has refused undated items since Phase 13. This is the same
 * rule at the aggregator door: an item without a date we can believe is not
 * stored at all, rather than guessed at from either end. The metric side was
 * already safe — newsVolume() only ever counted dated items inside its window.
 */
export const EARLIEST_PLAUSIBLE_PUBLISHED_AT = Date.UTC(2000, 0, 1);
/** A feed clock a few minutes ahead of ours is not a future article. */
export const FUTURE_TOLERANCE_MS = 10 * 60_000;

export function hasBelievableDate(item: FeedItem, now: Date): boolean {
  if (item.publishedAt === null) return false;
  const at = item.publishedAt.getTime();
  return at >= EARLIEST_PLAUSIBLE_PUBLISHED_AT && at <= now.getTime() + FUTURE_TOLERANCE_MS;
}

/**
 * STALE ON ARRIVAL (Phase 31). Google News resurfaces old items with their
 * original dates: a first poll for a subject returns their evergreen
 * profiles, and a quiet week returns July. The Engine already weights such an
 * item at exactly zero past freshnessMaxAgeHours and never sends it to the
 * model, so storing it moves no score; what it does is fill the person's
 * recent lists and, when it is less than the volume window old, their volume
 * series. Measured before this rule: 44 of Adin Ross's 47 stored articles in
 * the week of 09-14 were older than seven days when stored, every one at
 * 0.00. With the quality rules on, an item published more than
 * `maxAgeHours` before the poll is not stored at all, and the poll row says
 * how many were refused, as it does for undated items.
 */
export function isStaleItem(item: FeedItem, now: Date, quality: ConnectorQuality | undefined): boolean {
  if (!quality || item.publishedAt === null) return false;
  return now.getTime() - item.publishedAt.getTime() > quality.maxAgeHours * 3_600_000;
}

export function articleSignal(item: FeedItem, now: Date): RawSignal | null {
  const key = item.guid ?? item.link;
  if (!key) return null;
  if (!hasBelievableDate(item, now)) return null;
  const publishedAt = item.publishedAt as Date;
  const headline = stripOutletSuffix(item.title, item.outlet);
  const publisher = publisherDomainOf(item);
  return {
    headline,
    story: headline,
    publisherDomain: publisher.domain,
    occurredAt: publishedAt,
    dedupeKey: `rss:${key}`,
    rawPayload: {
      kind: "article",
      source: RSS_SOURCE_NAME,
      outlet: item.outlet,
      title: item.title,
      link: item.link,
      guid: item.guid,
      publishedAt: publishedAt.toISOString(),
      source_url: item.sourceUrl,
      publisher_domain: publisher.domain,
      publisher_domain_from: publisher.from,
    },
  };
}

export interface NewsVolumeOptions {
  /** The run's publisher allowlist: blocked domains are not counted. Absent = nothing is blocked. */
  publishers?: PublisherPolicy;
  /** The person's names, removed before stories are compared. */
  personNames?: string[];
}

/**
 * Distinct stories published inside the trailing window: dated items only,
 * blocked publishers excluded, syndicated copies of one story counted once
 * (the same rule the runner applies before a signal is stored). A metric
 * that counted URLs would teach the baseline that a wire pickup is news.
 */
export function newsVolume(items: FeedItem[], now: Date, windowHours: number, options: NewsVolumeOptions = {}): number {
  const since = now.getTime() - windowHours * 3_600_000;
  const inWindow = items.filter((item) => item.publishedAt !== null && item.publishedAt.getTime() >= since && item.publishedAt.getTime() <= now.getTime() + 60_000);
  const resolved = inWindow
    .map((item) => ({ item, publisher: options.publishers?.resolve(publisherDomainOf(item).domain) ?? null }))
    .filter(({ publisher }) => publisher === null || publisher.status !== "blocked");
  const { kept } = collapseStories(
    resolved,
    ({ item, publisher }) => ({
      tokens: storyTokens(item.title, { personNames: options.personNames, outlet: item.outlet }),
      tier: publisher && publisher.status !== "blocked" ? publisher.tier : 5,
      occurredAt: item.publishedAt as Date,
    }),
    [],
  );
  return kept.length;
}

// One fetch serves both fetchForPerson and fetchMetrics within a run: the
// parsed feed is kept for a few minutes, keyed by feed URL and run time.
const FEED_CACHE_TTL_MS = 10 * 60_000;
const feedCache = new Map<string, { at: number; feed: ReturnType<typeof parseFeed> }>();

/** For tests. */
export function resetFeedCache(): void {
  feedCache.clear();
}

/**
 * Fetches, parses and DISAMBIGUATES the feed, once per poll.
 *
 * The filtering lives here, ahead of the split into signals and the volume
 * metric, because both must see the same admitted set. An item about Drake
 * University is not only a bad signal; it is also a phantom unit of
 * news_volume_24h, and that metric is being baselined right now. Filtering in
 * only one of the two paths would fix the Feed and quietly corrupt the
 * baseline.
 *
 * Refusals are reported through `context.exclude` on the fetch that did the
 * work; the second caller reads the cache and reports nothing, so each refused
 * item is counted once per poll rather than twice.
 */
async function loadFeed(person: Person, identifier: string, context: ConnectorContext): Promise<ReturnType<typeof parseFeed>> {
  const rules = readDisambiguation(context.personConfig);
  // Query level first: what the feed never sends costs nothing to discard, and
  // it leaves room in a fixed-size window for items that are about the subject.
  const url = applyQueryExclusions(feedUrlFor(identifier), rules);
  const key = `${url}|${context.now.toISOString()}`;
  const cached = feedCache.get(key);
  if (cached && Date.now() - cached.at < FEED_CACHE_TTL_MS) return cached.feed;
  for (const [k, entry] of feedCache) if (Date.now() - entry.at >= FEED_CACHE_TTL_MS) feedCache.delete(k);

  const response = await context.fetch(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8" } });
  if (!response.ok) {
    throw new ConnectorError(`Feed responded ${response.status}`, { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }
  const parsed = parseFeed(await response.text());

  // Post-fetch, over the title as the feed wrote it — which on Google News
  // still carries the outlet suffix, so an outlet's own name ("Drake
  // Athletics") counts as evidence too.
  //
  // With the quality rules on (Phase 31) every item is judged against the
  // SUBJECT as well: the name-conditional exclusions, the namesake guard for
  // an unknown publisher, and the obituary guard, which needs no rules at all.
  // The subject is judged on the headline alone, without the outlet suffix: an
  // outlet's name is evidence for an exclusion, never evidence of naming.
  const quality = context.quality;
  const names = quality ? subjectNames(person, rules) : [];
  const items: FeedItem[] = [];
  const refused: Array<{ item: FeedItem; verdict: ExclusionVerdict }> = [];
  if (hasRules(rules) || quality) {
    for (const item of parsed.items) {
      // The Phase 10 rules, exactly as before: substring, title and outlet.
      let verdict = excludeReason(`${item.title} ${item.outlet ?? ""}`, rules);
      if (!verdict && quality) {
        const headline = stripOutletSuffix(item.title, item.outlet);
        const publisher = publisherDomainOf(item);
        const resolution = context.publishers?.resolve(publisher.domain) ?? { status: "unknown" as const };
        const subject = { names, unknownPublisher: resolution.status === "unknown" };
        verdict =
          excludeReason(headline, { ...EMPTY_DISAMBIGUATION, exclude_unless_named: rules.exclude_unless_named, namesake_guard: rules.namesake_guard, aliases: rules.aliases }, subject) ??
          obituaryReason({ headline, outlet: item.outlet, domain: publisher.domain });
      }
      if (verdict) refused.push({ item, verdict });
      else items.push(item);
    }
  } else {
    items.push(...parsed.items);
  }
  const feed = { title: parsed.title, items };

  feedCache.set(key, { at: Date.now(), feed });
  for (const { item, verdict } of refused) {
    context.exclude?.({ headline: item.title, reason: verdict.reason, term: verdict.term });
  }
  return feed;
}

export const rssConnector: DataConnector = {
  name: RSS_SOURCE_NAME,
  storyFamily: NEWS_STORY_FAMILY,

  async fetchForPerson(person, identifier, context) {
    if (typeof window !== "undefined") throw new Error("The RSS connector is server-only.");
    if (!identifier.trim()) throw new ConnectorError(`No feed configured for ${person.slug}`);
    const config = readRssConfig(context.config);
    const feed = await loadFeed(person, identifier, context);
    const considered = feed.items.slice(0, config.max_items);
    const fresh = considered.filter((item) => !isStaleItem(item, context.now, context.quality));
    const signals = fresh.map((item) => articleSignal(item, context.now)).filter((signal): signal is RawSignal => signal !== null);
    // A refusal that is only a missing row is a refusal nobody sees: the one
    // epoch-dated item of 2026-09-17 sat in production for a day unnoticed.
    const undated = considered.filter((item) => !hasBelievableDate(item, context.now)).length;
    if (undated > 0) context.note?.(`${undated} of ${considered.length} items refused: no believable publication date`);
    const stale = considered.length - fresh.length;
    if (stale > 0) context.note?.(`${stale} of ${considered.length} items refused: published more than ${context.quality?.maxAgeHours} h before the poll`);
    return signals;
  },

  async fetchMetrics(person, identifier, context): Promise<MetricReading[]> {
    if (!identifier.trim()) throw new ConnectorError(`No feed configured for ${person.slug}`);
    const config = readRssConfig(context.config);
    const feed = await loadFeed(person, identifier, context);
    const value = newsVolume(feed.items, context.now, config.volume_window_hours, { publishers: context.publishers, personNames: personNames(person) });
    return [{ metricKey: "news_volume_24h", value }];
  },
};
