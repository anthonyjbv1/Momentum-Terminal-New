import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";
import type { Json } from "@/types/database";

import type { SentimentAnomaly, SentimentInput, SentimentResult, SentimentScorer } from "./types";

/**
 * MetricScorer — the rules-based scorer for metric signals (Phase 7).
 *
 * Sits beside the sentiment scorers behind the same SentimentScorer
 * interface, so the Signals force consumes metric and news signals in ONE
 * unit: impact = baseImpact × tier × confidence × direction, exactly as for
 * a headline. What it reads is the normalised deviation and the metric's
 * metadata, nothing else:
 *
 *   confidence = clamp(|sigma| / fullConfidenceSigma × scale, 0, 1)
 *   direction  = polarity × sign(sigma)
 *
 * The polarity is the one declared on the source registration and carried
 * in the payload. It is never inferred here: a metric signal without an
 * explicit polarity of exactly 1 or -1 scores neutral and says why. The
 * scale is the metric's own, also from its registration; the sigma at which
 * confidence saturates is the one Engine constant, shared by every metric.
 */

export interface MetricPayload {
  metric: string;
  label: string;
  sigma: number;
  polarity: 1 | -1;
  scale: number;
  samples: number | null;
  windowHours: number | null;
  source: string | null;
}

function field(payload: Json | null, key: string): Json | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

/** True for any payload marked kind "metric", well-formed or not, so the Engine can route it away from keyword inference. */
export function isMetricSignal(payload: Json | null): boolean {
  return field(payload, "kind") === "metric";
}

/** The metric payload, strictly read, or null when anything the scorer needs is missing or malformed. */
export function readMetricPayload(payload: Json | null): MetricPayload | null {
  if (!isMetricSignal(payload)) return null;
  const metric = field(payload, "metric");
  const sigma = field(payload, "sigma");
  const polarity = field(payload, "polarity");
  const scale = field(payload, "scale");
  if (typeof metric !== "string" || !metric) return null;
  if (typeof sigma !== "number" || !Number.isFinite(sigma)) return null;
  if (polarity !== 1 && polarity !== -1) return null;
  const resolvedScale = scale === undefined ? 1 : typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : null;
  if (resolvedScale === null) return null;
  const label = field(payload, "label");
  const samples = field(payload, "samples");
  const windowHours = field(payload, "window_hours");
  const source = field(payload, "source");
  return {
    metric,
    label: typeof label === "string" && label ? label : metric,
    sigma,
    polarity,
    scale: resolvedScale,
    samples: typeof samples === "number" ? samples : null,
    windowHours: typeof windowHours === "number" ? windowHours : null,
    source: typeof source === "string" ? source : null,
  };
}

export class MetricScorer implements SentimentScorer {
  readonly name = "metric";
  private readonly config: EngineConfig["metrics"];

  constructor(config: EngineConfig["metrics"] = DEFAULT_ENGINE_CONFIG.metrics) {
    this.config = config;
  }

  async scoreSignal(signal: SentimentInput): Promise<SentimentResult> {
    const payload = readMetricPayload(signal.rawPayload);
    if (!payload) {
      return {
        label: "neutral",
        confidence: 0,
        direction: 0,
        scorer: this.name,
        rationale: isMetricSignal(signal.rawPayload)
          ? "metric signal without an explicit polarity, sigma or scale: ignored, never inferred"
          : "not a metric signal",
      };
    }

    const magnitude = Math.abs(payload.sigma);
    const sign: 1 | -1 | 0 = payload.sigma > 0 ? 1 : payload.sigma < 0 ? -1 : 0;
    const direction = (payload.polarity * sign) as 1 | -1 | 0;
    const confidence = direction === 0 ? 0 : Math.round(clamp((magnitude / this.config.fullConfidenceSigma) * payload.scale, 0, 1) * 1000) / 1000;
    const anomaly: SentimentAnomaly = magnitude >= this.config.anomalousSigma ? "anomalous" : magnitude >= this.config.notableSigma ? "notable" : "routine";
    const label = direction > 0 ? "positive" : direction < 0 ? "negative" : "neutral";
    const sigmaText = `${payload.sigma >= 0 ? "+" : ""}${payload.sigma.toFixed(2)}σ`;
    const window = payload.windowHours !== null ? ` over ${payload.windowHours}h` : "";

    return {
      label,
      confidence,
      direction,
      anomaly,
      scorer: this.name,
      rationale: `${payload.label} ${sigmaText} against their own baseline${window}; polarity ${payload.polarity > 0 ? "+1" : "-1"}, scale ${payload.scale}`,
    };
  }
}

export const metricScorer = new MetricScorer();
