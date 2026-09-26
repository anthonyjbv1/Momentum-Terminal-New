import { afterEach, describe, expect, it } from "vitest";

import type { LiveStream } from "@/lib/connectors/types";
import { makePerson } from "@/lib/__tests__/fixtures";

import { liveQualityFromEnv } from "../quality";
import {
  LIVE_QUALITY_DEFAULTS,
  audienceMoment,
  clipMoment,
  clipRate,
  confidenceAboveThreshold,
  dropMoment,
  liveMomentSignal,
  openSession,
  qualityClipMoment,
  qualitySurgeMoment,
  readLiveConfig,
  sessionShape,
  shapeBucket,
  smoothedAudience,
  usualClipsPerHour,
  withLiveQuality,
  type LiveConfig,
  type LiveMoment,
  type LiveSample,
  type LiveSession,
  type SessionShape,
} from "./rules";

/**
 * THE QUALITY RULES (Phase 31 switch), from Kai Cenat's stream of 2026-09-26:
 * the ramp, single readings that revert, a real step that holds, the caps,
 * confidence from the threshold, and the clip-burst floors. Each case is the
 * shape of something that session did, with round numbers.
 */

const T0 = new Date("2026-09-26T11:16:20.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const kai = makePerson({ id: "p-kai", slug: "kai-cenat", display_name: "Kai Cenat" });
const BASE: LiveConfig = readLiveConfig({ live: { enabled: true } })!;
const Q = LIVE_QUALITY_DEFAULTS;
const CONFIG = withLiveQuality(BASE, Q);

function stream(overrides: Partial<LiveStream> = {}): LiveStream {
  return { id: "320393470558", broadcasterId: "641972806", channel: "kaicenat", title: "EXPLORING ICELAND", category: "IRL", viewerCount: 0, startedAt: T0, ...overrides };
}

function session(overrides: Partial<LiveSession> = {}): LiveSession {
  return { ...openSession({ personId: kai.id, dataSourceId: "src-twitch", stream: stream(), now: T0, config: CONFIG }), id: "live-0001", ...overrides };
}

function sample(minutes: number, viewerCount: number | null, clips: { from: number; to: number; count: number } | null = null): LiveSample {
  return {
    sessionId: "live-0001",
    sampledAt: at(minutes),
    viewerCount,
    category: "IRL",
    title: "EXPLORING ICELAND",
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

/** A sample every four minutes from minute 0, the audience from `audience(minute)`; a small wobble keeps Helix's readings distinct. */
function series(until: number, audience: (minute: number) => number): LiveSample[] {
  const out: LiveSample[] = [];
  for (let minute = 0; minute <= until; minute += 4) out.push(sample(minute, Math.round(audience(minute)) + ((minute / 4) % 2) * 100));
  return out;
}

/** Walks a series as the runner does: each sample judged against the ones before it, the caps and the cooldown carried forward. */
function surges(samples: LiveSample[], shape: SessionShape | null = null): Array<{ minute: number; moment: LiveMoment }> {
  let current = session();
  const fired: Array<{ minute: number; moment: LiveMoment }> = [];
  samples.forEach((s, index) => {
    const moment = qualitySurgeMoment(current, samples.slice(0, index), { sampledAt: s.sampledAt, viewerCount: s.viewerCount }, { surgesSoFar: fired.length, shape }, CONFIG);
    if (moment) {
      fired.push({ minute: (s.sampledAt.getTime() - T0.getTime()) / 60_000, moment });
      current = { ...current, lastSurgeAt: s.sampledAt };
    }
  });
  return fired;
}

describe("the switch", () => {
  afterEach(() => {
    delete process.env.SIGNAL_QUALITY_ENABLED;
  });

  it("is off unless SIGNAL_QUALITY_ENABLED is exactly true, and off leaves the live config as it was", () => {
    expect(liveQualityFromEnv()).toBeUndefined();
    for (const value of ["1", "TRUE", "yes", ""]) {
      process.env.SIGNAL_QUALITY_ENABLED = value;
      expect(liveQualityFromEnv()).toBeUndefined();
    }
    process.env.SIGNAL_QUALITY_ENABLED = "true";
    expect(liveQualityFromEnv()).toBe(LIVE_QUALITY_DEFAULTS);
    expect(withLiveQuality(BASE, undefined)).toBe(BASE);
  });

  it("on, samples at Helix's four-minute refresh and doubles the gap a complete session tolerates; nothing else in the row moves", () => {
    expect({ sampleIntervalMinutes: CONFIG.sampleIntervalMinutes, maxGapMinutes: CONFIG.maxGapMinutes, quality: CONFIG.quality }).toEqual({ sampleIntervalMinutes: 4, maxGapMinutes: 10, quality: Q });
    expect({ ...CONFIG, sampleIntervalMinutes: BASE.sampleIntervalMinutes, maxGapMinutes: BASE.maxGapMinutes, quality: undefined }).toEqual(BASE);
  });
});

describe("confidence from the threshold", () => {
  it("reads 0 at the threshold and 1 at full, linearly, bounded", () => {
    expect(confidenceAboveThreshold(0.2, 0.2, 0.5)).toBe(0);
    expect(confidenceAboveThreshold(0.35, 0.2, 0.5)).toBe(0.5);
    expect(confidenceAboveThreshold(0.5, 0.2, 0.5)).toBe(1);
    expect(confidenceAboveThreshold(0.9, 0.2, 0.5)).toBe(1);
    expect(confidenceAboveThreshold(0.1, 0.2, 0.5)).toBe(0);
    // A burst at 3× read 0.4 under the Phase 16 scale; now it reads 0.
    expect(confidenceAboveThreshold(3, 3, 6)).toBe(0);
  });
});

describe("the smoothed audience", () => {
  it("is not judged on one stale number: two readings in the recent window must differ", () => {
    const flat = [sample(56, 40_000), sample(60, 40_000)];
    const base = [sample(20, 30_000), sample(24, 30_000), sample(28, 30_000)];
    expect(smoothedAudience([...base, ...flat], at(60), Q)).toBeNull();
    const fresh = [sample(56, 40_000), sample(60, 40_200)];
    expect(smoothedAudience([...base, ...fresh], at(60), Q)).toMatchObject({ recent: 40_100, base: 30_000, recentDistinct: 2, baseSamples: 3 });
  });

  it("never takes its base from the warm-up, and wants three base samples", () => {
    const ramp = [sample(0, 0), sample(4, 13_000), sample(8, 23_000), sample(12, 32_000), sample(16, 31_000), sample(20, 31_000), sample(24, 31_200), sample(28, 31_000)];
    const now = [sample(56, 32_000), sample(60, 32_300)];
    // Without the floor the base at minute 60 would average the ramp in (minutes 0-28): +43%.
    expect(smoothedAudience([...ramp, ...now], at(60), Q)!.fraction).toBeGreaterThan(0.3);
    const warmed = smoothedAudience([...ramp, ...now], at(60), Q, at(20))!;
    expect(warmed.baseSamples).toBe(3);
    expect(warmed.fraction).toBeCloseTo((32_150 - 31_066.67) / 31_066.67, 3);
    expect(smoothedAudience([...ramp, ...now], at(60), Q, at(25))).toBeNull();
  });
});

describe("an audience surge under the quality rules", () => {
  it("never reads the ramp, or the plateau after it, as a surge", () => {
    const ramp = (m: number) => (m < 12 ? (m / 12) * 30_000 : 30_000 + (m - 12) * 20);
    expect(surges(series(240, ramp))).toEqual([]);
  });

  it("does not fire on a single reading that reverts, however large", () => {
    const blip = (m: number) => (m === 100 || m === 180 ? 55_000 : 40_000);
    expect(surges(series(240, blip))).toEqual([]);
  });

  it("fires once on a step that holds, at the sample that confirms it, with confidence read from the threshold", () => {
    const step = (m: number) => (m < 104 ? 40_000 : 52_000);
    const fired = surges(series(240, step));
    expect(fired.map((f) => f.minute)).toEqual([112]);
    const { moment } = fired[0];
    expect(moment).toMatchObject({ moment: "audience_surge", direction: 1, rule: "quality" });
    expect(moment.magnitude).toBeCloseTo(0.3, 1);
    expect(moment.confidence).toBeCloseTo(confidenceAboveThreshold(moment.magnitude, 0.2, 0.5), 2);
    expect(moment.rationale).toContain("held from the previous sample");
  });

  it("allows two surges a session, an hour apart, the second at half confidence", () => {
    const stairs = (m: number) => (m < 104 ? 40_000 : m < 204 ? 52_000 : m < 304 ? 68_000 : 90_000);
    const fired = surges(series(400, stairs));
    expect(fired.map((f) => f.minute)).toEqual([112, 212]);
    const raw = confidenceAboveThreshold(fired[1].moment.magnitude, 0.2, 0.5);
    expect(fired[1].moment.confidence).toBeCloseTo(raw * 0.5, 2);
    expect(fired[1].moment.rationale).toContain("surge 2 of the session");
  });

  it("keeps the hour between surges: a second step 40 minutes after the first waits", () => {
    const quick = (m: number) => (m < 104 ? 40_000 : m < 144 ? 52_000 : 70_000);
    expect(surges(series(260, quick)).map((f) => f.minute)[1]).toBeGreaterThanOrEqual(172);
  });

  it("once the person has a shape, also has to clear their usual audience at this minute by 15%", () => {
    const step = (m: number) => (m < 104 ? 40_000 : 52_000);
    const usual = (median: number): SessionShape => ({ sessions: 5, median, spread: 1_000, bucketFromMinutes: 110, bucketToMinutes: 120 });
    expect(surges(series(240, step), usual(50_000))).toEqual([]);
    expect(surges(series(240, step), usual(44_000)).map((f) => f.minute)).toEqual([112]);
  });

  it("leaves drops to the Phase 16 rule, which stays off unless a row switches it on", () => {
    const fall = [sample(20, 40_000), sample(24, 40_000), sample(28, 40_000)];
    const now = { sampledAt: at(32), viewerCount: 28_000 };
    expect(dropMoment(session(), fall, now, CONFIG)).toBeNull();
    const withDrops = { ...CONFIG, dropFraction: 0.2 };
    expect(dropMoment(session(), fall, now, withDrops)).toEqual(audienceMoment(session(), fall, now, withDrops));
    expect(dropMoment(session(), fall, { sampledAt: at(32), viewerCount: 52_000 }, withDrops)).toBeNull();
  });
});

describe("the session shape", () => {
  it("is off until five sessions reached this minute, then the median of each session's mean, with its spread", () => {
    const bucket = shapeBucket(113, Q);
    expect(bucket).toEqual({ fromMinutes: 110, toMinutes: 120 });
    expect(sessionShape([[40_000], [41_000], [], [39_000], [42_000]], bucket, Q)).toBeNull();
    expect(sessionShape([[40_000, 40_400], [41_000], [39_000], [42_000], [38_000]], bucket, Q)).toEqual({ sessions: 5, median: 40_200, spread: 1_200, bucketFromMinutes: 110, bucketToMinutes: 120 });
  });
});

describe("a clip burst under the quality rules", () => {
  // Four-minute windows of clips, from minute 0 to `until`, `perWindow(to)` clips each.
  function windows(until: number, perWindow: (to: number) => number): LiveSample[] {
    const out: LiveSample[] = [];
    for (let to = 4; to <= until; to += 4) out.push(sample(to + 2, 40_000, { from: to - 4, to, count: perWindow(to) }));
    return out;
  }
  function burst(prior: LiveSample[], current: { from: number; to: number; count: number }, context: { burstsSoFar?: number; usualPerHour?: number | null; averageViewers?: number } = {}) {
    const total = prior.reduce((sum, s) => sum + s.clipsInWindow, 0);
    const averageViewers = context.averageViewers ?? 40_000;
    const s = session({ clipsTotal: total, sampleCount: 30, viewerSum: averageViewers * 30 });
    return qualityClipMoment(s, prior, { from: at(current.from), to: at(current.to), count: current.count }, at(current.to + 2), { burstsSoFar: context.burstsSoFar ?? 0, usualPerHour: context.usualPerHour ?? null }, CONFIG);
  }

  it("does not fire in the first hour: the 09-26 minute-20 burst (12 clips in ten minutes against 2 in eight) is not one", () => {
    const early = [sample(10, 30_000, { from: 0, to: 8, count: 2 })];
    expect(burst(early, { from: 8, to: 18, count: 12 })).toBeNull();
  });

  it("wants thirty clips before the window and fifteen in it", () => {
    const quiet = windows(96, () => 1); // 24 clips before
    expect(burst(quiet, { from: 96, to: 100, count: 30 })).toBeNull();
    const busy = windows(96, () => 2); // 48 before
    expect(burst(busy, { from: 96, to: 100, count: 14 })).toBeNull();
  });

  it("measures against the audience floor until the person has a usual rate, then against that", () => {
    // Two clips every four minutes (30 an hour), then 12 and 12. The trailing ten minutes reach into the window
    // ending at 92, so 2 + 12 + 12 = 26 clips over the 12 minutes those windows cover: 130 an hour, against the
    // floor of 40 an hour that 40,000 viewers set: 3.25×.
    const prior = windows(96, (to) => (to === 96 ? 12 : 2));
    const moment = burst(prior, { from: 96, to: 100, count: 12 });
    expect(moment).toMatchObject({ moment: "clip_burst", rule: "quality", to: 130, from: 40 });
    expect(moment!.magnitude).toBeCloseTo(3.25, 3);
    expect(moment!.confidence).toBeCloseTo(confidenceAboveThreshold(3.25, 3, 6), 3);
    expect(moment!.rationale).toContain("the audience floor 40.0/h");
    // A smaller audience sets a lower floor, and the session's own 30 an hour takes over from the floor below it.
    expect(burst(prior, { from: 96, to: 100, count: 12 }, { averageViewers: 10_000 })!.from).toBe(30);
    // With a usual 70 an hour: 1.9×, no burst.
    expect(burst(prior, { from: 96, to: 100, count: 12 }, { usualPerHour: 70 })).toBeNull();
    // The Phase 16 rule, against the session's own pace and the floor of 6, fires on the same hour.
    const s = session({ clipsTotal: prior.reduce((sum, x) => sum + x.clipsInWindow, 0), sampleCount: 30, viewerSum: 40_000 * 30 });
    expect(clipMoment(s, prior, { from: at(96), to: at(100), count: 12 }, at(102), BASE)).not.toBeNull();
  });

  it("fires once a session", () => {
    const prior = windows(96, (to) => (to === 96 ? 12 : 2));
    expect(burst(prior, { from: 96, to: 100, count: 12 }, { burstsSoFar: 1 })).toBeNull();
  });

  it("divides by the span the counted windows cover: a four-minute window half inside the trailing ten minutes no longer inflates the rate", () => {
    // Trailing ten minutes end at 100: the window 88-92 reaches in from before 90.
    const prior = [...windows(84, () => 2), sample(94, 40_000, { from: 84, to: 88, count: 2 }), sample(98, 40_000, { from: 88, to: 92, count: 10 }), sample(102, 40_000, { from: 92, to: 96, count: 10 })];
    const current = { from: at(96), to: at(100), count: 8 };
    const s = session({ clipsTotal: prior.reduce((sum, x) => sum + x.clipsInWindow, 0) });
    const phase16 = clipRate(s, prior, current, BASE)!;
    const exact = clipRate(s, prior, current, BASE, { exactSpan: true })!;
    expect(phase16.trailingClips).toBe(28);
    expect(phase16.trailingHours * 60).toBeCloseTo(10, 5);
    expect(exact.trailingHours * 60).toBeCloseTo(12, 5);
    expect(exact.trailingPerHour).toBeCloseTo(140, 5);
    expect(phase16.trailingPerHour).toBeCloseTo(168, 5);
  });
});

describe("the usual clips per stream hour", () => {
  it("is the median of the per-session metric once five sessions exist", () => {
    expect(usualClipsPerHour([50, 40, 60, 45], Q)).toBeNull();
    expect(usualClipsPerHour([50, 40, 60, 45, 55], Q)).toBe(50);
  });
});

describe("the moment's signal", () => {
  it("says what the smoothed surge compared and carries the rule in the payload", () => {
    const moment: LiveMoment = { moment: "audience_surge", direction: 1, confidence: 0.35, magnitude: 0.305, windowMinutes: 60, from: 40_050, to: 52_250, rationale: "r", rule: "quality" };
    const signal = liveMomentSignal(kai, session(), moment, at(112), "twitch");
    expect(signal.headline).toBe("Kai Cenat's live audience is up 31% on the half hour before: 52,250 viewers against 40,050 30 to 60 minutes earlier, 1h 52m into the stream.");
    expect(signal.rawPayload).toMatchObject({ kind: "live_moment", moment: "audience_surge", rule: "quality", confidence: 0.35 });
    const phase16 = liveMomentSignal(kai, session(), { ...moment, rule: undefined, windowMinutes: 10 }, at(112), "twitch");
    expect(phase16.rawPayload).not.toHaveProperty("rule");
    expect(phase16.headline).toContain("in the last 10 minutes");
  });
});
