import { baselineDeviation, type BaselineDeviation } from "@/lib/engine/baseline";
import type { RawSignal } from "@/lib/connectors/types";
import { metricSentence } from "@/lib/signals/metric-language";
import { heldRegister, type MetricRegister } from "@/lib/signals/register";
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
 *   threshold_std_devs     the deadband (default 2.0σ since Phase 21)
 *   publish_observed       whether the observed quantity may reach a reader.
 *                          EXPLICIT, default false (Phase 21+)
 *
 * The normalisation is the point. The raw level is written to the raw
 * snapshot table (service role only) and never leaves it: the signal that
 * comes out carries the direction, the normalised magnitude (sigma) and the
 * metric's metadata, never a number of subscribers.
 *
 * Since Phase 21+ the HEADLINE is plain language rather than sigma —
 * "12 stories on Drake today — 3x their usual pace" — written by
 * lib/signals/metric-language.ts. σ stays in the payload for the Engine and
 * the operator console, and reaches no reader. A metric whose declaration
 * opts in with `publish_observed` also carries its observed count and the
 * baseline pace, which is what lets the consumer app show the arithmetic
 * instead of asking anyone to trust a statistic.
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
  /**
   * Whether this metric's OBSERVED QUANTITY may reach a reader (Phase 21+).
   *
   * EXPLICIT, AND FALSE UNLESS DECLARED. A count of news stories and a
   * subscriber total are different categories of fact: the first is public,
   * small, and already visible in the Feed as the articles it counts; the
   * second is an absolute audience level, which Phase 7 exists to keep out of
   * a signal. Only the first may be published, and only because its
   * declaration says so — a `level` metric added later must not start
   * publishing its raw value because nobody thought about it.
   *
   * When true, `metricSignal` puts the observed value and the baseline mean
   * in the payload so the consumer app can say "12 stories against a usual 4"
   * rather than a sigma. When absent or false it writes neither.
   */
  publishObserved: boolean;
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
  /**
   * Metrics snapshotted only to feed a derived metric: the `from` of a
   * `config.derived` entry, carrying no declaration of their own, so they are
   * DELIBERATELY never scored. Keyed by metric, valued by the derived metric
   * that consumes it, so an observation with no config reads as a declared
   * input rather than an oversight — YouTube's `video_count` is the history
   * `upload_rate` is computed from, and needs a week of it before the derived
   * metric can say anything at all.
   */
  inputs: Record<string, string>;
}

/**
 * THE DEADBAND, in standard deviations of the person's own baseline: below it
 * a reading is normal and the metric emits nothing. TUNABLE per metric
 * (`threshold_std_devs` on the source row); this is the default, and every
 * metric currently takes it.
 *
 * 2.0, raised from 1.0 in Phase 21. At 1.0σ "unusual" meant "one reading in
 * three": for a normal statistic |z| > 1 occurs 31.7% of the time, and the
 * board bore that out — news_volume_24h emitted on 45.5% of its observations
 * and viral_moment_rate on 33.6%. That is a description of the middle of the
 * distribution, not of an anomaly; the threshold was the finding, not the
 * data. At 2.0σ the tail is 4.6% under normal theory, which is closer to what
 * the word the headline uses is worth.
 */
export const DEFAULT_THRESHOLD_STD_DEVS = 2.0;

/**
 * EMIT ON CHANGE (Phase 21). Two observations of one metric are THE SAME
 * READING when their observed quantities differ by no more than this,
 * relative to their own magnitude.
 *
 * An IDENTITY check, not a "small change" filter: a reading that moves at all
 * is a new reading and emits, whatever the size of the move. Magnitude is the
 * deadband's job, not this one's. The epsilon exists only so that a quantity
 * recomputed from the same inputs — a rate divided by a slightly different
 * elapsed time, a float reassembled out of the ledger — reads as unchanged
 * rather than as news.
 *
 * One part in a trillion: about a thousand times double precision's own
 * round-off (2.2e-16), which is enough to absorb a value that took a different
 * arithmetic route to the same number, and small enough that no real move is
 * ever swallowed — a count would have to reach 10^12 before a change of one
 * unit fell inside it, and the quantities compared here are article counts,
 * per-hour rates and growth fractions.
 */
export const UNCHANGED_RELATIVE_EPSILON = 1e-12;

/** True when two observed quantities are the same reading. Scale-relative, with an absolute floor for values near zero. */
export function isUnchangedObservation(current: number, previous: number): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return false;
  if (current === previous) return true;
  return Math.abs(current - previous) <= UNCHANGED_RELATIVE_EPSILON * Math.max(1, Math.abs(current), Math.abs(previous));
}

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
          // Exactly true opts in. Anything else — absent, "true", 1, null —
          // is off, because a privacy default must not be reachable by a typo.
          publishObserved: entry.publish_observed === true,
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

  // A derived metric's source, with no declaration of its own, is an input:
  // snapshotted forever and never scored, on purpose.
  const declared = new Set(metrics.map((metric) => metric.metricKey));
  const inputs: Record<string, string> = {};
  for (const entry of derived) {
    if (!declared.has(entry.from)) inputs[entry.from] = entry.metricKey;
  }

  return { metrics, derived, problems, inputs };
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

/**
 * What became of one reading.
 *
 * `unchanged` (Phase 21) is the identity rule: the reading is outside the
 * deadband and WOULD emit, but the observed quantity is the very number the
 * previous observation already put on the record.
 *
 * `same_register` (Phase 24) is the rule that does the work. The quantity
 * moved, but not far enough to change what the reading is CALLED, so it is
 * the same fact told again. See the note on the register rule below.
 *
 * Both are distinct outcomes rather than silent drops, so the ledger still
 * says why nothing was emitted — and so an operator can tell a connector that
 * returned the same number from one that returned a different number saying
 * the same thing.
 */
export type MetricOutcome = "no_config" | "first_contact" | "insufficient_baseline" | "inside_band" | "unchanged" | "same_register" | "emitted";

/**
 * THE REGISTER RULE (Phase 24): a metric emits when its BAND changes, not
 * when its number does.
 *
 * Phase 21 compared observed quantities, which is right on a quiet day and
 * wrong on the days that matter. A trailing-24h news count genuinely ticks 56,
 * 57, 58 through a big afternoon, so every poll was a new number and none was
 * new information: the first live NFL game produced 39 metric emissions for
 * one person in fourteen hours, "Coverage of Patrick Mahomes is running hot"
 * roughly every fifteen minutes. Because each emission is a metric signal
 * feeding the Signals force, that was not a Feed problem — it was the Phase 20
 * re-reporting problem (71% of the force being unchanged state) coming back in
 * a new shape.
 *
 * A reader cannot tell 2.6σ from 2.7σ. What they can tell is coverage going
 * from "running hot" to "56 stories today — 2x their usual pace" and back
 * again, and that transition is the event. So the record carries the REGISTER
 * a metric was last reported in, and a reading that lands in the same band
 * says nothing new. Held with hysteresis so a sigma wobbling across a boundary
 * does not chatter: see lib/signals/register.ts.
 *
 * MEASURED on the window that produced it. Mahomes, 2026-09-21 00:00–14:01
 * UTC: 39 emissions become 7, and the Signals force over that window falls
 * from 18.21 to 11.10 — the metric half from 9.30 to about 2.2, with the
 * events unchanged. Board-wide over the seven days to 2026-09-21: 2,074
 * emissions become 220, a cut of 89%.
 *
 * WHAT IT COSTS, stated rather than buried. A reading that intensifies WITHIN
 * a band no longer re-emits: a count that doubles from 2.6σ to 3.4σ says
 * nothing until it reaches "spiking". That is the intended trade and the same
 * principle Phase 21 shipped on — a metric describes a STATE and the event is
 * the state CHANGING — applied at the resolution a reader can actually read.
 */

/**
 * The observation immediately before this one, for the same person, source
 * and metric.
 *
 * `reported` means that observation put its state on the record: it emitted a
 * signal, or it was itself suppressed against one. Carrying it is what makes a
 * RUN collapse to its first: the second is suppressed against the first's
 * `emitted`, the third against the second's `same_register`, and so on. It is
 * also what keeps the rule from swallowing a metric's first real emission — an
 * observation that was `insufficient_baseline` or `inside_band` reported
 * nothing, so the reading after it is news even if the number is identical.
 *
 * `register` is the band the record currently holds, which is what a new
 * reading is judged against. Null on a record written before Phase 24, and
 * then the identity rule alone applies until the next emission writes one.
 */
export interface PreviousObservation {
  /** The observed quantity (not the raw level): what the sigma and the headline are computed from. */
  observed: number | null;
  /** The register that observation left on the record, or null if it left none. */
  register: MetricRegister | null;
  reported: boolean;
}

/** Whether an outcome put the reading on the record, for the next observation to compare against. */
export function outcomeReported(outcome: MetricOutcome): boolean {
  return outcome === "emitted" || outcome === "unchanged" || outcome === "same_register";
}

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
  /**
   * The register this observation leaves on the record for the next one to be
   * judged against, or null when it leaves none (no config, no baseline, or
   * inside the deadband). Persisted; see the register rule above.
   */
  register: MetricRegister | null;
}

export interface ObserveMetricInput {
  metricKey: string;
  config: MetricConfig | null;
  /** Snapshots recorded before this reading, oldest first. May reach further back than the window; it is cut here. */
  history: SnapshotPoint[];
  current: SnapshotPoint;
  /** The observation immediately before this one, for the emit-on-change rule. Absent means none has been recorded. */
  previousObservation?: PreviousObservation | null;
}

/** Judges one fresh reading against the person's own trailing history. Pure. */
export function observeMetric(input: ObserveMetricInput): MetricObservation {
  const { metricKey, config, history, current, previousObservation = null } = input;
  const last = history.length > 0 ? history[history.length - 1] : null;
  const base = { metricKey, config, value: current.value, recordedAt: current.recordedAt, previous: last?.value ?? null };

  if (!config) {
    return { ...base, delta: last ? current.value - last.value : null, deltaKind: null, observed: null, windowHours: null, reading: null, outcome: "no_config", register: null };
  }

  const windowStart = current.recordedAt.getTime() - config.baselineWindowHours * HOUR_MS;
  const inWindow = history.filter((point) => point.recordedAt.getTime() >= windowStart && point.recordedAt.getTime() < current.recordedAt.getTime());
  const series = observationSeries([...inWindow, current], config.delta);
  const latest = series.length > 0 && series[series.length - 1].at.getTime() === current.recordedAt.getTime() ? series[series.length - 1] : null;
  const shared = { delta: last ? current.value - last.value : null, deltaKind: config.delta, windowHours: config.baselineWindowHours };

  if (history.length === 0 || !latest) {
    return { ...base, ...shared, observed: latest?.observed ?? null, reading: null, outcome: "first_contact", register: null };
  }

  const reading = baselineDeviation(
    { current: latest.observed, baseline: series.map((point) => point.observed) },
    { minSamples: config.minSamples, sdFloor: config.sdFloor, thresholdStdDevs: config.thresholdStdDevs },
  );
  if (!reading.sufficient) return { ...base, ...shared, observed: latest.observed, reading, outcome: "insufficient_baseline", register: null };
  if (reading.atBaseline || reading.band === "inside") return { ...base, ...shared, observed: latest.observed, reading, outcome: "inside_band", register: null };

  const decision = emissionDecision(reading.sigma, latest.observed, previousObservation);
  return { ...base, ...shared, observed: latest.observed, reading, outcome: decision.outcome, register: decision.register };
}

/** What a reading outside the deadband does, and the band it leaves behind. */
export interface EmissionDecision {
  outcome: Extract<MetricOutcome, "unchanged" | "same_register" | "emitted">;
  register: MetricRegister;
}

/**
 * Whether a reading that cleared the deadband is NEWS, given the one on the
 * record.
 *
 * Its own function so the rule is readable in one place, and so the replay in
 * lib/signals/register.test.ts exercises the code that ships rather than a
 * copy of it. A metric describes a STATE; the event is the state CHANGING,
 * and there are two ways a reading fails to be a second fact, checked in this
 * order:
 *
 *   1. IDENTITY — the same number as the one on the record (Phase 21).
 *   2. THE SAME REGISTER — a different number that is called the same thing
 *      (Phase 24). This is the one that does the work on a busy day.
 *
 * Both need a record to compare against, and only an observation that
 * REPORTED left one: after an inside-band or insufficient-baseline reading
 * the next one is news whatever its number.
 */
export function emissionDecision(sigma: number, observed: number, previous: PreviousObservation | null): EmissionDecision {
  const onRecord = previous !== null && previous.reported ? previous : null;
  // The band this reading leaves, holding the one already there through
  // ordinary jitter. With nothing on the record this is the reading's own.
  const register = heldRegister(sigma, onRecord?.register ?? null);

  if (onRecord !== null && onRecord.observed !== null && isUnchangedObservation(observed, onRecord.observed)) return { outcome: "unchanged", register };
  if (onRecord !== null && onRecord.register !== null && register === onRecord.register) return { outcome: "same_register", register };
  return { outcome: "emitted", register };
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
  // Phase 21+, written ONLY for a metric whose declaration carries
  // publish_observed. This list is the outer bound the privacy trigger
  // enforces, not a description of what every payload holds.
  "observed",
  "baseline",
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
 * only: the payload is limited to METRIC_PAYLOAD_KEYS, and the previous level,
 * the delta and the sd stay in the raw tables.
 *
 * THE HEADLINE IS PLAIN LANGUAGE (Phase 21+), written by
 * lib/signals/metric-language.ts rather than in sigma. It is stored rather
 * than rendered on the way out because `signals.headline` is what the Engine's
 * narrative templates quote, what memory reads and what the LLM sees — fixing
 * the display alone would leave σ in every sentence the Engine wrote about a
 * metric. The consumer surfaces re-render from the payload anyway, which is
 * what carries the 1,950 headlines already stored in sigma.
 *
 * THE OBSERVED COUNT IS GATED. `publish_observed` on the metric's declaration
 * decides whether the observed quantity and the baseline pace reach the
 * payload; absent, neither does. See MetricConfig.publishObserved.
 */
export function metricSignal(input: {
  /**
   * The person's name and category. The category picks the nouns of the
   * stored headline (Phase 30), so a creator's reading keeps its creator
   * nouns exactly as before; the stored string is a denormalised copy that
   * every surface re-renders from the payload anyway.
   */
  person: { display_name: string; category?: string | null };
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

  // Published only where the declaration opts in, and rounded to the precision
  // a reader is shown: a stored headline and a later re-render of it must
  // agree exactly, so both sides see the same numbers.
  const published = config.publishObserved && observation.observed !== null && Number.isFinite(observation.observed) && Number.isFinite(reading.mean);
  const observed = published ? round2(observation.observed as number) : null;
  const baseline = published ? round2(reading.mean) : null;

  const headline = metricSentence({
    name: person.display_name,
    category: person.category ?? null,
    metric: config.metricKey,
    label: config.label,
    sigma,
    windowHours: config.baselineWindowHours,
    observed,
    baseline,
    // The variant is stable per person per DAY, and the day is the reading's
    // own — so re-rendering this signal tomorrow still produces this sentence.
    day: observation.recordedAt.toISOString().slice(0, 10),
  });

  const rawPayload: Record<string, unknown> = {
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
    // Both or neither: half a comparison is a bare level, not transparency,
    // and the privacy trigger refuses one without the other.
    ...(published ? { observed, baseline } : {}),
  };

  return {
    headline,
    rawPayload,
    occurredAt: observation.recordedAt,
    dedupeKey: `metric:${sourceName}:${externalIdentifier}:${config.metricKey}:${observation.recordedAt.toISOString()}`,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
