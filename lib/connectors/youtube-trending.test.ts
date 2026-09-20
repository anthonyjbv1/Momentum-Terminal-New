import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeFetchRoutes, makePerson, makeSource } from "@/lib/__tests__/fixtures";
import { PAYLOAD_KEYS } from "@/lib/engine/sentiment/prompts";
import { EMPTY_DISAMBIGUATION, readDisambiguation } from "@/lib/ingest/disambiguation";

import type { ConnectorContext, ExcludedItem } from "./types";
import {
  CHART_MAX_RESULTS,
  CHART_PAGE_SIZE,
  TRENDING_KIND,
  YOUTUBE_TRENDING_SOURCE_NAME,
  chartFor,
  fetchTrendingChart,
  matchTrendingVideo,
  readTrendingConfig,
  readTrendingSubject,
  resetTrendingChartCache,
  trendingSignal,
  youtubeTrendingConnector,
  type TrendingVideo,
} from "./youtube-trending";

/**
 * PHASE 22: a trending appearance is an EVENT, matched by two routes and
 * nothing else, deduplicated per video, read from the official chart once
 * per run.
 */

const NOW = new Date("2026-09-20T19:30:00.000Z");
const MRBEAST_CHANNEL = "UCX6OQ3DkcsbYNE6H8uQQuVA";
/** A channel id of the right shape that belongs to nobody on the board. */
const uc = (seed: string) => `UC${seed.padEnd(22, "0").slice(0, 22)}`;
const DRAKE_CHANNEL = uc("drakeofficial");

const mrbeast = makePerson();
const drake = makePerson({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", slug: "drake", display_name: "Drake", full_name: "Aubrey Drake Graham", category: "musician" });
const kai = makePerson({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", slug: "kai-cenat", display_name: "Kai Cenat", full_name: "Kai Cenat", category: "creator" });
const buffett = makePerson({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", slug: "warren-buffett", display_name: "Warren Buffett", full_name: "Warren Buffett", category: "executive" });
const jensen = makePerson({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", slug: "jensen-huang", display_name: "Jensen Huang", full_name: "Jensen Huang", category: "executive" });

/** The exclusions the seed inherits for Drake, plus the sitcom. */
const DRAKE_RULES = readDisambiguation({
  disambiguation: { exclude_terms: ["drake university", "drake bulldogs", "drake maye", "drake bell", "drake london", "nick drake", "non-conference", "drake & josh", "drake and josh"], require_any: [] },
});

function chartItem(id: string, title: string, channelId: string, channelTitle: string, extra: { description?: string; categoryId?: string; viewCount?: string } = {}) {
  return {
    kind: "youtube#video",
    id,
    snippet: { publishedAt: "2026-09-20T12:00:00Z", channelId, title, description: extra.description ?? "", channelTitle, categoryId: extra.categoryId ?? "24" },
    statistics: { viewCount: extra.viewCount ?? "1234567" },
  };
}

/** One page of the chart. */
function chartResponse(items: ReturnType<typeof chartItem>[], nextPageToken?: string) {
  return { kind: "youtube#videoListResponse", ...(nextPageToken ? { nextPageToken } : {}), items };
}

/** A chart with every case the matcher must decide, in rank order. */
const CHART = [
  chartItem("v-beast", "I Survived 7 Days In Solitary Confinement", MRBEAST_CHANNEL, "MrBeast"),
  chartItem("v-drake-uni", "Drake vs Iowa State | Full Game Highlights", uc("sports"), "Drake University Athletics"),
  chartItem("v-drake-mv", "Drake - NOKIA (Official Music Video)", uc("vevo"), "DrakeVEVO"),
  chartItem("v-collab", "MrBeast and Kai Cenat Swap Lives For 24 Hours", uc("kai"), "Kai Cenat Live"),
  chartItem("v-desc", "The Best Video Ever Made", uc("someone"), "Someone", { description: "inspired by MrBeast and Drake #mrbeast #drake" }),
  chartItem("v-fan", "Top 10 Moments Of All Time", uc("fan"), "Drake Fan Page"),
  chartItem("v-maye", "Drake Maye 4 TD Game Highlights", uc("nfl"), "NFL"),
  chartItem("v-buffett", 'Warren Buffett on the economy: "we are fine" (full interview)', uc("cnbc"), "CNBC Television"),
  chartItem("v-sitcom", "Drake & Josh Cast Reunites After 15 Years", uc("nick"), "Nickelodeon"),
];

function video(overrides: Partial<TrendingVideo> = {}): TrendingVideo {
  return { videoId: "v", rank: 1, title: "A title", description: "", channelId: uc("x"), channelTitle: "X", publishedAt: null, categoryId: null, viewCount: null, ...overrides };
}

interface Harness {
  context: (personConfig?: Record<string, unknown>, sourceId?: string, now?: Date) => ConnectorContext;
  excluded: ExcludedItem[];
  fetch: ReturnType<typeof fakeFetchRoutes>;
}

function harness(pages: Array<ReturnType<typeof chartResponse>> = [chartResponse(CHART)]): Harness {
  const excluded: ExcludedItem[] = [];
  const fetch = fakeFetchRoutes([
    {
      match: "/youtube/v3/videos?",
      body: (url: string) => {
        const token = new URL(url).searchParams.get("pageToken");
        const index = token ? Number(token.replace("page-", "")) : 0;
        return pages[index] ?? chartResponse([]);
      },
    },
  ]);
  return {
    excluded,
    fetch,
    context: (personConfig = {}, sourceId = "src-trending", now = NOW) => ({
      source: makeSource({ id: sourceId, name: YOUTUBE_TRENDING_SOURCE_NAME, tier: 2, poll_interval_minutes: 25 }),
      config: {},
      snapshots: { latest: async () => null, record: () => undefined },
      now,
      fetch,
      personConfig: personConfig as ConnectorContext["personConfig"],
      exclude: (item) => excluded.push(item),
    }),
  };
}

const previousKey = process.env.YOUTUBE_API_KEY;
beforeEach(() => {
  process.env.YOUTUBE_API_KEY = "test-key";
  resetTrendingChartCache();
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = previousKey;
});

describe("configuration", () => {
  it("reads one national chart, the top fifty, by default, and bounds what it is told", () => {
    expect(readTrendingConfig({})).toEqual({ region: "US", max_results: 50 });
    expect(readTrendingConfig({ region: "gb", max_results: 100 })).toEqual({ region: "GB", max_results: 100 });
    expect(readTrendingConfig({ region: "usa", max_results: 9_999 })).toEqual({ region: "US", max_results: CHART_MAX_RESULTS });
    expect(readTrendingConfig({ max_results: 0 }).max_results).toBe(CHART_PAGE_SIZE);
  });

  it("reads the subject's terms the way the publisher feeds do, and a channel id only when it has the shape of one", () => {
    expect(readTrendingSubject({ channel_id: MRBEAST_CHANNEL }, "MrBeast", mrbeast)).toEqual({ terms: ["MrBeast"], channelId: MRBEAST_CHANNEL });
    expect(readTrendingSubject({ match_terms: ["Beast"] }, "MrBeast", mrbeast)).toEqual({ terms: ["MrBeast", "Beast"], channelId: null });
    // A handle, a URL or a truncated id is not a channel route; it is ignored rather than matched against nothing.
    for (const bad of ["@mrbeast", "UC123", "https://youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA", 42]) {
      expect(readTrendingSubject({ channel_id: bad }, "MrBeast", mrbeast).channelId, String(bad)).toBeNull();
    }
    expect(readTrendingSubject(null, "MrBeast", mrbeast)).toEqual({ terms: ["MrBeast"], channelId: null });
  });
});

describe("the chart is read from the official API, once per run", () => {
  it("is videos.list with chart=mostPopular for the region: one call, one unit, at the default depth", async () => {
    const h = harness();
    const chart = await fetchTrendingChart(readTrendingConfig({}), "k", h.fetch);
    expect(h.fetch.calls).toHaveLength(1);
    const url = new URL(h.fetch.calls[0]);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
    expect(url.searchParams.get("chart")).toBe("mostPopular");
    expect(url.searchParams.get("regionCode")).toBe("US");
    expect(url.searchParams.get("maxResults")).toBe("50");
    expect(url.searchParams.get("part")).toContain("snippet");
    // Never the search endpoint (a hundred units) and never the chart's web page.
    expect(url.pathname).not.toContain("search");
    expect(url.hostname).not.toContain("charts.youtube.com");
    expect(chart.map((v) => v.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(chart[0]).toMatchObject({ videoId: "v-beast", channelId: MRBEAST_CHANNEL, channelTitle: "MrBeast", viewCount: 1_234_567, categoryId: "24", publishedAt: "2026-09-20T12:00:00Z" });
  });

  it("pages to the requested depth and numbers ranks across pages", async () => {
    const page = (start: number, n: number, next?: string) => chartResponse(Array.from({ length: n }, (_, i) => chartItem(`v${start + i}`, `Video ${start + i}`, uc(`c${start + i}`), `Channel ${start + i}`)), next);
    const h = harness([page(1, 50, "page-1"), page(51, 50, "page-2"), page(101, 50, "page-3"), page(151, 50)]);
    const chart = await fetchTrendingChart(readTrendingConfig({ max_results: 200 }), "k", h.fetch);
    expect(h.fetch.calls).toHaveLength(4);
    expect(chart).toHaveLength(200);
    expect(chart[0].rank).toBe(1);
    expect(chart[199]).toMatchObject({ videoId: "v200", rank: 200 });
    // A depth of 120 stops after the page that reaches it, at 120 exactly.
    resetTrendingChartCache();
    const h2 = harness([page(1, 50, "page-1"), page(51, 50, "page-2"), page(101, 20)]);
    expect(await fetchTrendingChart(readTrendingConfig({ max_results: 120 }), "k", h2.fetch)).toHaveLength(120);
    expect(h2.fetch.calls).toHaveLength(3);
  });

  it("is fetched once for a run's clock, however many subjects ask, and again for the next run", async () => {
    const h = harness();
    const config = readTrendingConfig({});
    const [a, b, c] = await Promise.all([chartFor(h.context(), config, "k"), chartFor(h.context(), config, "k"), chartFor(h.context({ channel_id: MRBEAST_CHANNEL }), config, "k")]);
    expect(h.fetch.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await chartFor(h.context({}, "src-trending", new Date(NOW.getTime() + 30 * 60_000)), config, "k");
    expect(h.fetch.calls).toHaveLength(2);
  });
});

describe("matching: two routes, and what is refused", () => {
  const chart = () => fetchTrendingChart(readTrendingConfig({}), "k", harness().fetch);
  const byId = async (id: string) => (await chart()).find((v) => v.videoId === id)!;

  it("CHANNEL: a video on the subject's own channel is theirs, whatever the title says", async () => {
    const subject = readTrendingSubject({ channel_id: MRBEAST_CHANNEL }, "MrBeast", mrbeast);
    expect(matchTrendingVideo(await byId("v-beast"), subject, EMPTY_DISAMBIGUATION)).toEqual({ match: { route: "channel", term: null } });
    // The title names nobody; only the channel says whose it is.
    expect((await byId("v-beast")).title).not.toMatch(/mrbeast/i);
  });

  it("CHANNEL beats an exclusion: the subject's own upload about an excluded name is still their upload", () => {
    const subject = readTrendingSubject({ channel_id: DRAKE_CHANNEL }, "Drake", drake);
    const own = video({ videoId: "v-own", title: "Reacting to the Drake & Josh reunion", channelId: DRAKE_CHANNEL, channelTitle: "Drake" });
    expect(matchTrendingVideo(own, subject, DRAKE_RULES)).toEqual({ match: { route: "channel", term: null } });
  });

  it("TITLE: the title names the subject as whole words and the rules admit it", async () => {
    const subject = readTrendingSubject({}, "Drake", drake);
    expect(matchTrendingVideo(await byId("v-drake-mv"), subject, DRAKE_RULES)).toEqual({ match: { route: "title", term: "Drake" } });
    expect(matchTrendingVideo(await byId("v-buffett"), readTrendingSubject({}, "Warren Buffett", buffett), EMPTY_DISAMBIGUATION)).toEqual({ match: { route: "title", term: "Warren Buffett" } });
    // Whole words: "DrakeVEVO" in a channel name is not "Drake", and nor would "Drakeford" be.
    expect(matchTrendingVideo(video({ title: "Drakeford wins by-election", channelTitle: "BBC" }), subject, DRAKE_RULES)).toBeNull();
  });

  it("TITLE: the same video can be two people's, when it names both", async () => {
    const collab = await byId("v-collab");
    expect(matchTrendingVideo(collab, readTrendingSubject({}, "MrBeast", mrbeast), EMPTY_DISAMBIGUATION)).toEqual({ match: { route: "title", term: "MrBeast" } });
    expect(matchTrendingVideo(collab, readTrendingSubject({}, "Kai Cenat", kai), EMPTY_DISAMBIGUATION)).toEqual({ match: { route: "title", term: "Kai Cenat" } });
  });

  it("REFUSES the wrong entity through the inherited disambiguation rules, wherever it is named", async () => {
    const subject = readTrendingSubject({}, "Drake", drake);
    // Named only in the channel's name: the title is "Drake vs Iowa State".
    expect(matchTrendingVideo(await byId("v-drake-uni"), subject, DRAKE_RULES)).toEqual({ refused: { reason: "excluded_term", term: "drake university" }, term: "Drake" });
    // Named in the title.
    expect(matchTrendingVideo(await byId("v-maye"), subject, DRAKE_RULES)).toEqual({ refused: { reason: "excluded_term", term: "drake maye" }, term: "Drake" });
    expect(matchTrendingVideo(await byId("v-sitcom"), subject, DRAKE_RULES)).toEqual({ refused: { reason: "excluded_term", term: "drake & josh" }, term: "Drake" });
    // Named only in the description: exclusion reads it, admission never does.
    const described = video({ title: "Drake drops a surprise single", channelTitle: "Music News", description: "Not the rapper — this is about Drake University's marching band." });
    expect(matchTrendingVideo(described, subject, DRAKE_RULES)).toEqual({ refused: { reason: "excluded_term", term: "drake university" }, term: "Drake" });
  });

  it("REFUSES a match that is only in the description, only in the channel's name, or only in a bare surname", async () => {
    // "inspired by MrBeast" in the description is not a MrBeast appearance.
    expect(matchTrendingVideo(await byId("v-desc"), readTrendingSubject({}, "MrBeast", mrbeast), EMPTY_DISAMBIGUATION)).toBeNull();
    expect(matchTrendingVideo(await byId("v-desc"), readTrendingSubject({}, "Drake", drake), DRAKE_RULES)).toBeNull();
    // "Drake Fan Page" trending is not Drake trending.
    expect(matchTrendingVideo(await byId("v-fan"), readTrendingSubject({}, "Drake", drake), DRAKE_RULES)).toBeNull();
    // The seed carries no aliases: "Buffett" alone does not admit, "Warren Buffett" does.
    const subject = readTrendingSubject({}, "Warren Buffett", buffett);
    expect(matchTrendingVideo(video({ title: "Buffett indicator hits a record" }), subject, EMPTY_DISAMBIGUATION)).toBeNull();
    expect(matchTrendingVideo(video({ title: "Warren Buffett indicator hits a record" }), subject, EMPTY_DISAMBIGUATION)).not.toBeNull();
  });

  it("honours require_any exactly as the news doors do", () => {
    const rules = readDisambiguation({ disambiguation: { exclude_terms: [], require_any: ["momentum terminal"] } });
    const subject = readTrendingSubject({}, "Anthony Baptiste", makePerson({ display_name: "Anthony Baptiste" }));
    expect(matchTrendingVideo(video({ title: "Anthony Baptiste explains the pick" }), subject, rules)).toEqual({ refused: { reason: "missing_context", term: null }, term: "Anthony Baptiste" });
    expect(matchTrendingVideo(video({ title: "Anthony Baptiste on Momentum Terminal" }), subject, rules)).toEqual({ match: { route: "title", term: "Anthony Baptiste" } });
  });
});

describe("the signal", () => {
  const own = video({ videoId: "v-beast", rank: 3, title: "I Survived 7 Days In Solitary Confinement", channelId: MRBEAST_CHANNEL, channelTitle: "MrBeast", publishedAt: "2026-09-20T12:00:00Z", categoryId: "24", viewCount: 12_000_000 });
  const about = video({ videoId: "v-buffett", rank: 12, title: 'Warren Buffett on the economy: "we are fine"', channelId: uc("cnbc"), channelTitle: "CNBC Television" });

  it("says it in plain English, names the person, and the one number is the rank anyone can check", () => {
    expect(trendingSignal(mrbeast, own, { route: "channel", term: null }, "US", NOW).headline).toBe('MrBeast is trending at #3 on YouTube: "I Survived 7 Days In Solitary Confinement".');
    // A video ABOUT the person says so and names its channel, so the two read differently at a glance; inner quotes are folded so the title stays one quoted span.
    expect(trendingSignal(buffett, about, { route: "title", term: "Warren Buffett" }, "US", NOW).headline).toBe("A video about Warren Buffett is trending at #12 on YouTube: \"Warren Buffett on the economy: ”we are fine”\", from CNBC Television.");
  });

  it("follows the Phase 21+ language rules: no sigma, no guessed pronoun, no statistic", () => {
    for (const signal of [trendingSignal(mrbeast, own, { route: "channel", term: null }, "US", NOW), trendingSignal(drake, about, { route: "title", term: "Drake" }, "US", NOW)]) {
      expect(signal.headline).not.toMatch(/σ|sigma|baseline|trailing|average/i);
      expect(signal.headline).not.toMatch(/\b(he|she|his|her|hers|him)\b/i);
    }
  });

  it("is keyed on the video and the subject, dated at the sighting, and marked as a trending event", () => {
    const signal = trendingSignal(mrbeast, own, { route: "channel", term: null }, "US", NOW);
    expect(signal.dedupeKey).toBe("youtube_trending:video:v-beast:mrbeast");
    expect(signal.occurredAt).toEqual(NOW);
    expect(signal.story).toBeUndefined();
    expect(signal.publisherDomain).toBeUndefined();
    expect(signal.rawPayload).toMatchObject({ kind: TRENDING_KIND, source: YOUTUBE_TRENDING_SOURCE_NAME, chart: "mostPopular", region: "US", video_id: "v-beast", rank: 3, route: "channel", matched_term: null, channel_id: MRBEAST_CHANNEL, view_count: 12_000_000 });
    expect(signal.rawPayload.kind).not.toBe("metric");
    expect(signal.rawPayload.sigma).toBeUndefined();
  });

  it("carries the channel and the video under the keys the sentiment prompt already admits, so the allow-list did not widen", () => {
    const signal = trendingSignal(buffett, about, { route: "title", term: "Warren Buffett" }, "US", NOW);
    for (const key of ["kind", "channelTitle", "videoTitle", "publishedAt"]) {
      expect(PAYLOAD_KEYS as readonly string[], key).toContain(key);
      expect(signal.rawPayload).toHaveProperty(key);
    }
    expect(signal.rawPayload.channelTitle).toBe("CNBC Television");
    expect(signal.rawPayload.videoTitle).toBe(about.title);
    // The rank reaches the model only inside the sentence, as a fact — never as a field it could weigh on its own.
    expect(PAYLOAD_KEYS as readonly string[]).not.toContain("rank");
  });
});

describe("the connector", () => {
  it("is events only: no fetchMetrics, so the rank can never become a level to baseline", () => {
    expect(youtubeTrendingConnector.name).toBe("youtube_trending");
    expect(youtubeTrendingConnector.fetchMetrics).toBeUndefined();
    expect(youtubeTrendingConnector.storyFamily).toBeUndefined();
  });

  it("reports itself unavailable without the key, like the other YouTube reads", () => {
    delete process.env.YOUTUBE_API_KEY;
    expect(youtubeTrendingConnector.available!()).toEqual({ ok: false, reason: "YOUTUBE_API_KEY is not set" });
  });

  it("polls five people against one fetch, crediting each their own videos and counting each refusal", async () => {
    const h = harness();
    const drakeConfig = { disambiguation: { exclude_terms: ["drake university", "drake maye", "drake & josh"], require_any: [] } };
    const beast = await youtubeTrendingConnector.fetchForPerson(mrbeast, "MrBeast", h.context({ channel_id: MRBEAST_CHANNEL }));
    const cenat = await youtubeTrendingConnector.fetchForPerson(kai, "Kai Cenat", h.context());
    const graham = await youtubeTrendingConnector.fetchForPerson(drake, "Drake", h.context(drakeConfig));
    const warren = await youtubeTrendingConnector.fetchForPerson(buffett, "Warren Buffett", h.context());
    const huang = await youtubeTrendingConnector.fetchForPerson(jensen, "Jensen Huang", h.context());

    expect(h.fetch.calls).toHaveLength(1);
    // MrBeast: his own upload by channel, the collaboration by title, in chart order.
    expect(beast.map((s) => [s.rawPayload.video_id, s.rawPayload.route, s.rawPayload.rank])).toEqual([["v-beast", "channel", 1], ["v-collab", "title", 4]]);
    expect(cenat.map((s) => s.rawPayload.video_id)).toEqual(["v-collab"]);
    expect(graham.map((s) => s.rawPayload.video_id)).toEqual(["v-drake-mv"]);
    expect(warren.map((s) => s.rawPayload.video_id)).toEqual(["v-buffett"]);
    // A person the chart does not carry: nothing produced, nothing refused, no error.
    expect(huang).toEqual([]);
    // Drake's three wrong Drakes were refused and reported, headline and term each.
    expect(h.excluded.map((e) => [e.headline, e.term])).toEqual([
      ["Drake vs Iowa State | Full Game Highlights", "drake university"],
      ["Drake Maye 4 TD Game Highlights", "drake maye"],
      ["Drake & Josh Cast Reunites After 15 Years", "drake & josh"],
    ]);
    // Two people, one video, two keys: the collaboration is credited to both.
    expect(beast[1].dedupeKey).toBe("youtube_trending:video:v-collab:mrbeast");
    expect(cenat[0].dedupeKey).toBe("youtube_trending:video:v-collab:kai-cenat");
  });

  it("is deterministic: the same chart at the same clock yields the same sentences and keys", async () => {
    const h = harness();
    const first = await youtubeTrendingConnector.fetchForPerson(mrbeast, "MrBeast", h.context({ channel_id: MRBEAST_CHANNEL }));
    resetTrendingChartCache();
    const second = await youtubeTrendingConnector.fetchForPerson(mrbeast, "MrBeast", h.context({ channel_id: MRBEAST_CHANNEL }));
    expect(second.map((s) => [s.headline, s.dedupeKey])).toEqual(first.map((s) => [s.headline, s.dedupeKey]));
  });
});
