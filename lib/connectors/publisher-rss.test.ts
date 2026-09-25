import { beforeEach, describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import {
  feedCandidatesFrom,
  isDue,
  matchesTerm,
  publisherRssConnector,
  readPublisherRssConfig,
  readSubjectConfig,
  resetPublisherFeedCache,
  usableItems,
  watchesFeed,
} from "./publisher-rss";
import { parseFeed } from "./rss";
import type { ConnectorContext, ExcludedItem, FeedCatalogEntry, FeedHealthReport } from "./types";

const NOW = new Date("2026-09-17T15:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const rfc = (date: Date) => date.toUTCString();

const mahomes = makePerson({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", slug: "patrick-mahomes", display_name: "Patrick Mahomes", full_name: "Patrick Lavon Mahomes II", category: "athlete" });
const drake = makePerson({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", slug: "drake", display_name: "Drake", full_name: "Aubrey Drake Graham", category: "musician" });

const NFL_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>ESPN NFL</title>
  <item><title>Mahomes throws for 184 yards as Chiefs beat Broncos</title><link>https://www.espn.com/nfl/story/_/id/1</link><guid>espn-1</guid><pubDate>${rfc(ago(2))}</pubDate><description>Patrick Mahomes was efficient in the opener.</description></item>
  <item><title>Chiefs defense shuts down Denver</title><link>https://www.espn.com/nfl/story/_/id/2</link><guid>espn-2</guid><pubDate>${rfc(ago(3))}</pubDate></item>
  <item><title>Mahomes named AFC player of the week</title><link>https://www.espn.com/nfl/story/_/id/3</link><guid>espn-3</guid></item>
  <item><title>Mahomes' preseason plan takes shape</title><link>https://www.espn.com/nfl/story/_/id/4</link><guid>espn-4</guid><pubDate>${rfc(ago(120))}</pubDate></item>
  <item><title>Drake London catches two touchdowns for Atlanta</title><link>https://www.espn.com/nfl/story/_/id/5</link><guid>espn-5</guid><pubDate>${rfc(ago(4))}</pubDate></item>
</channel></rss>`;

const MUSIC_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Billboard</title>
  <item><title>Drake announces a stadium tour</title><link>https://www.billboard.com/music/1</link><guid>bb-1</guid><pubDate>${rfc(ago(1))}</pubDate><description>Dates for 2027.</description></item>
  <item><title>Drakeford wins an award nobody expected</title><link>https://www.billboard.com/music/2</link><guid>bb-2</guid><pubDate>${rfc(ago(1))}</pubDate></item>
  <item><title>Nick Drake box set reissued</title><link>https://www.billboard.com/music/3</link><guid>bb-3</guid><pubDate>${rfc(ago(5))}</pubDate></item>
  <item><title>Mahomes on the charts? Not yet.</title><link>https://www.billboard.com/music/4</link><guid>bb-4</guid><pubDate>${rfc(ago(6))}</pubDate></item>
</channel></rss>`;

const UNDATED_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Headlines</title>
  <item><title>Mahomes headline with no date</title><link>https://undated.example/1</link><guid>u-1</guid></item>
</channel></rss>`;

const PAGE_WITH_HEAD_LINK = `<!doctype html><html><head><title>Outlet</title>
  <link rel="stylesheet" href="/site.css">
  <link rel="alternate" type="application/rss+xml" title="Outlet » Feed" href="/declared/feed.xml">
</head><body><a href="/about">About</a></body></html>`;

const PAGE_WITHOUT_LINK = `<!doctype html><html><head><title>Outlet</title></head><body><p>No feeds here.</p><a href="https://elsewhere.example/rss">other site</a></body></html>`;

const DECLARED_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Declared</title>
  <item><title>Declared item</title><link>https://outlet.example/a</link><guid>d-1</guid><pubDate>${rfc(ago(1))}</pubDate></item>
</channel></rss>`;

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch double that sees the request headers, so conditional requests can be asserted. */
function feedFetch(routes: Record<string, string | Handler>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url, headers });
    const route = Object.entries(routes).find(([match]) => url === match || url.startsWith(match));
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    const [, handler] = route;
    if (typeof handler === "string") return new Response(handler, { status: 200, headers: { "content-type": "application/rss+xml", etag: `"etag-of-${route[0]}"` } });
    return handler(init);
  };
  return Object.assign(impl, { calls });
}

let nextId = 1;
function entry(overrides: Partial<FeedCatalogEntry> & { url: string }): FeedCatalogEntry {
  return {
    id: `feed-${String(nextId++).padStart(2, "0")}`,
    domain: new URL(overrides.url).hostname.replace(/^www\./, ""),
    section: "All",
    topics: [],
    mode: "feed",
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    lastStatus: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

interface Harness {
  context: (personConfig?: Record<string, unknown>) => ConnectorContext;
  reports: FeedHealthReport[];
  matched: Array<[string, number]>;
  excluded: ExcludedItem[];
}

function harness(fetch: typeof globalThis.fetch, feeds: FeedCatalogEntry[], config: Record<string, unknown> = {}, now = NOW): Harness {
  const reports: FeedHealthReport[] = [];
  const matched: Array<[string, number]> = [];
  const excluded: ExcludedItem[] = [];
  return {
    reports,
    matched,
    excluded,
    context: (personConfig = {}) => ({
      source: makeSource({ id: "src-pub", name: "publisher_rss", tier: 3 }),
      config: config as Record<string, never>,
      snapshots: { latest: async () => null, record: () => undefined },
      now,
      fetch,
      personConfig: personConfig as Record<string, never>,
      exclude: (item) => excluded.push(item),
      feeds: { list: async () => feeds, report: (health) => reports.push(health), matched: (id, count) => matched.push([id, count]) },
    }),
  };
}

beforeEach(() => resetPublisherFeedCache());

describe("configuration", () => {
  it("reads the source config with clamps, and the subject config with the identifier as the first term", () => {
    expect(readPublisherRssConfig({})).toEqual({ max_items_per_feed: 50, max_items_per_person: 60, max_item_age_hours: 72, concurrency: 8, feed_timeout_ms: 6000, fetch_budget_ms: 15000 });
    expect(readPublisherRssConfig({ max_items_per_feed: 1000, concurrency: 0, max_item_age_hours: 24, fetch_budget_ms: 99_999 })).toMatchObject({ max_items_per_feed: 200, concurrency: 8, max_item_age_hours: 24, fetch_budget_ms: 50_000 });
    expect(readSubjectConfig({ match_terms: ["Mahomes", " Mahomes ", 7 as never], topics: ["NFL", "Sports"] }, " Patrick Mahomes ", mahomes)).toEqual({ terms: ["Patrick Mahomes", "Mahomes"], topics: ["nfl", "sports"] });
    expect(readSubjectConfig(null, "", mahomes)).toEqual({ terms: ["Patrick Mahomes"], topics: [] });
  });

  it("matches whole words, case-insensitively, through possessives and punctuation, never inside a longer word", () => {
    expect(matchesTerm("Mahomes' preseason plan", "Mahomes")).toBe(true);
    expect(matchesTerm("MAHOMES, again", "mahomes")).toBe(true);
    expect(matchesTerm("Drake-Kendrick feud", "Drake")).toBe(true);
    expect(matchesTerm("MrBeast's new video", "MrBeast")).toBe(true);
    expect(matchesTerm("Mr.  Beast returns", "Mr. Beast")).toBe(true);
    expect(matchesTerm("Drakeford wins", "Drake")).toBe(false);
    expect(matchesTerm("Mahomesville", "Mahomes")).toBe(false);
    expect(matchesTerm("anything", "")).toBe(false);
    expect(matchesTerm("Beyoncé and Drake", "Beyonce")).toBe(true);
  });

  it("scopes feeds by topic, with an untagged side reading everything", () => {
    expect(watchesFeed(["nfl", "general"], ["nfl"])).toBe(true);
    expect(watchesFeed(["nfl", "general"], ["music"])).toBe(false);
    expect(watchesFeed(["nfl", "general"], ["Music", "General"])).toBe(true);
    expect(watchesFeed(["nfl"], ["Music", "General"])).toBe(false);
    expect(watchesFeed([], ["music"])).toBe(true);
    expect(watchesFeed(["nfl"], [])).toBe(true);
  });

  it("keeps dated items inside the age window, newest first, capped; undated and stale items are out", () => {
    const items = parseFeed(NFL_FEED).items;
    const config = readPublisherRssConfig({ max_items_per_feed: 2 });
    expect(usableItems(items, NOW, config).map((item) => item.guid)).toEqual(["espn-1", "espn-2"]);
    expect(usableItems(items, NOW, readPublisherRssConfig({})).map((item) => item.guid)).toEqual(["espn-1", "espn-2", "espn-5"]);
  });
});

describe("reading the catalogue", () => {
  it("stores only dated, in-window items that name the subject, with the publisher from the link and the story text, and reports feed health", async () => {
    const fetch = feedFetch({ "https://www.espn.com/espn/rss/nfl/news": NFL_FEED });
    const nfl = entry({ url: "https://www.espn.com/espn/rss/nfl/news", section: "NFL", topics: ["nfl"] });
    const h = harness(fetch, [nfl]);

    const signals = await publisherRssConnector.fetchForPerson(mahomes, "Patrick Mahomes", h.context({ match_terms: ["Mahomes"], topics: ["nfl", "general"] }));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      headline: "Mahomes throws for 184 yards as Chiefs beat Broncos",
      story: "Mahomes throws for 184 yards as Chiefs beat Broncos",
      publisherDomain: "espn.com",
      dedupeKey: "pub:espn-1",
      occurredAt: ago(2),
    });
    expect(signals[0].rawPayload).toMatchObject({ kind: "article", source: "publisher_rss", outlet: "ESPN NFL", link: "https://www.espn.com/nfl/story/_/id/1", publisher_domain: "espn.com", publisher_domain_from: "link", feed_id: nfl.id, feed_section: "NFL", matched_term: "Mahomes" });
    expect(JSON.stringify(signals[0].rawPayload)).not.toContain("efficient in the opener");

    // The undated item and the stale one are not ingested; the feed's health says what it carried.
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ id: nfl.id, status: "ok", httpStatus: 200, error: null, itemCount: 5, datedCount: 4, describedCount: 1, newestPublishedAt: ago(2), etag: '"etag-of-https://www.espn.com/espn/rss/nfl/news"' });
    // Matched counts every item that named the subject, including the ones disambiguation or the window then refused.
    expect(h.matched).toEqual([[nfl.id, 1]]);
    expect(fetch.calls.map((call) => call.url)).toEqual(["https://www.espn.com/espn/rss/nfl/news"]);
  });

  it("reads only the feeds the subject's topics select, matches whole words, and applies the disambiguation rules", async () => {
    const fetch = feedFetch({ "https://www.espn.com/espn/rss/nfl/news": NFL_FEED, "https://www.billboard.com/feed/": MUSIC_FEED });
    const nfl = entry({ url: "https://www.espn.com/espn/rss/nfl/news", topics: ["nfl"] });
    const music = entry({ url: "https://www.billboard.com/feed/", topics: ["music"] });
    const h = harness(fetch, [nfl, music]);

    const signals = await publisherRssConnector.fetchForPerson(drake, "Drake", h.context({ topics: ["music"], disambiguation: { exclude_terms: ["drake london", "nick drake"] } }));

    expect(signals.map((s) => s.headline)).toEqual(["Drake announces a stadium tour"]);
    expect(h.excluded).toEqual([{ headline: "Nick Drake box set reissued", reason: "excluded_term", term: "nick drake" }]);
    // The NFL feed was fetched (the catalogue is one fetch for everyone) but not read for Drake.
    expect(h.matched).toEqual([[music.id, 2]]);
    expect(fetch.calls).toHaveLength(2);
  });

  it("fetches the catalogue once per run for every subject, and again on the next run", async () => {
    const fetch = feedFetch({ "https://www.espn.com/espn/rss/nfl/news": NFL_FEED, "https://www.billboard.com/feed/": MUSIC_FEED });
    const feeds = [entry({ url: "https://www.espn.com/espn/rss/nfl/news", topics: ["nfl"] }), entry({ url: "https://www.billboard.com/feed/", topics: ["music"] })];
    const h = harness(fetch, feeds);

    await publisherRssConnector.fetchForPerson(mahomes, "Patrick Mahomes", h.context({ topics: ["nfl"] }));
    await publisherRssConnector.fetchForPerson(drake, "Drake", h.context({ topics: ["music"] }));
    expect(fetch.calls).toHaveLength(2);
    expect(h.reports).toHaveLength(2);

    const later = harness(fetch, feeds, {}, new Date(NOW.getTime() + 15 * 60_000));
    await publisherRssConnector.fetchForPerson(mahomes, "Patrick Mahomes", later.context({ topics: ["nfl"] }));
    expect(fetch.calls).toHaveLength(4);
  });

  it("sends the conditional validators it was given and treats 304 as nothing new", async () => {
    const fetch = feedFetch({
      "https://www.espn.com/espn/rss/nfl/news": (init) => {
        const headers = new Headers(init?.headers ?? {});
        return headers.get("if-none-match") === '"v1"' ? new Response(null, { status: 304 }) : new Response(NFL_FEED, { status: 200, headers: { etag: '"v1"', "last-modified": "Thu, 17 Sep 2026 12:00:00 GMT" } });
      },
    });
    const nfl = entry({ url: "https://www.espn.com/espn/rss/nfl/news", topics: ["nfl"], etag: '"v1"', lastModified: "Thu, 17 Sep 2026 12:00:00 GMT" });
    const h = harness(fetch, [nfl]);

    const signals = await publisherRssConnector.fetchForPerson(mahomes, "Mahomes", h.context({ topics: ["nfl"] }));
    expect(signals).toEqual([]);
    expect(fetch.calls[0].headers).toMatchObject({ "if-none-match": '"v1"', "if-modified-since": "Thu, 17 Sep 2026 12:00:00 GMT" });
    expect(h.reports[0]).toMatchObject({ status: "not_modified", httpStatus: 304, itemCount: null, etag: '"v1"', lastModified: "Thu, 17 Sep 2026 12:00:00 GMT" });
  });

  it("records a failing feed, an HTML answer and an undated feed on their health and keeps reading the others; refuses undated items", async () => {
    const fetch = feedFetch({
      "https://dead.example/rss": () => new Response("gone", { status: 503 }),
      "https://page.example/rss": () => new Response(PAGE_WITHOUT_LINK, { status: 200, headers: { "content-type": "text/html" } }),
      "https://undated.example/rss": UNDATED_FEED,
      "https://www.espn.com/espn/rss/nfl/news": NFL_FEED,
    });
    const feeds = [
      entry({ url: "https://dead.example/rss", topics: ["nfl"] }),
      entry({ url: "https://page.example/rss", topics: ["nfl"] }),
      entry({ url: "https://undated.example/rss", topics: ["nfl"] }),
      entry({ url: "https://www.espn.com/espn/rss/nfl/news", topics: ["nfl"] }),
    ];
    const h = harness(fetch, feeds);

    const signals = await publisherRssConnector.fetchForPerson(mahomes, "Mahomes", h.context({ topics: ["nfl"] }));
    expect(signals.map((s) => s.dedupeKey)).toEqual(["pub:espn-1"]);
    const byUrl = Object.fromEntries(h.reports.map((report) => [feeds.find((feed) => feed.id === report.id)?.url, report]));
    expect(byUrl["https://dead.example/rss"]).toMatchObject({ status: "error", httpStatus: 503, error: "responded 503" });
    expect(byUrl["https://page.example/rss"]).toMatchObject({ status: "not_feed", httpStatus: 200, error: "answered with an HTML page, not a feed" });
    expect(byUrl["https://undated.example/rss"]).toMatchObject({ status: "undated", itemCount: 1, datedCount: 0 });
    expect(byUrl["https://www.espn.com/espn/rss/nfl/news"]).toMatchObject({ status: "ok" });
  });

  it("backs off a feed that keeps failing, and fails the poll only when the catalogue is empty or absent", async () => {
    const soon = entry({ url: "https://dead.example/rss", consecutiveFailures: 3, lastFetchedAt: new Date(NOW.getTime() - 10 * 60_000) });
    const overdue = entry({ url: "https://dead.example/rss", consecutiveFailures: 3, lastFetchedAt: new Date(NOW.getTime() - 60 * 60_000) });
    const capped = entry({ url: "https://dead.example/rss", consecutiveFailures: 40, lastFetchedAt: new Date(NOW.getTime() - 181 * 60_000) });
    expect(isDue(soon, NOW)).toBe(false);
    expect(isDue(overdue, NOW)).toBe(true);
    expect(isDue(capped, NOW)).toBe(true);
    expect(isDue(entry({ url: "https://fresh.example/rss", consecutiveFailures: 2, lastFetchedAt: NOW }), NOW)).toBe(true);

    const fetch = feedFetch({});
    const h = harness(fetch, [soon]);
    await expect(publisherRssConnector.fetchForPerson(mahomes, "Mahomes", h.context())).resolves.toEqual([]);
    expect(fetch.calls).toEqual([]);

    resetPublisherFeedCache();
    await expect(publisherRssConnector.fetchForPerson(mahomes, "Mahomes", harness(fetch, []).context())).rejects.toThrow(/catalogue is empty/);
    resetPublisherFeedCache();
    const withoutCatalogue: ConnectorContext = { ...harness(fetch, [soon]).context() };
    delete withoutCatalogue.feeds;
    await expect(publisherRssConnector.fetchForPerson(mahomes, "Mahomes", withoutCatalogue)).rejects.toThrow(/not supplied/);
  });

  it("starts feeds only inside what is left of the run's budget (after Phase 29e): none with nothing left, all when unbounded", async () => {
    const feeds = [entry({ url: "https://a.example/feed", topics: ["nfl"] }), entry({ url: "https://b.example/feed", topics: ["nfl"] })];
    const spent = feedFetch({ "https://a.example/feed": NFL_FEED, "https://b.example/feed": NFL_FEED });
    const none = await publisherRssConnector.fetchForPerson(mahomes, "Mahomes", { ...harness(spent, feeds).context({ topics: ["nfl"] }), remainingBudgetMs: () => 0 });
    expect(spent.calls).toEqual([]);
    expect(none).toEqual([]);

    resetPublisherFeedCache();
    const open = feedFetch({ "https://a.example/feed": NFL_FEED, "https://b.example/feed": NFL_FEED });
    await publisherRssConnector.fetchForPerson(mahomes, "Mahomes", { ...harness(open, feeds).context({ topics: ["nfl"] }), remainingBudgetMs: () => null });
    expect(open.calls).toHaveLength(2);
    expect(publisherRssConnector.sharedFetch).toBe(true);
  });

  it("caps what one person stores per poll and never stores the same item twice from two feeds", async () => {
    const fetch = feedFetch({ "https://a.example/feed": NFL_FEED, "https://b.example/feed": NFL_FEED });
    const feeds = [entry({ url: "https://a.example/feed", topics: ["nfl"] }), entry({ url: "https://b.example/feed", topics: ["nfl"] })];
    const h = harness(fetch, feeds, { max_items_per_person: 1 });
    const signals = await publisherRssConnector.fetchForPerson(mahomes, "Mahomes", h.context({ topics: ["nfl"] }));
    expect(signals.map((s) => s.dedupeKey)).toEqual(["pub:espn-1"]);
    expect(h.matched).toEqual([[feeds[0].id, 1], [feeds[1].id, 1]]);
  });
});

describe("discovery", () => {
  it("lists a page's declared feeds first, then feed-like anchors on the same site, then the conventional paths", () => {
    const candidates = feedCandidatesFrom(PAGE_WITH_HEAD_LINK, "https://outlet.example/music/");
    expect(candidates[0]).toBe("https://outlet.example/declared/feed.xml");
    expect(candidates).toContain("https://outlet.example/music/feed/");
    expect(candidates).toContain("https://outlet.example/rss.xml");
    expect(feedCandidatesFrom(PAGE_WITHOUT_LINK, "https://outlet.example/")).not.toContain("https://elsewhere.example/rss");
    expect(feedCandidatesFrom(PAGE_WITHOUT_LINK, "https://outlet.example/")[0]).toBe("https://outlet.example/feed/");
  });

  it("records the feed it finds behind a page, or that none was found, and ingests nothing from a discovery row", async () => {
    const fetch = feedFetch({
      "https://outlet.example/music/": () => new Response(PAGE_WITH_HEAD_LINK, { status: 200, headers: { "content-type": "text/html" } }),
      "https://outlet.example/declared/feed.xml": DECLARED_FEED,
      "https://bare.example/": () => new Response(PAGE_WITHOUT_LINK, { status: 200, headers: { "content-type": "text/html" } }),
      "https://direct.example/rss": NFL_FEED,
    });
    const declared = entry({ url: "https://outlet.example/music/", mode: "discover", topics: ["music"] });
    const bare = entry({ url: "https://bare.example/", mode: "discover", topics: ["music"] });
    const direct = entry({ url: "https://direct.example/rss", mode: "discover", topics: ["nfl"] });
    const h = harness(fetch, [declared, bare, direct]);

    const signals = await publisherRssConnector.fetchForPerson(mahomes, "Mahomes", h.context());
    expect(signals).toEqual([]);
    const byId = Object.fromEntries(h.reports.map((report) => [report.id, report]));
    expect(byId[declared.id]).toMatchObject({ status: "discovered", discoveredUrl: "https://outlet.example/declared/feed.xml", itemCount: 1, datedCount: 1 });
    expect(byId[bare.id]).toMatchObject({ status: "no_feed_found", discoveredUrl: null });
    expect(byId[bare.id].error).toMatch(/no feed among \d+ candidates/);
    expect(byId[direct.id]).toMatchObject({ status: "discovered", discoveredUrl: "https://direct.example/rss", itemCount: 5, datedCount: 4 });
    // The bare page's conventional paths were all probed and 404ed.
    expect(fetch.calls.filter((call) => call.url.startsWith("https://bare.example/")).length).toBeGreaterThan(3);
  });

  it("does not run discovery again once a row has reported, except after a transient error", () => {
    expect(isDue(entry({ url: "https://x.example/", mode: "discover" }), NOW)).toBe(true);
    expect(isDue(entry({ url: "https://x.example/", mode: "discover", lastStatus: "discovered" }), NOW)).toBe(false);
    expect(isDue(entry({ url: "https://x.example/", mode: "discover", lastStatus: "no_feed_found" }), NOW)).toBe(false);
    expect(isDue(entry({ url: "https://x.example/", mode: "discover", lastStatus: "error", consecutiveFailures: 1 }), NOW)).toBe(true);
    expect(isDue(entry({ url: "https://x.example/", mode: "discover", lastStatus: "error", consecutiveFailures: 3 }), NOW)).toBe(false);
  });
});
