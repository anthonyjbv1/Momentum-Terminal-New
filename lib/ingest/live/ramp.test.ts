import { describe, expect, it } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";

import { ASMONGOLD_1008, fixtureSamples, KAI_0926, KAI_1001_RECORD, KAI_1009, SESSION_FIXTURES, type SessionFixture } from "./__fixtures__/sessions";
import { DEFAULT_LIVE_CONFIG, liveMomentSignal, rampUpMoment, readLiveConfig, typicalSessionPeak, type LiveConfig, type LiveMoment, type LiveSession } from "./rules";

/**
 * THE RAMP-UP REPLAY (TWITCH_RAMP_UP_ENABLED, 2026-10-09), over the four
 * sessions production stored in the thirty days to 10-09: Kai Cenat's 09-26,
 * his record stream of 10-01, his 10-09, and Asmongold's 10-08. Each is
 * replayed as production would judge it on the day, against the typical
 * session peak the ledger held THEN (the session_peak_viewers snapshots
 * written before the session opened), live (nothing: the rule did not exist)
 * against on.
 */

const CONFIG: LiveConfig = readLiveConfig({ live: { enabled: true } })!;
const kai = makePerson({ id: "p-kai", slug: "kai-cenat", display_name: "Kai Cenat" });

/** The session_peak_viewers ledger as the closed sessions wrote it, oldest first; only complete sessions write one. */
const PEAK_LEDGER = SESSION_FIXTURES.filter((f) => f.complete).map((f) => ({ slug: f.slug, recordedAt: new Date(f.endedAt), value: f.viewerPeak }));

/** The peaks the ledger held for a person when a session opened. */
function peaksBefore(fixture: SessionFixture): number[] {
  const opened = new Date(fixture.startedAt).getTime();
  return PEAK_LEDGER.filter((row) => row.slug === fixture.slug && row.recordedAt.getTime() < opened).map((row) => row.value);
}

function session(fixture: SessionFixture): Pick<LiveSession, "startedAt"> {
  return { startedAt: new Date(fixture.startedAt) };
}

/** Every firing of the ramp-up over a session's ledger, judged sample by sample as the runner would. */
function replay(fixture: SessionFixture, config: LiveConfig = CONFIG): Array<{ at: Date; secondsIn: number; moment: LiveMoment }> {
  const samples = fixtureSamples(fixture);
  const typicalPeak = typicalSessionPeak(peaksBefore(fixture), config);
  const firings: Array<{ at: Date; secondsIn: number; moment: LiveMoment }> = [];
  samples.forEach((current, index) => {
    const moment = rampUpMoment(session(fixture), samples.slice(0, index), current, { typicalPeak, rampsSoFar: firings.length }, config);
    if (moment) firings.push({ at: current.sampledAt, secondsIn: (current.sampledAt.getTime() - new Date(fixture.startedAt).getTime()) / 1000, moment });
  });
  return firings;
}

describe("the typical session peak", () => {
  it("is the median of the newest complete sessions' peaks with the single highest left out, once three exist, and null before (revised 2026-10-09)", () => {
    expect(typicalSessionPeak([], CONFIG)).toBeNull();
    expect(typicalSessionPeak([48_370], CONFIG)).toBeNull();
    expect(typicalSessionPeak([48_370, 690_631], CONFIG)).toBeNull();
    // Three: the record is left out, the median of the other two.
    expect(typicalSessionPeak([48_370, 690_631, 182_938], CONFIG)).toBe((48_370 + 182_938) / 2);
    expect(typicalSessionPeak([48_370, 690_631, 182_938, 60_000], CONFIG)).toBe(60_000);
    // The newest rampSessions only; zeros and non-numbers are not peaks; below the minimum, nothing.
    expect(typicalSessionPeak([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100, 10, 30, 20], { ...CONFIG, rampSessions: 3 })).toBe(15);
    expect(typicalSessionPeak([0, Number.NaN, 48_370, 50_000, 52_000], CONFIG)).toBe(49_185);
    // The minimum relaxed to two: the highest is still left out.
    expect(typicalSessionPeak([48_370, 690_631], { ...CONFIG, rampMinSessions: 2 })).toBe(48_370);
    expect(typicalSessionPeak([48_370], { ...CONFIG, rampMinSessions: 1 })).toBe(48_370);
  });
});

describe("the ramp-up, replayed on the four stored sessions (revised rule: three past sessions, the highest left out)", () => {
  it("is silent on every stored session under the three-session minimum: 09-26 and 10-01 had one past session at most, 10-09 two, Asmongold none", () => {
    expect(peaksBefore(KAI_0926)).toEqual([]);
    expect(peaksBefore(KAI_1001_RECORD)).toEqual([48_370]);
    expect(peaksBefore(KAI_1009)).toEqual([48_370, 690_631]);
    expect(peaksBefore(ASMONGOLD_1008)).toEqual([]);
    for (const fixture of SESSION_FIXTURES) expect(replay(fixture)).toEqual([]);
  });

  it("with the minimum at two, 10-09 fires at 00:12:39, twelve minutes in: 109,607 then 182,938 against a typical of 48,370 (the record left out), 2.3× at confidence 0.306", () => {
    const relaxed = { ...CONFIG, rampMinSessions: 2 };
    const firings = replay(KAI_1009, relaxed);
    expect(firings).toHaveLength(1);
    expect(firings[0].at.toISOString()).toBe("2026-10-09T00:12:39.000Z");
    expect(firings[0].secondsIn).toBe(747);
    expect(firings[0].moment).toMatchObject({ moment: "ramp_up", direction: 1, confidence: 0.306, magnitude: 2.266, from: 48_370, to: 182_938, windowMinutes: 4, rule: "ramp" });
    expect(firings[0].moment.rationale).toBe("audience 109,607 then 182,938 (12 min in) against a typical session peak of 48,370: 2.3×, threshold 1.5×");
    // The record stream still fires at 03:11:38 once its one past session counts (the minimum at one), and still twelve minutes before the live surge.
    const record = replay(KAI_1001_RECORD, { ...CONFIG, rampMinSessions: 1 });
    expect(record.map((f) => f.at.toISOString())).toEqual(["2026-10-01T03:11:38.000Z"]);
    expect(record[0].moment).toMatchObject({ magnitude: 8.229, confidence: 1 });
    expect(Math.round((new Date(KAI_1001_RECORD.liveSurgeAt!).getTime() - record[0].at.getTime()) / 60_000)).toBe(12);
    // 09-26 and Asmongold stay silent at any minimum: no past session at all.
    expect(replay(KAI_0926, { ...CONFIG, rampMinSessions: 1 })).toEqual([]);
    expect(replay(ASMONGOLD_1008, { ...CONFIG, rampMinSessions: 1 })).toEqual([]);
  });

  it("never fires on a normal-sized session: a stream that peaks at 1.4× the typical stays under the multiple, with three past sessions on the record", () => {
    const start = new Date("2026-10-12T00:00:00.000Z");
    const typical = typicalSessionPeak([100_000, 95_000, 300_000], CONFIG)!;
    expect(typical).toBe(97_500);
    const samples = Array.from({ length: 30 }, (_, i) => ({ sampledAt: new Date(start.getTime() + i * 120_000), viewerCount: Math.round(Math.min(1.4, 0.1 * i) * typical) }));
    const firings = samples.map((current, index) => rampUpMoment({ startedAt: start }, samples.slice(0, index), current, { typicalPeak: typical, rampsSoFar: 0 }, CONFIG)).filter(Boolean);
    expect(firings).toEqual([]);
    // 1.6× for two readings: a ramp.
    const big = [...samples, { sampledAt: new Date(start.getTime() + 30 * 120_000), viewerCount: Math.round(1.6 * typical) }, { sampledAt: new Date(start.getTime() + 31 * 120_000), viewerCount: Math.round(1.6 * typical) }];
    expect(rampUpMoment({ startedAt: start }, big.slice(0, -1), big.at(-1)!, { typicalPeak: typical, rampsSoFar: 0 }, CONFIG)).toMatchObject({ magnitude: 1.6 });
  });
});

describe("the ramp-up rule", () => {
  const start = new Date("2026-10-12T00:00:00.000Z");
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  const sample = (minutes: number, viewerCount: number | null) => ({ sampledAt: at(minutes), viewerCount });

  it("needs two consecutive positive readings over the multiple: one is not a ramp, and a 0 or missing reading is never counted either way", () => {
    const ctx = { typicalPeak: 48_370, rampsSoFar: 0 };
    // One reading over: nothing.
    expect(rampUpMoment({ startedAt: start }, [sample(0, 0), sample(2, 62_192)], sample(4, 398_044), ctx, CONFIG)).toBeNull();
    // The second: fires.
    expect(rampUpMoment({ startedAt: start }, [sample(0, 0), sample(2, 62_192), sample(4, 398_044)], sample(6, 398_044), ctx, CONFIG)).toMatchObject({ moment: "ramp_up", magnitude: 8.229 });
    // A 0 between two readings over the multiple neither counts nor breaks the pair (the neutral go-live rule).
    expect(rampUpMoment({ startedAt: start }, [sample(0, 398_044), sample(2, 0)], sample(4, 398_044), ctx, CONFIG)).toMatchObject({ moment: "ramp_up", windowMinutes: 4 });
    expect(rampUpMoment({ startedAt: start }, [sample(0, 398_044), sample(2, null)], sample(4, 398_044), ctx, CONFIG)).toMatchObject({ moment: "ramp_up" });
    // The current reading 0 or missing: never judged.
    expect(rampUpMoment({ startedAt: start }, [sample(0, 398_044), sample(2, 398_044)], sample(4, 0), ctx, CONFIG)).toBeNull();
    expect(rampUpMoment({ startedAt: start }, [sample(0, 398_044), sample(2, 398_044)], sample(4, null), ctx, CONFIG)).toBeNull();
  });

  it("fires once a session, needs a typical peak, and reads confidence from the multiple to the full multiple on the smaller of the two readings", () => {
    const prior = [sample(0, 100_000)];
    expect(rampUpMoment({ startedAt: start }, prior, sample(2, 100_000), { typicalPeak: 48_370, rampsSoFar: 1 }, CONFIG)).toBeNull();
    expect(rampUpMoment({ startedAt: start }, prior, sample(2, 100_000), { typicalPeak: null, rampsSoFar: 0 }, CONFIG)).toBeNull();
    // 1.5× is confidence 0, 4× is 1, 2.75× is 0.5; the smaller reading sets it.
    expect(rampUpMoment({ startedAt: start }, [sample(0, 150_000)], sample(2, 400_000), { typicalPeak: 100_000, rampsSoFar: 0 }, CONFIG)).toBeNull();
    expect(rampUpMoment({ startedAt: start }, [sample(0, 150_001)], sample(2, 400_000), { typicalPeak: 100_000, rampsSoFar: 0 }, CONFIG)).toMatchObject({ confidence: 0, magnitude: 1.5 });
    expect(rampUpMoment({ startedAt: start }, [sample(0, 400_000)], sample(2, 275_000), { typicalPeak: 100_000, rampsSoFar: 0 }, CONFIG)).toMatchObject({ confidence: 0.5, magnitude: 2.75 });
    expect(rampUpMoment({ startedAt: start }, [sample(0, 400_000)], sample(2, 900_000), { typicalPeak: 100_000, rampsSoFar: 0 }, CONFIG)).toMatchObject({ confidence: 1, magnitude: 4 });
  });

  it("has its thresholds on the live block with defaults, and writes its signal as a live moment the prescored scorer reads", () => {
    expect(DEFAULT_LIVE_CONFIG).toMatchObject({ rampMultiple: 1.5, rampFullMultiple: 4, rampMinSessions: 3, rampSessions: 10 });
    expect(readLiveConfig({ live: { enabled: true, ramp_multiple: 2, ramp_min_sessions: 3 } })).toMatchObject({ rampMultiple: 2, rampMinSessions: 3, rampFullMultiple: 4 });
    const moment = rampUpMoment({ startedAt: start }, [sample(0, 398_044)], sample(2, 398_044), { typicalPeak: 48_370, rampsSoFar: 0 }, CONFIG)!;
    const liveSession = { startedAt: start, streamId: "319414213079", channel: "kaicenat" } as LiveSession;
    const signal = liveMomentSignal(kai, liveSession, moment, at(2), "twitch");
    expect(signal.headline).toBe("Kai Cenat's stream is already 8.2× their usual peak: 398,044 viewers against a typical session peak of 48,370, 2m into the stream.");
    expect(signal.dedupeKey).toBe(`twitch:live:319414213079:ramp_up:${at(2).toISOString()}`);
    expect(signal.rawPayload).toMatchObject({ kind: "live_moment", moment: "ramp_up", direction: 1, confidence: 1, magnitude: 8.229, from: 48_370, to: 398_044, rule: "ramp", minutes_into_stream: 2 });
  });
});
