import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";
import type { Json } from "@/types/database";

import type { SentimentAnomaly, SentimentInput, SentimentResult, SentimentScorer } from "./types";

/**
 * PrescoredScorer — the scorer for signals that arrive already judged
 * (Phase 16: the moments of a live broadcast).
 *
 * A within-session audience surge or a burst of clips is arithmetic on the
 * session's own samples: the direction is the sign of the change and the
 * magnitude is a fraction or a multiple against the session itself. There
 * is nothing for a language model to read into it, and asking one would
 * spend a call to have it confirm the sign. So, like the metric scorer, this
 * one reads an EXPLICIT direction and confidence from the payload and never
 * infers either: a live moment without both scores neutral and says why.
 *
 * What it decides for the tick: a prescored signal is FREE (never reaches
 * the model, never counts against the call budget or the one-chunk-per-
 * person cap, taken by every tick like a metric), is AGED like any event
 * (a surge is a moment; a week later it is nothing), and is never volume-
 * weighted (it is a derivative of the platform's own sampling, not
 * coverage the world produced).
 */

/** The payload kind of a live moment: an event signal scored from its own declared direction and confidence. */
export const LIVE_MOMENT_KIND = "live_moment";

export interface PrescoredPayload {
  /** What kind of moment: "audience_surge", "audience_drop", "clip_burst". */
  moment: string;
  direction: 1 | -1;
  /** 0–1, declared by the producer from the moment's magnitude. */
  confidence: number;
  /** The magnitude behind the confidence (a fraction, a multiple), for the rationale. */
  magnitude: number | null;
  source: string | null;
}

function field(payload: Json | null, key: string): Json | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

/** True for any payload marked as a live moment, well-formed or not, so the Engine routes it away from the model. */
export function isPrescoredSignal(payload: Json | null): boolean {
  return field(payload, "kind") === LIVE_MOMENT_KIND;
}

/** The prescored payload, strictly read, or null when the direction or confidence is missing or malformed. */
export function readPrescoredPayload(payload: Json | null): PrescoredPayload | null {
  if (!isPrescoredSignal(payload)) return null;
  const moment = field(payload, "moment");
  const direction = field(payload, "direction");
  const confidence = field(payload, "confidence");
  const magnitude = field(payload, "magnitude");
  const source = field(payload, "source");
  if (typeof moment !== "string" || !moment) return null;
  if (direction !== 1 && direction !== -1) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return {
    moment,
    direction,
    confidence,
    magnitude: typeof magnitude === "number" && Number.isFinite(magnitude) ? magnitude : null,
    source: typeof source === "string" ? source : null,
  };
}

export class PrescoredScorer implements SentimentScorer {
  readonly name = "prescored";
  private readonly config: EngineConfig["live"];

  constructor(config: EngineConfig["live"] = DEFAULT_ENGINE_CONFIG.live) {
    this.config = config;
  }

  async scoreSignal(signal: SentimentInput): Promise<SentimentResult> {
    const payload = readPrescoredPayload(signal.rawPayload);
    if (!payload) {
      return {
        label: "neutral",
        confidence: 0,
        direction: 0,
        scorer: this.name,
        rationale: isPrescoredSignal(signal.rawPayload) ? "live moment without an explicit direction and confidence: ignored, never inferred" : "not a prescored signal",
      };
    }
    const confidence = Math.round(clamp(payload.confidence, 0, 1) * 1000) / 1000;
    const direction: 1 | -1 | 0 = confidence === 0 ? 0 : payload.direction;
    const anomaly: SentimentAnomaly = confidence >= this.config.anomalousConfidence ? "anomalous" : confidence >= this.config.notableConfidence ? "notable" : "routine";
    const magnitude = payload.magnitude === null ? "" : `, magnitude ${payload.magnitude}`;
    return {
      label: direction > 0 ? "positive" : direction < 0 ? "negative" : "neutral",
      confidence,
      direction,
      anomaly,
      scorer: this.name,
      rationale: `${payload.moment.replace(/_/g, " ")} against the session itself: direction ${payload.direction > 0 ? "+1" : "-1"}, confidence ${confidence}${magnitude}`,
    };
  }
}

export const prescoredScorer = new PrescoredScorer();
