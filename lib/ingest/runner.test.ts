import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeFetch, fakeFetchRoutes, makePerson, makeSource, youtubeChannelsResponse, youtubePlaylistItemsResponse, youtubeVideosResponse } from "@/lib/__tests__/fixtures";
import { buildRegistry } from "@/lib/connectors/registry";
import type { DataConnector } from "@/lib/connectors/types";
import { youtubeConnector } from "@/lib/connectors/youtube";
import type { Json } from "@/types/database";

import { METRIC_PAYLOAD_KEYS } from "./metrics";
import { runIngestion, type IngestLogLine } from "./runner";
import { createMemoryIngestStore, type MemoryIngestStore } from "./store";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const hour = (n: number, from = NOW) => new Date(from.getTime() + n * 3_600_000);
const person = makePerson();
const quiet = () => undefined;

/** A metric connector that reads whatever level the test says, for one metric. */
function levelConnector(name: string, level: () => Record<string, number>, events: () => Array<{ headline: string; dedupeKey: string }> = () => []): DataConnector {
  return {
    name,
    async fetchForPerson() {
      return events().map((e) => ({ headline: e.headline, dedupeKey: e.dedupeKey, occurredAt: NOW, rawPayload: { kind: "article" } }));
    },
    async fetchMetrics() {
      return Object.entries(level()).map(([metricKey, value]) => ({ metricKey, value }));
    },
  };
}

const FOLLOWERS_CONFIG: Json = {
  metrics: {
    followers: { label: "follower growth", polarity: 1, delta: "relative_rate", baseline_window_hours: 48, min_samples: 6, sd_floor: 0.00001, scale: 1 },
  },
};

describe("runIngestion", () => {
  it("returns a clean summary and records the run when no sources are active", async () => {
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-youtube", is_active: false }), makeSource({ id: "src-rss", name: "rss", is_active: false })],
    });

    const summary = await runIngestion({ store, now: NOW, fetch: fakeFetch({}), log: quiet });

    expect(summary.sourcesRun).toEqual([]);
    expect(summary.sourcesSkipped).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.totals).toEqual({ sources: 0, people: 0, signalsCreated: 0, snapshotsRecorded: 0, observations: 0, errors: 0 });
    expect(summary).toMatchObject({ runId: store.runs[0].id, trigger: "manual", forced: false });
    expect(store.runs[0].result).toMatchObject({ sourcesRun: 0, errors: 0 });
    expect(store.signals).toHaveLength(0);
  });

  it("skips and records sources with no connector, no mappings, or missing credentials", async () => {
    const unavailable: DataConnector = { name: "spotify", available: () => ({ ok: false, reason: "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set" }), fetchForPerson: async () => [] };
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-youtube", is_active: true }), makeSource({ id: "src-unknown", name: "myspace", is_active: true }), makeSource({ id: "src-spotify", name: "spotify", is_active: true })],
      mappings: { "src-spotify": [{ person, externalIdentifier: "artist" }] },
    });

    const summary = await runIngestion({ store, now: NOW, fetch: fakeFetch({}), registry: buildRegistry([youtubeConnector, unavailable]), log: quiet });

    expect(summary.sourcesRun).toEqual([]);
    expect(summary.sourcesSkipped).toEqual([
      { name: "myspace", reason: "no connector registered for this source" },
      { name: "spotify", reason: "inactive: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set" },
      { name: "youtube", reason: "inactive: YOUTUBE_API_KEY is not set" },
    ]);
    expect(store.polls.map((p) => [p.dataSourceId, p.status, p.personId])).toEqual([
      ["src-unknown", "skipped", null],
      ["src-spotify", "skipped", null],
      ["src-youtube", "skipped", null],
    ]);
  });

  it("respects the poll interval unless forced", async () => {
    const source = makeSource({ id: "src-x", name: "x", poll_interval_minutes: 60, is_active: true });
    const store = createMemoryIngestStore({
      sources: [source],
      mappings: { "src-x": [{ person, externalIdentifier: "id" }] },
      polls: [{ runId: "r0", dataSourceId: "src-x", personId: person.id, status: "ok", reason: null, latencyMs: 5, signalsCreated: 0, snapshotsRecorded: 0, observations: 0, startedAt: hour(-0.5), finishedAt: hour(-0.5) }],
    });
    const registry = buildRegistry([levelConnector("x", () => ({ followers: 100 }))]);

    const skipped = await runIngestion({ store, now: NOW, registry, log: quiet });
    expect(skipped.sourcesSkipped[0].reason).toMatch(/polled 30 min ago; interval 60 min/);
    expect(skipped.sourcesRun).toEqual([]);

    const forced = await runIngestion({ store, now: NOW, registry, force: true, log: quiet });
    expect(forced.forced).toBe(true);
    expect(forced.sourcesRun).toHaveLength(1);

    const later = await runIngestion({ store, now: hour(2), registry, log: quiet });
    expect(later.sourcesRun).toHaveLength(1);
  });

  describe("the metric pipeline", () => {
    let store: MemoryIngestStore;
    let level = 1_000_000;
    let lines: IngestLogLine[];
    const source = makeSource({ id: "src-x", name: "x", is_active: true, config: FOLLOWERS_CONFIG });
    const registry = buildRegistry([levelConnector("x", () => ({ followers: level }))]);
    const run = (at: Date) => runIngestion({ store, now: at, registry, force: true, log: (line) => lines.push(line) });

    beforeEach(() => {
      store = createMemoryIngestStore({ sources: [source], mappings: { "src-x": [{ person, externalIdentifier: "id" }] } });
      level = 1_000_000;
      lines = [];
    });

    it("first run: a snapshot and a first-contact observation, no signal", async () => {
      const summary = await run(NOW);
      expect(summary.sourcesRun).toEqual([{ name: "x", people: 1, signalsCreated: 0, eventSignals: 0, metricSignals: 0, snapshotsRecorded: 1, observations: 1, errors: 0 }]);
      expect(store.snapshots).toEqual([{ personId: person.id, dataSourceId: "src-x", metricKey: "followers", value: 1_000_000, recordedAt: NOW }]);
      expect(store.observations[0]).toMatchObject({ metricKey: "followers", outcome: "first_contact", value: 1_000_000, previous: null, signalId: null });
      expect(store.signals).toEqual([]);
      expect(lines.map((l) => l.event)).toEqual(["observation", "poll", "run"]);
      expect(lines[1]).toMatchObject({ event: "poll", source: "x", person: "mrbeast", status: "ok", signals: 0, snapshots: 1, observations: 1 });
      expect(typeof lines[1].latencyMs).toBe("number");
    });

    it("below the minimum sample every run is silent, however the level moves", async () => {
      await run(NOW);
      level = 1_500_000;
      const second = await run(hour(1));
      expect(second.totals.signalsCreated).toBe(0);
      expect(store.observations[1]).toMatchObject({ outcome: "insufficient_baseline", previous: 1_000_000, delta: 500_000, deltaKind: "relative_rate", samples: 1, minSamples: 6, signalId: null });
      expect(store.observations[1].sigma).toBe(0);
      for (let i = 2; i < 6; i += 1) {
        level += 1_000;
        await run(hour(i));
      }
      expect(store.observations.every((o) => o.outcome === "first_contact" || o.outcome === "insufficient_baseline")).toBe(true);
      expect(store.signals).toEqual([]);
    });

    it("once the baseline is sufficient a normal reading is inside the band and a burst emits a normalised signal", async () => {
      for (let i = 0; i < 10; i += 1) {
        level += i === 0 ? 0 : 1_000;
        await run(hour(i));
      }
      const last = store.observations[store.observations.length - 1];
      expect(last).toMatchObject({ outcome: "inside_band", samples: 9, minSamples: 6 });
      expect(store.signals).toEqual([]);

      level += 40_000;
      lines = [];
      const burst = await run(hour(10));
      expect(burst.sourcesRun[0]).toMatchObject({ signalsCreated: 1, metricSignals: 1, eventSignals: 0, observations: 1 });
      expect(store.signals).toHaveLength(1);
      const signal = store.signals[0];
      expect(signal.headline).toMatch(/^MrBeast's follower growth is running \+\d+\.\dσ above their own trailing 2 days$/);
      expect(Object.keys(signal.rawPayload).sort()).toEqual([...METRIC_PAYLOAD_KEYS].sort());
      expect(signal.rawPayload).toMatchObject({ kind: "metric", metric: "followers", direction: 1, polarity: 1, samples: 10, min_samples: 6, window_hours: 48, delta_kind: "relative_rate", scale: 1, source: "x" });
      expect(JSON.stringify(signal)).not.toContain("1049000");
      expect(JSON.stringify(signal)).not.toContain("40000");
      // The observation records the level and links the signal; the signal carries neither the level nor the delta.
      const observation = store.observations[store.observations.length - 1];
      expect(observation).toMatchObject({ outcome: "emitted", value: 1_049_000, previous: 1_009_000, delta: 40_000, signalId: signal.id });
      expect(Number(observation.sigma)).toBeCloseTo(Number(signal.rawPayload.sigma), 2);
      expect(lines.filter((l) => l.event === "signal")).toHaveLength(1);
      expect(lines.find((l) => l.event === "signal")).toMatchObject({ source: "x", person: "mrbeast", metric: "followers", direction: 1, signalId: signal.id, stored: true });

      // A re-run at the same instant stores nothing twice.
      const again = await run(hour(10));
      expect(again.totals.signalsCreated).toBe(0);
      expect(store.signals).toHaveLength(1);
    });

    it("a metric without a declaration is snapshot-only, and a malformed declaration is reported", async () => {
      const looseSource = makeSource({
        id: "src-x",
        name: "x",
        is_active: true,
        config: { metrics: { followers: { polarity: "up", delta: "level", baseline_window_hours: 24, min_samples: 4, sd_floor: 0, scale: 1 } } },
      });
      store = createMemoryIngestStore({ sources: [looseSource], mappings: { "src-x": [{ person, externalIdentifier: "id" }] } });
      for (let i = 0; i < 8; i += 1) {
        level += 500_000;
        const summary = await run(hour(i));
        expect(summary.configProblems).toEqual([{ source: "x", problem: "metrics.followers: polarity must be exactly 1 or -1 (declared, never inferred)" }]);
      }
      expect(store.snapshots).toHaveLength(8);
      expect(store.observations.map((o) => o.outcome)).toEqual(Array(8).fill("no_config"));
      expect(store.observations[7]).toMatchObject({ previous: 4_500_000, delta: 500_000, sigma: null, signalId: null });
      expect(store.signals).toEqual([]);
    });
  });

  it("computes derived metrics from another metric's history and normalises them like any other", async () => {
    let videos = 900;
    const source = makeSource({
      id: "src-x",
      name: "x",
      is_active: true,
      config: {
        metrics: { upload_rate: { label: "upload cadence", polarity: 1, delta: "level", baseline_window_hours: 240, min_samples: 4, sd_floor: 0.15, scale: 0.6 } },
        derived: { upload_rate: { from: "video_count", kind: "rate", window_hours: 168, per_hours: 24, min_span_hours: 160 } },
      },
    });
    const store = createMemoryIngestStore({ sources: [source], mappings: { "src-x": [{ person, externalIdentifier: "id" }] } });
    const registry = buildRegistry([levelConnector("x", () => ({ video_count: videos }))]);
    const lines: IngestLogLine[] = [];
    const run = (at: Date) => runIngestion({ store, now: at, registry, force: true, log: (line) => lines.push(line) });

    // Hourly polls, one upload a day, for nine days. The derivation yields
    // nothing until the source history spans the window (160 of 168 hours).
    for (let i = 0; i <= 24 * 9; i += 1) {
      if (i > 0 && i % 24 === 0) videos += 1;
      await run(hour(i));
    }
    const derived = store.snapshots.filter((s) => s.metricKey === "upload_rate");
    expect(derived).toHaveLength(24 * 9 - 160 + 1);
    expect(derived[0].recordedAt).toEqual(hour(160));
    expect(derived[0].value).toBeCloseTo((6 / 160) * 24, 6);
    expect(lines.filter((l) => l.event === "observation" && l.metric === "upload_rate" && l.outcome === "skipped").length).toBe(160);
    expect(store.observations.filter((o) => o.metricKey === "video_count").every((o) => o.outcome === "no_config")).toBe(true);
    // A steady cadence never fires: the window's edge effects sit inside the band.
    expect(store.signals).toEqual([]);
    // First contact, then two readings short of the four-sample minimum, then a steady band.
    expect(store.observations.filter((o) => o.metricKey === "upload_rate").map((o) => o.outcome)).toEqual(["first_contact", "insufficient_baseline", "insufficient_baseline", ...Array(24 * 9 - 160 + 1 - 3).fill("inside_band")]);

    // Then a burst: an upload every five hours for a day.
    for (let i = 24 * 9 + 1; i <= 24 * 10; i += 1) {
      if (i % 5 === 0) videos += 1;
      await run(hour(i));
    }
    expect(store.signals.length).toBeGreaterThan(0);
    expect(store.signals[0].headline).toMatch(/^MrBeast's upload cadence is running \+\d+\.\dσ above their own trailing 10 days$/);
    expect(store.signals[0].rawPayload).toMatchObject({ kind: "metric", metric: "upload_rate", direction: 1, polarity: 1, delta_kind: "level" });
  });

  it("stores events and metrics from one connector, deduplicating events", async () => {
    const source = makeSource({ id: "src-x", name: "x", is_active: true, config: FOLLOWERS_CONFIG });
    const store = createMemoryIngestStore({ sources: [source], mappings: { "src-x": [{ person, externalIdentifier: "id" }] } });
    const registry = buildRegistry([levelConnector("x", () => ({ followers: 5 }), () => [{ headline: "MrBeast launches a burger", dedupeKey: "a1" }, { headline: "MrBeast opens a store", dedupeKey: "a2" }])]);

    const first = await runIngestion({ store, now: NOW, registry, force: true, log: quiet });
    expect(first.sourcesRun[0]).toMatchObject({ signalsCreated: 2, eventSignals: 2, metricSignals: 0, snapshotsRecorded: 1, observations: 1 });
    const second = await runIngestion({ store, now: hour(1), registry, force: true, log: quiet });
    expect(second.sourcesRun[0]).toMatchObject({ signalsCreated: 0, eventSignals: 0, snapshotsRecorded: 1 });
    expect(store.signals.map((s) => s.headline)).toEqual(["MrBeast launches a burger", "MrBeast opens a store"]);
  });

  it("records connector failures per person as error polls and keeps going", async () => {
    const drake = makePerson({ id: "33333333-3333-4333-8333-333333333333", slug: "drake", display_name: "Drake" });
    const failing: DataConnector = {
      name: "x",
      async fetchForPerson(p) {
        if (p.slug === "drake") throw new Error("boom");
        return [];
      },
      async fetchMetrics() {
        return [{ metricKey: "followers", value: 1 }];
      },
    };
    const store = createMemoryIngestStore({
      sources: [makeSource({ id: "src-x", name: "x", is_active: true })],
      mappings: { "src-x": [{ person: drake, externalIdentifier: "d" }, { person, externalIdentifier: "m" }] },
    });

    const summary = await runIngestion({ store, now: NOW, registry: buildRegistry([failing]), force: true, log: quiet });

    expect(summary.errors).toEqual([{ source: "x", person: "drake", message: "boom" }]);
    expect(summary.sourcesRun).toEqual([{ name: "x", people: 2, signalsCreated: 0, eventSignals: 0, metricSignals: 0, snapshotsRecorded: 1, observations: 1, errors: 1 }]);
    expect(store.polls.map((p) => [p.personId, p.status, p.reason])).toEqual([
      [drake.id, "error", "boom"],
      [person.id, "ok", null],
    ]);
    expect(summary.totals.errors).toBe(1);
  });

  describe("with the YouTube connector", () => {
    const previousKey = process.env.YOUTUBE_API_KEY;
    beforeEach(() => {
      process.env.YOUTUBE_API_KEY = "test-key";
    });
    afterEach(() => {
      if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = previousKey;
    });

    it("first contact records five raw levels and emits nothing", async () => {
      const youtube = makeSource({ id: "src-youtube", name: "youtube", is_active: true, config: { metrics: { subscriber_count: { polarity: 1, delta: "relative_rate", baseline_window_hours: 168, min_samples: 24, sd_floor: 0.00001, scale: 1 } } } });
      const store = createMemoryIngestStore({ sources: [youtube], mappings: { "src-youtube": [{ person, externalIdentifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" }] } });
      const fetch = fakeFetchRoutes([
        { match: "/channels?", body: youtubeChannelsResponse({}) },
        { match: "/playlistItems?", body: youtubePlaylistItemsResponse([{ id: "a", title: "A" }]) },
        { match: "/videos?", body: youtubeVideosResponse({ a: "1000" }) },
        { match: "/search?", body: { items: [{ id: { videoId: "z" }, snippet: { channelId: "UCsomeoneelse" } }] } },
      ]);

      const summary = await runIngestion({ store, now: NOW, fetch, force: true, log: quiet });

      expect(summary.sourcesRun).toEqual([{ name: "youtube", people: 1, signalsCreated: 0, eventSignals: 0, metricSignals: 0, snapshotsRecorded: 5, observations: 5, errors: 0 }]);
      expect(store.snapshots.map((s) => [s.metricKey, s.value])).toEqual([
        ["subscriber_count", 516_000_000],
        ["view_count", 90_000_000_000],
        ["video_count", 900],
        ["recent_video_views", 1000],
        ["commentary_volume_24h", 1],
      ]);
      // Only subscriber_count is declared in this source's config: the rest are snapshot-only.
      expect(store.observations.map((o) => [o.metricKey, o.outcome])).toEqual([
        ["subscriber_count", "first_contact"],
        ["view_count", "no_config"],
        ["video_count", "no_config"],
        ["recent_video_views", "no_config"],
        ["commentary_volume_24h", "no_config"],
      ]);
      expect(store.signals).toEqual([]);
    });
  });
});
