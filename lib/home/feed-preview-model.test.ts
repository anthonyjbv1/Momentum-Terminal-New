import { describe, expect, it } from "vitest";

import { buildFeedPreview, type FeedPreviewNarrativeRow, type FeedPreviewSignalRow } from "./feed-preview-model";

/**
 * Home's desktop rail (Phase 31): one card per fact, as on the Feed. The
 * fixture is Kai Cenat's 2026-09-26 afternoon: a surge the Engine wrote a
 * narrative about, the went-live signal, and an unrelated article.
 */

const KAI = { id: "p-kai", slug: "kai-cenat", display_name: "Kai Cenat", category: "creator" };
const MUSK = { id: "p-musk", slug: "elon-musk", display_name: "Elon Musk", category: "executive" };

const SURGE_PAYLOAD = { kind: "live_moment", source: "twitch" };

function signalRow(over: Partial<FeedPreviewSignalRow>): FeedPreviewSignalRow {
  return {
    id: "s",
    headline: "A headline",
    occurred_at: "2026-09-26T15:00:00Z",
    impact_score: "0.5",
    processed: true,
    sentiment_label: null,
    raw_payload: null,
    people: KAI,
    data_sources: { display_name: "Twitch" },
    narrative_signals: [],
    ...over,
  };
}

const surge = signalRow({ id: "surge", headline: "Kai Cenat's live audience jumped 22% in ten minutes.", occurred_at: "2026-09-26T15:24:00Z", impact_score: "0.54", raw_payload: SURGE_PAYLOAD, narrative_signals: [{ relation: "direct" }] });
const wentLive = signalRow({
  id: "live",
  headline: 'Kai Cenat is live on Twitch playing IRL to 0 viewers: "🇮🇸EXPLORING ICELAND🇮🇸[Exploring The Unexplored]".',
  occurred_at: "2026-09-26T11:16:20Z",
  impact_score: "0.2",
  raw_payload: { kind: "stream", source: "twitch", title: "🇮🇸EXPLORING ICELAND🇮🇸[Exploring The Unexplored]", game: "IRL", viewer_count: 0 },
});
const article = signalRow({
  id: "article",
  headline: "Tesla recalls 2,000 trucks",
  occurred_at: "2026-09-26T14:00:00Z",
  impact_score: "-0.3",
  people: MUSK,
  data_sources: { display_name: "Publisher feeds" },
  raw_payload: { kind: "article", outlet: "Reuters", publisher_domain: "reuters.com", link: "https://reuters.com/a" },
  // The other half of an inverse pair: still Musk's own news.
  narrative_signals: [{ relation: "inverse_pair" }],
});

const narrative: FeedPreviewNarrativeRow = {
  id: "n-surge",
  text: "Kai Cenat's momentum climbed as his Iceland stream drew a sudden crowd.",
  created_at: "2026-09-26T15:30:00Z",
  score_before: "61.0",
  score_after: "61.5",
  people: KAI,
  narrative_signals: [{ relation: "direct", signals: { id: "surge", headline: surge.headline, occurred_at: surge.occurred_at, impact_score: "0.54", raw_payload: SURGE_PAYLOAD, data_sources: { display_name: "Twitch" }, people: { display_name: "Kai Cenat" } } }],
};

describe("the rail", () => {
  it("shows a narrative's direct evidence as the narrative only (rule 8)", () => {
    const items = buildFeedPreview([narrative], [surge, wentLive, article], new Map(), 8);
    expect(items.map((item) => item.id)).toEqual(["narrative:n-surge", "signal:article", "signal:live"]);
    expect(items[0].source).toBe("The Engine · Twitch");
  });

  it("renders the went-live line without a count, and playing only for a game", () => {
    const [live] = buildFeedPreview([], [wentLive], new Map(), 8);
    expect(live.text).toBe("Kai Cenat went live on Twitch: “🇮🇸EXPLORING ICELAND🇮🇸[Exploring The Unexplored]” (IRL).");
    const game = signalRow({ id: "g", raw_payload: { kind: "stream", source: "twitch", title: "🎮WOLVERINE MARATHON🎮CLICK HERE🎮", game: "Marvel's Wolverine", viewer_count: 40327 } });
    expect(buildFeedPreview([], [game], new Map(), 8)[0].text).toBe("Kai Cenat went live on Twitch playing Marvel's Wolverine: “🎮WOLVERINE MARATHON🎮CLICK HERE🎮”.");
  });

  it("still leaves out what prints as zero or is unread, and keeps the limit", () => {
    const zero = signalRow({ id: "zero", impact_score: "0.01" });
    const unread = signalRow({ id: "unread", processed: false });
    expect(buildFeedPreview([], [zero, unread, wentLive], new Map(), 8).map((item) => item.id)).toEqual(["signal:live"]);
    expect(buildFeedPreview([narrative], [wentLive, article], new Map(), 2).map((item) => item.id)).toEqual(["narrative:n-surge", "signal:article"]);
  });
});
