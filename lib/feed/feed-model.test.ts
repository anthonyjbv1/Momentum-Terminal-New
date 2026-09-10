import { describe, expect, it } from "vitest";

import {
  FEED_MAX_ENTRIES,
  HIGH_IMPACT_THRESHOLD,
  PINNED_MAX,
  PINNED_WINDOW_HOURS,
  cursorAfter,
  filterEntries,
  frameSignal,
  indefiniteArticle,
  mergeEntries,
  selectPinned,
  shortSource,
  toFeedEntry,
  type FeedEntry,
  type FeedRow,
} from "./feed-model";
import { chronologicalRanker, rankFeed } from "./ranking";

const NOW = Date.UTC(2026, 8, 10, 18, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function row(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    kind: "narrative",
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    person_id: "dda851f2-38e8-4b46-ace0-de4bbba33a0b",
    person_slug: "drake",
    person_name: "Drake",
    person_category: "musician",
    person_avatar: null,
    text: "Drake's momentum climbed on \"channel adds 516K subscribers in 24 hours\".",
    impact: "1.4",
    score_before: "50",
    score_after: "51.4",
    tick_number: "512",
    occurred_at: iso(NOW - 120_000),
    sources: ["YouTube"],
    evidence: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", headline: "channel adds 516K subscribers in 24 hours", source: "YouTube", impact: 1.4, occurred_at: iso(NOW - 180_000), sentiment: "positive", confidence: 0.82 }],
    ...overrides,
  };
}

function entry(overrides: Partial<FeedEntry> & { id: string }): FeedEntry {
  return {
    kind: "narrative",
    person: { id: "p1", slug: "drake", name: "Drake", category: "musician", avatarUrl: null },
    text: "x",
    quote: null,
    impact: null,
    direction: "neutral",
    scoreBefore: null,
    scoreAfter: null,
    tickNumber: null,
    occurredAt: iso(NOW),
    sources: [],
    evidence: [],
    ...overrides,
  };
}

describe("toFeedEntry", () => {
  it("keeps a narrative's sentence as written, with its move and evidence", () => {
    const made = toFeedEntry(row());
    expect(made).toMatchObject({
      kind: "narrative",
      text: "Drake's momentum climbed on \"channel adds 516K subscribers in 24 hours\".",
      quote: null,
      impact: 1.4,
      direction: "heating",
      scoreBefore: 50,
      scoreAfter: 51.4,
      tickNumber: 512,
      sources: ["YouTube"],
    });
    expect(made?.evidence).toHaveLength(1);
    expect(made?.evidence[0]).toMatchObject({ source: "YouTube", impact: 1.4, sentiment: "positive", confidence: 0.82, relation: "direct", person: null });
  });

  it("frames a raw signal in the Engine's voice and quotes the headline beneath", () => {
    const unread = toFeedEntry(
      row({
        kind: "signal",
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        text: "Label confirms release date slipped",
        impact: null,
        score_before: null,
        score_after: null,
        tick_number: null,
        sources: ["RSS (per-person news feed)"],
        evidence: [{ id: "aaaaaaaa-0000-4000-8000-000000000002", headline: "Label confirms release date slipped", source: "RSS (per-person news feed)", impact: null, occurred_at: iso(NOW), processed: false }],
      }),
    );
    expect(unread).toMatchObject({
      kind: "signal",
      text: "An RSS signal on Drake is waiting for the Engine's next read.",
      quote: "Label confirms release date slipped",
      impact: null,
      direction: "neutral",
      sources: ["RSS"],
    });

    const read = toFeedEntry(
      row({
        kind: "signal",
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        text: "New upload, day one",
        impact: 0.2,
        sources: ["YouTube"],
        evidence: [{ id: "aaaaaaaa-0000-4000-8000-000000000003", headline: "New upload, day one", source: "YouTube", impact: 0.2, occurred_at: iso(NOW), processed: true }],
      }),
    );
    expect(read?.text).toBe("A YouTube signal on Drake read +0.2.");
    expect(read?.direction).toBe("heating");
  });

  it("drops rows it cannot place", () => {
    expect(toFeedEntry(row({ kind: "mystery" }))).toBeNull();
    expect(toFeedEntry(row({ occurred_at: "" }))).toBeNull();
  });

  it("shortens source names to a name", () => {
    expect(shortSource("RSS (per-person news feed)")).toBe("RSS");
    expect(shortSource("YouTube")).toBe("YouTube");
    expect(shortSource(null)).toBeNull();
    expect(frameSignal("Drake", null, 0.01, true)).toBe("A signal on Drake read as neutral.");
    expect(frameSignal("Drake", "YouTube", -0.6, true)).toBe("A YouTube signal on Drake read −0.6.");
  });

  it("picks the article by the sound of the source's first letter", () => {
    expect(indefiniteArticle("RSS")).toBe("An");
    expect(indefiniteArticle("X")).toBe("An");
    expect(indefiniteArticle("API-Sports")).toBe("An");
    expect(indefiniteArticle("YouTube")).toBe("A");
    expect(indefiniteArticle("Twitch")).toBe("A");
    expect(indefiniteArticle("Instagram")).toBe("An");
    expect(indefiniteArticle("")).toBe("A");
  });
});

describe("paging", () => {
  it("cursors from the last entry of a full page only", () => {
    const full = Array.from({ length: 3 }, (_, index) => entry({ id: `e${index}`, occurredAt: iso(NOW - index * 1000) }));
    expect(cursorAfter(full, 3)).toEqual({ before: iso(NOW - 2000), beforeId: "e2" });
    expect(cursorAfter(full, 4)).toBeNull();
    expect(cursorAfter([], 3)).toBeNull();
  });

  it("merges pages without duplicates and never past the cap", () => {
    const first = [entry({ id: "a" }), entry({ id: "b" })];
    const next = [entry({ id: "b" }), entry({ id: "c" })];
    expect(mergeEntries(first, next).map((item) => item.id)).toEqual(["a", "b", "c"]);
    const many = Array.from({ length: FEED_MAX_ENTRIES + 10 }, (_, index) => entry({ id: `m${index}` }));
    expect(mergeEntries([], many)).toHaveLength(FEED_MAX_ENTRIES);
  });
});

describe("selection", () => {
  it("filters by the person's category", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b", person: { id: "p2", slug: "mrbeast", name: "MrBeast", category: "creator", avatarUrl: null } })];
    expect(filterEntries(entries, "all")).toHaveLength(2);
    expect(filterEntries(entries, "creator").map((item) => item.id)).toEqual(["b"]);
  });

  it("pins recorded moves at or beyond the threshold, strongest first, at most PINNED_MAX, within the window", () => {
    expect(HIGH_IMPACT_THRESHOLD).toBe(1.25);
    expect(PINNED_WINDOW_HOURS).toBe(24);
    const entries = [
      entry({ id: "small", impact: 1.2 }),
      entry({ id: "exact", impact: 1.25 }),
      entry({ id: "down", impact: -3.1 }),
      entry({ id: "old", impact: 5, occurredAt: iso(NOW - 25 * 3_600_000) }),
      entry({ id: "big", impact: 2.6 }),
      entry({ id: "bigger", impact: 2.8 }),
      entry({ id: "none", impact: null }),
    ];
    const pinned = selectPinned(entries, NOW);
    expect(pinned.map((item) => item.id)).toEqual(["down", "bigger", "big"]);
    expect(pinned).toHaveLength(PINNED_MAX);
    // At the threshold qualifies; just under it does not.
    expect(selectPinned([entry({ id: "small", impact: 1.2 }), entry({ id: "exact", impact: -1.25 })], NOW).map((item) => item.id)).toEqual(["exact"]);
    expect(selectPinned([entry({ id: "quiet", impact: 0.4 })], NOW)).toEqual([]);
  });
});

describe("ranking", () => {
  it("ships chronological only, newest first", () => {
    const entries = [entry({ id: "old", occurredAt: iso(NOW - 5000) }), entry({ id: "new", occurredAt: iso(NOW) }), entry({ id: "mid", occurredAt: iso(NOW - 1000) })];
    expect(rankFeed(entries, { now: NOW }).map((item) => item.id)).toEqual(["new", "mid", "old"]);
    expect(rankFeed(entries, { now: NOW }, chronologicalRanker)).toEqual(rankFeed(entries, { now: NOW }));
  });
});
