import { beforeEach, describe, expect, it } from "vitest";

import { fakeFetchRoutes, makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { articleSignal, feedUrlFor, newsVolume, parseFeed, readRssConfig, resetFeedCache, rssConnector, type FeedItem } from "./rss";
import { ConnectorError } from "./types";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const person = makePerson();

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>"MrBeast" - Google News</title>
    <item>
      <title><![CDATA[MrBeast opens a theme park - Example Times]]></title>
      <link>https://news.google.com/rss/articles/one</link>
      <guid isPermaLink="false">one-guid</guid>
      <pubDate>Sat, 12 Sep 2026 10:30:00 GMT</pubDate>
      <source url="https://example.com">Example Times</source>
    </item>
    <item>
      <title>MrBeast sued over sweepstakes</title>
      <link>https://news.google.com/rss/articles/two</link>
      <pubDate>Fri, 11 Sep 2026 09:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Undated item</title>
      <link>https://news.google.com/rss/articles/three</link>
    </item>
    <item>
      <title></title>
      <link>https://news.google.com/rss/articles/blank</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Outlet tag feed</title>
  <entry>
    <title>Drake announces a tour</title>
    <id>tag:outlet.example,2026:1</id>
    <link rel="self" href="https://outlet.example/self/1"/>
    <link rel="alternate" href="https://outlet.example/drake-tour"/>
    <published>2026-09-12T08:00:00Z</published>
    <source><title>Outlet</title></source>
  </entry>
</feed>`;

describe("feedUrlFor", () => {
  it("keeps a URL and builds a Google News query from a term", () => {
    expect(feedUrlFor(" https://outlet.example/feed.xml ")).toBe("https://outlet.example/feed.xml");
    const url = new URL(feedUrlFor('"Drake" rapper'));
    expect(url.origin + url.pathname).toBe("https://news.google.com/rss/search");
    expect(url.searchParams.get("q")).toBe('"Drake" rapper');
    expect(url.searchParams.get("ceid")).toBe("US:en");
  });
});

describe("parseFeed", () => {
  it("reads RSS 2.0 with CDATA titles, guids, dates and outlets, dropping blank items", () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe('"MrBeast" - Google News');
    expect(feed.items).toHaveLength(3);
    expect(feed.items[0]).toEqual({ title: "MrBeast opens a theme park - Example Times", link: "https://news.google.com/rss/articles/one", guid: "one-guid", publishedAt: new Date("2026-09-12T10:30:00Z"), outlet: "Example Times" });
    expect(feed.items[1]).toMatchObject({ guid: null, outlet: '"MrBeast" - Google News', publishedAt: new Date("2026-09-11T09:00:00Z") });
    expect(feed.items[2].publishedAt).toBeNull();
  });

  it("reads Atom, preferring the alternate link", () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe("Outlet tag feed");
    expect(feed.items).toEqual([{ title: "Drake announces a tour", link: "https://outlet.example/drake-tour", guid: "tag:outlet.example,2026:1", publishedAt: new Date("2026-09-12T08:00:00Z"), outlet: "Outlet" }]);
  });

  it("refuses what is not a feed", () => {
    expect(() => parseFeed("<html><body>not a feed</body></html>")).toThrow(ConnectorError);
    expect(() => parseFeed("<rss><channel><item><title>unclosed")).toThrow(/Feed is/);
  });
});

describe("articleSignal and newsVolume", () => {
  const items = parseFeed(RSS).items;

  it("keys on the guid, then the link, and dates by pubDate or the run", () => {
    const first = articleSignal(items[0], NOW)!;
    expect(first).toMatchObject({ headline: "MrBeast opens a theme park - Example Times", dedupeKey: "rss:one-guid", occurredAt: new Date("2026-09-12T10:30:00Z") });
    expect(first.rawPayload).toEqual({ kind: "article", source: "rss", outlet: "Example Times", link: "https://news.google.com/rss/articles/one", guid: "one-guid", publishedAt: "2026-09-12T10:30:00.000Z" });
    expect(articleSignal(items[1], NOW)!.dedupeKey).toBe("rss:https://news.google.com/rss/articles/two");
    expect(articleSignal(items[2], NOW)!.occurredAt).toBe(NOW);
    expect(articleSignal({ title: "x", link: null, guid: null, publishedAt: null, outlet: null }, NOW)).toBeNull();
  });

  it("counts dated items inside the trailing window only", () => {
    expect(newsVolume(items, NOW, 24)).toBe(1);
    expect(newsVolume(items, NOW, 48)).toBe(2);
    const future: FeedItem = { title: "f", link: "l", guid: null, publishedAt: new Date(NOW.getTime() + 3_600_000), outlet: null };
    expect(newsVolume([future], NOW, 24)).toBe(0);
  });
});

describe("rssConnector", () => {
  beforeEach(() => resetFeedCache());

  const context = (fetch: typeof globalThis.fetch, config: Record<string, unknown> = {}) => ({
    source: makeSource({ name: "rss" }),
    config: config as Record<string, never>,
    snapshots: { latest: async () => null, record: () => undefined },
    now: NOW,
    fetch,
  });

  it("needs no credentials, fetches the feed once for both events and the volume metric, and honours max_items", async () => {
    expect(rssConnector.available).toBeUndefined();
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: RSS }]);
    const url = feedUrlFor('"MrBeast"');
    const signals = await rssConnector.fetchForPerson(person, url, context(fetch, { max_items: 2 }));
    const readings = await rssConnector.fetchMetrics!(person, url, context(fetch, { max_items: 2 }));
    expect(fetch.calls).toEqual([url]);
    expect(signals.map((s) => s.headline)).toEqual(["MrBeast opens a theme park - Example Times", "MrBeast sued over sweepstakes"]);
    expect(readings).toEqual([{ metricKey: "news_volume_24h", value: 1 }]);
    expect(readRssConfig({ max_items: 500, volume_window_hours: 0 })).toEqual({ max_items: 100, volume_window_hours: 24 });
  });

  it("turns an HTTP failure into a ConnectorError and refuses an empty identifier", async () => {
    const fetch = fakeFetchRoutes([{ match: "outlet.example", body: "gone", status: 503 }]);
    await expect(rssConnector.fetchForPerson(person, "https://outlet.example/feed", context(fetch))).rejects.toMatchObject({ name: "ConnectorError", status: 503, retryable: true });
    await expect(rssConnector.fetchForPerson(person, "  ", context(fetch))).rejects.toThrow(/No feed configured/);
  });
});
