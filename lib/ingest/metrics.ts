import { baselineDeviation, type BaselineDeviation } from "@/lib/engine/baseline";
import type { RawSignal } from "@/lib/connectors/types";
import type { Json } from "@/types/database";

/**
 * THE METRIC PIPELINE (Phase 7): poll → snapshot → delta → normalise → signal.
 *
 * A metric is a raw level a connector reads (subscribers, followers, a
 * popularity index, a news-volume count). Nothing here is hard-coded to a
 * source: what each metric means is declared on its data_sources row, in
 * config.metrics, and a source is a row plus credentials. Per metric:
 *
 *   polarity               +1 when up is good for the person, -1 when up is
 *                          bad. EXPLICIT, never inferred from the sign of the
 *                          delta: a metric without a polarity is snapshot-only.
 *   delta                  how consecutive snapshots become an observation:
 *                          "level" (the value itself: a bounded index, a
 *                          windowed count), "absolute_rate" (change per hour),
 *                          "relative_rate" (change per hour as a fraction of
 *                          the previous level)
 *   baseline_window_hours  how far back the person's own trailing series
 *                          reaches
 *   min_samples            observations required before a deviation counts;
 *                          below it the metric emits NOTHING
 *   sd_floor               floor for the baseline sd, in the observation's units
 *   scale                  how strongly a sigma of this metric should read,
 *                          consumed by the metric scorer
 *   threshold_std_devs     the deadband (default 1.0σ)
 *
 * The normalisation is the point. The raw level is written to the raw
 * snapshot table (service role only) and never leaves it: the signal that
 * comes out carries the direction, the normalised magnitude (sigma) and the
 * metric's metadata, and the headline says "+1.4σ above their own trailing
 * week", never a number of subscribers.
 *
 * Derived metrics (config.derived) are computed from another metric's
 * snapshot history and then normalised like any other: the upload cadence
 * from the video count, the viral-moment rate from news-volume spikes.
 */

export type MetricDeltaKind = "level" | "absolute_rate" | "relative_rate";
export type MetricPolarity = 1 | -1;
export const METRIC_DELTA_KINDS: readonly MetricDeltaKind[] = ["level", "absolute_rate", "relative_rate"];

export interface MetricConfig {
  metricKey: string;
  /** Human phrase for the headline, e.g. "YouTube subscriber growth". */
  label: string;
  polarity: MetricPolarity;
  delta: MetricDeltaKind;
  baselineWindowHours: number;
  minSamples: number;
  sdFloor: number;
  scale: number;
  thresholdStdDevs: number;
}

export type DerivedMetricKind = "rate" | "spike_count";

export interface DerivedMetricConfig {
  metricKey: string;
  /** The snapshotted metric it is computed from. */
  from: string;
  kind: DerivedMetricKind;
  /** How much source history the derivation looks at. */
  windowHours: number;
  /** rate: express the change per this many hours (24 = per day). Default 24. */
  perHours: number;
  /** rate: the source history must span at least this long. Default 24. */
  minSpanHours: number;
  /** spike_count: a source reading this many sd above the window mean is a spike. Default 2. */
  spikeStdDevs: number;
  /** spike_count: sd floor for the spike test, in the source metric's units. Default 0.5. */
  spikeSdFloor: number;
  /** spike_count: source readings required in the window. Default 24. */
  minSourceSamples: number;
}

export interface MetricConfigs {
  metrics: MetricConfig[];
  derived: DerivedMetricConfig[];
  /** Malformed entries, with the reason they were ignored. */
  problems: string[];
}

const DEFAULT_THRESHOLD_STD_DEVS = 1.0;

function isRecord(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** "subscriber_count" → "subscriber count", for a label when none is declared. */
function humanize(metricKey: string): string {
  return metricKey.replace(/_/g, " ");
}

/**
 * Reads config.metrics and config.derived from a data_sources.config object.
 * Strict: every required field must be present and well-typed, or the metric
 * is reported as a problem and treated as snapshot-only.
 */
export function readMetricConfigs(config: Record<string, Json | undefined>): MetricConfigs {
  const metrics: MetricConfig[] = [];
  const derived: DerivedMetricConfig[] = [];
  const problems: string[] = [];

  const rawMetrics = config.metrics;
  if (rawMetrics !== undefined) {
    if (!isRecord(rawMetrics)) {
      problems.push("config.metrics must be an object keyed by metric");
    } else {
      for (const [metricKey, entry] of Object.entries(rawMetrics)) {
        const problem = (reason: string) => problems.push(`metrics.${metricKey}: ${reason}`);
        if (!/^[a-z0-9_]+$/.test(metricKey)) {
          problem("metric keys are lowercase snake_case");
          continue;
        }
        if (!isRecord(entry)) {
          problem("must be an object");
          continue;
        }
        const polarity = entry.polarity;
        if (polarity !== 1 && polarity !== -1) {
          problem("polarity must be exactly 1 or -1 (declared, never inferred)");
          continue;
        }
        const delta = entry.delta;
        if (typeof delta !== "string" || !METRIC_DELTA_KINDS.includes(delta as MetricDeltaKind)) {
          problem(`delta must be one of ${METRIC_DELTA_KINDS.join(", ")}`);
          continue;
        }
        const baselineWindowHours = positiveNumber(entry.baseline_window_hours);
        const minSamples = typeof entry.min_samples === "number" && Number.isInteger(entry.min_samples) && entry.min_samples >= 2 ? entry.min_samples : null;
        const sdFloor = nonNegativeNumber(entry.sd_floor);
        const scale = positiveNumber(entry.scale);
        const thresholdStdDevs = entry.threshold_std_devs === undefined ? DEFAULT_THRESHOLD_STD_DEVS : positiveNumber(entry.threshold_std_devs);
        if (baselineWindowHours === null) {
          problem("baseline_window_hours must be a positive number");
          continue;
        }
        if (minSamples === null) {
          problem("min_samples must be an integer of at least 2");
          continue;
        }
        if (sdFloor === null) {
          problem("sd_floor must be a non-negative number");
          continue;
        }
        if (scale === null) {
          problem("scale must be a positive number");
          continue;
        }
        if (thresholdStdDevs === null) {
          problem("threshold_std_devs must be a positive number");
          continue;
        }
        metrics.push({
          metricKey,
          label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : humanize(metricKey),
          polarity,
          delta: delta as MetricDeltaKind,
          baselineWindowHours,
          minSamples,
          sdFloor,
          scale,
          thresholdStdDevs,
        });
      }
    }
  }

  const rawDerived = config.derived;
  if (rawDerived !== undefined) {
    if (!isRecord(rawDerived)) {
      problems.push("config.derived must be an object keyed by metric");
    } else {
      for (const [metricKey, entry] of Object.entries(rawDerived)) {
        const problem = (reason: string) => problems.push(`derived.${metricKey}: ${reason}`);
        if (!/^[a-z0-9_]+$/.test(metricKey)) {
          problem("metric keys are lowercase snake_case");
          continue;
        }
        if (!isRecord(entry)) {
          problem("must be an object");
          continue;
        }
        if (typeof entry.from !== "string" || !entry.from) {
          problem("from must name the source metric");
          continue;
        }
        if (entry.kind !== "rate" && entry.kind !== "spike_count") {
          problem("kind must be rate or spike_count");
          continue;
        }
        const windowHours = positiveNumber(entry.window_hours);
        if (windowHours === null) {
          problem("window_hours must be a positive number");
          continue;
        }
        const optional = (key: string, fallback: number, reader: (value: Json | undefined) => number | null) => {
          const value = entry[key];
          if (value === undefined) return fallback;
          return reader(value);
        };
        const perHours = optional("per_hours", 24, positiveNumber);
        const minSpanHours = optional("min_span_hours", 24, positiveNumber);
        const spikeStdDevs = optional("spike_std_devs", 2, positiveNumber);
        const spikeSdFloor = optional("spike_sd_floor", 0.5, nonNegativeNumber);
        const minSourceSamples = optional("min_source_samples", 24, (value) => (typeof value === "number" && Number.isInteger(value) && value >= 2 ? value : null));
        if (perHours === null || minSpanHours === null || spikeStdDevs === null || spikeSdFloor === null || minSourceSamples === null) {
          problem("per_hours, min_span_hours, spike_std_devs must be positive; spike_sd_floor non-negative; min_source_samples an integer of at least 2");
          continue;
        }
        derived.push({ metricKey, from: entry.from, kind: entry.kind, windowHours, perHours, minSpanHours, spikeStdDevs, spikeSdFloor, minSourceSamples });
      }
    }
  }

  return { metrics, derived, problems };
}

// ---------------------------------------------------------------------------
// Observation series
// ---------------------------------------------------------------------------

export interface SnapshotPoint {
  value: number;
  recordedAt: Date;
}

export interface ObservationPoint {
  /** The observation the baseline is built from: the level, or the rate since the previous point. */
  observed: number;
  at: Date;
  value: number;
  previous: number | null;
  delta: number | null;
}

const HOUR_MS = 3_600_000;

/**
 * Turns a snapshot series (oldest first) into the observation series for a
 * delta kind. Rates need a previous point; pairs with no elapsed time, or a
 * non-positive previous level for a relative rate, are skipped.
 */
export function observationSeries(points: SnapshotPoint[], kind: MetricDeltaKind): ObservationPoint[] {
  if (kind === "level") {
    return points.map((point) => ({ observed: point.value, at: point.recordedAt, value: point.value, previous: null, delta: null }));
  }
  const out: ObservationPoint[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const point = points[i];
    const hours = (point.recordedAt.getTime() - previous.recordedAt.getTime()) / HOUR_MS;
    if (!(hours > 0)) continue;
    const delta = point.value - previous.value;
    if (kind === "relative_rate" && !(previous.value > 0)) continue;
    const observed = kind === "absolute_rate" ? delta / hours : delta / (previous.value * hours);
    out.push({ observed, at: point.recordedAt, value: point.value, previous: previous.value, delta });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Observing one reading
// ---------------------------------------------------------------------------

export type MetricOutcome = "no_config" | "first_contact" | "insufficient_baseline" | "inside_band" | "emitted";

export interface MetricObservation {
  metricKey: string;
  config: MetricConfig | null;
  value: number;
  recordedAt: Date;
  previous: number | null;
  delta: number | null;
  deltaKind: MetricDeltaKind | null;
  observed: number | null;
  windowHours: number | null;
  reading: BaselineDeviation | null;
  outcome: MetricOutcome;
}

export interface ObserveMetricInput {
  metricKey: string;
  config: MetricConfig | null;
  /** Snapshots recorded before this reading, oldest first. May reach further back than the window; it is cut here. */
  history: SnapshotPoint[];
  current: SnapshotPoint;
}

/** Judges one fresh reading against the person's own trailing history. Pure. */
export function observeMetric(input: ObserveMetricInput): MetricObservation {
  const { metricKey, config, history, current } = input;
  const last = history.length > 0 ? history[history.length - 1] : null;
  const base = { metricKey, config, value: current.value, recordedAt: current.recordedAt, previous: last?.value ?? null };

  if (!config) {
    return { ...base, delta: last ? current.value - last.value : null, deltaKind: null, observed: null, windowHours: null, reading: null, outcome: "no_config" };
  }

  const windowStart = current.recordedAt.getTime() - config.baselineWindowHours * HOUR_MS;
  const inWindow = history.filter((point) => point.recordedAt.getTime() >= windowStart && point.recordedAt.getTime() < current.recordedAt.getTime());
  const series = observationSeries([...inWindow, current], config.delta);
  const latest = series.length > 0 && series[series.length - 1].at.getTime() === current.recordedAt.getTime() ? series[series.length - 1] : null;
  const shared = { delta: last ? current.value - last.value : null, deltaKind: config.delta, windowHours: config.baselineWindowHours };

  if (history.length === 0 || !latest) {
    return { ...base, ...shared, observed: latest?.observed ?? null, reading: null, outcome: "first_contact" };
  }

  const reading = baselineDeviation(
    { current: latest.observed, baseline: series.map((point) => point.observed) },
    { minSamples: config.minSamples, sdFloor: config.sdFloor, thresholdStdDevs: config.thresholdStdDevs },
  );
  const outcome: MetricOutcome = !reading.sufficient ? "insufficient_baseline" : reading.atBaseline || reading.band === "inside" ? "inside_band" : "emitted";
  return { ...base, ...shared, observed: latest.observed, reading, outcome };
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

export type DerivedResult = { ok: true; value: number } | { ok: false; reason: string };

/** Computes a derived metric's current level from the source metric's history (oldest first, the fresh reading included). */
export function deriveMetric(config: DerivedMetricConfig, sourceHistory: SnapshotPoint[], now: Date): DerivedResult {
  const windowStart = now.getTime() - config.windowHours * HOUR_MS;
  const points = sourceHistory.filter((point) => point.recordedAt.getTime() >= windowStart && point.recordedAt.getTime() <= now.getTime());

  if (config.kind === "rate") {
    if (points.length < 2) return { ok: false, reason: "needs at least two source readings in the window" };
    const first = points[0];
    const last = points[points.length - 1];
    const spanHours = (last.recordedAt.getTime() - first.recordedAt.getTime()) / HOUR_MS;
    if (spanHours < config.minSpanHours) return { ok: false, reason: `source history spans ${spanHours.toFixed(1)}h, needs ${config.minSpanHours}h` };
    return { ok: true, value: ((last.value - first.value) / spanHours) * config.perHours };
  }

  // spike_count: readings that sit spikeStdDevs above the window's own mean.
  if (points.length < config.minSourceSamples) {
    return { ok: false, reason: `${points.length} source readings in the window, needs ${config.minSourceSamples}` };
  }
  const values = points.map((point) => point.value);
  const stats = baselineDeviation({ current: 0, baseline: values }, { minSamples: config.minSourceSamples, sdFloor: config.spikeSdFloor, thresholdStdDevs: config.spikeStdDevs });
  const cutoff = stats.mean + config.spikeStdDevs * stats.sdApplied;
  return { ok: true, value: values.filter((value) => value > cutoff).length };
}

// ---------------------------------------------------------------------------
// The signal
// ---------------------------------------------------------------------------

/** Keys a metric signal's payload may carry. Enforced again by a trigger on the signals table. */
export const METRIC_PAYLOAD_KEYS = [
  "kind",
  "metric",
  "label",
  "sigma",
  "direction",
  "polarity",
  "samples",
  "min_samples",
  "window_hours",
  "delta_kind",
  "threshold_std_devs",
  "scale",
  "source",
] as const;

export function formatSigma(sigma: number): string {
  const bounded = Math.max(-99.9, Math.min(99.9, sigma));
  const rounded = Math.round(bounded * 10) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? "-" : ""}${Math.abs(rounded).toFixed(1)}σ`;
}

export function describeWindow(hours: number): string {
  if (hours === 24) return "day";
  if (hours === 168) return "week";
  if (hours === 336) return "fortnight";
  if (hours >= 672 && hours <= 744) return "month";
  if (hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hours`;
}

/**
 * The signal for an emitted observation. Direction and normalised magnitude
 * only: the headline speaks in sigma against the person's own window and the
 * payload is limited to METRIC_PAYLOAD_KEYS. The level, the previous level,
 * the delta, the mean and the sd stay in the raw tables.
 */
export function metricSignal(input: {
  person: { display_name: string };
  sourceName: string;
  externalIdentifier: string;
  observation: MetricObservation;
}): RawSignal {
  const { person, sourceName, externalIdentifier, observation } = input;
  const { config, reading } = observation;
  if (!config || !reading || observation.outcome !== "emitted") {
    throw new Error(`metricSignal called for a ${observation.outcome} observation of ${observation.metricKey}`);
  }
  const sigma = Math.round(reading.sigma * 100) / 100;
  const sign: 1 | -1 = sigma > 0 ? 1 : -1;
  const direction = (config.polarity * sign) as 1 | -1;
  const possessive = person.display_name.endsWith("s") ? `${person.display_name}'` : `${person.display_name}'s`;
  const headline = `${possessive} ${config.label} is running ${formatSigma(sigma)} ${sign > 0 ? "above" : "below"} their own trailing ${describeWindow(config.baselineWindowHours)}`;

  const rawPayload: Record<(typeof METRIC_PAYLOAD_KEYS)[number], unknown> = {
    kind: "metric",
    metric: config.metricKey,
    label: config.label,
    sigma,
    direction,
    polarity: config.polarity,
    samples: reading.samples,
    min_samples: reading.minSamples,
    window_hours: config.baselineWindowHours,
    delta_kind: config.delta,
    threshold_std_devs: config.thresholdStdDevs,
    scale: config.scale,
    source: sourceName,
  };

  return {
    headline,
    rawPayload,
    occurredAt: observation.recordedAt,
    dedupeKey: `metric:${sourceName}:${externalIdentifier}:${config.metricKey}:${observation.recordedAt.toISOString()}`,
  };
}
