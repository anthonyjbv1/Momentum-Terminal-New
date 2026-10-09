import { describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";
import { buildRegistry } from "@/lib/connectors/registry";
import type { DataConnector, LiveStream } from "@/lib/connectors/types";
import type { Json } from "@/types/database";

import { ASMONGOLD_1009, fixtureSamples, KAI_0926, KAI_1001_RECORD, STORED_MOMENTS, type SessionFixture } from "./__fixtures__/sessions";
import { fullFractionFor, LIVE_QUALITY_DEFAULTS, LIVE_TUNE_DEFAULTS, normalSwing, readLiveConfig, tuneMoments, type LiveConfig, type LiveMoment } from "./rules";
import { runLiveMode, type LiveLogLine } from "./runner";
import { createMemoryLiveStore } from "./store";

/**
 * THE LIVE-MOMENT TUNE (LIVE_MOMENT_TUNE_ENABLED, 2026-10-09), replayed two
 * ways: the pure rule over every moment production stored (what each would
 * have scored), and the runner over Asmongold's session of 10-09 under the
 * quality rules, tune on against off.
 *
 * At the Twitch tier and full freshness, one confidence unit is 1.5 points
 * (baseImpact 1.5 × tier multiplier 1.0): the stored impacts read exactly so.
 */

const CONFIG: LiveConfig = readLiveConfig({ live: { enabled: true } })!;
const POINTS_PER_UNIT = 1.5;

function session(fixture: SessionFixture) {
  return { startedAt: new Date(fixture.startedAt), samples: fixtureSamples(fixture) };
}

describe("the channel's normal swing", () => {
  it("reads Kai Cenat's 09-26 ledger at a 3.0% median ten-minute step, and nothing from a session too short to step", () => {
    const swing = normalSwing([session(KAI_0926)], CONFIG)!;
    expect(swing).toBeCloseTo(0.03, 2);
    expect(normalSwing([], CONFIG)).toBeNull();
    expect(normalSwing([{ startedAt: new Date(KAI_0926.startedAt), samples: fixtureSamples(KAI_0926).slice(0, 10) }], CONFIG)).toBeNull();
    // Full confidence on his channel is the floor: ten of his normal swings is 30%, under 50%.
    expect(fullFractionFor(swing, LIVE_TUNE_DEFAULTS)).toBe(0.5);
    expect(fullFractionFor(0.08, LIVE_TUNE_DEFAULTS)).toBe(0.8);
    expect(fullFractionFor(null, LIVE_TUNE_DEFAULTS)).toBe(0.5);
  });
});

/** The stored firings of one stream, replayed through the tune in order, carrying the ledger forward. */
function replayStream(streamId: string, swing: number | null) {
  const stored = STORED_MOMENTS.filter((moment) => moment.streamId === streamId);
  const bySample = new Map<string, typeof stored>();
  for (const moment of stored) bySample.set(moment.at, [...(bySample.get(moment.at) ?? []), moment]);
  let pointsUsed = 0;
  let lastMomentAt: Date | null = null;
  const fired: Array<{ at: string; moment: string; found: number; tuned: number; points: number }> = [];
  for (const [at, group] of bySample) {
    const found: LiveMoment[] = group.map((moment) => ({ moment: moment.moment, direction: 1, confidence: moment.confidence, magnitude: moment.magnitude, windowMinutes: 10, from: moment.from, to: moment.to, rationale: moment.moment }));
    const tuned = tuneMoments(found, { normalSwing: swing, pointsUsed, lastMomentAt: lastMomentAt }, LIVE_TUNE_DEFAULTS, new Date(at));
    if (!tuned) continue;
    fired.push({ at, moment: tuned.moment, found: tuned.tune.foundConfidence, tuned: tuned.confidence, points: Math.round(tuned.confidence * POINTS_PER_UNIT * 1000) / 1000 });
    pointsUsed += tuned.confidence;
    lastMomentAt = new Date(at);
  }
  const before = stored.reduce((sum, moment) => sum + moment.impact, 0);
  const after = fired.reduce((sum, moment) => sum + moment.points, 0);
  return { fired, before: Math.round(before * 1000) / 1000, after: Math.round(after * 1000) / 1000 };
}

describe("the tune, replayed over every stored moment", () => {
  const kaiSwing = normalSwing([session(KAI_0926)], CONFIG);

  it("Kai Cenat's record stream stays strong: the +73% surge at 1.0, the burst in the same sample folded into it; 1.50 points for the stream, from 3.00", () => {
    const record = replayStream(KAI_1001_RECORD.streamId, kaiSwing);
    expect(record.fired).toEqual([{ at: "2026-10-01T03:23:38.252Z", moment: "audience_surge", found: 1, tuned: 1, points: 1.5 }]);
    expect(record.before).toBe(2.999);
    expect(record.after).toBe(1.5);
  });

  it("Kai Cenat's 09-26 stream: the burst at minute 20 wins its sample, the +22% at 72 reads 0.45, the +21% at 106 takes what the cap leaves, the one at 248 nothing; 2.25 points from 4.15", () => {
    const first = replayStream(KAI_0926.streamId, kaiSwing);
    expect(first.fired).toEqual([
      { at: "2026-09-26T11:36:38.172Z", moment: "clip_burst", found: 0.796, tuned: 0.796, points: 1.194 },
      { at: "2026-09-26T12:28:38.296Z", moment: "audience_surge", found: 0.448, tuned: 0.448, points: 0.672 },
      { at: "2026-09-26T13:02:38.375Z", moment: "audience_surge", found: 0.429, tuned: 0.256, points: 0.384 },
    ]);
    expect(first.before).toBe(4.142);
    expect(first.after).toBe(2.25);
  });

  it("Asmongold's +15% today scores small: 0.306 against a full fraction of 50% with no past session, 0.46 points from 1.46", () => {
    const today = replayStream(ASMONGOLD_1009.streamId, null);
    expect(today.fired).toEqual([{ at: "2026-10-09T18:43:38.665Z", moment: "audience_surge", found: 0.971, tuned: 0.306, points: 0.459 }]);
    expect(today.before).toBe(1.456);
    expect(today.after).toBe(0.459);
  });

  it("holds the cooldown and the cap, and a burst or a ramp-up is sized as found", () => {
    const now = new Date("2026-10-12T01:00:00.000Z");
    const surge: LiveMoment = { moment: "audience_surge", direction: 1, confidence: 1, magnitude: 0.2, windowMinutes: 10, from: 100, to: 120, rationale: "surge" };
    const burst: LiveMoment = { moment: "clip_burst", direction: 1, confidence: 0.5, magnitude: 3, windowMinutes: 10, from: 6, to: 18, rationale: "burst" };
    expect(tuneMoments([surge], { normalSwing: null, pointsUsed: 0, lastMomentAt: new Date(now.getTime() - 29 * 60_000) }, LIVE_TUNE_DEFAULTS, now)).toBeNull();
    expect(tuneMoments([surge], { normalSwing: null, pointsUsed: 0, lastMomentAt: new Date(now.getTime() - 30 * 60_000) }, LIVE_TUNE_DEFAULTS, now)).toMatchObject({ confidence: 0.4 });
    expect(tuneMoments([surge], { normalSwing: null, pointsUsed: 1.5, lastMomentAt: null }, LIVE_TUNE_DEFAULTS, now)).toBeNull();
    expect(tuneMoments([surge], { normalSwing: null, pointsUsed: 1.3, lastMomentAt: null }, LIVE_TUNE_DEFAULTS, now)).toMatchObject({ confidence: 0.2, tune: { pointsUsed: 1.3, pointsAfter: 1.5 } });
    // The burst keeps its own confidence and wins the sample over a small surge.
    expect(tuneMoments([surge, burst], { normalSwing: null, pointsUsed: 0, lastMomentAt: null }, LIVE_TUNE_DEFAULTS, now)).toMatchObject({ moment: "clip_burst", confidence: 0.5, tune: { chosenOf: 2 } });
    // A volatile channel: full confidence rises with its normal swing.
    expect(tuneMoments([surge], { normalSwing: 0.1, pointsUsed: 0, lastMomentAt: null }, LIVE_TUNE_DEFAULTS, now)).toMatchObject({ confidence: 0.2, tune: { fullFraction: 1 } });
    expect(tuneMoments([], { normalSwing: null, pointsUsed: 0, lastMomentAt: null }, LIVE_TUNE_DEFAULTS, now)).toBeNull();
  });
});

describe("the tune through the runner: Asmongold's session of 10-09 under the quality rules", () => {
  const asmon = makePerson({ id: "p-asmon", slug: "asmongold", display_name: "Asmongold" });
  const source = makeSource({ id: "src-twitch", name: "twitch", display_name: "Twitch", is_active: true, config: { live: { enabled: true, sample_interval_minutes: 4 } } as Json });

  function connector(streams: Map<string, LiveStream | null>): DataConnector {
    return {
      name: "twitch",
      async fetchForPerson() {
        return [];
      },
      live: {
        async detect(identifiers) {
          return identifiers.map((externalIdentifier) => ({ externalIdentifier, stream: streams.get(externalIdentifier) ?? null }));
        },
        async countClips() {
          return { count: 0, truncated: false, requests: 1 };
        },
        liveSignal(person, live, now) {
          return { headline: `${person.display_name} went live`, occurredAt: live.startedAt ?? now, dedupeKey: `twitch:stream:${live.id}`, rawPayload: { kind: "stream", stream_id: live.id } };
        },
      },
    };
  }

  async function replay(tune: boolean) {
    const started = new Date(ASMONGOLD_1009.startedAt);
    const streams = new Map<string, LiveStream | null>();
    const store = createMemoryLiveStore({ sources: [source], mappings: { "src-twitch": [{ person: asmon, externalIdentifier: "zackrawrr" }] } });
    const registry = buildRegistry([connector(streams)]);
    const lines: LiveLogLine[] = [];
    for (const sample of fixtureSamples(ASMONGOLD_1009)) {
      streams.set("zackrawrr", { id: ASMONGOLD_1009.streamId, broadcasterId: "b-asmon", channel: "zackrawrr", title: "x", category: null, viewerCount: sample.viewerCount, startedAt: started });
      await runLiveMode({ store, registry, now: sample.sampledAt, log: (line) => lines.push(line), quality: LIVE_QUALITY_DEFAULTS, tune: tune ? LIVE_TUNE_DEFAULTS : false, rampUp: false });
    }
    return { moments: store.ingest.signals.filter((s) => s.rawPayload.kind === "live_moment").map((s) => ({ at: s.occurredAt.toISOString(), payload: s.rawPayload as Record<string, unknown> })), lines };
  }

  it("off: the +15% surge fires at 18:43 as the quality rules find it; on: the same moment sized against the floor, and nothing else changes", async () => {
    const off = await replay(false);
    const on = await replay(true);
    expect(off.moments).toHaveLength(1);
    const found = off.moments[0].payload as { moment: string; confidence: number; magnitude: number; to: number; rule: string };
    // The fixture's whole-second timestamps shift the step read by one sample against production's (0.971 at +15.3%); the shape is the same: a step in the teens read near full confidence.
    expect(off.moments[0].at.startsWith("2026-10-09T18:43:")).toBe(true);
    expect(found).toMatchObject({ moment: "audience_surge", to: 32_282, rule: "quality" });
    expect(found.magnitude).toBeGreaterThan(0.12);
    expect(found.magnitude).toBeLessThan(0.16);
    expect(found.confidence).toBeGreaterThan(0.7);
    expect(on.moments).toHaveLength(1);
    const tuned = on.moments[0].payload as { confidence: number; magnitude: number; tune: Record<string, unknown> };
    expect(on.moments[0].at).toBe(off.moments[0].at);
    expect(tuned.confidence).toBe(Math.round((found.magnitude / 0.5) * 1000) / 1000);
    expect(tuned.confidence).toBeLessThan(0.32);
    expect(tuned.tune).toMatchObject({ normalSwing: null, fullFraction: 0.5, foundConfidence: found.confidence, pointsUsed: 0, chosenOf: 1 });
    const { tune: _tune, confidence: _c, rationale: _r, ...onRest } = on.moments[0].payload;
    const { confidence: _c2, rationale: _r2, ...offRest } = off.moments[0].payload;
    expect(onRest).toEqual(offRest);
    const judged = on.lines.find((line) => line.event === "sample" && line.tune !== undefined);
    expect(judged?.tune).toMatchObject({ found: [{ moment: "audience_surge", confidence: found.confidence }], normalSwing: null, pointsUsed: 0, fired: { moment: "audience_surge", confidence: tuned.confidence } });
    expect(off.lines.every((line) => line.tune === undefined)).toBe(true);
  });
});
