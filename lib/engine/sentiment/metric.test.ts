import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG as CONFIG } from "@/lib/engine/config";
import { scoreSignals, signalsForce } from "@/lib/engine/forces/signals";
import type { EngineSignal } from "@/lib/engine/types";
import type { Json } from "@/types/database";

import { MetricScorer, isMetricSignal, metricScorer, readMetricPayload } from "./metric";
import { RulesBasedScorer } from "./rules";
import type { SentimentInput } from "./types";

/**
 * The metric scorer: normalised deviation + explicit polarity in, Signals
 * impact out, in the same units as a news headline.
 */

const NOW = new Date("2026-09-12T12:00:00.000Z");

function payload(overrides: Record<string, Json | undefined> = {}): Json {
  return {
    kind: "metric",
    metric: "subscriber_count",
    label: "YouTube subscriber growth",
    sigma: 1.5,
    direction: 1,
    polarity: 1,
    samples: 48,
    min_samples: 24,
    window_hours: 168,
    delta_kind: "relative_rate",
    threshold_std_devs: 1,
    scale: 1,
    source: "youtube",
    ...overrides,
  } as Json;
}

function input(rawPayload: Json | null, overrides: Partial<SentimentInput> = {}): SentimentInput {
  return { id: "m1", personId: "p1", headline: "MrBeast's YouTube subscriber growth is running +1.5σ above their own trailing week", rawPayload, sourceName: "youtube", sourceTier: 2, ...overrides };
}

describe("readMetricPayload", () => {
  it("reads a well-formed metric payload and nothing else", () => {
    expect(readMetricPayload(payload())).toMatchObject({ metric: "subscriber_count", sigma: 1.5, polarity: 1, scale: 1, samples: 48, windowHours: 168, source: "youtube" });
    expect(isMetricSignal(payload())).toBe(true);
    expect(isMetricSignal({ kind: "article" })).toBe(false);
    expect(readMetricPayload({ kind: "article", sigma: 2, polarity: 1 })).toBeNull();
    expect(readMetricPayload(null)).toBeNull();
  });

  it("refuses to guess: no polarity, a non-numeric sigma or a bad scale is null", () => {
    expect(readMetricPayload(payload({ polarity: undefined }))).toBeNull();
    expect(readMetricPayload(payload({ polarity: "up" }))).toBeNull();
    expect(readMetricPayload(payload({ polarity: 0 }))).toBeNull();
    expect(readMetricPayload(payload({ polarity: 2 }))).toBeNull();
    expect(readMetricPayload(payload({ sigma: "1.5" }))).toBeNull();
    expect(readMetricPayload(payload({ scale: -1 }))).toBeNull();
    expect(readMetricPayload(payload({ scale: undefined }))).toMatchObject({ scale: 1 });
  });
});

describe("MetricScorer", () => {
  it("confidence = |sigma| / fullConfidenceSigma × scale, direction = polarity × sign(sigma)", async () => {
    expect(CONFIG.metrics.fullConfidenceSigma).toBe(3);
    const up = await metricScorer.scoreSignal(input(payload({ sigma: 1.5 })));
    expect(up).toMatchObject({ label: "positive", direction: 1, confidence: 0.5, scorer: "metric", anomaly: "routine" });
    const down = await metricScorer.scoreSignal(input(payload({ sigma: -2.4 })));
    expect(down).toMatchObject({ label: "negative", direction: -1, confidence: 0.8, anomaly: "notable" });
    const scaled = await metricScorer.scoreSignal(input(payload({ sigma: 1.5, scale: 0.6 })));
    expect(scaled.confidence).toBeCloseTo(0.3);
    const saturated = await metricScorer.scoreSignal(input(payload({ sigma: 7.2 })));
    expect(saturated).toMatchObject({ confidence: 1, anomaly: "anomalous" });
  });

  it("DIRECTION POLARITY IS EXPLICIT: the same rise reads negative for a metric declared polarity -1", async () => {
    const rising = payload({ sigma: 2, metric: "controversy_mentions", label: "controversy mentions" });
    expect(await metricScorer.scoreSignal(input({ ...(rising as object), polarity: 1 } as Json))).toMatchObject({ direction: 1, label: "positive" });
    expect(await metricScorer.scoreSignal(input({ ...(rising as object), polarity: -1 } as Json))).toMatchObject({ direction: -1, label: "negative" });
    // A fall in a polarity -1 metric is good news.
    expect(await metricScorer.scoreSignal(input(payload({ sigma: -2, polarity: -1 })))).toMatchObject({ direction: 1, label: "positive" });
  });

  it("scores neutral, and says why, when the polarity is missing rather than inferring it from the sign", async () => {
    const result = await metricScorer.scoreSignal(input(payload({ polarity: undefined })));
    expect(result).toMatchObject({ label: "neutral", direction: 0, confidence: 0, scorer: "metric" });
    expect(result.rationale).toMatch(/never inferred/);
    expect(await metricScorer.scoreSignal(input({ kind: "article" }))).toMatchObject({ direction: 0, rationale: "not a metric signal" });
    expect(await metricScorer.scoreSignal(input(payload({ sigma: 0 })))).toMatchObject({ direction: 0, confidence: 0 });
  });

  it("the keyword scorer never assigns a metric signal a direction", async () => {
    const rules = new RulesBasedScorer();
    const result = await rules.scoreSignal(input(payload({ sigma: 3 }), { headline: "MrBeast gains a record surge, wins, up" }));
    expect(result).toMatchObject({ label: "neutral", direction: 0, confidence: 0 });
    expect(result.rationale).toMatch(/metric scorer/);
  });

  it("flows into the Signals force in the same units as a headline, tier weighting included", async () => {
    const custom = new MetricScorer({ fullConfidenceSigma: 2, notableSigma: 2, anomalousSigma: 3 });
    const metric = await custom.scoreSignal(input(payload({ sigma: 1 })));
    expect(metric.confidence).toBe(0.5);
    const headline = { label: "positive" as const, confidence: 0.5, direction: 1 as const };
    const signals: EngineSignal[] = [
      { id: "metric", personId: "p1", headline: "x", rawPayload: payload(), sourceName: "youtube", sourceTier: 2, occurredAt: NOW, createdAt: NOW },
      { id: "news", personId: "p1", headline: "y", rawPayload: null, sourceName: "rss", sourceTier: 2, occurredAt: NOW, createdAt: NOW },
      { id: "low", personId: "p1", headline: "z", rawPayload: payload(), sourceName: "scraped", sourceTier: 5, occurredAt: NOW, createdAt: NOW },
    ];
    const scored = scoreSignals(signals, new Map([["metric", metric], ["news", headline], ["low", metric]]), CONFIG.signals);
    // Same confidence and tier → the same impact, whatever produced it.
    expect(scored[0].impact).toBeCloseTo(scored[1].impact);
    expect(scored[0].impact).toBeCloseTo(1.5 * 1.0 * 0.5);
    // A low-tier source carries the tier multiplier, not the connector's opinion of itself.
    expect(scored[2].impact).toBeCloseTo(1.5 * 0.3 * 0.5);
    const force = signalsForce(scored, CONFIG.signals);
    expect(force.impact).toBeCloseTo((0.75 + 0.75 + 0.225) / Math.sqrt(3));
  });
});
