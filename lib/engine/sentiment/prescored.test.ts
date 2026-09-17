import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "../config";
import { LIVE_MOMENT_KIND, PrescoredScorer, isPrescoredSignal, prescoredScorer, readPrescoredPayload } from "./prescored";

const input = (rawPayload: Record<string, unknown> | null, headline = "Kai Cenat's live audience is up 24% in ten minutes") => ({
  id: "s1",
  personId: "p1",
  headline,
  rawPayload: rawPayload as never,
  sourceName: "twitch",
  sourceTier: 2,
});

describe("PrescoredScorer (Phase 16)", () => {
  it("recognises a live moment by its kind, well-formed or not, so the Engine routes it away from the model", () => {
    expect(isPrescoredSignal({ kind: LIVE_MOMENT_KIND })).toBe(true);
    expect(isPrescoredSignal({ kind: "metric" })).toBe(false);
    expect(isPrescoredSignal({ kind: "stream" })).toBe(false);
    expect(isPrescoredSignal(null)).toBe(false);
  });

  it("reads the declared direction and confidence strictly, and refuses to infer either", () => {
    expect(readPrescoredPayload({ kind: LIVE_MOMENT_KIND, moment: "audience_surge", direction: 1, confidence: 0.48, magnitude: 0.24 })).toEqual({
      moment: "audience_surge",
      direction: 1,
      confidence: 0.48,
      magnitude: 0.24,
      source: null,
    });
    expect(readPrescoredPayload({ kind: LIVE_MOMENT_KIND, moment: "audience_surge", confidence: 0.5 })).toBeNull();
    expect(readPrescoredPayload({ kind: LIVE_MOMENT_KIND, moment: "audience_surge", direction: "up", confidence: 0.5 })).toBeNull();
    expect(readPrescoredPayload({ kind: LIVE_MOMENT_KIND, moment: "audience_surge", direction: 1, confidence: "high" })).toBeNull();
    expect(readPrescoredPayload({ kind: LIVE_MOMENT_KIND, moment: "", direction: 1, confidence: 0.5 })).toBeNull();
    expect(readPrescoredPayload({ kind: "article" })).toBeNull();
  });

  it("scores from the declaration: label by direction, confidence bounded, anomaly by the configured tiers", async () => {
    const surge = await prescoredScorer.scoreSignal(input({ kind: LIVE_MOMENT_KIND, moment: "audience_surge", direction: 1, confidence: 0.48, magnitude: 0.24 }));
    expect(surge).toMatchObject({ label: "positive", direction: 1, confidence: 0.48, anomaly: "routine", scorer: "prescored" });
    expect(surge.rationale).toMatch(/audience surge against the session itself: direction \+1, confidence 0.48, magnitude 0.24/);

    const burst = await prescoredScorer.scoreSignal(input({ kind: LIVE_MOMENT_KIND, moment: "clip_burst", direction: 1, confidence: 0.7 }));
    expect(burst).toMatchObject({ label: "positive", confidence: 0.7, anomaly: "notable" });

    const drop = await prescoredScorer.scoreSignal(input({ kind: LIVE_MOMENT_KIND, moment: "audience_drop", direction: -1, confidence: 1.4 }));
    expect(drop).toMatchObject({ label: "negative", direction: -1, confidence: 1, anomaly: "anomalous" });

    expect(DEFAULT_ENGINE_CONFIG.live).toEqual({ notableConfidence: 0.5, anomalousConfidence: 0.9 });
    const custom = new PrescoredScorer({ notableConfidence: 0.3, anomalousConfidence: 0.6 });
    expect((await custom.scoreSignal(input({ kind: LIVE_MOMENT_KIND, moment: "clip_burst", direction: 1, confidence: 0.65 }))).anomaly).toBe("anomalous");
  });

  it("scores a malformed live moment neutral and says so, whatever the headline claims", async () => {
    const result = await prescoredScorer.scoreSignal(input({ kind: LIVE_MOMENT_KIND, moment: "audience_surge" }, "audience surges 300%, record high, wins everything"));
    expect(result).toMatchObject({ label: "neutral", direction: 0, confidence: 0 });
    expect(result.rationale).toMatch(/without an explicit direction and confidence: ignored, never inferred/);
    const zero = await prescoredScorer.scoreSignal(input({ kind: LIVE_MOMENT_KIND, moment: "audience_surge", direction: 1, confidence: 0 }));
    expect(zero).toMatchObject({ label: "neutral", direction: 0, confidence: 0 });
  });
});
