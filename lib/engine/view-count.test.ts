import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG, describeEngineOverrides, engineConfigFromEnv } from "./config";
import { followerGrowthDayStates, tuneFollowerGrowth } from "./follower-growth";
import type { EngineSignal, ScoredSignal } from "./types";

/**
 * THE VIEW TUNE (VIEW_COUNT_TUNE_ENABLED, 2026-10-14), replayed over the
 * thirty days to 2026-10-13 23:51 UTC: every view_count firing as production
 * scored it (sigma and impact from the stored signals), live against tuned,
 * per firing, tick by tick as the day's state would have been read back.
 * MrBeast's forty-one firings and the three streamers' ten. Every firing in
 * the window went upward; the tune's lull rule never applies here.
 */

const CONFIG = { ...DEFAULT_ENGINE_CONFIG.viewCount, enabled: true };

const FIRINGS: Record<string, Array<[at: string, sigma: number, impact: number]>> = {
  mrbeast: [
    ["2026-09-16T05:00:29.888Z", 2.88, 1.152],
    ["2026-09-16T18:00:30.354Z", 3.5, 1.3995],
    ["2026-09-17T05:00:28.603Z", 4.3, 1.5],
    ["2026-09-17T18:15:29.471Z", 1.79, 0.7155],
    ["2026-09-18T04:15:29.277Z", 2.69, 1.0755],
    ["2026-09-18T16:15:29.402Z", 3.41, 1.3635],
    ["2026-09-19T05:15:29.342Z", 4.39, 1.5],
    ["2026-09-19T08:15:29.564Z", 1.09, 0.4365],
    ["2026-09-19T19:15:29.763Z", 2.22, 0.888],
    ["2026-09-20T02:15:29.568Z", 5.44, 1.5],
    ["2026-09-21T14:15:29.352Z", 8.9, 1.5],
    ["2026-09-22T06:15:29.523Z", 3.08, 1.2315],
    ["2026-09-23T03:15:29.446Z", 2.14, 0.8565],
    ["2026-09-23T18:15:29.53Z", 2.47, 0.9885],
    ["2026-09-24T21:15:30.691Z", 2.18, 0.8715],
    ["2026-09-25T11:15:29.291Z", 2.98, 1.1925],
    ["2026-09-25T16:15:29.406Z", 2.26, 0.9045],
    ["2026-09-26T06:15:29.551Z", 2.83, 1.1325],
    ["2026-09-27T08:15:29.675Z", 3.55, 1.4205],
    ["2026-09-29T05:15:29.384Z", 8.84, 1.5],
    ["2026-09-30T07:15:29.363Z", 6.08, 1.5],
    ["2026-10-01T06:15:29.547Z", 2.41, 0.9645],
    ["2026-10-01T17:15:29.598Z", 2.22, 0.888],
    ["2026-10-02T04:15:29.347Z", 2.35, 0.9405],
    ["2026-10-02T16:15:31.176Z", 2.26, 0.9045],
    ["2026-10-03T02:15:29.558Z", 2.57, 1.0275],
    ["2026-10-03T15:15:29.544Z", 2.23, 0.8925],
    ["2026-10-04T02:15:29.987Z", 3.37, 1.3485],
    ["2026-10-04T14:15:29.26Z", 5.23, 1.5],
    ["2026-10-05T05:15:29.54Z", 5.07, 1.5],
    ["2026-10-05T16:15:29.539Z", 2.26, 0.9045],
    ["2026-10-06T15:15:29.73Z", 4.9, 1.5],
    ["2026-10-07T15:15:29.702Z", 4.54, 1.5],
    ["2026-10-08T16:15:29.381Z", 4.75, 1.5],
    ["2026-10-09T20:15:29.49Z", 4.24, 1.5],
    ["2026-10-10T07:15:29.279Z", 4.49, 1.5],
    ["2026-10-10T15:15:29.71Z", 3.15, 1.26],
    ["2026-10-11T19:15:29.548Z", 5.7, 1.5],
    ["2026-10-12T04:15:29.562Z", 2.77, 1.1085],
    ["2026-10-12T11:15:29.284Z", 2.02, 0.8085],
    ["2026-10-13T21:15:29.326Z", 5.9, 1.5],
  ],
  asmongold: [
    ["2026-10-11T19:15:29.548Z", 7.25, 1.5],
    ["2026-10-13T16:15:29.309Z", 4.67, 1.5],
  ],
  caedrel: [
    ["2026-10-10T07:15:29.279Z", 4.02, 1.5],
    ["2026-10-10T15:15:29.71Z", 3, 1.2],
    ["2026-10-11T19:15:29.548Z", 7.87, 1.5],
    ["2026-10-12T12:15:29.319Z", 3.33, 1.332],
    ["2026-10-13T17:15:30.254Z", 4.12, 1.5],
  ],
  jynxzi: [
    ["2026-10-10T14:15:29.39Z", 2.19, 0.876],
    ["2026-10-11T17:15:29.996Z", 6.44, 1.5],
    ["2026-10-13T22:15:29.595Z", 6.81, 1.5],
  ],
};

function firing(person: string, id: string, at: string, sigma: number, impact: number): ScoredSignal {
  const signal: EngineSignal = { id, personId: person, headline: "x", rawPayload: { kind: "metric", metric: "view_count", sigma, direction: 1, polarity: 1, scale: 0.8 }, sourceName: "youtube", sourceTier: 2, occurredAt: new Date(at), createdAt: new Date(at) };
  return { signal, sentiment: { label: "positive", direction: 1, confidence: 1 }, impact, ageHours: 0, freshness: 1, volumeWeight: 1 };
}

interface Replayed {
  at: string;
  sigma: number;
  live: number;
  tuned: number;
  why: string | null;
}

/** Each firing in its own tick, the day's state read back from the earlier ones, as production would. */
function replay(person: string): Replayed[] {
  const out: Replayed[] = [];
  let processed: ScoredSignal[] = [];
  FIRINGS[person].forEach(([at, sigma, impact], index) => {
    const entry = firing(person, `${person}-${index}`, at, sigma, impact);
    const today = followerGrowthDayStates(
      processed.map((p) => ({ person_id: person, impact_score: p.impact, occurred_at: p.signal.occurredAt.toISOString(), sigma: (p.signal.rawPayload as { sigma: number }).sigma })),
      new Set([person]),
      entry.signal.occurredAt,
    ).get(person);
    const [tuned] = tuneFollowerGrowth([entry], today, CONFIG, "viewCount");
    processed = [...processed, tuned];
    out.push({ at, sigma, live: entry.impact, tuned: tuned.impact, why: tuned.viewCount?.zeroBecause ?? null });
  });
  return out;
}

const sum = (rows: Replayed[], key: "live" | "tuned") => Math.round(rows.reduce((total, row) => total + row[key], 0) * 10_000) / 10_000;

describe("the view tune, replayed over the thirty days to 2026-10-13", () => {
  it("MrBeast: forty-one firings, 49.18 live points become 20.25: one capped reading a day, a second pass of the same day given nothing", () => {
    const rows = replay("mrbeast");
    expect(rows).toHaveLength(41);
    expect(sum(rows, "live")).toBe(49.176);
    expect(sum(rows, "tuned")).toBe(20.25);
    // Twenty-seven UTC days fired at least once; each pays its peak reading, capped at 0.75 (every live reading is above the cap); no day pays more.
    const byDay = new Map<string, number>();
    for (const row of rows) byDay.set(row.at.slice(0, 10), (byDay.get(row.at.slice(0, 10)) ?? 0) + row.tuned);
    expect(byDay.size).toBe(27);
    expect([...byDay.values()].every((points) => points === 0.75)).toBe(true);
    // 09-19, the three-pass day: the 05:15 pass at 4.39σ takes the day; 08:15 at 1.09σ and 19:15 at 2.22σ are not the peak.
    expect(rows.slice(6, 9)).toEqual([
      { at: "2026-09-19T05:15:29.342Z", sigma: 4.39, live: 1.5, tuned: 0.75, why: null },
      { at: "2026-09-19T08:15:29.564Z", sigma: 1.09, live: 0.4365, tuned: 0, why: "not_the_peak" },
      { at: "2026-09-19T19:15:29.763Z", sigma: 2.22, live: 0.888, tuned: 0, why: "not_the_peak" },
    ]);
    // 09-16, where the second pass is the larger: the day moves to 0.75 on the first pass already (1.152 capped), the second adds nothing more.
    expect(rows.slice(0, 2)).toEqual([
      { at: "2026-09-16T05:00:29.888Z", sigma: 2.88, live: 1.152, tuned: 0.75, why: null },
      { at: "2026-09-16T18:00:30.354Z", sigma: 3.5, live: 1.3995, tuned: 0, why: "day_already_given" },
    ]);
    // Fourteen second or third passes of a day already given: ten smaller than the day's peak, four larger but the day already at its ceiling.
    expect(rows.filter((row) => row.why === "not_the_peak")).toHaveLength(10);
    expect(rows.filter((row) => row.why === "day_already_given")).toHaveLength(4);
  });

  it("the three streamers: every day's single firing pays its reading capped at 0.75, a second pass of the same day nothing", () => {
    const asmongold = replay("asmongold");
    expect(asmongold.map((row) => row.tuned)).toEqual([0.75, 0.75]);
    expect(sum(asmongold, "live")).toBe(3);
    expect(sum(asmongold, "tuned")).toBe(1.5);

    const caedrel = replay("caedrel");
    expect(caedrel).toEqual([
      { at: "2026-10-10T07:15:29.279Z", sigma: 4.02, live: 1.5, tuned: 0.75, why: null },
      { at: "2026-10-10T15:15:29.71Z", sigma: 3, live: 1.2, tuned: 0, why: "not_the_peak" },
      { at: "2026-10-11T19:15:29.548Z", sigma: 7.87, live: 1.5, tuned: 0.75, why: null },
      { at: "2026-10-12T12:15:29.319Z", sigma: 3.33, live: 1.332, tuned: 0.75, why: null },
      { at: "2026-10-13T17:15:30.254Z", sigma: 4.12, live: 1.5, tuned: 0.75, why: null },
    ]);
    expect(sum(caedrel, "live")).toBe(7.032);
    expect(sum(caedrel, "tuned")).toBe(3);

    const jynxzi = replay("jynxzi");
    expect(jynxzi.map((row) => row.tuned)).toEqual([0.75, 0.75, 0.75]);
    expect(sum(jynxzi, "live")).toBe(3.876);
    expect(sum(jynxzi, "tuned")).toBe(2.25);
  });

  it("records its working under its own key, leaves the follower tune's metric alone, and reads only the exact switch", () => {
    const view = firing("p", "v", "2026-10-12T10:00:00Z", 3, 1.5);
    const [tuned] = tuneFollowerGrowth([view], null, CONFIG, "viewCount");
    expect(tuned.viewCount).toMatchObject({ sigma: 3, scored: 1.5, reading: 0.75, delta: 0.75, zeroBecause: null });
    expect(tuned.followerGrowth).toBeUndefined();
    const follower = firing("p", "f", "2026-10-12T10:00:00Z", 3, 1.5);
    follower.signal.rawPayload = { kind: "metric", metric: "follower_count", sigma: 3, direction: 1, polarity: 1, scale: 1 };
    expect(tuneFollowerGrowth([follower], null, CONFIG, "viewCount")).toEqual([follower]);
    expect(engineConfigFromEnv({ viewCountTuneEnabled: "true" }).viewCount).toEqual({ enabled: true, metric: "view_count", ceilingPoints: 0.75 });
    for (const raw of [undefined, "", "TRUE", "1", "false"]) expect(engineConfigFromEnv({ viewCountTuneEnabled: raw }).viewCount.enabled).toBe(false);
    expect(describeEngineOverrides(engineConfigFromEnv({ viewCountTuneEnabled: "true" }))).toEqual(["viewCount.enabled = true (default false)"]);
    expect(DEFAULT_ENGINE_CONFIG.viewCount.enabled).toBe(false);
  });
});
