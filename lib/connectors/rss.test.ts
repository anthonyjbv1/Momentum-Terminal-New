import { beforeEach, describe, expect, it } from "vitest";

import { fakeFetchRoutes, makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { buildPublisherPolicy } from "@/lib/ingest/publishers";
import { personNames } from "@/lib/ingest/stories";

import { EARLIEST_PLAUSIBLE_PUBLISHED_AT, FUTURE_TOLERANCE_MS, articleSignal, feedUrlFor, hasBelievableDate, isStaleItem, newsVolume, parseFeed, readRssConfig, resetFeedCache, rssConnector, type FeedItem } from "./rss";
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
  it("reads RSS 2.0 with CDATA titles, guids, dates, outlets and the source URL, dropping blank items", () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe('"MrBeast" - Google News');
    expect(feed.items).toHaveLength(3);
    expect(feed.items[0]).toEqual({ title: "MrBeast opens a theme park - Example Times", link: "https://news.google.com/rss/articles/one", guid: "one-guid", publishedAt: new Date("2026-09-12T10:30:00Z"), outlet: "Example Times", sourceUrl: "https://example.com", hasDescription: false });
    expect(feed.items[1]).toMatchObject({ guid: null, outlet: '"MrBeast" - Google News', publishedAt: new Date("2026-09-11T09:00:00Z"), sourceUrl: null });
    expect(feed.items[2].publishedAt).toBeNull();
  });

  it("reads Atom, preferring the alternate link", () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe("Outlet tag feed");
    expect(feed.items).toEqual([{ title: "Drake announces a tour", link: "https://outlet.example/drake-tour", guid: "tag:outlet.example,2026:1", publishedAt: new Date("2026-09-12T08:00:00Z"), outlet: "Outlet", sourceUrl: null, hasDescription: false }]);
  });

  it("refuses what is not a feed", () => {
    expect(() => parseFeed("<html><body>not a feed</body></html>")).toThrow(ConnectorError);
    expect(() => parseFeed("<rss><channel><item><title>unclosed")).toThrow(/Feed is/);
  });
});

describe("articleSignal and newsVolume", () => {
  const items = parseFeed(RSS).items;

  it("keys on the guid, then the link, refuses an item with no believable date, and names the publisher and the story", () => {
    const first = articleSignal(items[0], NOW)!;
    // The outlet suffix Google News appends is not part of the headline; the publisher comes from the source URL, never the Google News link.
    expect(first).toMatchObject({ headline: "MrBeast opens a theme park", story: "MrBeast opens a theme park", publisherDomain: "example.com", dedupeKey: "rss:one-guid", occurredAt: new Date("2026-09-12T10:30:00Z") });
    expect(first.rawPayload).toEqual({
      kind: "article",
      source: "rss",
      outlet: "Example Times",
      title: "MrBeast opens a theme park - Example Times",
      link: "https://news.google.com/rss/articles/one",
      guid: "one-guid",
      publishedAt: "2026-09-12T10:30:00.000Z",
      source_url: "https://example.com",
      publisher_domain: "example.com",
      publisher_domain_from: "source",
    });
    // No source URL and a Google News link: the item names no publisher (the runner treats it as unknown, never as news.google.com).
    const second = articleSignal(items[1], NOW)!;
    expect(second).toMatchObject({ dedupeKey: "rss:https://news.google.com/rss/articles/two", publisherDomain: null });
    expect(second.rawPayload).toMatchObject({ publisher_domain: null, publisher_domain_from: null });
    // A direct outlet feed: the link's host is the publisher.
    const atom = articleSignal(parseFeed(ATOM).items[0], NOW)!;
    expect(atom).toMatchObject({ publisherDomain: "outlet.example", headline: "Drake announces a tour" });
    expect(atom.rawPayload).toMatchObject({ publisher_domain: "outlet.example", publisher_domain_from: "link" });
    // Phase 18++: an item without a date we can believe is refused outright
    // rather than stamped with the run's clock, which made it maximally FRESH.
    expect(articleSignal(items[2], NOW)).toBeNull();
    expect(articleSignal({ title: "x", link: null, guid: null, publishedAt: null, outlet: null, sourceUrl: null }, NOW)).toBeNull();
    expect(personNames(person)).toEqual(["MrBeast", "James Stephen Donaldson"]);
  });

  /**
   * PHASE 18++. The two date holes, one realised and one latent, both closed.
   * Google News emits the epoch for an entry with no publication date — a
   * publisher's standing profile page, say — and one of those ("Sergey Brin -
   * Forbes", forbes.com) reached production on 2026-09-17 dated 1970-01-01.
   * The other direction was worse: an item with no date at all was stamped
   * with the run's clock, making the least trustworthy item the freshest.
   */
  it("refuses an item whose date we cannot believe: none at all, the epoch, or the far future", () => {
    const item = (publishedAt: Date | null): FeedItem => ({ title: "Sergey Brin - Forbes", link: "https://news.google.com/rss/articles/x", guid: "x", publishedAt, outlet: "Forbes", sourceUrl: "https://www.forbes.com" });
    expect(hasBelievableDate(item(null), NOW)).toBe(false);
    expect(hasBelievableDate(item(new Date(0)), NOW)).toBe(false);
    expect(hasBelievableDate(item(new Date("1999-12-31T23:59:59Z")), NOW)).toBe(false);
    expect(hasBelievableDate(item(new Date(NOW.getTime() + 60 * 60_000)), NOW)).toBe(false);
    // The boundaries: the floor itself and a feed clock a few minutes fast.
    expect(hasBelievableDate(item(new Date(EARLIEST_PLAUSIBLE_PUBLISHED_AT)), NOW)).toBe(true);
    expect(hasBelievableDate(item(new Date(NOW.getTime() + FUTURE_TOLERANCE_MS - 1)), NOW)).toBe(true);
    // And the refusal reaches the signal, so nothing epoch-dated is stored.
    expect(articleSignal(item(new Date(0)), NOW)).toBeNull();
    expect(articleSignal(item(null), NOW)).toBeNull();
    expect(articleSignal(item(new Date("2026-09-12T10:30:00Z")), NOW)).not.toBeNull();
  });

  it("counts dated items inside the trailing window only", () => {
    expect(newsVolume(items, NOW, 24)).toBe(1);
    expect(newsVolume(items, NOW, 48)).toBe(2);
    const future: FeedItem = { title: "f", link: "l", guid: null, publishedAt: new Date(NOW.getTime() + 3_600_000), outlet: null, sourceUrl: null };
    expect(newsVolume([future], NOW, 24)).toBe(0);
  });

  it("counts distinct stories, not copies, and never a blocked publisher", () => {
    const item = (title: string, outlet: string, sourceUrl: string, minutesAgo: number): FeedItem => ({ title: `${title} - ${outlet}`, outlet, sourceUrl, link: "https://news.google.com/rss/articles/x", guid: null, publishedAt: new Date(NOW.getTime() - minutesAgo * 60_000) });
    const feed = [
      item("MrBeast opens a theme park in Kansas", "Example Times", "https://www.example.com", 60),
      item("MrBeast opens theme park in Kansas", "Copy Cat Daily", "https://copycat.example", 50),
      item("MrBeast Opens a Theme Park in Kansas", "Farm", "https://farm.example", 40),
      item("MrBeast sued over sweepstakes", "Example Times", "https://www.example.com", 30),
    ];
    const publishers = buildPublisherPolicy([{ domain: "example.com", status: "allowed", tier: 2 }, { domain: "farm.example", status: "blocked", tier: null }]);
    expect(newsVolume(feed, NOW, 24)).toBe(2);
    expect(newsVolume(feed, NOW, 24, { publishers, personNames: personNames(person) })).toBe(2);
    expect(newsVolume(feed.slice(2), NOW, 24, { publishers })).toBe(1);
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
    expect(signals.map((s) => s.headline)).toEqual(["MrBeast opens a theme park", "MrBeast sued over sweepstakes"]);
    expect(signals.map((s) => s.publisherDomain)).toEqual(["example.com", null]);
    expect(readings).toEqual([{ metricKey: "news_volume_24h", value: 1 }]);
    expect(readRssConfig({ max_items: 500, volume_window_hours: 0 })).toEqual({ max_items: 100, volume_window_hours: 24 });
  });

  it("turns an HTTP failure into a ConnectorError and refuses an empty identifier", async () => {
    const fetch = fakeFetchRoutes([{ match: "outlet.example", body: "gone", status: 503 }]);
    await expect(rssConnector.fetchForPerson(person, "https://outlet.example/feed", context(fetch))).rejects.toMatchObject({ name: "ConnectorError", status: 503, retryable: true });
    await expect(rssConnector.fetchForPerson(person, "  ", context(fetch))).rejects.toThrow(/No feed configured/);
  });
});

describe("entity disambiguation", () => {
  beforeEach(() => resetFeedCache());

  /** Two real Drake stories and the Drake University one that reached production. */
  const MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>"Drake" - Google News</title>
    <item>
      <title><![CDATA[Michigan State Adds Non-Conference Game Against Drake - Roundtable]]></title>
      <link>https://news.google.com/rss/articles/uni</link>
      <guid isPermaLink="false">uni-guid</guid>
      <pubDate>Sat, 12 Sep 2026 10:30:00 GMT</pubDate>
      <source url="https://roundtable.io">Roundtable</source>
    </item>
    <item>
      <title><![CDATA[Drake Reveals the Only Gift He Wants for His 40th Birthday - Billboard]]></title>
      <link>https://news.google.com/rss/articles/gift</link>
      <guid isPermaLink="false">gift-guid</guid>
      <pubDate>Sat, 12 Sep 2026 09:00:00 GMT</pubDate>
      <source url="https://billboard.com">Billboard</source>
    </item>
    <item>
      <title><![CDATA[Drake Bell speaks out again - Example Times]]></title>
      <link>https://news.google.com/rss/articles/bell</link>
      <guid isPermaLink="false">bell-guid</guid>
      <pubDate>Sat, 12 Sep 2026 08:00:00 GMT</pubDate>
      <source url="https://example.com">Example Times</source>
    </item>
  </channel>
</rss>`;

  const drakeRules = { disambiguation: { exclude_terms: ["drake university", "non-conference", "drake bell"], require_any: [] } };

  /** The same context the connector normally gets, with no per-subject rules. */
  const plainContext = (fetch: typeof globalThis.fetch) => ({
    source: makeSource({ name: "rss" }),
    config: {} as Record<string, never>,
    snapshots: { latest: async () => null, record: () => undefined },
    now: NOW,
    fetch,
  });

  const disambiguatingContext = (fetch: typeof globalThis.fetch, excluded: unknown[]) => ({
    source: makeSource({ name: "rss" }),
    config: {} as Record<string, never>,
    snapshots: { latest: async () => null, record: () => undefined },
    now: NOW,
    fetch,
    personConfig: drakeRules,
    exclude: (item: unknown) => excluded.push(item),
  });

  it("refuses the other entity's items and keeps the subject's", async () => {
    const excluded: unknown[] = [];
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: MIXED }]);
    const signals = await rssConnector.fetchForPerson(person, feedUrlFor('"Drake"'), disambiguatingContext(fetch, excluded));
    expect(signals.map((s) => s.headline)).toEqual(["Drake Reveals the Only Gift He Wants for His 40th Birthday"]);
    expect(excluded).toEqual([
      { headline: "Michigan State Adds Non-Conference Game Against Drake - Roundtable", reason: "excluded_term", term: "non-conference" },
      { headline: "Drake Bell speaks out again - Example Times", reason: "excluded_term", term: "drake bell" },
    ]);
  });

  it("keeps the refused items out of news_volume_24h, not only out of the Feed", async () => {
    // The whole point: a phantom unit of volume corrupts a metric that is being
    // baselined, so filtering the signals alone would fix the Feed and quietly
    // poison the baseline.
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: MIXED }]);
    const withRules = await rssConnector.fetchMetrics!(person, feedUrlFor('"Drake"'), disambiguatingContext(fetch, []));
    resetFeedCache();
    const plain = await rssConnector.fetchMetrics!(person, feedUrlFor('"Drake"'), plainContext(fakeFetchRoutes([{ match: "news.google.com/rss/search", body: MIXED }])));
    expect(plain[0].value).toBe(3);
    expect(withRules[0].value).toBe(1);
  });

  it("pushes the exclusions into the query, and reports each refusal once per poll", async () => {
    const excluded: unknown[] = [];
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: MIXED }]);
    const ctx = disambiguatingContext(fetch, excluded);
    await rssConnector.fetchForPerson(person, feedUrlFor('"Drake"'), ctx);
    await rssConnector.fetchMetrics!(person, feedUrlFor('"Drake"'), ctx);
    expect(fetch.calls).toHaveLength(1);
    // Read the parsed parameter rather than the raw URL: URLSearchParams
    // percent-encodes the quotes and writes spaces as "+".
    const query = new URL(fetch.calls[0]).searchParams.get("q") ?? "";
    expect(query).toContain('-"drake university"');
    expect(query).toContain('-"non-conference"');
    // Two refusals, reported once — not once per caller.
    expect(excluded).toHaveLength(2);
  });

  it("is inert for a subject with no rules configured", async () => {
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: MIXED }]);
    const signals = await rssConnector.fetchForPerson(person, feedUrlFor('"Drake"'), plainContext(fetch));
    expect(signals).toHaveLength(3);
    // The feed URL is untouched — no negative terms appended at all.
    expect(fetch.calls[0]).toBe(feedUrlFor('"Drake"'));
  });
});

describe("the signal-quality rules (Phase 31)", () => {
  beforeEach(() => resetFeedCache());

  const larry = makePerson({ id: "p-ellison", slug: "larry-ellison", display_name: "Larry Ellison", full_name: "Lawrence Joseph Ellison", category: "executive" });

  /** Seven real items from Larry Ellison's feed in September 2026, plus one from July. */
  const ELLISON = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>"Larry Ellison" - Google News</title>
    <item>
      <title><![CDATA[Ellison Pledges $9.2 Billion More in Oracle Shares as Collateral - Bloomberg.com]]></title>
      <link>https://news.google.com/rss/articles/pledge</link><guid isPermaLink="false">pledge</guid>
      <pubDate>Fri, 25 Sep 2026 21:53:00 GMT</pubDate><source url="https://www.bloomberg.com">Bloomberg.com</source>
    </item>
    <item>
      <title><![CDATA[Paramount's David Ellison Attends Trump White House State Dinner for Chinese President - Variety]]></title>
      <link>https://news.google.com/rss/articles/variety</link><guid isPermaLink="false">variety</guid>
      <pubDate>Fri, 25 Sep 2026 03:53:00 GMT</pubDate><source url="https://variety.com">Variety</source>
    </item>
    <item>
      <title><![CDATA[Larry and David Ellison have all the money, and a boost from Trump. Now they're going to own Warner Bros. - Business Insider]]></title>
      <link>https://news.google.com/rss/articles/both</link><guid isPermaLink="false">both</guid>
      <pubDate>Mon, 21 Sep 2026 18:58:00 GMT</pubDate><source url="https://www.businessinsider.com">Business Insider</source>
    </item>
    <item>
      <title><![CDATA[Larry Dean Ellison Obituary Sep 22, 2026 - Reynolds-Love Funeral Home]]></title>
      <link>https://news.google.com/rss/articles/obit</link><guid isPermaLink="false">obit</guid>
      <pubDate>Tue, 22 Sep 2026 07:00:00 GMT</pubDate><source url="https://www.reynoldslovefuneralhome.com">Reynolds-Love Funeral Home</source>
    </item>
    <item>
      <title><![CDATA[Oracle leaders receive subpoenas to appear before House VA Committee - Healthcare IT News]]></title>
      <link>https://news.google.com/rss/articles/subpoena</link><guid isPermaLink="false">subpoena</guid>
      <pubDate>Thu, 17 Sep 2026 12:00:00 GMT</pubDate><source url="https://www.healthcareitnews.com">Healthcare IT News</source>
    </item>
    <item>
      <title><![CDATA[Oracle Falls 4.7% Despite Ellison Scrapping a 50 Million-Share Sale - Barron's]]></title>
      <link>https://news.google.com/rss/articles/barrons</link><guid isPermaLink="false">barrons</guid>
      <pubDate>Wed, 23 Sep 2026 12:00:00 GMT</pubDate><source url="https://www.barrons.com">Barron's</source>
    </item>
    <item>
      <title><![CDATA[Larry Ellison's Lanai: a look inside the island - Forbes]]></title>
      <link>https://news.google.com/rss/articles/lanai</link><guid isPermaLink="false">lanai</guid>
      <pubDate>Sat, 04 Jul 2026 07:00:00 GMT</pubDate><source url="https://www.forbes.com">Forbes</source>
    </item>
  </channel>
</rss>`;

  const POLL = new Date("2026-09-26T00:00:00.000Z");
  const policy = buildPublisherPolicy([
    { domain: "bloomberg.com", status: "allowed", tier: 1 },
    { domain: "variety.com", status: "allowed", tier: 1 },
    { domain: "businessinsider.com", status: "allowed", tier: 2 },
    { domain: "barrons.com", status: "allowed", tier: 1 },
    { domain: "forbes.com", status: "allowed", tier: 1 },
  ]);
  const rules = { disambiguation: { exclude_unless_named: ["David Ellison", "Skydance", "Paramount"], namesake_guard: true, aliases: ["Larry"] } };

  const ctx = (fetch: typeof globalThis.fetch, on: boolean, excluded: unknown[] = [], notes: string[] = []) => ({
    source: makeSource({ name: "rss" }),
    config: {} as Record<string, never>,
    snapshots: { latest: async () => null, record: () => undefined },
    now: POLL,
    fetch,
    publishers: policy,
    personConfig: rules,
    exclude: (item: unknown) => excluded.push(item),
    note: (message: string) => notes.push(message),
    ...(on ? { quality: { maxAgeHours: 168 } } : {}),
  });

  it("off: the new configuration keys are inert, every item is stored, the July item too", async () => {
    const excluded: unknown[] = [];
    const notes: string[] = [];
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: ELLISON }]);
    const signals = await rssConnector.fetchForPerson(larry, feedUrlFor('"Larry Ellison"'), ctx(fetch, false, excluded, notes));
    expect(signals).toHaveLength(7);
    expect(excluded).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("on: the David Ellison story, the obituary and the unknown publisher's unnamed item are refused with their reasons; the story about both and the pledge are kept", async () => {
    const excluded: Array<{ headline: string; reason: string; term: string | null }> = [];
    const notes: string[] = [];
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: ELLISON }]);
    const signals = await rssConnector.fetchForPerson(larry, feedUrlFor('"Larry Ellison"'), ctx(fetch, true, excluded, notes));
    expect(signals.map((s) => s.headline)).toEqual([
      // Known publisher, surname only: kept — the namesake guard is for unknown publishers.
      "Ellison Pledges $9.2 Billion More in Oracle Shares as Collateral",
      "Larry and David Ellison have all the money, and a boost from Trump. Now they're going to own Warner Bros.",
      "Oracle Falls 4.7% Despite Ellison Scrapping a 50 Million-Share Sale",
    ]);
    expect(excluded.map((e) => [e.reason, e.term])).toEqual([
      ["excluded_unless_named", "david ellison"],
      ["obituary", "obituary"],
      ["namesake_unnamed", null],
    ]);
    // The July item is stale, not somebody else's: refused with a note, like an undated item, and not counted as an
    // exclusion. The note counts among the items the entity rules admitted (four of the seven).
    expect(notes).toEqual(["1 of 4 items refused: published more than 168 h before the poll"]);
  });

  it("on: the refusals leave news_volume_24h as well, the stale rule does not touch it", async () => {
    const fetch = fakeFetchRoutes([{ match: "news.google.com/rss/search", body: ELLISON }]);
    const c = ctx(fetch, true);
    await rssConnector.fetchForPerson(larry, feedUrlFor('"Larry Ellison"'), c);
    const [reading] = await rssConnector.fetchMetrics!(larry, feedUrlFor('"Larry Ellison"'), c);
    // Inside the trailing 24 h of the poll: the pledge (21:53 on the 25th) and the Variety item (03:53 on the 25th): the Variety item is refused.
    expect(reading).toEqual({ metricKey: "news_volume_24h", value: 1 });
    expect(fetch.calls).toHaveLength(1);
  });

  it("isStaleItem: past the horizon, not at it; undated items are not stale (the date rule owns them)", () => {
    const item = (publishedAt: Date | null): FeedItem => ({ title: "x", link: null, guid: "g", publishedAt, outlet: null, sourceUrl: null });
    const quality = { maxAgeHours: 168 };
    expect(isStaleItem(item(new Date(POLL.getTime() - 168 * 3_600_000)), POLL, quality)).toBe(false);
    expect(isStaleItem(item(new Date(POLL.getTime() - 168 * 3_600_000 - 1)), POLL, quality)).toBe(true);
    expect(isStaleItem(item(null), POLL, quality)).toBe(false);
    expect(isStaleItem(item(new Date(2020, 0, 1)), POLL, undefined)).toBe(false);
  });
});
