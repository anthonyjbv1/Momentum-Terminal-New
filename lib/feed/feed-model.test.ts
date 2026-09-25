import { describe, expect, it } from "vitest";

import { type SignalDetail } from "./card-copy";
import {
  FEED_MAX_ENTRIES,
  HIGH_IMPACT_THRESHOLD,
  PINNED_MAX,
  PINNED_WINDOW_HOURS,
  cursorAfter,
  evidenceDetailLines,
  evidenceHeadline,
  filterEntries,
  isCard,
  mergeEntries,
  pageFromRows,
  selectPinned,
  shortSource,
  signalIdsOf,
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
    person: { id: "p1", slug: "drake", name: "Drake", category: "musician", avatarUrl: null, company: null },
    text: "x",
    copy: { label: null, headline: "x", link: null, line: "The Engine.", attribution: "The Engine", quoted: false },
    impact: null,
    direction: "neutral",
    scoreBefore: null,
    scoreAfter: null,
    tickNumber: null,
    occurredAt: iso(NOW),
    sources: [],
    evidence: [],
    detailLines: [],
    ...overrides,
  };
}

const article: SignalDetail = { kind: "article", outlet: "Billboard", domain: "billboard.com", link: "https://www.billboard.com/story", digest: null };

describe("toFeedEntry", () => {
  it("keeps a narrative's stored text, un-nests the template for the card, and carries its move and evidence", () => {
    const made = toFeedEntry(row());
    expect(made).toMatchObject({
      kind: "narrative",
      text: "Drake's momentum climbed on \"channel adds 516K subscribers in 24 hours\".",
      impact: 1.4,
      direction: "heating",
      scoreBefore: 50,
      scoreAfter: 51.4,
      tickNumber: 512,
      sources: ["YouTube"],
    });
    // Rule 2: the quoted signal is the headline; the move is in the line; nothing is nested.
    expect(made?.copy).toEqual({ label: null, headline: "channel adds 516K subscribers in 24 hours", link: null, line: "YouTube · Drake +1.4.", attribution: "The Engine · YouTube", quoted: false });
    expect(made?.evidence).toHaveLength(1);
    expect(made?.evidence[0]).toMatchObject({ source: "YouTube", impact: 1.4, sentiment: "positive", confidence: 0.82, relation: "direct", person: null, detail: null });
  });

  it("renders a raw signal as its outlet, its title and one line, and knows an unread one is waiting", () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000002";
    const details = new Map([[id, article]]);
    const unread = toFeedEntry(
      row({
        kind: "signal",
        id,
        text: "Label confirms release date slipped",
        impact: null,
        score_before: null,
        score_after: null,
        tick_number: null,
        sources: ["RSS (per-person news feed)"],
        evidence: [{ id, headline: "Label confirms release date slipped", source: "RSS (per-person news feed)", impact: null, occurred_at: iso(NOW), processed: false }],
      }),
      { details, companies: new Map() },
    );
    expect(unread).toMatchObject({
      kind: "signal",
      text: "Label confirms release date slipped",
      impact: null,
      direction: "neutral",
      sources: ["RSS (per-person news feed)"],
    });
    expect(unread?.copy).toEqual({ label: "Billboard", headline: "Label confirms release date slipped", link: "https://www.billboard.com/story", line: "Waiting for the Engine's next read.", attribution: "Billboard", quoted: true });
    expect(unread ? isCard(unread) : null).toBe(false);
    for (const text of [unread?.copy.headline, unread?.copy.line, unread?.copy.attribution]) expect(text).not.toMatch(/RSS/);

    const read = toFeedEntry(
      row({
        kind: "signal",
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        text: "New upload, day one",
        impact: 0.2,
        sources: ["YouTube"],
        evidence: [{ id: "aaaaaaaa-0000-4000-8000-000000000003", headline: "New upload, day one", source: "YouTube", impact: 0.2, occurred_at: iso(NOW), processed: true, sentiment: "positive" }],
      }),
    );
    expect(read?.copy.headline).toBe("New upload, day one");
    expect(read?.copy.line).toBe("YouTube · Drake +0.2.");
    expect(read?.direction).toBe("heating");
    expect(read ? isCard(read) : null).toBe(true);
    expect(read?.detailLines).toEqual([{ label: "Source", value: "YouTube" }]);
  });

  it("carries the company from the context into a company-news sentence", () => {
    const payload = { kind: "metric", metric: "company_news_volume_24h", label: "company news volume", sigma: 2.2, direction: 1, polarity: 1, samples: 234, min_samples: 24, window_hours: 336, delta_kind: "level", threshold_std_devs: 2, scale: 0.5, source: "finnhub" };
    const made = toFeedEntry(
      row({
        kind: "signal",
        id: "aaaaaaaa-0000-4000-8000-000000000004",
        person_id: "musk",
        person_slug: "elon-musk",
        person_name: "Elon Musk",
        person_category: "executive",
        text: "Elon Musk's company is in the news more than usual",
        impact: 0.8,
        sources: ["Finnhub"],
        evidence: [{ id: "aaaaaaaa-0000-4000-8000-000000000004", headline: "Elon Musk's company is in the news more than usual", source: "Finnhub", impact: 0.8, occurred_at: iso(NOW), processed: true, payload }],
      }),
      { details: new Map(), companies: new Map([["musk", "Tesla"]]) },
    );
    expect(made?.person.company).toBe("Tesla");
    expect(made?.copy.headline).toContain("Tesla");
    expect(made?.copy.line).toBe("Company news · Musk +0.8.");
    expect(made?.detailLines.map((line) => line.label)).toContain("Source");
  });

  it("drops rows it cannot place", () => {
    expect(toFeedEntry(row({ kind: "mystery" }))).toBeNull();
    expect(toFeedEntry(row({ occurred_at: "" }))).toBeNull();
  });

  it("shortens source names to a handle for logs", () => {
    expect(shortSource("RSS (per-person news feed)")).toBe("RSS");
    expect(shortSource("YouTube")).toBe("YouTube");
    expect(shortSource(null)).toBeNull();
  });

  it("lists every signal id a page refers to", () => {
    expect(signalIdsOf([row(), row({ evidence: [{ id: "x" }, { nope: true }] }), row({ evidence: null })])).toEqual(["aaaaaaaa-0000-4000-8000-000000000001", "x"]);
  });
});

describe("paging", () => {
  it("cursors from the last entry of a full page only", () => {
    const full = Array.from({ length: 3 }, (_, index) => entry({ id: `e${index}`, occurredAt: iso(NOW - index * 1000) }));
    expect(cursorAfter(full, 3)).toEqual({ before: iso(NOW - 2000), beforeId: "e2" });
    expect(cursorAfter(full, 4)).toBeNull();
    expect(cursorAfter([], 3)).toBeNull();
  });

  it("takes a page's cursor from the last ROW, then hides the cards that print as zero (rule 6)", () => {
    const signal = (id: string, impact: number | null, at: number, processed = true) =>
      row({ kind: "signal", id, text: `h${id}`, impact, score_before: null, score_after: null, tick_number: null, occurred_at: iso(at), sources: ["YouTube"], evidence: [{ id, headline: `h${id}`, source: "YouTube", impact, occurred_at: iso(at), processed }] });
    const rows = [signal("a", 0.8, NOW), signal("b", 0, NOW - 1000), signal("c", 0.04, NOW - 2000), signal("d", null, NOW - 3000, false), signal("e", -0.3, NOW - 4000), signal("f", 0.0, NOW - 5000)];
    const page = pageFromRows(rows, 6);
    expect(page.entries.map((item) => item.id)).toEqual(["a", "e"]);
    // The cursor points past the hidden last row, not past the last card shown.
    expect(page.nextCursor).toEqual({ before: iso(NOW - 5000), beforeId: "f" });
    // A short page is the last page, however many of its rows were hidden.
    expect(pageFromRows(rows.slice(0, 3), 6).nextCursor).toBeNull();
    expect(pageFromRows([], 6)).toEqual({ entries: [], nextCursor: null });
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
    const entries = [entry({ id: "a" }), entry({ id: "b", person: { id: "p2", slug: "mrbeast", name: "MrBeast", category: "creator", avatarUrl: null, company: null } })];
    expect(filterEntries(entries, "all")).toHaveLength(2);
    expect(filterEntries(entries, "creator").map((item) => item.id)).toEqual(["b"]);
  });

  it("pins recorded moves at or beyond the threshold, strongest first, at most PINNED_MAX, within the window", () => {
    // Phase 14: the Engine's own unit of notable, shared with narratives.minAbsChange and memory.notableImpactThreshold.
    expect(HIGH_IMPACT_THRESHOLD).toBe(0.5);
    expect(PINNED_WINDOW_HOURS).toBe(24);
    const entries = [
      entry({ id: "small", impact: 0.45 }),
      entry({ id: "exact", impact: 0.5 }),
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
    expect(selectPinned([entry({ id: "small", impact: 0.45 }), entry({ id: "exact", impact: -0.5 })], NOW).map((item) => item.id)).toEqual(["exact"]);
    expect(selectPinned([entry({ id: "quiet", impact: 0.28 })], NOW)).toEqual([]); // the first run's mean move when anything moved
  });
});

describe("ranking", () => {
  it("ships chronological only, newest first", () => {
    const entries = [entry({ id: "old", occurredAt: iso(NOW - 5000) }), entry({ id: "new", occurredAt: iso(NOW) }), entry({ id: "mid", occurredAt: iso(NOW - 1000) })];
    expect(rankFeed(entries, { now: NOW }).map((item) => item.id)).toEqual(["new", "mid", "old"]);
    expect(rankFeed(entries, { now: NOW }, chronologicalRanker)).toEqual(rankFeed(entries, { now: NOW }));
  });
});

describe("a metric signal reads as plain language, whenever it was stored (Phase 21+)", () => {
  /** A payload as Phase 7 wrote them: everything but the counts, which came later. */
  const historical = {
    kind: "metric", metric: "news_volume_24h", label: "news volume",
    sigma: -4.5, direction: -1, polarity: 1, samples: 312, min_samples: 24,
    window_hours: 336, delta_kind: "level", threshold_std_devs: 1, scale: 1, source: "rss",
  };
  /** The same reading written since the gate opened. */
  const current = { ...historical, sigma: 2.9, direction: 1, observed: 12, baseline: 4 };
  const zuck = { name: "Mark Zuckerberg", category: "executive", company: "Meta" };

  const evidence = (payload: unknown, headline: string) => ({
    id: "s1", headline, source: "RSS (per-person news feed)", impact: -0.4, occurredAt: "2026-09-19T12:00:00Z",
    sentiment: null, confidence: null, processed: true, relation: "direct" as const, person: null, payload, detail: null,
  });

  it("re-renders a headline stored in sigma, without rewriting the stored row", () => {
    const stored = "Mark Zuckerberg's news volume is running -4.5σ below their own trailing fortnight";
    const item = evidence(historical, stored);
    const shown = evidenceHeadline(item, zuck);
    expect(shown).not.toContain("σ");
    expect(shown).toContain("Mark Zuckerberg");
    // The stored string is untouched; the payload is what display reads.
    expect(item.headline).toBe(stored);
  });

  it("un-nests a narrative the Engine wrote around a sigma headline", () => {
    // 137 of the last week's 236 narratives are this exact shape: a template
    // that quotes the signal verbatim. The card shows the re-rendered signal
    // as its headline and the move in its line; the stored text is kept.
    const stored = "Mark Zuckerberg's news volume is running -4.5σ below their own trailing fortnight";
    const made = toFeedEntry(
      row({
        person_slug: "mark-zuckerberg",
        person_name: "Mark Zuckerberg",
        person_category: "executive",
        text: `Mark Zuckerberg's momentum slipped on "${stored}".`,
        impact: "-0.4",
        sources: ["RSS (per-person news feed)"],
        evidence: [{ id: "s1", headline: stored, source: "RSS (per-person news feed)", impact: -0.4, occurred_at: "2026-09-19T12:00:00Z", processed: true, payload: historical }],
      }),
    );
    expect(made?.text).toContain("momentum slipped on");
    expect(made?.copy.headline).not.toMatch(/σ|momentum slipped/);
    expect(made?.copy.headline).toContain("Mark Zuckerberg");
    expect(made?.copy.line).toBe("News coverage · −0.4.");
    expect(made?.copy.attribution).toBe("The Engine · News coverage");
  });

  it("leaves an event signal's headline exactly as observed", () => {
    const item = evidence(null, "MrBeast opens a theme park in Kansas");
    expect(evidenceHeadline(item, { name: "MrBeast", category: "creator", company: null })).toBe("MrBeast opens a theme park in Kansas");
  });

  it("shows the counts for a metric that publishes them, and none for one that does not", () => {
    const drake = { name: "Drake", category: "musician", company: null };
    const withCounts = evidenceDetailLines(evidence(current, "x"), drake);
    expect(withCounts.map((line) => line.value)).toContain("12 stories");
    expect(withCounts.map((line) => line.value)).toContain("4 stories");
    expect(withCounts.some((line) => line.value.includes("3x their usual pace"))).toBe(true);
    expect(withCounts[0]).toEqual({ label: "Source", value: "News coverage" });

    // A historical payload has no counts: the sentence still renders, the
    // arithmetic is simply absent rather than invented.
    const withoutCounts = evidenceDetailLines(evidence(historical, "x"), drake);
    expect(withoutCounts.some((line) => line.label === "Observed")).toBe(false);
    expect(withoutCounts.some((line) => line.value.includes("fortnight"))).toBe(true);
  });
});
