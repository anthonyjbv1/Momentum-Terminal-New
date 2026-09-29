import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";

import type { SignalDetail } from "./card-copy";
import type { FeedEntry, FeedEvidence } from "./feed-model";
import {
  ALSO_MOVING_BELOW,
  KIND_LABELS,
  SPARK_MIN_POINTS,
  groupStream,
  isAlsoMoving,
  mediaLink,
  sourceGlyph,
  sourceIconUrl,
  sparkAcross,
  storyKind,
  storyLabel,
  storyMedia,
  storySources,
  twitchEmbedUrl,
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
} from "./story-card";

/**
 * Phase 34: the story card's rules. Which kind of card a story is, what its
 * strip says, what it may embed, which moves fold into rows, and the score's
 * path across a move.
 */

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function evidence(over: Partial<FeedEvidence> = {}): FeedEvidence {
  return { id: "s1", headline: "A headline", source: "RSS (per-person news feed)", impact: 0.4, occurredAt: iso(NOW), sentiment: "positive", confidence: 0.8, processed: true, relation: "direct", person: null, payload: null, detail: null, ...over };
}

function entry(over: Partial<FeedEntry> & { id: string }): FeedEntry {
  return {
    kind: "signal",
    person: { id: "p1", slug: "drake", name: "Drake", category: "musician", avatarUrl: null, company: null },
    text: "x",
    copy: { label: null, headline: "x", link: null, line: "YouTube · +0.4.", attribution: "YouTube", quoted: false },
    impact: 0.4,
    direction: "heating",
    scoreBefore: null,
    scoreAfter: null,
    tickNumber: null,
    occurredAt: iso(NOW),
    sources: ["YouTube"],
    evidence: [],
    detailLines: [],
    spark: null,
    ...over,
  };
}

const article = (outlet: string, domain: string): SignalDetail => ({ kind: "article", outlet, domain, link: `https://${domain}/story`, digest: null });
const youtube: SignalDetail = { kind: "trending", outlet: null, domain: null, link: null, digest: null, media: { kind: "youtube", videoId: "y56D2WIeKxg", title: "DRAKE - QUEBEC" } };
const twitch: SignalDetail = { kind: "live_moment", outlet: null, domain: null, link: null, digest: null, media: { kind: "twitch", channel: "kaicenat", clip: null, title: null } };
const game: SignalDetail = { kind: "game_result", outlet: null, domain: null, link: null, digest: null, game: { week: "Week 3", home: "Miami Dolphins", away: "Kansas City Chiefs", homeScore: 10, awayScore: 24 } };

describe("the kind of card", () => {
  it("follows the story: article, video, live, game, narrative, else a reading", () => {
    expect(storyKind(entry({ id: "a", copy: { label: "Forbes", headline: "T", link: "https://forbes.com/a", line: "l", attribution: "Forbes", quoted: true }, evidence: [evidence({ detail: article("Forbes", "forbes.com") })] }))).toBe("article");
    expect(storyKind(entry({ id: "v", evidence: [evidence({ source: "YouTube Trending", detail: youtube })] }))).toBe("video");
    expect(storyKind(entry({ id: "l", evidence: [evidence({ source: "Twitch", detail: twitch })] }))).toBe("live");
    expect(storyKind(entry({ id: "g", evidence: [evidence({ source: "API-Sports", detail: game })] }))).toBe("game");
    expect(storyKind(entry({ id: "n", kind: "narrative" }))).toBe("narrative");
    expect(storyKind(entry({ id: "m", evidence: [evidence({ source: "YouTube", payload: { kind: "metric" } })] }))).toBe("signal");
  });

  it("labels each kind in the house voice, the outlet for an article and the week for a game", () => {
    expect(storyLabel(entry({ id: "a", copy: { label: "Forbes", headline: "T", link: "https://forbes.com/a", line: "l", attribution: "Forbes", quoted: true }, evidence: [evidence({ detail: article("Forbes", "forbes.com") })] }))).toBe("Forbes");
    expect(storyLabel(entry({ id: "g", evidence: [evidence({ detail: game })] }))).toBe("Game result · Week 3");
    expect(storyLabel(entry({ id: "l", evidence: [evidence({ detail: twitch })] }))).toBe("Live on Twitch");
    expect(storyLabel(entry({ id: "s", evidence: [evidence({ detail: { ...twitch, kind: "stream_summary" } })] }))).toBe("Twitch");
    expect(storyLabel(entry({ id: "n", kind: "narrative" }))).toBe("The Engine");
    for (const label of Object.values(KIND_LABELS)) expect(copyViolations(label)).toEqual([]);
  });
});

describe("the source strip", () => {
  it("lists each outlet once with how many signals it supplied, most first, linked to a piece", () => {
    const sources = storySources(
      entry({
        id: "n",
        kind: "narrative",
        evidence: [
          evidence({ id: "1", detail: article("Forbes", "forbes.com") }),
          evidence({ id: "2", detail: article("Yahoo Finance", "finance.yahoo.com") }),
          evidence({ id: "3", detail: article("Forbes - Business", "www.forbes.com") }),
          evidence({ id: "4", relation: "inverse_pair", person: { name: "Kendrick Lamar", slug: "kendrick-lamar" }, detail: article("Billboard", "billboard.com") }),
        ],
      }),
    );
    expect(sources).toEqual([
      { name: "Forbes", domain: "forbes.com", link: "https://forbes.com/story", count: 2 },
      { name: "Yahoo Finance", domain: "finance.yahoo.com", link: "https://finance.yahoo.com/story", count: 1 },
    ]);
  });

  it("names a platform for media, a reader's noun for a metric, and falls back to the entry's sources", () => {
    expect(storySources(entry({ id: "v", evidence: [evidence({ source: "YouTube Trending", detail: youtube })] }))).toEqual([{ name: "YouTube", domain: "youtube.com", link: "https://www.youtube.com/watch?v=y56D2WIeKxg", count: 1 }]);
    expect(storySources(entry({ id: "l", evidence: [evidence({ source: "Twitch", detail: twitch })] }))).toEqual([{ name: "Twitch", domain: "twitch.tv", link: "https://www.twitch.tv/kaicenat", count: 1 }]);
    expect(storySources(entry({ id: "m", evidence: [evidence({ source: "Finnhub", payload: { kind: "metric" } })] }))).toEqual([{ name: "Company news", domain: null, link: null, count: 1 }]);
    expect(storySources(entry({ id: "e", evidence: [], sources: ["API-Sports"] }))).toEqual([{ name: "Game data", domain: null, link: null, count: 1 }]);
    for (const source of storySources(entry({ id: "w", evidence: [evidence({ source: "RSS (per-person news feed)" })] }))) expect(source.name).not.toMatch(/RSS/);
  });

  it("asks the icon service for the outlet's own icon, by domain", () => {
    expect(sourceIconUrl("www.Forbes.com")).toBe("https://icons.duckduckgo.com/ip3/forbes.com.ico");
  });

  it("gives a platform its own mark, a publisher its favicon, and a metric or data source a neutral glyph, never a letter (2026-09-29)", () => {
    expect(sourceGlyph({ name: "YouTube", domain: "youtube.com" })).toBe("youtube");
    expect(sourceGlyph({ name: "YouTube comments", domain: null })).toBe("youtube");
    expect(sourceGlyph({ name: "Twitch", domain: "twitch.tv" })).toBe("twitch");
    expect(sourceGlyph({ name: "Twitch", domain: null })).toBe("twitch");
    expect(sourceGlyph({ name: "Forbes", domain: "forbes.com" })).toBe("favicon");
    expect(sourceGlyph({ name: "HotNewHipHop", domain: "hotnewhiphop.com" })).toBe("favicon");
    expect(sourceGlyph({ name: "News coverage", domain: null })).toBe("news");
    expect(sourceGlyph({ name: "Company news", domain: null })).toBe("news");
    expect(sourceGlyph({ name: "Game data", domain: null })).toBe("game");
    expect(sourceGlyph({ name: "Company filings", domain: null })).toBe("filing");
    expect(sourceGlyph({ name: "Spotify", domain: null })).toBe("metric");
    expect(sourceGlyph({ name: "Signal", domain: null })).toBe("metric");
  });
});

describe("media: only what the platform publishes for embedding", () => {
  it("builds the official YouTube thumbnail and player, and Twitch's players with the page's hostname", () => {
    expect(youtubeThumbnailUrl("y56D2WIeKxg")).toBe("https://i.ytimg.com/vi/y56D2WIeKxg/hqdefault.jpg");
    expect(youtubeEmbedUrl("y56D2WIeKxg")).toBe("https://www.youtube-nocookie.com/embed/y56D2WIeKxg?autoplay=1&rel=0");
    expect(twitchEmbedUrl({ kind: "twitch", channel: "kaicenat", clip: null, title: null }, "momentumterminal.app")).toBe("https://player.twitch.tv/?channel=kaicenat&parent=momentumterminal.app&muted=true");
    expect(twitchEmbedUrl({ kind: "twitch", channel: "kaicenat", clip: "Clip-1", title: null }, "momentumterminal.app")).toBe("https://clips.twitch.tv/embed?clip=Clip-1&parent=momentumterminal.app&autoplay=true");
    expect(mediaLink({ kind: "youtube", videoId: "y56D2WIeKxg", title: null })).toBe("https://www.youtube.com/watch?v=y56D2WIeKxg");
    expect(mediaLink({ kind: "twitch", channel: "kaicenat", clip: "Clip-1", title: null })).toBe("https://clips.twitch.tv/Clip-1");
  });

  it("takes the story's media from its own evidence, never the paired person's, and an article has none", () => {
    expect(storyMedia(entry({ id: "v", evidence: [evidence({ detail: youtube })] }))).toEqual(youtube.media);
    expect(storyMedia(entry({ id: "p", evidence: [evidence({ relation: "inverse_pair", person: { name: "X", slug: "x" }, detail: youtube })] }))).toBeNull();
    expect(storyMedia(entry({ id: "a", evidence: [evidence({ detail: article("Forbes", "forbes.com") })] }))).toBeNull();
  });
});

describe("the score across the move", () => {
  const at = NOW;
  const series = [
    { at: iso(at - 4 * 3_600_000), score: 49 },
    { at: iso(at - 3_600_000), score: 50 },
    { at: iso(at - 60_000), score: 50.2 },
    { at: iso(at), score: 51.4 },
    { at: iso(at + 3_600_000), score: 51.2 },
    { at: iso(at + 4 * 3_600_000), score: 52 },
  ];

  it("takes the hours around the move, oldest first, and says nothing below the minimum", () => {
    expect(sparkAcross(series, iso(at))).toEqual([50, 50.2, 51.4, 51.2]);
    expect(sparkAcross([...series].reverse(), iso(at))).toEqual([50, 50.2, 51.4, 51.2]);
    expect(sparkAcross(series.slice(0, SPARK_MIN_POINTS - 1), iso(at - 4 * 3_600_000))).toBeNull();
    expect(sparkAcross(series, "not a time")).toBeNull();
    expect(sparkAcross([], iso(at))).toBeNull();
  });
});

describe("Also moving", () => {
  it("is a signal whose move is under the threshold; a narrative never", () => {
    expect(isAlsoMoving(entry({ id: "a", impact: 0.1 }))).toBe(true);
    expect(isAlsoMoving(entry({ id: "b", impact: -(ALSO_MOVING_BELOW - 0.01) }))).toBe(true);
    expect(isAlsoMoving(entry({ id: "c", impact: ALSO_MOVING_BELOW }))).toBe(false);
    expect(isAlsoMoving(entry({ id: "d", impact: null }))).toBe(false);
    expect(isAlsoMoving(entry({ id: "n", kind: "narrative", impact: 0.1 }))).toBe(false);
  });

  it("folds each run of small moves into one block where the run began, keeps the order, drops nothing", () => {
    const stream = [entry({ id: "1", impact: 0.8 }), entry({ id: "2", impact: 0.1 }), entry({ id: "3", impact: -0.2 }), entry({ id: "4", impact: 0.5 }), entry({ id: "5", impact: 0.1 })];
    const blocks = groupStream(stream);
    expect(blocks.map((block) => (block.type === "card" ? block.entry.id : block.entries.map((item) => item.id)))).toEqual(["1", ["2", "3"], "4", ["5"]]);
    expect(blocks.flatMap((block) => (block.type === "card" ? [block.entry.id] : block.entries.map((item) => item.id)))).toEqual(["1", "2", "3", "4", "5"]);
    expect(groupStream([])).toEqual([]);
  });
});
