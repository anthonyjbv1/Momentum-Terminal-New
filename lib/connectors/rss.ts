import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { Json } from "@/types/database";

import { ConnectorError, type ConnectorContext, type DataConnector, type MetricReading, type RawSignal } from "./types";

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
 *   events    one signal per new item: the headline as the outlet wrote it,
 *             deduplicated by guid or link, dated by pubDate; the sentiment
 *             scorer reads the text
 *   metric    news_volume_24h, how many items the feed carries from the
 *             trailing volume window, a raw level the runner normalises
 *             against the person's own trailing weeks; the viral-moment
 *             frequency is derived from its spikes (config.derived)
 */

export const RSS_SOURCE_NAME = "rss";

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
  title: string;
  link: string | null;
  guid: string | null;
  publishedAt: Date | null;
  outlet: string | null;
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
      return [
        {
          title,
          link: alternate ? text(alternate) : null,
          guid: text(entry.id),
          publishedAt: date(entry.published) ?? date(entry.updated),
          outlet: text((entry.source as Record<string, unknown> | undefined)?.title) ?? feedTitle,
        },
      ];
    });
    return { title: feedTitle, items };
  }

  throw new ConnectorError("Feed is neither RSS 2.0 nor Atom");
}

export function articleSignal(item: FeedItem, now: Date): RawSignal | null {
  const key = item.guid ?? item.link;
  if (!key) return null;
  return {
    headline: item.title,
    occurredAt: item.publishedAt ?? now,
    dedupeKey: `rss:${key}`,
    rawPayload: {
      kind: "article",
      source: RSS_SOURCE_NAME,
      outlet: item.outlet,
      link: item.link,
      guid: item.guid,
      publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
    },
  };
}

/** Items published inside the trailing window. Undated items are not counted. */
export function newsVolume(items: FeedItem[], now: Date, windowHours: number): number {
  const since = now.getTime() - windowHours * 3_600_000;
  return items.filter((item) => item.publishedAt !== null && item.publishedAt.getTime() >= since && item.publishedAt.getTime() <= now.getTime() + 60_000).length;
}

// One fetch serves both fetchForPerson and fetchMetrics within a run: the
// parsed feed is kept for a few minutes, keyed by feed URL and run time.
const FEED_CACHE_TTL_MS = 10 * 60_000;
const feedCache = new Map<string, { at: number; feed: ReturnType<typeof parseFeed> }>();

/** For tests. */
export function resetFeedCache(): void {
  feedCache.clear();
}

async function loadFeed(identifier: string, context: ConnectorContext): Promise<ReturnType<typeof parseFeed>> {
  const url = feedUrlFor(identifier);
  const key = `${url}|${context.now.toISOString()}`;
  const cached = feedCache.get(key);
  if (cached && Date.now() - cached.at < FEED_CACHE_TTL_MS) return cached.feed;
  for (const [k, entry] of feedCache) if (Date.now() - entry.at >= FEED_CACHE_TTL_MS) feedCache.delete(k);

  const response = await context.fetch(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8" } });
  if (!response.ok) {
    throw new ConnectorError(`Feed responded ${response.status}`, { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }
  const feed = parseFeed(await response.text());
  feedCache.set(key, { at: Date.now(), feed });
  return feed;
}

export const rssConnector: DataConnector = {
  name: RSS_SOURCE_NAME,

  async fetchForPerson(person, identifier, context) {
    if (typeof window !== "undefined") throw new Error("The RSS connector is server-only.");
    if (!identifier.trim()) throw new ConnectorError(`No feed configured for ${person.slug}`);
    const config = readRssConfig(context.config);
    const feed = await loadFeed(identifier, context);
    return feed.items
      .slice(0, config.max_items)
      .map((item) => articleSignal(item, context.now))
      .filter((signal): signal is RawSignal => signal !== null);
  },

  async fetchMetrics(person, identifier, context): Promise<MetricReading[]> {
    if (!identifier.trim()) throw new ConnectorError(`No feed configured for ${person.slug}`);
    const config = readRssConfig(context.config);
    const feed = await loadFeed(identifier, context);
    return [{ metricKey: "news_volume_24h", value: newsVolume(feed.items, context.now, config.volume_window_hours) }];
  },
};
