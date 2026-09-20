import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeFetchRoutes, makePerson, makeSource } from "@/lib/__tests__/fixtures";
import { buildRegistry } from "@/lib/connectors/registry";
import { resetTrendingChartCache, youtubeTrendingConnector } from "@/lib/connectors/youtube-trending";

import { runIngestion, type IngestLogLine } from "./runner";
import { createMemoryIngestStore } from "./store";

/**
 * PHASE 22, at the runner: a video trending for hours is ONE signal per
 * subject, not one per poll; a collaboration is credited to both people; a
 * person the chart never carries is unaffected; and sixteen mappings are one
 * upstream request.
 */

const NOW = new Date("2026-09-20T19:30:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const MRBEAST_CHANNEL = "UCX6OQ3DkcsbYNE6H8uQQuVA";
const uc = (seed: string) => `UC${seed.padEnd(22, "0").slice(0, 22)}`;

const mrbeast = makePerson();
const kai = makePerson({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", slug: "kai-cenat", display_name: "Kai Cenat", full_name: "Kai Cenat" });
const drake = makePerson({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", slug: "drake", display_name: "Drake", full_name: "Aubrey Drake Graham", category: "musician" });
const buffett = makePerson({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", slug: "warren-buffett", display_name: "Warren Buffett", full_name: "Warren Buffett", category: "executive" });

const source = makeSource({ id: "src-trending", name: "youtube_trending", display_name: "YouTube Trending", tier: 2, poll_interval_minutes: 25, config: { region: "US", max_results: 50 } });

function item(id: string, title: string, channelId: string, channelTitle: string) {
  return { id, snippet: { publishedAt: "2026-09-20T12:00:00Z", channelId, title, description: "", channelTitle, categoryId: "24" }, statistics: { viewCount: "1000000" } };
}

const CHART = [
  item("v-beast", "I Survived 7 Days In Solitary Confinement", MRBEAST_CHANNEL, "MrBeast"),
  item("v-collab", "MrBeast and Kai Cenat Swap Lives For 24 Hours", uc("kai"), "Kai Cenat Live"),
  item("v-drake-uni", "Drake vs Iowa State | Full Game Highlights", uc("sports"), "Drake University Athletics"),
  item("v-drake-mv", "Drake - NOKIA (Official Music Video)", uc("vevo"), "DrakeVEVO"),
];

function chartFetch(items: ReturnType<typeof item>[]) {
  return fakeFetchRoutes([{ match: "/youtube/v3/videos?", body: { items } }]);
}

function seed() {
  return createMemoryIngestStore({
    sources: [source],
    mappings: {
      "src-trending": [
        { person: mrbeast, externalIdentifier: "MrBeast", config: { channel_id: MRBEAST_CHANNEL, match_terms: [], disambiguation: { exclude_terms: [], require_any: [] } } },
        { person: kai, externalIdentifier: "Kai Cenat", config: { match_terms: [], disambiguation: { exclude_terms: [], require_any: [] } } },
        { person: drake, externalIdentifier: "Drake", config: { match_terms: [], disambiguation: { exclude_terms: ["drake university", "drake maye"], require_any: [] } } },
        { person: buffett, externalIdentifier: "Warren Buffett", config: { match_terms: [], disambiguation: { exclude_terms: ["jimmy buffett"], require_any: [] } } },
      ],
    },
  });
}

const registry = buildRegistry([youtubeTrendingConnector]);
const previousKey = process.env.YOUTUBE_API_KEY;

beforeEach(() => {
  process.env.YOUTUBE_API_KEY = "test-key";
  resetTrendingChartCache();
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = previousKey;
});

describe("one appearance is one signal", () => {
  it("polls four people against one request, credits the collaboration to both, refuses the wrong Drake, and leaves the quiet person untouched", async () => {
    const store = seed();
    const fetch = chartFetch(CHART);
    const lines: IngestLogLine[] = [];
    const summary = await runIngestion({ store, now: NOW, registry, fetch, force: true, log: (line) => lines.push(line) });

    expect(fetch.calls).toHaveLength(1);
    const run = summary.sourcesRun.find((s) => s.name === "youtube_trending")!;
    expect(run).toMatchObject({ people: 4, signalsCreated: 4, eventSignals: 4, metricSignals: 0, observations: 0, snapshotsRecorded: 0, errors: 0, excludedFiltered: 1 });

    const stored = store.signals.map((s) => [s.personId, s.dedupeKey]).sort();
    expect(stored).toEqual(
      [
        [mrbeast.id, "youtube_trending:video:v-beast:mrbeast"],
        [mrbeast.id, "youtube_trending:video:v-collab:mrbeast"],
        [kai.id, "youtube_trending:video:v-collab:kai-cenat"],
        [drake.id, "youtube_trending:video:v-drake-mv:drake"],
      ].sort(),
    );
    // Nothing for Warren Buffett: no signal row, so nothing for any force to read, and his poll is a plain ok.
    expect(store.signals.filter((s) => s.personId === buffett.id)).toEqual([]);
    expect(lines.find((l) => l.event === "poll" && l.person === "warren-buffett")).toMatchObject({ status: "ok", signals: 0, observations: 0 });
    // The refusal is on the record, with the term that decided it.
    expect(lines.find((l) => l.event === "exclude")).toMatchObject({ source: "youtube_trending", person: "drake", reason: "excluded_term", term: "drake university", headline: "Drake vs Iowa State | Full Game Highlights" });
    // No raw level and no observation: nothing here is a metric.
    expect(store.snapshots).toEqual([]);
    expect(store.signals.every((s) => s.rawPayload.kind === "trending")).toBe(true);
  });

  it("stores nothing new while the same videos stay on the chart, poll after poll", async () => {
    const store = seed();
    await runIngestion({ store, now: NOW, registry, fetch: chartFetch(CHART), force: true, log: () => undefined });
    expect(store.signals).toHaveLength(4);

    // Six more polls over three hours see the same chart. The connector
    // re-reads it each time (a new run, a new clock) and the store refuses
    // every key it already holds.
    for (const minutes of [30, 60, 90, 120, 150, 180]) {
      resetTrendingChartCache();
      const summary = await runIngestion({ store, now: later(minutes), registry, fetch: chartFetch(CHART), force: true, log: () => undefined });
      expect(summary.sourcesRun[0].signalsCreated, `${minutes} min`).toBe(0);
      expect(summary.sourcesRun[0].errors, `${minutes} min`).toBe(0);
    }
    expect(store.signals).toHaveLength(4);
  });

  it("stores exactly the new video when the chart changes, and the rank is the rank at first sighting", async () => {
    const store = seed();
    await runIngestion({ store, now: NOW, registry, fetch: chartFetch(CHART), force: true, log: () => undefined });

    // Half an hour on: MrBeast's video has climbed to #1 (no event — same
    // fact), and a second MrBeast upload has entered at #7.
    resetTrendingChartCache();
    const changed = [CHART[0], CHART[1], CHART[2], CHART[3], item("v-x", "Filler", uc("f"), "F"), item("v-y", "Filler 2", uc("g"), "G"), item("v-beast-2", "$1 vs $1,000,000 Hotel Room!", MRBEAST_CHANNEL, "MrBeast")];
    const summary = await runIngestion({ store, now: later(30), registry, fetch: chartFetch(changed), force: true, log: () => undefined });
    expect(summary.sourcesRun[0].signalsCreated).toBe(1);
    const added = store.signals.find((s) => s.dedupeKey === "youtube_trending:video:v-beast-2:mrbeast")!;
    expect(added.headline).toBe('MrBeast is trending at #7 on YouTube: "$1 vs $1,000,000 Hotel Room!".');
    expect(added.rawPayload.rank).toBe(7);
    // The first video's stored rank is still the rank it was first seen at.
    expect(store.signals.find((s) => s.dedupeKey === "youtube_trending:video:v-beast:mrbeast")!.rawPayload.rank).toBe(1);
  });

  it("marks the source inactive for the run, not failed, when the key is absent", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const store = seed();
    const fetch = chartFetch(CHART);
    const summary = await runIngestion({ store, now: NOW, registry, fetch, force: true, log: () => undefined });
    expect(fetch.calls).toHaveLength(0);
    expect(summary.sourcesSkipped).toEqual([{ name: "youtube_trending", reason: "inactive: YOUTUBE_API_KEY is not set" }]);
    expect(summary.totals.errors).toBe(0);
  });
});
