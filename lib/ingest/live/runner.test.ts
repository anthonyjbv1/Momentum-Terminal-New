import { describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";
import { buildRegistry } from "@/lib/connectors/registry";
import type { DataConnector, LiveStream } from "@/lib/connectors/types";
import type { Json } from "@/types/database";

import { runLiveMode, type LiveLogLine } from "./runner";
import { createMemoryLiveStore, type MemoryLiveStore } from "./store";

/**
 * The live runner against an in-memory store and a connector double: per-
 * broadcaster state, the cadence, the return to normal, the moments, the
 * closing metrics, the budget, and what it never writes.
 */

const T0 = new Date("2026-09-18T01:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const kai = makePerson({ id: "p-kai", slug: "kai-cenat", display_name: "Kai Cenat" });
const adin = makePerson({ id: "p-adin", slug: "adin-ross", display_name: "Adin Ross" });
const quiet = () => undefined;

const LIVE_CONFIG: Json = {
  live: { enabled: true, sample_interval_minutes: 2 },
  metrics: {
    session_peak_viewers: { label: "peak live audience per stream", delta: "level", polarity: 1, baseline_window_hours: 720, min_samples: 5, sd_floor: 50, scale: 0.8 },
    clips_per_stream_hour: { label: "clips per stream hour", delta: "level", polarity: 1, baseline_window_hours: 720, min_samples: 5, sd_floor: 2, scale: 1 },
  },
};
const twitch = makeSource({ id: "src-twitch", name: "twitch", display_name: "Twitch", is_active: true, config: LIVE_CONFIG });

interface World {
  /** identifier -> the stream it is on, or null when offline. */
  streams: Map<string, LiveStream | null>;
  /** Clips created in a window, by broadcaster. */
  clips: (broadcasterId: string, from: Date, to: Date) => number;
  failDetect?: boolean;
  failClips?: boolean;
}

function stream(overrides: Partial<LiveStream> = {}): LiveStream {
  return { id: "s-1", broadcasterId: "b-kai", channel: "kaicenat", title: "MAFIATHON 3", category: "Just Chatting", viewerCount: 40_000, startedAt: at(-1), ...overrides };
}

/** A connector with live mode, driven by the world the test sets up. */
function liveConnector(world: World): DataConnector & { calls: { detect: number; clips: Array<{ broadcasterId: string; from: Date; to: Date }> } } {
  const calls = { detect: 0, clips: [] as Array<{ broadcasterId: string; from: Date; to: Date }> };
  return {
    name: "twitch",
    calls,
    async fetchForPerson() {
      return [];
    },
    live: {
      async detect(identifiers) {
        calls.detect += 1;
        if (world.failDetect) throw new Error("Helix responded 503");
        return identifiers.map((externalIdentifier) => ({ externalIdentifier, stream: world.streams.get(externalIdentifier) ?? null }));
      },
      async countClips(broadcasterId, from, to) {
        calls.clips.push({ broadcasterId, from, to });
        if (world.failClips) throw new Error("Helix responded 500 for /clips");
        return { count: world.clips(broadcasterId, from, to), truncated: false, requests: 1 };
      },
      liveSignal(person, live, now) {
        return { headline: `${person.display_name} is live on Twitch to ${live.viewerCount} viewers.`, occurredAt: live.startedAt ?? now, dedupeKey: `twitch:stream:${live.id}`, rawPayload: { kind: "stream", stream_id: live.id } };
      },
    },
  };
}

function world(overrides: Partial<World> = {}): World {
  return { streams: new Map(), clips: () => 0, ...overrides };
}

function setup(w: World, mappings = [{ person: kai, externalIdentifier: "kaicenat" }]) {
  const store: MemoryLiveStore = createMemoryLiveStore({ sources: [twitch], mappings: { "src-twitch": mappings } });
  const connector = liveConnector(w);
  const registry = buildRegistry([connector]);
  const lines: LiveLogLine[] = [];
  const fire = (now: Date, options: { budgetMs?: number; clock?: () => number } = {}) => runLiveMode({ store, registry, now, log: (line) => lines.push(line), ...options });
  return { store, connector, fire, lines };
}

describe("live mode — per broadcaster", () => {
  it("opens a session per live broadcaster, stores the 'is live' event under the poll's key, and samples both when two are live at once", async () => {
    const w = world({
      streams: new Map([
        ["kaicenat", stream()],
        ["adinross", stream({ id: "s-2", broadcasterId: "b-adin", channel: "adinross", viewerCount: 25_000 })],
      ]),
      clips: (b) => (b === "b-kai" ? 3 : 1),
    });
    const { store, connector, fire } = setup(w, [
      { person: kai, externalIdentifier: "kaicenat" },
      { person: adin, externalIdentifier: "adinross" },
    ]);
    const summary = await fire(T0);
    expect(summary.sources).toHaveLength(1);
    expect(summary.sources[0]).toMatchObject({ name: "twitch", status: "checked", broadcasters: 2, live: 2, sessionsOpened: 2, samples: 2, signalsCreated: 2, errors: 0 });
    expect(summary.sources[0].people).toEqual([
      { slug: "kai-cenat", live: true, sampled: true, viewerCount: 40_000, sessionId: "live-0001" },
      { slug: "adin-ross", live: true, sampled: true, viewerCount: 25_000, sessionId: "live-0002" },
    ]);
    // One detect for both; the first clip window of each runs from the stream's start (a minute ago) to now less the two-minute lag: empty, so no clip request yet.
    expect(connector.calls.detect).toBe(1);
    expect(connector.calls.clips).toEqual([]);
    expect(store.samples.map((s) => [s.sessionId, s.clipsWindowFrom, s.clipsInWindow])).toEqual([
      ["live-0001", null, 0],
      ["live-0002", null, 0],
    ]);
    // Per-person state: two rows, each its own stream, each complete (seen within the grace of its start).
    expect(store.sessions.map((s) => [s.personId, s.streamId, s.complete, s.sampleCount, s.viewerPeak])).toEqual([
      ["p-kai", "s-1", true, 1, 40_000],
      ["p-adin", "s-2", true, 1, 25_000],
    ]);
    expect(store.ingest.signals.map((s) => [s.personId, s.dedupeKey, s.rawPayload.kind])).toEqual([
      ["p-kai", "twitch:stream:s-1", "stream"],
      ["p-adin", "twitch:stream:s-2", "stream"],
    ]);
    expect(store.samples).toHaveLength(2);
  });

  it("samples on the interval: a minute later only the sighting is recorded, two minutes later a sample is taken", async () => {
    const w = world({ streams: new Map([["kaicenat", stream()]]) });
    const { store, connector, fire } = setup(w);
    await fire(T0);
    expect(store.samples).toHaveLength(1);
    const second = await fire(at(1));
    expect(second.sources[0]).toMatchObject({ live: 1, sessionsOpened: 0, samples: 0 });
    expect(store.samples).toHaveLength(1);
    expect(store.sessions[0].lastSeenAt).toEqual(at(1));
    expect(store.sessions[0].lastSampledAt).toEqual(T0);
    const third = await fire(at(2));
    expect(third.sources[0]).toMatchObject({ live: 1, samples: 1 });
    expect(store.samples).toHaveLength(2);
    const fourth = await fire(at(4));
    expect(fourth.sources[0]).toMatchObject({ live: 1, samples: 1 });
    // Every fire detects; only the due samples count clips, and each window starts exactly where the last one stopped.
    expect(connector.calls.detect).toBe(4);
    expect(connector.calls.clips.map((c) => [c.from, c.to])).toEqual([
      [at(-1), at(0)],
      [at(0), at(2)],
    ]);
  });

  it("returns to normal when the stream ends: one miss is a miss, the second closes the session at its last sighting, with the summary and the session metrics, and nothing is sampled after", async () => {
    const w = world({ streams: new Map([["kaicenat", stream({ startedAt: T0 })]]), clips: () => 2 });
    const { store, connector, fire } = setup(w);
    let viewers = 30_000;
    for (let minute = 0; minute <= 40; minute += 2) {
      viewers += 500;
      w.streams.set("kaicenat", stream({ startedAt: T0, viewerCount: viewers }));
      await fire(at(minute));
    }
    expect(store.samples).toHaveLength(21);
    w.streams.set("kaicenat", null);
    const miss = await fire(at(42));
    expect(miss.sources[0]).toMatchObject({ live: 0, sessionsClosed: 0 });
    expect(store.sessions[0]).toMatchObject({ endedAt: null, missedChecks: 1 });
    const end = await fire(at(43));
    expect(end.sources[0]).toMatchObject({ live: 0, sessionsClosed: 1, snapshotsRecorded: 2, observations: 2 });
    const session = store.sessions[0];
    expect(session.endedAt).toEqual(at(40));
    expect(session.complete).toBe(true);
    expect(session.viewerPeak).toBe(40_500);
    // The tail of clips between the last window and the end was counted too.
    expect(connector.calls.clips.at(-1)).toMatchObject({ to: at(40) });
    // The summary is one ordinary event; the two metrics went through the pipeline under a run of trigger "live".
    const summary = store.ingest.signals.find((s) => s.rawPayload.kind === "stream_summary")!;
    expect(summary.headline).toMatch(/^Kai Cenat's Twitch stream ended after 40m: a peak of 40,500 viewers \(\d{2},\d{3} on average\), \d+ clips \(\d+(\.\d)? an hour\)\.$/);
    expect(summary.occurredAt).toEqual(at(40));
    expect(store.ingest.runs).toHaveLength(1);
    expect(store.ingest.runs[0]).toMatchObject({ trigger: "live", requestedSources: ["twitch"] });
    expect(store.ingest.runs[0].result).toMatchObject({ snapshotsRecorded: 2, observations: 2, signalsCreated: 0 });
    expect(end.runId).toBe(store.ingest.runs[0].id);
    expect(store.ingest.snapshots.map((s) => [s.metricKey, s.value, s.recordedAt])).toEqual([
      ["session_peak_viewers", 40_500, at(40)],
      ["clips_per_stream_hour", expect.any(Number), at(40)],
    ]);
    expect(store.ingest.observations.map((o) => [o.metricKey, o.outcome, o.runId])).toEqual([
      ["session_peak_viewers", "first_contact", store.ingest.runs[0].id],
      ["clips_per_stream_hour", "first_contact", store.ingest.runs[0].id],
    ]);
    // Offline: nothing more happens, no session reopens, no sample is taken.
    const later = await fire(at(50));
    expect(later.sources[0]).toMatchObject({ live: 0, sessionsOpened: 0, samples: 0, sessionsClosed: 0 });
    expect(store.samples).toHaveLength(21);
    // And live mode never wrote a source poll: the hourly metrics poll's clock is untouched.
    expect(store.ingest.polls).toEqual([]);
  });

  it("a new stream id closes the old session and opens a new one in the same fire", async () => {
    const w = world({ streams: new Map([["kaicenat", stream({ id: "s-1", startedAt: at(-30) })]]) });
    const { store, fire } = setup(w);
    await fire(T0);
    w.streams.set("kaicenat", stream({ id: "s-2", startedAt: at(5) }));
    const switched = await fire(at(6));
    expect(switched.sources[0]).toMatchObject({ sessionsClosed: 1, sessionsOpened: 1, samples: 1 });
    expect(store.sessions.map((s) => [s.streamId, s.endedAt])).toEqual([
      ["s-1", at(5)],
      ["s-2", null],
    ]);
    // The old session was joined late (thirty minutes in): incomplete, so no session metrics, but its summary is written.
    expect(store.sessions[0].complete).toBe(false);
    expect(store.ingest.signals.filter((s) => s.rawPayload.kind === "stream_summary")).toHaveLength(1);
    expect(store.ingest.observations).toEqual([]);
  });

  it("a failed detect changes nothing: no miss is counted and no session closes", async () => {
    const w = world({ streams: new Map([["kaicenat", stream()]]) });
    const { store, fire } = setup(w);
    await fire(T0);
    w.failDetect = true;
    const failed = await fire(at(2));
    expect(failed.sources[0]).toMatchObject({ status: "error", errors: 1 });
    expect(failed.sources[0].reason).toMatch(/detect: Helix responded 503/);
    expect(store.sessions[0]).toMatchObject({ endedAt: null, missedChecks: 0 });
    expect(store.samples).toHaveLength(1);
  });

  it("a failed clip read keeps the viewer sample, records the error on it, and retries the same window next time", async () => {
    const w = world({ streams: new Map([["kaicenat", stream()]]) });
    const { store, connector, fire } = setup(w);
    w.failClips = true;
    const first = await fire(at(2));
    expect(first.sources[0]).toMatchObject({ samples: 1, errors: 1 });
    expect(store.samples[0]).toMatchObject({ status: "error", error: "clips: Helix responded 500 for /clips", viewerCount: 40_000, clipsInWindow: 0 });
    expect(store.sessions[0].clipsCountedTo).toBeNull();
    w.failClips = false;
    await fire(at(4));
    expect(connector.calls.clips.map((c) => [c.from, c.to])).toEqual([
      [at(-1), at(0)],
      [at(-1), at(2)],
    ]);
    expect(store.sessions[0].clipsCountedTo).toEqual(at(2));
  });
});

describe("live mode — the moments", () => {
  it("emits an audience surge as a prescored live moment, once, and records the largest fall without emitting a drop", async () => {
    const w = world({ streams: new Map([["kaicenat", stream({ startedAt: T0 })]]) });
    const { store, fire } = setup(w);
    const levels = [30_000, 32_000, 34_000, 35_000, 36_000, 36_500, 37_000, 37_000, 37_500, 38_000, 38_000, 38_500, 39_000, 50_000, 51_000, 52_000, 30_000];
    for (let i = 0; i < levels.length; i += 1) {
      w.streams.set("kaicenat", stream({ startedAt: T0, viewerCount: levels[i] }));
      await fire(at(2 * i));
    }
    const moments = store.ingest.signals.filter((s) => s.rawPayload.kind === "live_moment");
    // Minute 26: 50,000 against 37,500 at minute 16 (+33%), past the warm-up. Minute 28 and 30 are inside the cooldown.
    expect(moments).toHaveLength(1);
    expect(moments[0].headline).toBe("Kai Cenat's live audience is up 33% in the last 10 minutes, 37,500 to 50,000 viewers, 26m into the stream.");
    expect(moments[0].rawPayload).toMatchObject({ kind: "live_moment", moment: "audience_surge", direction: 1, confidence: 0.667, source: "twitch", stream_id: "s-1" });
    expect(moments[0].occurredAt).toEqual(at(26));
    expect(store.sessions[0].lastSurgeAt).toEqual(at(26));
    // The fall at minute 32 (30,000 against 38,500 at minute 22: −22%) is recorded, and not emitted: drops are off by default.
    expect(store.sessions[0].largestDropFraction).toBe(-0.221);
    expect(store.sessions[0].lastDropAt).toBeNull();
  });

  it("emits a clip burst when the trailing window runs at a multiple of the session's pace", async () => {
    // Two clips a window for the first half hour, then twenty a window.
    const w = world({ streams: new Map([["kaicenat", stream({ startedAt: T0 })]]), clips: (_b, from) => (from.getTime() < at(30).getTime() ? 2 : 20) });
    const { store, fire } = setup(w);
    for (let minute = 0; minute <= 40; minute += 2) await fire(at(minute));
    const bursts = store.ingest.signals.filter((s) => (s.rawPayload as { moment?: string }).moment === "clip_burst");
    expect(bursts).toHaveLength(1);
    expect(bursts[0].headline).toMatch(/^Clips of Kai Cenat's stream are being made at \d+(\.\d)?× the session's pace: \d+(\.\d)? an hour over the last 10 minutes, \d+m in\.$/);
    expect(bursts[0].rawPayload).toMatchObject({ kind: "live_moment", moment: "clip_burst", direction: 1 });
    expect((bursts[0].rawPayload as { confidence: number }).confidence).toBeGreaterThan(0.5);
    expect(store.sessions[0].lastBurstAt).not.toBeNull();
  });
});

describe("live mode — what it leaves alone", () => {
  it("ignores a source without a live block, and one with it off", async () => {
    const plain = makeSource({ id: "src-plain", name: "twitch", is_active: true, config: { live: { enabled: false } } });
    const store = createMemoryLiveStore({ sources: [plain], mappings: { "src-plain": [{ person: kai, externalIdentifier: "kaicenat" }] } });
    const connector = liveConnector(world({ streams: new Map([["kaicenat", stream()]]) }));
    const summary = await runLiveMode({ store, registry: buildRegistry([connector]), now: T0, log: quiet });
    expect(summary.sources).toEqual([]);
    expect(connector.calls.detect).toBe(0);
    expect(store.sessions).toEqual([]);
  });

  it("skips a source whose connector is unavailable, saying why", async () => {
    const store = createMemoryLiveStore({ sources: [twitch], mappings: { "src-twitch": [{ person: kai, externalIdentifier: "kaicenat" }] } });
    const connector = { ...liveConnector(world()), available: () => ({ ok: false as const, reason: "TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set" }) };
    const summary = await runLiveMode({ store, registry: buildRegistry([connector]), now: T0, log: quiet });
    expect(summary.sources[0]).toMatchObject({ status: "skipped", reason: "inactive: TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set" });
  });

  it("under the budget, a due sample waits for the next fire and the session stays open", async () => {
    const w = world({ streams: new Map([["kaicenat", stream()]]) });
    const { store, fire } = setup(w);
    await fire(T0);
    let clock = 0;
    // The clock jumps past the budget as soon as the run starts: the check happens, the sample does not.
    const starved = await fire(at(2), { budgetMs: 1_000, clock: () => (clock += 2_000) });
    expect(starved.budget).toEqual({ ms: 1_000, exhausted: true });
    expect(starved.sources[0]).toMatchObject({ status: "skipped" });
    expect(store.samples).toHaveLength(1);
    expect(store.sessions[0].endedAt).toBeNull();
    const fed = await fire(at(3));
    expect(fed.sources[0]).toMatchObject({ samples: 1, samplesSkipped: 0 });
  });

  it("closes an orphaned session (its mapping gone) at its last sighting, without a summary", async () => {
    const w = world({ streams: new Map([["kaicenat", stream()]]) });
    const { store, fire } = setup(w);
    await fire(T0);
    // The mapping disappears: an empty mapping list skips the source, so give the source another person instead.
    const gone = createMemoryLiveStore({ sources: [twitch], mappings: { "src-twitch": [{ person: adin, externalIdentifier: "adinross" }] }, sessions: store.sessions });
    const summary = await runLiveMode({ store: gone, registry: buildRegistry([liveConnector(w)]), now: at(2), log: quiet });
    expect(summary.sources[0]).toMatchObject({ sessionsClosed: 1 });
    expect(gone.sessions[0]).toMatchObject({ personId: "p-kai", endedAt: T0 });
    expect(gone.ingest.signals).toEqual([]);
  });
});
