import { describe, expect, it } from "vitest";

import type { LiveStream } from "@/lib/connectors/types";
import { makePerson } from "@/lib/__tests__/fixtures";

import {
  DEFAULT_LIVE_CONFIG,
  applySample,
  audienceDelta,
  audienceMoment,
  clipMoment,
  clipRate,
  clipWindow,
  describeElapsed,
  liveMomentSignal,
  openSession,
  readLiveConfig,
  sampleDue,
  sessionAggregates,
  sessionMetricReadings,
  streamSummarySignal,
  type LiveConfig,
  type LiveSample,
  type LiveSession,
} from "./rules";

const T0 = new Date("2026-09-18T01:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const kai = makePerson({ id: "p-kai", slug: "kai-cenat", display_name: "Kai Cenat" });

const CONFIG: LiveConfig = readLiveConfig({ live: { enabled: true } })!;

function stream(overrides: Partial<LiveStream> = {}): LiveStream {
  return { id: "48211", broadcasterId: "144304", channel: "kaicenat", title: "MAFIATHON 3", category: "Just Chatting", viewerCount: 40_000, startedAt: T0, ...overrides };
}

function session(overrides: Partial<LiveSession> = {}): LiveSession {
  return { ...openSession({ personId: kai.id, dataSourceId: "src-twitch", stream: stream(), now: T0, config: CONFIG }), id: "live-0001", ...overrides };
}

function sample(minutes: number, viewerCount: number, clips: { from: number; to: number; count: number } | null = null): LiveSample {
  return {
    sessionId: "live-0001",
    sampledAt: at(minutes),
    viewerCount,
    category: "Just Chatting",
    title: "MAFIATHON 3",
    clipsWindowFrom: clips ? at(clips.from) : null,
    clipsWindowTo: clips ? at(clips.to) : null,
    clipsInWindow: clips?.count ?? 0,
    clipsTruncated: false,
    latencyMs: 100,
    status: "ok",
    error: null,
    signalsCreated: 0,
  };
}

describe("readLiveConfig", () => {
  it("is null without a live block or with it off, and the defaults with it on", () => {
    expect(readLiveConfig(undefined)).toBeNull();
    expect(readLiveConfig({})).toBeNull();
    expect(readLiveConfig({ live: { enabled: false } })).toBeNull();
    expect(readLiveConfig({ live: { enabled: "true" } })).toBeNull();
    expect(readLiveConfig({ live: { enabled: true } })).toEqual({ enabled: true, ...DEFAULT_LIVE_CONFIG });
  });

  it("bounds the sample interval to one to five minutes, whatever the row says", () => {
    expect(readLiveConfig({ live: { enabled: true, sample_interval_minutes: 0.2 } })?.sampleIntervalMinutes).toBe(1);
    expect(readLiveConfig({ live: { enabled: true, sample_interval_minutes: 15 } })?.sampleIntervalMinutes).toBe(5);
    expect(readLiveConfig({ live: { enabled: true, sample_interval_minutes: 3 } })?.sampleIntervalMinutes).toBe(3);
    expect(readLiveConfig({ live: { enabled: true, sample_interval_minutes: "fast" } })?.sampleIntervalMinutes).toBe(2);
  });

  it("layers the person's own block over the source's: a threshold is per broadcaster when it needs to be", () => {
    const source = { live: { enabled: true, surge_fraction: 0.2, min_viewers: 500 } };
    const person = { live: { min_viewers: 20_000, drop_fraction: 0.3 } };
    const merged = readLiveConfig(source, person)!;
    expect(merged).toMatchObject({ surgeFraction: 0.2, minViewers: 20_000, dropFraction: 0.3 });
    // The person cannot switch live mode on for a source that has it off.
    expect(readLiveConfig({ live: { enabled: false } }, { live: { enabled: true } })).toBeNull();
    // Drops are off unless a fraction is given.
    expect(readLiveConfig(source)!.dropFraction).toBeNull();
    expect(readLiveConfig({ live: { enabled: true, drop_fraction: 0 } })!.dropFraction).toBeNull();
  });
});

describe("the session", () => {
  it("opens complete when first seen within the grace of its start, incomplete when joined late", () => {
    expect(openSession({ personId: kai.id, dataSourceId: "s", stream: stream(), now: at(3), config: CONFIG }).complete).toBe(true);
    expect(openSession({ personId: kai.id, dataSourceId: "s", stream: stream(), now: at(40), config: CONFIG }).complete).toBe(false);
    // No start time from the platform: now is the start, and the session is complete by definition.
    const unknown = openSession({ personId: kai.id, dataSourceId: "s", stream: stream({ startedAt: null }), now: at(40), config: CONFIG });
    expect(unknown.startedAt).toEqual(at(40));
    expect(unknown.complete).toBe(true);
  });

  it("is due for a sample on its interval with half a minute of grace for the cron's jitter, and always the first time", () => {
    expect(sampleDue(session(), T0, CONFIG)).toBe(true);
    const sampled = session({ lastSampledAt: T0 });
    expect(sampleDue(sampled, at(1), CONFIG)).toBe(false);
    expect(sampleDue(sampled, at(1.5), CONFIG)).toBe(true);
    expect(sampleDue(sampled, at(2), CONFIG)).toBe(true);
    expect(sampleDue(sampled, at(1), { ...CONFIG, sampleIntervalMinutes: 1 })).toBe(true);
  });

  it("counts clips from where the last window stopped, lagged behind now, and never over an empty window", () => {
    expect(clipWindow(session(), at(10), CONFIG)).toEqual({ from: T0, to: at(8) });
    expect(clipWindow(session({ clipsCountedTo: at(8) }), at(12), CONFIG)).toEqual({ from: at(8), to: at(10) });
    expect(clipWindow(session({ clipsCountedTo: at(8) }), at(9), CONFIG)).toBeNull();
    // Joined late: the window starts where the session was first seen, not where the stream began.
    const late = session({ complete: false, firstSeenAt: at(40), startedAt: T0 });
    expect(clipWindow(late, at(50), CONFIG)).toEqual({ from: at(40), to: at(48) });
  });

  it("folds a sample in: count, sum, peak and when, category switches, the clip total, and a gap makes it incomplete", () => {
    let s = session();
    s = applySample(s, { now: at(2), stream: stream({ viewerCount: 40_000 }), clips: { from: T0, to: at(0), count: 0 } }, CONFIG);
    s = applySample(s, { now: at(4), stream: stream({ viewerCount: 52_000 }), clips: { from: at(0), to: at(2), count: 7 } }, CONFIG);
    s = applySample(s, { now: at(6), stream: stream({ viewerCount: 48_000, category: "Marvel's Wolverine" }), clips: { from: at(2), to: at(4), count: 3 } }, CONFIG);
    expect(s).toMatchObject({ sampleCount: 3, viewerSum: 140_000, viewerLatest: 48_000, viewerPeak: 52_000, peakAt: at(4), categorySwitches: 1, categoryLatest: "Marvel's Wolverine", clipsTotal: 10, clipsCountedTo: at(4), lastSampledAt: at(6), complete: true });
    // A null viewer count is not a sample of zero.
    const blind = applySample(s, { now: at(8), stream: stream({ viewerCount: null }), clips: null }, CONFIG);
    expect(blind).toMatchObject({ sampleCount: 4, viewerSum: 140_000, viewerPeak: 52_000, clipsTotal: 10, clipsCountedTo: at(4) });
    // Twenty minutes without a sample: the session is no longer complete.
    expect(applySample(s, { now: at(26), stream: stream(), clips: null }, CONFIG).complete).toBe(false);
  });
});

describe("audience moments — the session against itself", () => {
  const ramp = [sample(0, 30_000), sample(2, 34_000), sample(4, 38_000), sample(6, 40_000), sample(8, 41_000), sample(10, 41_500), sample(12, 42_000), sample(14, 42_000), sample(16, 42_500), sample(18, 43_000), sample(20, 43_000)];

  it("measures the delta against the newest sample at least the window back", () => {
    const delta = audienceDelta(ramp, { sampledAt: at(22), viewerCount: 52_000 }, CONFIG);
    // The newest sample at least ten minutes back is the one at minute 12: 42,000.
    expect(delta).toEqual({ from: 42_000, to: 52_000, fraction: expect.closeTo((52_000 - 42_000) / 42_000, 6), minutes: 10 });
    expect(audienceDelta(ramp.slice(-2), { sampledAt: at(22), viewerCount: 52_000 }, CONFIG)).toBeNull();
    expect(audienceDelta(ramp, { sampledAt: at(22), viewerCount: null }, CONFIG)).toBeNull();
  });

  it("fires a surge past the fraction, after the warm-up, with a confidence from the magnitude, and once per cooldown", () => {
    const s = session();
    // +25% in ten minutes at 22 minutes in: a surge at confidence 0.25 / 0.5.
    const surge = audienceMoment(s, ramp, { sampledAt: at(22), viewerCount: 52_500 }, CONFIG);
    expect(surge).toMatchObject({ moment: "audience_surge", direction: 1, confidence: 0.5, windowMinutes: 10, from: 42_000, to: 52_500 });
    expect(surge?.magnitude).toBeCloseTo(0.25, 2);
    expect(surge?.rationale).toMatch(/\+25%/);
    // +50% reads at 1; +10% is under the threshold.
    expect(audienceMoment(s, ramp, { sampledAt: at(22), viewerCount: 63_000 }, CONFIG)?.confidence).toBe(1);
    expect(audienceMoment(s, ramp, { sampledAt: at(22), viewerCount: 46_200 }, CONFIG)).toBeNull();
    // Inside the warm-up: the first minutes of any stream are a ramp, not a surge.
    expect(audienceMoment(s, ramp.slice(0, 5), { sampledAt: at(12), viewerCount: 60_000 }, CONFIG)).toBeNull();
    // A surge twenty minutes ago holds this one back; one thirty minutes ago does not.
    expect(audienceMoment(session({ lastSurgeAt: at(2) }), ramp, { sampledAt: at(22), viewerCount: 60_000 }, CONFIG)).toBeNull();
    expect(audienceMoment(session({ lastSurgeAt: at(-10) }), ramp, { sampledAt: at(22), viewerCount: 60_000 }, CONFIG)).not.toBeNull();
  });

  it("ignores a small channel's noise below min_viewers", () => {
    const small = [sample(0, 120), sample(2, 130), sample(10, 140), sample(12, 150)];
    expect(audienceMoment(session(), small, { sampledAt: at(24), viewerCount: 300 }, CONFIG)).toBeNull();
    expect(audienceMoment(session(), small, { sampledAt: at(24), viewerCount: 300 }, { ...CONFIG, minViewers: 100 })).not.toBeNull();
  });

  it("emits a drop only when the fraction is switched on; the fall is measured either way", () => {
    const fall = { sampledAt: at(22), viewerCount: 25_000 };
    expect(audienceMoment(session(), ramp, fall, CONFIG)).toBeNull();
    const drop = audienceMoment(session(), ramp, fall, { ...CONFIG, dropFraction: 0.3 });
    expect(drop).toMatchObject({ moment: "audience_drop", direction: -1, from: 42_000, to: 25_000 });
    expect(drop?.magnitude).toBeCloseTo(-0.405, 2);
    expect(drop?.confidence).toBeCloseTo(0.81, 2);
    expect(audienceDelta(ramp, fall, CONFIG)?.fraction).toBeLessThan(-0.4);
  });
});

describe("clip moments — the trailing rate against the session's own pace", () => {
  // A steady session: two clips a window (a minute each, every two minutes) for an hour: 60 clips/hour.
  const steady = Array.from({ length: 30 }, (_, i) => sample(2 * i + 2, 40_000, { from: 2 * i, to: 2 * i + 2, count: 2 }));
  const steadySession = session({ clipsTotal: 60, clipsCountedTo: at(60) });

  it("measures the trailing window's rate against the session's pace BEFORE the window, floored, as a multiple", () => {
    const rate = clipRate(steadySession, steady, { from: at(60), to: at(62), count: 2 }, CONFIG)!;
    // Five two-minute windows inside the trailing ten minutes: 10 clips, 60/h; the fifty-two before them: 60/h too.
    expect(rate.trailingClips).toBe(10);
    expect(rate.trailingHours).toBeCloseTo(1 / 6, 6);
    expect(rate.trailingPerHour).toBeCloseTo(60, 6);
    expect(rate.sessionPerHour).toBeCloseTo(60, 6);
    expect(rate.baselinePerHour).toBeCloseTo(60, 6);
    expect(rate.multiple).toBeCloseTo(1, 6);
  });

  it("fires a burst at the multiple with enough clips in the window, with a confidence from the multiple, once per cooldown", () => {
    // 40 clips in this two-minute window on top of 8 in the previous eight minutes: 48 in ten = 288/h against the 60/h before it.
    const burst = clipMoment(steadySession, steady, { from: at(60), to: at(62), count: 40 }, at(64), CONFIG);
    expect(burst).toMatchObject({ moment: "clip_burst", direction: 1, windowMinutes: 10, from: 60, to: 288 });
    expect(burst?.magnitude).toBeCloseTo(4.8, 1);
    // (4.8 − 1) / (6 − 1)
    expect(burst?.confidence).toBeCloseTo(0.76, 2);
    expect(burst?.rationale).toMatch(/48 clips in 10 min/);
    // Six in the window: 14 in ten minutes, 84/h, 1.4×. No burst.
    expect(clipMoment(steadySession, steady, { from: at(60), to: at(62), count: 6 }, at(64), CONFIG)).toBeNull();
    expect(clipMoment(session({ ...steadySession, lastBurstAt: at(50) }), steady, { from: at(60), to: at(62), count: 40 }, at(64), CONFIG)).toBeNull();
  });

  it("floors a quiet session's pace so a slow start cannot make any clip a burst, and needs the minimum count", () => {
    // A session that has produced one clip in an hour, then four in a window: 4 clips is under burstMinClips.
    const quiet = session({ clipsTotal: 1, clipsCountedTo: at(60) });
    const few = Array.from({ length: 30 }, (_, i) => sample(2 * i + 2, 1_000, { from: 2 * i, to: 2 * i + 2, count: i === 0 ? 1 : 0 }));
    expect(clipMoment(quiet, few, { from: at(60), to: at(62), count: 4 }, at(64), CONFIG)).toBeNull();
    // Five clips in ten minutes is 30/h: against the floor of 6/h that is 5×, a burst; against a 1/h session it would have been 30×.
    const burst = clipMoment(quiet, few, { from: at(60), to: at(62), count: 5 }, at(64), CONFIG)!;
    expect(burst.magnitude).toBeCloseTo(5, 0);
    expect(burst.from).toBe(6);
  });

  it("fires nothing inside the warm-up", () => {
    expect(clipMoment(session({ clipsTotal: 2, clipsCountedTo: at(10) }), steady.slice(0, 5), { from: at(10), to: at(12), count: 40 }, at(14), CONFIG)).toBeNull();
  });
});

describe("the signals", () => {
  it("writes a live moment with its declared direction and confidence, keyed to the session and the minute", () => {
    const s = session();
    const signal = liveMomentSignal(kai, s, { moment: "audience_surge", direction: 1, confidence: 0.48, magnitude: 0.24, windowMinutes: 10, from: 48_200, to: 59_800, rationale: "x" }, at(125), "twitch");
    expect(signal.headline).toBe("Kai Cenat's live audience is up 24% in the last 10 minutes, 48,200 to 59,800 viewers, 2h 05m into the stream.");
    expect(signal.dedupeKey).toBe(`twitch:live:48211:audience_surge:${at(125).toISOString()}`);
    expect(signal.occurredAt).toEqual(at(125));
    expect(signal.rawPayload).toMatchObject({ kind: "live_moment", source: "twitch", moment: "audience_surge", direction: 1, confidence: 0.48, magnitude: 0.24, window_minutes: 10, stream_id: "48211", minutes_into_stream: 125 });
    const burst = liveMomentSignal(kai, s, { moment: "clip_burst", direction: 1, confidence: 0.7, magnitude: 3.4, windowMinutes: 10, from: 60, to: 204, rationale: "x" }, at(45), "twitch");
    expect(burst.headline).toBe("Clips of Kai Cenat's stream are being made at 3.4× the session's pace: 204 an hour over the last 10 minutes, 45m in.");
  });

  it("summarises a closed session as one ordinary event with its facts, and reads incomplete sessions as such", () => {
    let s = session();
    for (let i = 1; i <= 90; i += 1) s = applySample(s, { now: at(2 * i), stream: stream({ viewerCount: 40_000 + (i <= 45 ? i * 1_000 : (90 - i) * 1_000), category: i > 60 ? "Marvel's Wolverine" : "Just Chatting" }), clips: { from: at(2 * i - 2), to: at(2 * i), count: 2 } }, CONFIG);
    const ended = at(180);
    const aggregates = sessionAggregates(s, ended);
    expect(aggregates).toMatchObject({ hours: 3, peakViewers: 85_000, timeToPeakMinutes: 90, clipsTotal: 180, clipsPerHour: 60, categorySwitches: 1 });
    expect(aggregates.averageViewers).toBeGreaterThan(60_000);
    expect(aggregates.peakToAverage).toBeGreaterThan(1.2);
    const signal = streamSummarySignal(kai, s, ended, "twitch", "Twitch");
    expect(signal.headline).toMatch(/^Kai Cenat's Twitch stream ended after 3h 00m: a peak of 85,000 viewers \(\d{2},\d{3} on average\), 180 clips \(60 an hour\), 2 categories\.$/);
    expect(signal.dedupeKey).toBe("twitch:stream_summary:48211");
    expect(signal.occurredAt).toEqual(ended);
    expect(signal.rawPayload).toMatchObject({ kind: "stream_summary", peak_viewers: 85_000, clips_per_hour: 60, complete: true, samples: 90 });
    expect(streamSummarySignal(kai, { ...s, complete: false }, ended, "twitch", "Twitch").headline).toMatch(/\(watched from part way through\)\.$/);
  });

  it("records the two session metrics for a COMPLETE session longer than the warm-up, and nothing otherwise", () => {
    let s = session();
    for (let i = 1; i <= 30; i += 1) s = applySample(s, { now: at(2 * i), stream: stream({ viewerCount: 30_000 + i * 500 }), clips: { from: at(2 * i - 2), to: at(2 * i), count: 1 } }, CONFIG);
    expect(sessionMetricReadings(s, at(60), CONFIG)).toEqual([
      { metricKey: "session_peak_viewers", value: 45_000 },
      { metricKey: "clips_per_stream_hour", value: 30 },
    ]);
    expect(sessionMetricReadings({ ...s, complete: false }, at(60), CONFIG)).toEqual([]);
    expect(sessionMetricReadings(s, at(15), CONFIG)).toEqual([]);
  });

  it("describes elapsed time the way a person would", () => {
    expect(describeElapsed(5)).toBe("5m");
    expect(describeElapsed(65)).toBe("1h 05m");
    expect(describeElapsed(372)).toBe("6h 12m");
  });
});
