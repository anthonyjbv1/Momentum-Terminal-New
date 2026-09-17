import { describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";
import { buildRegistry } from "@/lib/connectors/registry";
import type { DataConnector, FeedCatalogEntry, RawSignal } from "@/lib/connectors/types";

import { runIngestion, type IngestLogLine } from "./runner";
import { createMemoryIngestStore } from "./store";

/**
 * Phase 13, at the runner: one story is one signal across the two news
 * doors, and what the catalogue fetch found is written back onto its rows.
 */

const NOW = new Date("2026-09-17T15:00:00.000Z");
const hour = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const person = makePerson();
const quiet = () => undefined;

function article(headline: string, key: string, domain: string, at: Date): RawSignal {
  return { headline, story: headline, publisherDomain: domain, dedupeKey: key, occurredAt: at, rawPayload: { kind: "article", outlet: "Outlet", publisher_domain: domain } };
}

/** A news connector in a story family, returning whatever the test says. */
function newsConnector(name: string, family: string | undefined, items: () => RawSignal[]): DataConnector {
  return { name, storyFamily: family, fetchForPerson: async () => items() };
}

describe("story families", () => {
  const sources = [
    makeSource({ id: "src-pub", name: "publisher_rss", tier: 3, is_active: true }),
    makeSource({ id: "src-rss", name: "rss", tier: 3, is_active: true }),
    makeSource({ id: "src-games", name: "games", tier: 2, is_active: true }),
  ];
  const seed = () =>
    createMemoryIngestStore({
      sources,
      mappings: { "src-pub": [{ person, externalIdentifier: "MrBeast" }], "src-rss": [{ person, externalIdentifier: "q" }], "src-games": [{ person, externalIdentifier: "1" }] },
      publisherDomains: [{ domain: "example.com", status: "allowed", tier: 1 }],
    });

  it("collapses the aggregator's later copy of a story into the publisher's earlier signal, across sources", async () => {
    const store = seed();
    const first = buildRegistry([
      newsConnector("publisher_rss", "news", () => [article("MrBeast opens a theme park in Kansas", "pub:1", "example.com", NOW)]),
      newsConnector("rss", "news", () => []),
      newsConnector("games", undefined, () => []),
    ]);
    await runIngestion({ store, now: NOW, registry: first, force: true, log: quiet });
    expect(store.signals.map((s) => [s.dataSourceId, s.dedupeKey])).toEqual([["src-pub", "pub:1"]]);

    // Thirty hours on, Google News surfaces the same story under its own key.
    const lines: IngestLogLine[] = [];
    const second = buildRegistry([
      newsConnector("publisher_rss", "news", () => []),
      newsConnector("rss", "news", () => [article("MrBeast opens theme park in Kansas", "rss:1", "example.com", hour(30))]),
      newsConnector("games", undefined, () => []),
    ]);
    const summary = await runIngestion({ store, now: hour(30), registry: second, force: true, log: (line) => lines.push(line) });
    expect(summary.sourcesRun.find((s) => s.name === "rss")).toMatchObject({ signalsCreated: 0, duplicatesCollapsed: 1 });
    expect(store.signals).toHaveLength(1);
    expect(lines.find((l) => l.event === "collapse")).toMatchObject({ source: "rss", into: { kind: "stored", signalId: store.signals[0].id, tier: 1 } });
  });

  it("leaves a source outside the family deduplicating against itself alone", async () => {
    const store = seed();
    const registry = buildRegistry([
      newsConnector("publisher_rss", "news", () => [article("MrBeast opens a theme park in Kansas", "pub:1", "example.com", NOW)]),
      newsConnector("rss", "news", () => []),
      // A wire that happens to word a story the same way is not a copy of a news article: different family, different signal.
      newsConnector("games", undefined, () => [article("MrBeast opens a theme park in Kansas", "game:1", "example.com", NOW)]),
    ]);
    const summary = await runIngestion({ store, now: NOW, registry, force: true, log: quiet });
    expect(summary.sourcesRun.find((s) => s.name === "games")).toMatchObject({ signalsCreated: 1, duplicatesCollapsed: 0 });
    expect(store.signals.map((s) => s.dedupeKey).sort()).toEqual(["game:1", "pub:1"]);
  });
});

describe("the feed catalogue", () => {
  const feeds: FeedCatalogEntry[] = [
    { id: "f1", domain: "espn.com", url: "https://www.espn.com/espn/rss/nfl/news", section: "NFL", topics: ["nfl"], mode: "feed", etag: null, lastModified: null, lastFetchedAt: null, lastStatus: null, consecutiveFailures: 0 },
    { id: "f2", domain: "dead.example", url: "https://dead.example/rss", section: "All", topics: ["nfl"], mode: "feed", etag: null, lastModified: null, lastFetchedAt: null, lastStatus: null, consecutiveFailures: 1 },
  ];

  /** A connector that reads the catalogue the way the publisher connector does: list, report per feed, count matches. */
  const catalogueConnector: DataConnector = {
    name: "publisher_rss",
    storyFamily: "news",
    async fetchForPerson(_person, _identifier, context) {
      const entries = await context.feeds!.list();
      for (const entry of entries) {
        if (entry.id === "f1") {
          context.feeds!.report({ id: "f1", fetchedAt: context.now, status: "ok", httpStatus: 200, error: null, itemCount: 12, datedCount: 12, describedCount: 12, newestPublishedAt: NOW, discoveredUrl: null, etag: '"e1"', lastModified: null });
          context.feeds!.matched("f1", 2);
        } else {
          context.feeds!.report({ id: "f2", fetchedAt: context.now, status: "error", httpStatus: 503, error: "responded 503", itemCount: null, datedCount: null, describedCount: null, newestPublishedAt: null, discoveredUrl: null, etag: null, lastModified: null });
        }
      }
      return [article("MrBeast opens a theme park in Kansas", "pub:1", "example.com", NOW)];
    },
  };

  it("hands the catalogue to the connector once, writes every fetch's health back with the match count and the failure streak, and logs each feed", async () => {
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-pub", name: "publisher_rss", tier: 3, is_active: true })],
      mappings: { "src-pub": [{ person, externalIdentifier: "MrBeast" }, { person: makePerson({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", slug: "drake", display_name: "Drake" }), externalIdentifier: "Drake" }] },
      feeds,
    });
    const lines: IngestLogLine[] = [];
    const summary = await runIngestion({ store, now: NOW, registry: buildRegistry([catalogueConnector]), force: true, log: (line) => lines.push(line) });

    expect(summary.sourcesRun[0].feeds).toEqual({ fetched: 2, ok: 1, failed: 1, discovered: 0, matched: 4 });
    // Two people, one report per feed (the map keeps the last), matches summed across both.
    expect([...store.feedHealth].sort((a, b) => a.id.localeCompare(b.id)).map((row) => [row.id, row.status, row.matchedCount, row.consecutiveFailures])).toEqual([
      ["f1", "ok", 4, 0],
      ["f2", "error", 0, 2],
    ]);
    // The catalogue rows now carry what was found, as the production rows do.
    expect(store.feeds.find((feed) => feed.id === "f1")).toMatchObject({ lastStatus: "ok", etag: '"e1"', lastFetchedAt: NOW, consecutiveFailures: 0 });
    expect(store.feeds.find((feed) => feed.id === "f2")).toMatchObject({ lastStatus: "error", consecutiveFailures: 2 });
    const feedLines = lines.filter((line) => line.event === "feed");
    expect(feedLines).toHaveLength(2);
    expect(feedLines.find((line) => line.feed === "https://www.espn.com/espn/rss/nfl/news")).toMatchObject({ source: "publisher_rss", domain: "espn.com", section: "NFL", status: "ok", items: 12, dated: 12, matched: 4, error: null });
    expect(feedLines.find((line) => line.feed === "https://dead.example/rss")).toMatchObject({ status: "error", httpStatus: 503, error: "responded 503" });
    expect(summary.errors).toEqual([]);
  });

  it("writes nothing back for a source that never asked for the catalogue", async () => {
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-x", name: "x", tier: 3, is_active: true })],
      mappings: { "src-x": [{ person, externalIdentifier: "id" }] },
      feeds,
    });
    const summary = await runIngestion({ store, now: NOW, registry: buildRegistry([{ name: "x", fetchForPerson: async () => [] }]), force: true, log: quiet });
    expect(summary.sourcesRun[0].feeds).toBeUndefined();
    expect(store.feedHealth).toEqual([]);
  });
});

describe("the run budget", () => {
  /** A connector whose poll costs a fixed amount of the injected clock. */
  function slowConnector(name: string, costMs: number, clock: { now: number }): DataConnector {
    return {
      name,
      async fetchForPerson(_person, identifier) {
        clock.now += costMs;
        return [{ headline: `${name} item for ${identifier}`, dedupeKey: `${name}:${identifier}`, occurredAt: NOW, rawPayload: { kind: "article" } }];
      },
    };
  }

  it("stops starting polls once the budget is spent, records what waited as skipped, and still closes the run", async () => {
    const clock = { now: NOW.getTime() };
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-a", name: "a", is_active: true }), makeSource({ id: "src-b", name: "b", is_active: true }), makeSource({ id: "src-c", name: "c", is_active: true })],
      mappings: {
        "src-a": [{ person, externalIdentifier: "one" }, { person: makePerson({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", slug: "drake", display_name: "Drake" }), externalIdentifier: "two" }],
        "src-b": [{ person, externalIdentifier: "one" }],
        "src-c": [{ person, externalIdentifier: "one" }],
      },
    });
    const lines: IngestLogLine[] = [];
    const registry = buildRegistry([slowConnector("a", 20_000, clock), slowConnector("b", 20_000, clock), slowConnector("c", 20_000, clock)]);
    const summary = await runIngestion({ store, now: NOW, registry, force: true, log: (line) => lines.push(line), budgetMs: 35_000, clock: () => clock.now });

    // a/one (20 s) and a/two (40 s) ran — the second started at 20 s, inside the budget; b and c did not start.
    expect(store.signals.map((s) => s.dedupeKey)).toEqual(["a:one", "a:two"]);
    expect(summary.budget).toEqual({ ms: 35_000, exhausted: true });
    expect(summary.sourcesSkipped).toEqual([
      { name: "b", reason: expect.stringMatching(/^run budget of 35000 ms exhausted after 40000 ms/) },
      { name: "c", reason: expect.stringMatching(/^run budget of 35000 ms exhausted/) },
    ]);
    expect(store.polls.map((p) => [p.dataSourceId, p.status])).toEqual([
      ["src-a", "ok"],
      ["src-a", "ok"],
      ["src-b", "skipped"],
      ["src-c", "skipped"],
    ]);
    // Closed, with its ledger: what a killed function never writes.
    expect(store.runs[0].result).toMatchObject({ sourcesRun: 1, signalsCreated: 2 });
    expect(summary.durationMs).toBe(40_000);
    expect(lines.find((l) => l.event === "run")).toMatchObject({ budgetMs: 35_000, budgetExhausted: true });
  });

  it("skips the people who waited inside a source, per person, and the source is due again on the next fire", async () => {
    const clock = { now: NOW.getTime() };
    const other = makePerson({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", slug: "drake", display_name: "Drake" });
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-a", name: "a", is_active: true, poll_interval_minutes: 10 })],
      mappings: { "src-a": [{ person, externalIdentifier: "one" }, { person: other, externalIdentifier: "two" }] },
    });
    const registry = buildRegistry([slowConnector("a", 30_000, clock)]);
    const summary = await runIngestion({ store, now: NOW, registry, force: true, log: quiet, budgetMs: 25_000, clock: () => clock.now });
    expect(summary.budget.exhausted).toBe(true);
    expect(store.polls.map((p) => [p.personId, p.status])).toEqual([
      [person.id, "ok"],
      [other.id, "skipped"],
    ]);
    expect(store.polls[1].reason).toMatch(/run budget of 25000 ms exhausted after 30000 ms/);
    // The source's last successful poll is the first person's, so fifteen minutes on it is due and the queue resumes.
    const later = new Date(NOW.getTime() + 15 * 60_000);
    const next = await runIngestion({ store, now: later, registry: buildRegistry([slowConnector("a", 1_000, clock)]), log: quiet, budgetMs: 25_000, clock: () => clock.now });
    expect(next.sourcesSkipped).toEqual([]);
    expect(next.budget.exhausted).toBe(false);
  });

  it("polls the source that has waited longest first, so the hourly ones are not queued behind the quarter-hourly ones", async () => {
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-fast", name: "fast", is_active: true, poll_interval_minutes: 10 }), makeSource({ id: "src-slow", name: "slow", is_active: true, poll_interval_minutes: 55 })],
      mappings: { "src-fast": [{ person, externalIdentifier: "f" }], "src-slow": [{ person, externalIdentifier: "s" }] },
      polls: [
        { runId: "old", dataSourceId: "src-fast", personId: person.id, status: "ok", reason: null, latencyMs: 1, signalsCreated: 0, snapshotsRecorded: 0, observations: 0, blockedDropped: 0, duplicatesCollapsed: 0, excludedFiltered: 0, startedAt: hour(-0.25), finishedAt: hour(-0.25) },
        { runId: "old", dataSourceId: "src-slow", personId: person.id, status: "ok", reason: null, latencyMs: 1, signalsCreated: 0, snapshotsRecorded: 0, observations: 0, blockedDropped: 0, duplicatesCollapsed: 0, excludedFiltered: 0, startedAt: hour(-1), finishedAt: hour(-1) },
      ],
    });
    const clock = { now: NOW.getTime() };
    const summary = await runIngestion({ store, now: NOW, registry: buildRegistry([slowConnector("fast", 1_000, clock), slowConnector("slow", 1_000, clock)]), log: quiet, clock: () => clock.now });
    expect(summary.sourcesRun.map((s) => s.name)).toEqual(["slow", "fast"]);
    expect(store.polls.slice(2).map((p) => p.dataSourceId)).toEqual(["src-slow", "src-fast"]);
  });
});
