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

/**
 * THE PUBLISHER CATALOGUE AND THE BUDGET (after Phase 29e). Overruns deferred
 * the same twelve people every time: people were polled alphabetically, four
 * at a time; all four waited on the one shared catalogue read; when it
 * returned the budget was gone, so the rest were skipped, AFTER the expensive
 * part had been paid for. And the run saved the feeds' new caching markers
 * though twelve people never read what they marked, so an unchanged feed
 * answered 304 at the next fire and handed them nothing until it next changed.
 */
describe("a shared read, the budget, and who waits", () => {
  const people = ["Adin Ross", "Drake", "Elon Musk", "Jeff Bezos", "Mark Zuckerberg", "Warren Buffett"].map((name, index) => ({
    person: makePerson({ id: `00000000-0000-4000-8000-00000000000${index}`, slug: name.toLowerCase().replace(/ /g, "-"), display_name: name }),
    externalIdentifier: name,
  }));
  const source = makeSource({ id: "src-pub", name: "publisher_rss", tier: 3, is_active: true, poll_interval_minutes: 10 });
  const okPoll = (personId: string, finishedAt: Date) => ({
    runId: "earlier",
    dataSourceId: "src-pub",
    personId,
    status: "ok" as const,
    reason: null,
    latencyMs: 1,
    signalsCreated: 0,
    snapshotsRecorded: 0,
    observations: 0,
    blockedDropped: 0,
    duplicatesCollapsed: 0,
    excludedFiltered: 0,
    startedAt: finishedAt,
    finishedAt,
  });

  /**
   * A publisher-like connector on an injected clock: the first person's poll
   * starts the shared read, which costs `sharedMs`; every person then costs
   * `perPersonMs` of matching and writes. It records what the runner told it
   * about the remaining budget, and reports one feed with a new caching marker.
   */
  function sharedConnector(clock: { now: number }, options: { sharedMs: number; perPersonMs: number; shared?: boolean; failFor?: string }) {
    let read: Promise<void> | null = null;
    const remaining: Array<number | null> = [];
    const connector: DataConnector = {
      name: "publisher_rss",
      storyFamily: "news",
      sharedFetch: options.shared ?? true,
      async fetchForPerson(person, identifier, context) {
        remaining.push(context.remainingBudgetMs?.() ?? null);
        read ??= (async () => {
          await context.feeds?.list();
          clock.now += options.sharedMs;
          context.feeds?.report({ id: "f1", fetchedAt: context.now, status: "ok", httpStatus: 200, error: null, itemCount: 5, datedCount: 5, describedCount: 5, newestPublishedAt: NOW, discoveredUrl: null, etag: '"new"', lastModified: "Thu, 25 Sep 2026 17:00:00 GMT" });
        })();
        await read;
        clock.now += options.perPersonMs;
        if (identifier === options.failFor) throw new Error("database hiccup");
        return [];
      },
    };
    return { connector, remaining };
  }
  const feed: FeedCatalogEntry = { id: "f1", domain: "espn.com", url: "https://www.espn.com/espn/rss/news", section: "All", topics: [], mode: "feed", etag: '"old"', lastModified: "Wed, 24 Sep 2026 17:00:00 GMT", lastFetchedAt: hour(-0.25), lastStatus: "ok", consecutiveFailures: 0 };

  it("polls the person who has waited longest first, not the alphabet", async () => {
    const store = createMemoryIngestStore({
      sources: [source],
      mappings: { "src-pub": people },
      polls: [
        okPoll(people[0].person.id, hour(-0.25)), // Adin Ross: served a quarter of an hour ago
        okPoll(people[1].person.id, hour(-0.5)), // Drake: half an hour ago
        okPoll(people[2].person.id, hour(-0.25)), // Elon Musk: a quarter of an hour ago
        okPoll(people[3].person.id, hour(-1)), // Jeff Bezos: an hour ago
        okPoll(people[5].person.id, hour(-8)), // Warren Buffett: outside the window, so as good as never
        // Mark Zuckerberg: never
      ],
    });
    const clock = { now: NOW.getTime() };
    const { connector } = sharedConnector(clock, { sharedMs: 0, perPersonMs: 0 });
    await runIngestion({ store, now: NOW, registry: buildRegistry([connector]), force: true, log: quiet, clock: () => clock.now, pollConcurrency: 1 });
    const order = store.polls.filter((poll) => poll.runId !== "earlier").map((poll) => people.find((p) => p.person.id === poll.personId)?.externalIdentifier);
    expect(order).toEqual(["Mark Zuckerberg", "Warren Buffett", "Jeff Bezos", "Drake", "Adin Ross", "Elon Musk"]);
  });

  it("finishes every person once the shared read is paid for, where a per-person source still skips", async () => {
    // The read returns at 38 s, past the 35 s budget; each person is then a second.
    for (const shared of [true, false]) {
      const clock = { now: NOW.getTime() };
      const store = createMemoryIngestStore({ sources: [source], mappings: { "src-pub": people }, feeds: [feed] });
      const { connector } = sharedConnector(clock, { sharedMs: 38_000, perPersonMs: 1_000, shared });
      const summary = await runIngestion({ store, now: NOW, registry: buildRegistry([connector]), force: true, log: quiet, clock: () => clock.now, budgetMs: 35_000, pollConcurrency: 1 });
      expect(summary.budget.exhausted).toBe(true);
      expect(store.polls.map((poll) => poll.status)).toEqual(shared ? ["ok", "ok", "ok", "ok", "ok", "ok"] : ["ok", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    }
  });

  it("stops even a shared-read source at the grace, so a slow database cannot reach the platform's kill", async () => {
    const clock = { now: NOW.getTime() };
    const store = createMemoryIngestStore({ sources: [source], mappings: { "src-pub": people }, feeds: [feed] });
    // The read ends at 28 s; each person then takes 5 s, starting at 0, 33, 38 and 43 s — the last inside 35 + 10 — and the fifth would start at 48 s.
    const { connector } = sharedConnector(clock, { sharedMs: 28_000, perPersonMs: 5_000 });
    const summary = await runIngestion({ store, now: NOW, registry: buildRegistry([connector]), force: true, log: quiet, clock: () => clock.now, budgetMs: 35_000, sharedFetchGraceMs: 10_000, pollConcurrency: 1 });
    expect(store.polls.map((poll) => poll.status)).toEqual(["ok", "ok", "ok", "ok", "skipped", "skipped"]);
    expect(summary.durationMs).toBe(48_000);
    // Someone missed the feed, so its old markers stay: the next fire downloads it whole.
    expect(store.feeds.find((row) => row.id === "f1")).toMatchObject({ etag: '"old"', lastModified: "Wed, 24 Sep 2026 17:00:00 GMT", lastFetchedAt: NOW, lastStatus: "ok" });
  });

  it("tells the connector what is left of the budget, and nothing when there is none", async () => {
    const clock = { now: NOW.getTime() };
    const bounded = sharedConnector(clock, { sharedMs: 20_000, perPersonMs: 1_000 });
    await runIngestion({ store: createMemoryIngestStore({ sources: [source], mappings: { "src-pub": people.slice(0, 2) }, feeds: [feed] }), now: NOW, registry: buildRegistry([bounded.connector]), force: true, log: quiet, clock: () => clock.now, budgetMs: 35_000, pollConcurrency: 1 });
    // The first person asked at 0 s (35 s left); the second after the read and one person, at 21 s (14 s left).
    expect(bounded.remaining).toEqual([35_000, 14_000]);
    const unbounded = sharedConnector(clock, { sharedMs: 0, perPersonMs: 0 });
    await runIngestion({ store: createMemoryIngestStore({ sources: [source], mappings: { "src-pub": people.slice(0, 1) }, feeds: [feed] }), now: NOW, registry: buildRegistry([unbounded.connector]), force: true, log: quiet, clock: () => clock.now, pollConcurrency: 1 });
    expect(unbounded.remaining).toEqual([null]);
  });

  it("saves the new caching markers when everyone was served, and keeps the old ones when anyone was skipped or failed", async () => {
    const served = createMemoryIngestStore({ sources: [source], mappings: { "src-pub": people }, feeds: [{ ...feed }] });
    const clock = { now: NOW.getTime() };
    await runIngestion({ store: served, now: NOW, registry: buildRegistry([sharedConnector(clock, { sharedMs: 1_000, perPersonMs: 100 }).connector]), force: true, log: quiet, clock: () => clock.now, budgetMs: 35_000 });
    expect(served.feeds[0]).toMatchObject({ etag: '"new"', lastModified: "Thu, 25 Sep 2026 17:00:00 GMT" });

    const lines: IngestLogLine[] = [];
    const failed = createMemoryIngestStore({ sources: [source], mappings: { "src-pub": people }, feeds: [{ ...feed }] });
    await runIngestion({ store: failed, now: NOW, registry: buildRegistry([sharedConnector(clock, { sharedMs: 1_000, perPersonMs: 100, failFor: "Drake" }).connector]), force: true, log: (line) => lines.push(line), clock: () => clock.now, budgetMs: 35_000 });
    expect(failed.polls.filter((poll) => poll.status === "error")).toHaveLength(1);
    expect(failed.feeds[0]).toMatchObject({ etag: '"old"', lastModified: "Wed, 24 Sep 2026 17:00:00 GMT" });
    expect(lines.find((line) => line.event === "feed_markers_kept")).toMatchObject({ source: "publisher_rss", missedPeople: 1, feeds: 1 });
  });

  /**
   * A virtual clock with sleepers, so four people polled at once cost the
   * time of one: every lane registers its sleep before the clock moves to the
   * earliest wake-up (the in-memory store resolves in microtasks, which all
   * run before the next macrotask).
   */
  function virtualClock(start: number) {
    const state = { now: start };
    const sleepers: Array<{ at: number; resolve: () => void }> = [];
    let pumping = false;
    const pump = () => {
      if (pumping) return;
      pumping = true;
      setTimeout(() => {
        pumping = false;
        sleepers.sort((a, b) => a.at - b.at);
        const next = sleepers.shift();
        if (!next) return;
        state.now = Math.max(state.now, next.at);
        next.resolve();
        if (sleepers.length > 0) pump();
      }, 0);
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ at: state.now + ms, resolve });
        pump();
      });
    return { state, sleep };
  }

  it("THE WORST CASE, against the 60-second kill: the catalogue starts at the budget's last moment, every feed hangs to its timeout, sixteen people four at a time", async () => {
    // Production's numbers: a 35 s budget, the 10 s grace, the catalogue's 6 s
    // feed timeout, four people at once. An earlier source takes the run to
    // 34.9 s; the catalogue then starts with 0.1 s of budget left, which is
    // all it gets to START feeds, so the last feed it starts ends at 40.9 s.
    // Each person is then 1 s of matching and writes (production's average
    // poll is under a second; its p90 of 3 s includes waiting on the read),
    // and a second run takes 3 s a person for a slow database.
    for (const [perPersonMs, expected] of [
      [1_000, { skipped: 0, endedByMs: 45_000 }],
      [3_000, { skipped: 8, endedByMs: 47_000 }],
    ] as const) {
      const clock = virtualClock(NOW.getTime());
      const sixteen = Array.from({ length: 16 }, (_, index) => ({
        person: makePerson({ id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`, slug: `p${index}`, display_name: `Person ${index}` }),
        externalIdentifier: `Person ${String(index).padStart(2, "0")}`,
      }));
      const earlier: DataConnector = {
        name: "a_hourly",
        async fetchForPerson() {
          await clock.sleep(34_900);
          return [];
        },
      };
      let read: Promise<void> | null = null;
      const startedAt: number[] = [];
      const publisher: DataConnector = {
        name: "publisher_rss",
        sharedFetch: true,
        async fetchForPerson(_person, _identifier, context) {
          startedAt.push(clock.state.now - NOW.getTime());
          read ??= (async () => {
            const left = context.remainingBudgetMs?.();
            // What the real catalogue does with it: start feeds only inside what is left; each started feed may then hang to its 6 s timeout.
            expect(left).toBe(100);
            await clock.sleep(6_000);
          })();
          await read;
          await clock.sleep(perPersonMs);
          return [];
        },
      };
      const store = createMemoryIngestStore({
        sources: [makeSource({ id: "src-a", name: "a_hourly", is_active: true }), source],
        mappings: { "src-a": [{ person: people[0].person, externalIdentifier: "one" }], "src-pub": sixteen },
        feeds: [feed],
      });
      const summary = await runIngestion({ store, now: NOW, registry: buildRegistry([earlier, publisher]), force: true, log: quiet, clock: () => clock.state.now, budgetMs: 35_000, pollConcurrency: 4 });
      const skipped = store.polls.filter((poll) => poll.dataSourceId === "src-pub" && poll.status === "skipped").length;
      expect(skipped).toBe(expected.skipped);
      // Nobody started after budget + grace.
      expect(Math.max(...startedAt)).toBeLessThan(45_000);
      expect(summary.durationMs).toBeLessThanOrEqual(expected.endedByMs);
      expect(summary.durationMs).toBeLessThan(60_000);
    }
  });
});
