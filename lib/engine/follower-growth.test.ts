import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG, engineConfigFromEnv } from "./config";
import { followerGrowthDayStates, readFollowerGrowth, tuneFollowerGrowth } from "./follower-growth";
import type { EngineSignal, ScoredSignal } from "./types";

/**
 * THE FOLLOWER TUNE (FOLLOWER_TUNE_ENABLED), replayed over Kai Cenat's
 * thirty days to 2026-10-09: every follower_count firing as production
 * scored it (sigma and impact from the stored signals), live against tuned,
 * per firing.
 */

const CONFIG = { ...DEFAULT_ENGINE_CONFIG.followerGrowth, enabled: true };

const KAI_FIRINGS = [
  { at: "2026-09-18T10:15:29.846Z", sigma: 1.13, impact: 0.5655 },
  { at: "2026-09-21T08:15:29.393Z", sigma: 11.06, impact: 1.5 },
  { at: "2026-09-30T21:15:29.650Z", sigma: 2.73, impact: 1.365 },
  { at: "2026-09-30T22:15:30.307Z", sigma: 9.16, impact: 1.5 },
  { at: "2026-10-09T00:15:29.556Z", sigma: 2.56, impact: 1.2795 },
  { at: "2026-10-09T01:15:29.802Z", sigma: 12.01, impact: 1.5 },
  { at: "2026-10-09T18:15:29.751Z", sigma: 3.08, impact: 1.5 },
];

function firing(id: string, at: string, sigma: number, impact: number): ScoredSignal {
  const signal: EngineSignal = { id, personId: "p-kai", headline: "x", rawPayload: { kind: "metric", metric: "follower_count", sigma, direction: 1, polarity: 1, scale: 1 }, sourceName: "twitch", sourceTier: 2, occurredAt: new Date(at), createdAt: new Date(at) };
  return { signal, sentiment: { label: "positive", direction: 1, confidence: 1 }, impact, ageHours: 0, freshness: 1, volumeWeight: 1 };
}

describe("the follower tune, replayed over Kai Cenat's thirty days", () => {
  it("live 9.21 points become 2.82: one capped reading a day, the second half of each pair adds only what the first had not, the evening firing of a day already given nothing", () => {
    const scored = KAI_FIRINGS.map((f, i) => firing(`f${i}`, f.at, f.sigma, f.impact));
    // Each firing arrived in its own tick with the day's state read back from the earlier ones: replay tick by tick.
    const perFiring: Array<{ at: string; sigma: number; live: number; tuned: number; why: string | null }> = [];
    let processed: ScoredSignal[] = [];
    for (const entry of scored) {
      const today = followerGrowthDayStates(
        processed.map((p) => ({ person_id: "p-kai", impact_score: p.impact, occurred_at: p.signal.occurredAt.toISOString(), sigma: (p.signal.rawPayload as { sigma: number }).sigma })),
        new Set(["p-kai"]),
        entry.signal.occurredAt,
      ).get("p-kai");
      const [tuned] = tuneFollowerGrowth([entry], today, CONFIG);
      processed = [...processed, tuned];
      perFiring.push({ at: entry.signal.occurredAt.toISOString(), sigma: (entry.signal.rawPayload as { sigma: number }).sigma, live: entry.impact, tuned: tuned.impact, why: tuned.followerGrowth?.zeroBecause ?? null });
    }
    expect(perFiring).toEqual([
      { at: "2026-09-18T10:15:29.846Z", sigma: 1.13, live: 0.5655, tuned: 0.5655, why: null },
      { at: "2026-09-21T08:15:29.393Z", sigma: 11.06, live: 1.5, tuned: 0.75, why: null },
      { at: "2026-09-30T21:15:29.650Z", sigma: 2.73, live: 1.365, tuned: 0.75, why: null },
      { at: "2026-09-30T22:15:30.307Z", sigma: 9.16, live: 1.5, tuned: 0, why: "day_already_given" },
      { at: "2026-10-09T00:15:29.556Z", sigma: 2.56, live: 1.2795, tuned: 0.75, why: null },
      { at: "2026-10-09T01:15:29.802Z", sigma: 12.01, live: 1.5, tuned: 0, why: "day_already_given" },
      { at: "2026-10-09T18:15:29.751Z", sigma: 3.08, live: 1.5, tuned: 0, why: "not_the_peak" },
    ]);
    const live = perFiring.reduce((sum, f) => sum + f.live, 0);
    const tuned = perFiring.reduce((sum, f) => sum + f.tuned, 0);
    expect(Math.round(live * 100) / 100).toBe(9.21);
    expect(Math.round(tuned * 1000) / 1000).toBe(2.816);
  });

  it("is upward only, capped per firing and per day, peak-only, and a smaller later reading of a day never subtracts", () => {
    const day = (sigma: number, scored: number, at: string, state: ReturnType<typeof readFollowerGrowth>["day"] | null) => readFollowerGrowth({ sigma, scored, at: new Date(at) }, state, CONFIG);
    // A lull: nothing, the day untouched.
    const lull = day(-2.5, -0.9, "2026-10-12T10:00:00Z", null);
    expect(lull.detail).toMatchObject({ reading: 0, delta: 0, zeroBecause: "lull" });
    expect(lull.day.peakSigma).toBe(Number.NEGATIVE_INFINITY);
    // A first firing of 0.4 points at 2.1σ: 0.4; a 3σ firing later at 1.5 scored: the day moves to 0.75, delta 0.35.
    const first = day(2.1, 0.4, "2026-10-12T10:00:00Z", null);
    expect(first.detail).toMatchObject({ reading: 0.4, delta: 0.4 });
    const second = day(3, 1.5, "2026-10-12T14:00:00Z", first.day);
    expect(second.detail).toMatchObject({ reading: 0.75, delta: 0.35, dayBefore: { peakSigma: 2.1, applied: 0.4 } });
    expect(second.day).toEqual({ day: "2026-10-12", peakSigma: 3, applied: 0.75 });
    // A later firing at the peak with a smaller scored impact: never negative.
    const smaller = day(3, 0.5, "2026-10-12T16:00:00Z", second.day);
    expect(smaller.detail).toMatchObject({ reading: 0.5, delta: 0, zeroBecause: "day_already_given" });
    // The next UTC day starts clean.
    const next = day(2.2, 1.5, "2026-10-13T00:15:00Z", second.day);
    expect(next.detail).toMatchObject({ reading: 0.75, delta: 0.75, dayBefore: { peakSigma: null, applied: 0 } });
    // Signals that are not the metric pass through untouched, and the switch reads only the exact string.
    const other = firing("o", "2026-10-12T10:00:00Z", 2, 1);
    other.signal.rawPayload = { kind: "metric", metric: "news_volume_24h", sigma: 2, direction: 1, polarity: 1, scale: 1 };
    expect(tuneFollowerGrowth([other], null, CONFIG)).toEqual([other]);
    expect(engineConfigFromEnv({ followerTuneEnabled: "true" }).followerGrowth.enabled).toBe(true);
    for (const raw of [undefined, "", "TRUE", "1", "false"]) expect(engineConfigFromEnv({ followerTuneEnabled: raw }).followerGrowth.enabled).toBe(false);
  });
});
