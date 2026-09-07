import { beforeEach, describe, expect, it } from "vitest";

import { fakeFetch, makePerson, makeSource, youtubeChannelsResponse } from "@/lib/__tests__/fixtures";
import { buildRegistry } from "@/lib/connectors/registry";
import type { DataConnector } from "@/lib/connectors/types";
import { youtubeConnector } from "@/lib/connectors/youtube";

import { runIngestion } from "./runner";
import { createMemoryIngestStore } from "./store";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const person = makePerson();
const youtube = makeSource({ id: "src-youtube", name: "youtube", is_active: true });

describe("runIngestion", () => {
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "test-key";
  });

  it("returns a clean empty summary when no sources are active", async () => {
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-youtube", is_active: false }), makeSource({ id: "src-rss", name: "rss", is_active: false })],
    });

    const summary = await runIngestion({ store, now: NOW, fetch: fakeFetch({}) });

    expect(summary.sourcesRun).toEqual([]);
    expect(summary.sourcesSkipped).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.totals).toEqual({ sources: 0, people: 0, signalsCreated: 0, snapshotsRecorded: 0, errors: 0 });
    expect(store.signals).toHaveLength(0);
  });

  it("skips active sources with no connector or no mappings", async () => {
    const store = createMemoryIngestStore({
      sources: [youtube, makeSource({ id: "src-unknown", name: "myspace", is_active: true })],
    });

    const summary = await runIngestion({ store, now: NOW, fetch: fakeFetch({}) });

    expect(summary.sourcesRun).toEqual([]);
    expect(summary.sourcesSkipped).toEqual([
      { name: "myspace", reason: "no connector registered for this source" },
      { name: "youtube", reason: "no active person_data_sources mappings" },
    ]);
  });

  it("runs the YouTube connector, stores signals and snapshots, and is idempotent", async () => {
    const store = createMemoryIngestStore({
      sources: [youtube],
      mappings: { "src-youtube": [{ person, externalIdentifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" }] },
    });
    const fetch = fakeFetch(youtubeChannelsResponse({}));

    const first = await runIngestion({ store, now: NOW, fetch });

    expect(first.sourcesRun).toEqual([{ name: "youtube", people: 1, signalsCreated: 1, snapshotsRecorded: 3, errors: 0 }]);
    expect(first.totals).toEqual({ sources: 1, people: 1, signalsCreated: 1, snapshotsRecorded: 3, errors: 0 });
    expect(store.signals[0]).toMatchObject({
      personId: person.id,
      dataSourceId: "src-youtube",
      headline: "MrBeast stands at 516M subscribers, 90B total views and 900 videos on YouTube",
      dedupeKey: "youtube:UCX6OQ3DkcsbYNE6H8uQQuVA:baseline",
      occurredAt: NOW,
    });
    expect(store.snapshots.map((s) => [s.metricKey, s.value])).toEqual([
      ["subscriber_count", 516_000_000],
      ["view_count", 90_000_000_000],
      ["video_count", 900],
    ]);

    // Same data one hour later: nothing changed, so no new signal, but a fresh snapshot row per metric.
    const LATER = new Date("2026-09-07T13:00:00.000Z");
    const second = await runIngestion({ store, now: LATER, fetch });
    expect(second.totals.signalsCreated).toBe(0);
    expect(second.totals.snapshotsRecorded).toBe(3);
    expect(store.signals).toHaveLength(1);
  });

  it("honours the sources filter", async () => {
    const store = createMemoryIngestStore({
      sources: [youtube, makeSource({ id: "src-rss", name: "rss", is_active: true })],
      mappings: { "src-youtube": [{ person, externalIdentifier: "UC1" }] },
    });

    const summary = await runIngestion({ store, now: NOW, fetch: fakeFetch(youtubeChannelsResponse({})), sources: ["rss"] });

    expect(summary.sourcesRun).toEqual([]);
    expect(summary.sourcesSkipped).toEqual([{ name: "rss", reason: "no active person_data_sources mappings" }]);
  });

  it("records connector failures per person and keeps going", async () => {
    const failing: DataConnector = {
      name: "youtube",
      async fetchForPerson(p) {
        if (p.slug === "drake") throw new Error("boom");
        return youtubeConnector.fetchForPerson(p, "UC1", {
          source: youtube,
          config: {},
          snapshots: { latest: async () => null, record: () => undefined },
          now: NOW,
          fetch: fakeFetch(youtubeChannelsResponse({})),
        });
      },
    };
    const drake = makePerson({ id: "33333333-3333-4333-8333-333333333333", slug: "drake", display_name: "Drake" });
    const store = createMemoryIngestStore({
      sources: [youtube],
      mappings: {
        "src-youtube": [
          { person: drake, externalIdentifier: "UC0" },
          { person, externalIdentifier: "UC1" },
        ],
      },
    });

    const summary = await runIngestion({ store, now: NOW, fetch: fakeFetch({}), registry: buildRegistry([failing]) });

    expect(summary.errors).toEqual([{ source: "youtube", person: "drake", message: "boom" }]);
    expect(summary.sourcesRun).toEqual([{ name: "youtube", people: 2, signalsCreated: 1, snapshotsRecorded: 0, errors: 1 }]);
    expect(summary.totals.errors).toBe(1);
  });
});
