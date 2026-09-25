import { describe, expect, it } from "vitest";

import { REGISTER_HYSTERESIS_SIGMA, registerFor } from "@/lib/signals/register";

import { DEFAULT_THRESHOLD_STD_DEVS, METRIC_PAYLOAD_KEYS, UNCHANGED_RELATIVE_EPSILON, deriveMetric, describeWindow, formatSigma, isUnchangedObservation, metricSignal, observationSeries, observeMetric, outcomeReported, readMetricConfigs, type MetricConfig, type PreviousObservation, type SnapshotPoint } from "./metrics";

/**
 * The metric pipeline's pure half: configuration is strict, observations are
 * normalised against the person's own trailing window, nothing is emitted
 * below the minimum sample, and what is emitted carries no raw level.
 */

const T0 = new Date("2026-09-01T00:00:00.000Z");
const hour = (n: number) => new Date(T0.getTime() + n * 3_600_000);

const SUBSCRIBERS: MetricConfig = {
  metricKey: "subscriber_count",
  label: "YouTube subscriber growth",
  polarity: 1,
  delta: "relative_rate",
  baselineWindowHours: 168,
  minSamples: 24,
  sdFloor: 1e-5,
  scale: 1,
  thresholdStdDevs: 1,
  publishObserved: false,
};

/** Hourly snapshots growing by `perHour` each hour from `start`, with optional overrides per hour index. */
function series(start: number, perHour: number, hours: number, override: Record<number, number> = {}): SnapshotPoint[] {
  const out: SnapshotPoint[] = [];
  let value = start;
  for (let i = 0; i < hours; i += 1) {
    if (i > 0) value += override[i] ?? perHour;
    out.push({ value, recordedAt: hour(i) });
  }
  return out;
}

describe("readMetricConfigs", () => {
  it("reads a complete metric declaration", () => {
    const { metrics, derived, problems } = readMetricConfigs({
      metrics: {
        subscriber_count: { polarity: 1, delta: "relative_rate", baseline_window_hours: 168, min_samples: 24, sd_floor: 0.00001, scale: 1, label: "YouTube subscriber growth" },
        popularity: { polarity: 1, delta: "level", baseline_window_hours: 720, min_samples: 48, sd_floor: 0.1, scale: 1, threshold_std_devs: 1.5 },
      },
      derived: { upload_rate: { from: "video_count", kind: "rate", window_hours: 168 } },
    });
    expect(problems).toEqual([]);
    expect(metrics).toEqual([
      // subscriber_count declares no threshold, so it takes the default; popularity overrides it.
      { ...SUBSCRIBERS, thresholdStdDevs: DEFAULT_THRESHOLD_STD_DEVS },
      { metricKey: "popularity", label: "popularity", polarity: 1, delta: "level", baselineWindowHours: 720, minSamples: 48, sdFloor: 0.1, scale: 1, thresholdStdDevs: 1.5, publishObserved: false },
    ]);
    expect(derived).toEqual([{ metricKey: "upload_rate", from: "video_count", kind: "rate", windowHours: 168, perHours: 24, minSpanHours: 24, spikeStdDevs: 2, spikeSdFloor: 0.5, minSourceSamples: 24 }]);
  });

  it("refuses a metric without an explicit polarity, or with any field missing or malformed", () => {
    const base = { delta: "level", baseline_window_hours: 24, min_samples: 5, sd_floor: 0, scale: 1 };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base }, /polarity must be exactly 1 or -1/],
      [{ ...base, polarity: "+" }, /polarity/],
      [{ ...base, polarity: 0.5 }, /polarity/],
      [{ ...base, polarity: 1, delta: "sign" }, /delta must be one of/],
      [{ ...base, polarity: 1, baseline_window_hours: 0 }, /baseline_window_hours/],
      [{ ...base, polarity: 1, min_samples: 1 }, /min_samples/],
      [{ ...base, polarity: 1, min_samples: 2.5 }, /min_samples/],
      [{ ...base, polarity: 1, sd_floor: -1 }, /sd_floor/],
      [{ ...base, polarity: 1, scale: 0 }, /scale/],
      [{ ...base, polarity: 1, threshold_std_devs: 0 }, /threshold_std_devs/],
    ];
    for (const [entry, reason] of cases) {
      const result = readMetricConfigs({ metrics: { m: entry as never } });
      expect(result.metrics, JSON.stringify(entry)).toEqual([]);
      expect(result.problems.join("\n")).toMatch(reason);
    }
    expect(readMetricConfigs({ metrics: { "Bad Key": { polarity: 1, ...base } as never } }).problems[0]).toMatch(/snake_case/);
    expect(readMetricConfigs({ metrics: [] as never }).problems[0]).toMatch(/object keyed by metric/);
    expect(readMetricConfigs({})).toEqual({ metrics: [], derived: [], problems: [], inputs: {} });
  });
});

describe("observationSeries", () => {
  const points = series(1000, 10, 4);

  it("levels are the values themselves", () => {
    expect(observationSeries(points, "level").map((p) => p.observed)).toEqual([1000, 1010, 1020, 1030]);
  });

  it("rates need a previous point and divide by the hours between", () => {
    const absolute = observationSeries(points, "absolute_rate");
    expect(absolute.map((p) => p.observed)).toEqual([10, 10, 10]);
    expect(absolute[0]).toMatchObject({ previous: 1000, value: 1010, delta: 10 });
    const relative = observationSeries(points, "relative_rate");
    expect(relative.map((p) => p.observed)).toEqual([10 / 1000, 10 / 1010, 10 / 1020]);
    // A two-hour gap halves the rate; a zero gap or a non-positive previous level is skipped.
    const gappy = [points[0], { value: 1020, recordedAt: hour(2) }, { value: 1020, recordedAt: hour(2) }, { value: 5, recordedAt: hour(3) }, { value: 0, recordedAt: hour(4) }, { value: 3, recordedAt: hour(5) }];
    expect(observationSeries(gappy, "absolute_rate").map((p) => p.observed)).toEqual([10, -1015, -5, 3]);
    expect(observationSeries(gappy, "relative_rate").map((p) => p.observed)).toEqual([10 / 1000, -1015 / 1020, -1]);
  });
});

describe("observeMetric", () => {
  it("first contact records and reports, emitting nothing", () => {
    const observation = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history: [], current: { value: 1000, recordedAt: hour(0) } });
    expect(observation.outcome).toBe("first_contact");
    expect(observation.reading).toBeNull();
    expect(observation.previous).toBeNull();
  });

  it("without a configuration the reading is snapshot-only", () => {
    const observation = observeMetric({ metricKey: "mystery", config: null, history: series(10, 1, 5), current: { value: 15, recordedAt: hour(5) } });
    expect(observation.outcome).toBe("no_config");
    expect(observation.previous).toBe(14);
    expect(observation.delta).toBe(1);
  });

  it("BELOW THE MINIMUM SAMPLE the metric emits nothing, whatever the move", () => {
    const history = series(1_000_000, 100, 10);
    const spike = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: 1_500_000, recordedAt: hour(10) } });
    expect(spike.outcome).toBe("insufficient_baseline");
    expect(spike.reading?.samples).toBe(10);
    expect(spike.reading?.sufficient).toBe(false);
    expect(spike.reading?.sigma).toBe(0);
  });

  it("with enough history a normal reading is inside the band and a burst is emitted, in sigma", () => {
    const history = series(1_000_000, 100, 48);
    const normal = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: history[47].value + 100, recordedAt: hour(48) } });
    expect(normal.outcome).toBe("inside_band");
    expect(normal.reading?.sufficient).toBe(true);
    expect(Math.abs(normal.reading!.sigma)).toBeLessThan(1);

    const burst = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: history[47].value + 5_000, recordedAt: hour(48) } });
    expect(burst.outcome).toBe("emitted");
    expect(burst.reading!.sigma).toBeGreaterThan(3);
    expect(burst.observed).toBeCloseTo(5_000 / history[47].value);

    const drought = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: history[47].value - 2_000, recordedAt: hour(48) } });
    expect(drought.outcome).toBe("emitted");
    expect(drought.reading!.sigma).toBeLessThan(-1);
  });

  it("the baseline reaches back only the configured window", () => {
    // A wild week long ago, then a calm fortnight: the calm is the baseline.
    const wild = series(1_000_000, 10_000, 168);
    const calmStart = wild[167].value;
    const calm = series(calmStart, 100, 336).slice(1).map((p, i) => ({ value: p.value, recordedAt: hour(168 + i) }));
    const history = [...wild, ...calm];
    const observation = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: history[history.length - 1].value + 2_000, recordedAt: hour(history.length) } });
    expect(observation.outcome).toBe("emitted");
    expect(observation.reading!.samples).toBe(168);
    expect(observation.windowHours).toBe(168);
  });

  it("a level metric is judged directly", () => {
    const popularity: MetricConfig = { ...SUBSCRIBERS, metricKey: "popularity", label: "Spotify popularity", delta: "level", baselineWindowHours: 720, minSamples: 48, sdFloor: 0.5 };
    const steady = Array.from({ length: 60 }, (_, i) => ({ value: 90 + (i % 2), recordedAt: hour(i) }));
    const same = observeMetric({ metricKey: "popularity", config: popularity, history: steady, current: { value: 91, recordedAt: hour(60) } });
    expect(same.outcome).toBe("inside_band");
    const jump = observeMetric({ metricKey: "popularity", config: popularity, history: steady, current: { value: 95, recordedAt: hour(60) } });
    expect(jump.outcome).toBe("emitted");
    expect(jump.reading!.sigma).toBeGreaterThan(1);
  });
});

/**
 * Phase 21. A metric describes a STATE; the event is the state CHANGING.
 * Two independent rules, tested independently: the deadband decides whether a
 * reading is unusual at all, and emit-on-change decides whether an unusual
 * reading is news or the same fact told again.
 */
describe("the deadband", () => {
  const LEVEL: MetricConfig = { ...SUBSCRIBERS, metricKey: "popularity", label: "Spotify popularity", delta: "level", baselineWindowHours: 720, minSamples: 48, sdFloor: 0.5, thresholdStdDevs: DEFAULT_THRESHOLD_STD_DEVS };
  const steady = Array.from({ length: 60 }, (_, i) => ({ value: 90 + (i % 2), recordedAt: hour(i) }));

  it("defaults to 2.0 standard deviations, raised from Phase 7's 1.0", () => {
    // Pinned with its reason: at 1.0 a normal statistic is "unusual" 31.7% of
    // the time, and the board bore that out (news_volume_24h emitted on 45.5%
    // of its observations). Changing this number means re-deriving it, not
    // editing the test.
    expect(DEFAULT_THRESHOLD_STD_DEVS).toBe(2.0);
    expect(readMetricConfigs({ metrics: { m: { polarity: 1, delta: "level", baseline_window_hours: 24, min_samples: 5, sd_floor: 1, scale: 1 } } }).metrics[0].thresholdStdDevs).toBe(2.0);
  });

  it("is TUNABLE per metric, and the middle of the distribution no longer emits", () => {
    const current = { value: 91.2, recordedAt: hour(60) };
    const atOneSigma = observeMetric({ metricKey: "popularity", config: { ...LEVEL, thresholdStdDevs: 1 }, history: steady, current });
    const atTwoSigma = observeMetric({ metricKey: "popularity", config: LEVEL, history: steady, current });

    // The same reading against the same baseline, between one and two standard
    // deviations from it: it was a signal, and is now normal.
    expect(atOneSigma.reading!.sigma).toBe(atTwoSigma.reading!.sigma);
    expect(Math.abs(atTwoSigma.reading!.sigma)).toBeGreaterThan(1);
    expect(Math.abs(atTwoSigma.reading!.sigma)).toBeLessThan(2);
    expect(atOneSigma.outcome).toBe("emitted");
    expect(atTwoSigma.outcome).toBe("inside_band");

    // A real anomaly still emits at 2σ.
    expect(observeMetric({ metricKey: "popularity", config: LEVEL, history: steady, current: { value: 95, recordedAt: hour(60) } }).outcome).toBe("emitted");
  });
});

describe("emit on change: the identity rule (Phase 21)", () => {
  const LEVEL: MetricConfig = { ...SUBSCRIBERS, metricKey: "popularity", label: "Spotify popularity", delta: "level", baselineWindowHours: 720, minSamples: 48, sdFloor: 0.5, thresholdStdDevs: DEFAULT_THRESHOLD_STD_DEVS };
  const steady = Array.from({ length: 60 }, (_, i) => ({ value: 90 + (i % 2), recordedAt: hour(i) }));
  const observe = (value: number, previousObservation: PreviousObservation | null) =>
    observeMetric({ metricKey: "popularity", config: LEVEL, history: steady, current: { value, recordedAt: hour(60) }, previousObservation });

  // A record with no register is a row written before Phase 24, and it is
  // also the shape that isolates the identity rule from the register rule.
  const record = (observed: number | null, reported = true): PreviousObservation => ({ observed, register: null, reported });

  it("suppresses a reading identical to the one already on the record", () => {
    expect(observe(95, null).outcome).toBe("emitted");
    expect(observe(95, record(95)).outcome).toBe("unchanged");
    expect(observe(94, record(95)).outcome).toBe("emitted");
  });

  it("NEVER suppresses a metric's first emission after its baseline becomes sufficient", () => {
    // The previous observation carries the same level, but it was
    // insufficient_baseline or inside_band, so it never reported and there is
    // nothing on the record for this reading to repeat.
    for (const outcome of ["no_config", "first_contact", "insufficient_baseline", "inside_band"] as const) {
      expect(outcomeReported(outcome), outcome).toBe(false);
      expect(observe(95, record(95, outcomeReported(outcome))).outcome, outcome).toBe("emitted");
    }
    expect(outcomeReported("emitted")).toBe(true);
    expect(outcomeReported("unchanged")).toBe(true);
    expect(outcomeReported("same_register")).toBe(true);
  });

  it("is an IDENTITY check: the same quantity recomputed reads as unchanged, any real move emits", () => {
    // The epsilon exists for a float reassembled out of the ledger or a rate
    // divided by a slightly different elapsed time — NOT to filter small moves.
    expect(observe(95, record(95 * (1 + 1e-13))).outcome).toBe("unchanged");
    expect(observe(95, record(94.9999)).outcome).toBe("emitted");

    expect(isUnchangedObservation(0, 0)).toBe(true);
    expect(isUnchangedObservation(0, UNCHANGED_RELATIVE_EPSILON / 2)).toBe(true);
    expect(isUnchangedObservation(0, 1e-6)).toBe(false);
    // A single unit still counts as a move at every magnitude the board carries.
    expect(isUnchangedObservation(1e9, 1e9 + 1)).toBe(false);
    expect(isUnchangedObservation(1e9, 1e9 * (1 + 1e-14))).toBe(true);
    expect(isUnchangedObservation(Number.NaN, Number.NaN)).toBe(false);
  });

  it("an observation with no level on the record is compared against nothing", () => {
    expect(observe(95, record(null)).outcome).toBe("emitted");
  });
});

describe("emit on a change of REGISTER (Phase 24)", () => {
  // A baseline of mean 10, sd 1, so sigma reads directly off the value: a
  // reading of 12.6 is +2.6σ. That makes every band boundary legible below.
  const LEVEL: MetricConfig = { ...SUBSCRIBERS, metricKey: "news_volume_24h", label: "news volume", delta: "level", baselineWindowHours: 720, minSamples: 8, sdFloor: 0, scale: 1, thresholdStdDevs: DEFAULT_THRESHOLD_STD_DEVS };
  // Twenty points either side of 10 at exactly one unit: mean 10, sd 1.
  const steady = Array.from({ length: 40 }, (_, i) => ({ value: i % 2 === 0 ? 9 : 11, recordedAt: hour(i) }));
  const observe = (value: number, previousObservation: PreviousObservation | null) =>
    observeMetric({ metricKey: "news_volume_24h", config: LEVEL, history: steady, current: { value, recordedAt: hour(40) }, previousObservation });

  const sigmaOf = (value: number) => observe(value, null).reading?.sigma ?? Number.NaN;

  // The values below are pinned to the sigma they actually produce, because
  // the fresh reading joins the series it is judged against — so a value is
  // not simply its distance from ten. Band boundaries themselves are tested
  // where they live, in lib/signals/register.test.ts; this file tests the
  // wiring of the rule into the pipeline.
  const ELEVATED = 12.2;
  const HOLDS = 12.5;
  const RELEASES = 12.4;
  const CONCRETE = 13;
  const SPIKING = 15;

  it("sits where the test says it sits", () => {
    expect(sigmaOf(ELEVATED)).toBeCloseTo(2.055, 3);
    expect(sigmaOf(HOLDS)).toBeCloseTo(2.3, 3);
    expect(sigmaOf(RELEASES)).toBeCloseTo(2.22, 3);
    expect(sigmaOf(CONCRETE)).toBeCloseTo(2.683, 3);
    expect(sigmaOf(SPIKING)).toBeCloseTo(3.8925, 3);
    expect(registerFor(sigmaOf(ELEVATED))).toBe("elevated");
    expect(registerFor(sigmaOf(CONCRETE))).toBe("concrete");
    expect(registerFor(sigmaOf(SPIKING))).toBe("spiking");
    // The hysteresis margin, stated where the values that exercise it are.
    expect(REGISTER_HYSTERESIS_SIGMA).toBe(0.25);
    expect(sigmaOf(HOLDS)).toBeGreaterThanOrEqual(2.5 - REGISTER_HYSTERESIS_SIGMA);
    expect(sigmaOf(RELEASES)).toBeLessThan(2.5 - REGISTER_HYSTERESIS_SIGMA);
  });

  it("suppresses a number that moved but is still called the same thing", () => {
    // 47 stories then 48: two different numbers, one register.
    const first = observe(ELEVATED, null);
    expect(first.outcome).toBe("emitted");
    expect(first.register).toBe("elevated");
    const second = observe(ELEVATED + 0.1, { observed: ELEVATED, register: "elevated", reported: true });
    expect(second.outcome).toBe("same_register");
    expect(second.register).toBe("elevated");
  });

  it("emits the moment the band changes, upward with no margin at all", () => {
    // Escalation is the news, so it is reported the instant it qualifies —
    // otherwise the sentence, which is chosen from the reading alone, would
    // be worded for a band the signal never announced.
    const up = observe(CONCRETE, { observed: ELEVATED, register: "elevated", reported: true });
    expect(up.outcome).toBe("emitted");
    expect(up.register).toBe("concrete");
    const further = observe(SPIKING, { observed: CONCRETE, register: "concrete", reported: true });
    expect(further.outcome).toBe("emitted");
    expect(further.register).toBe("spiking");
  });

  it("HOLDS a band through a wobble back across the boundary, and lets go a margin below it", () => {
    // The defect this exists for: on the Mahomes window news_volume_24h
    // crossed 2.5σ in both directions six times in four hours.
    const wobble = observe(HOLDS, { observed: CONCRETE, register: "concrete", reported: true });
    expect(wobble.outcome).toBe("same_register");
    expect(wobble.register).toBe("concrete");
    const released = observe(RELEASES, { observed: CONCRETE, register: "concrete", reported: true });
    expect(released.outcome).toBe("emitted");
    expect(released.register).toBe("elevated");
  });

  it("a RUN collapses to its first, because a suppressed reading is itself on the record", () => {
    let previous: PreviousObservation | null = null;
    const outcomes: string[] = [];
    for (const value of [ELEVATED, ELEVATED + 0.1, ELEVATED + 0.2, HOLDS, ELEVATED + 0.15]) {
      const observation = observe(value, previous);
      outcomes.push(observation.outcome);
      previous = { observed: observation.observed, register: observation.register, reported: outcomeReported(observation.outcome) };
    }
    expect(outcomes).toEqual(["emitted", "same_register", "same_register", "same_register", "same_register"]);
  });

  it("clears the record when a reading falls back inside the deadband, so the next rise is news again", () => {
    const quietened = observe(11.0, { observed: CONCRETE, register: "concrete", reported: true });
    expect(quietened.outcome).toBe("inside_band");
    expect(quietened.register).toBeNull();
    const back = observe(CONCRETE, { observed: 11.0, register: null, reported: outcomeReported(quietened.outcome) });
    expect(back.outcome).toBe("emitted");
  });

  it("treats a record with no register as carrying no band, which is every row written before Phase 24", () => {
    const observation = observe(ELEVATED + 0.1, { observed: ELEVATED, register: null, reported: true });
    expect(observation.outcome).toBe("emitted");
    expect(observation.register).toBe("elevated");
  });

  it("checks identity FIRST, so an unmoved number is still reported as unmoved rather than as a held band", () => {
    expect(observe(ELEVATED, { observed: ELEVATED, register: "elevated", reported: true }).outcome).toBe("unchanged");
  });
});

describe("deriveMetric", () => {
  it("rate: the change over the window expressed per day, once the history spans enough", () => {
    const config = { metricKey: "upload_rate", from: "video_count", kind: "rate" as const, windowHours: 168, perHours: 24, minSpanHours: 24, spikeStdDevs: 2, spikeSdFloor: 0.5, minSourceSamples: 24 };
    const uploads = series(900, 0, 168, { 30: 1, 80: 1, 150: 1 });
    expect(deriveMetric(config, uploads, hour(167))).toEqual({ ok: true, value: (3 / 167) * 24 });
    expect(deriveMetric(config, uploads.slice(0, 2), hour(1))).toMatchObject({ ok: false });
    expect(deriveMetric(config, [], hour(0))).toMatchObject({ ok: false });
  });

  it("spike_count: how many readings in the window sat well above its own mean", () => {
    const config = { metricKey: "viral_moment_rate", from: "news_volume_24h", kind: "spike_count" as const, windowHours: 168, perHours: 24, minSpanHours: 24, spikeStdDevs: 2, spikeSdFloor: 0.5, minSourceSamples: 24 };
    const quiet = Array.from({ length: 100 }, (_, i) => ({ value: 3 + (i % 3), recordedAt: hour(i) }));
    expect(deriveMetric(config, quiet, hour(99))).toEqual({ ok: true, value: 0 });
    const spiky = quiet.map((p, i) => (i === 40 || i === 41 || i === 90 ? { ...p, value: 40 } : p));
    expect(deriveMetric(config, spiky, hour(99))).toEqual({ ok: true, value: 3 });
    expect(deriveMetric(config, quiet.slice(0, 10), hour(9))).toMatchObject({ ok: false });
  });
});

describe("metricSignal", () => {
  const history = series(1_000_000, 100, 48);
  const burst = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: history[47].value + 5_000, recordedAt: hour(48) } });

  it("speaks PLAIN LANGUAGE and carries direction and magnitude only", () => {
    const signal = metricSignal({ person: { display_name: "MrBeast" }, sourceName: "youtube", externalIdentifier: "UCX6OQ3DkcsbYNE6H8uQQuVA", observation: burst });
    // Phase 21+: the stored headline is the sentence a reader sees, because
    // it is also what the Engine's narrative templates quote and what memory
    // reads. σ lives in the payload, for the Engine and the operator console.
    expect(signal.headline).not.toMatch(/σ|sigma|trailing|baseline/i);
    expect(signal.headline).toContain("MrBeast");
    expect(signal.headline).not.toMatch(/\d{4,}|\d{1,3}(,\d{3})+|\d(\.\d+)?\s?[KMB]\b/);
    expect(signal.occurredAt).toEqual(hour(48));
    expect(signal.dedupeKey).toBe(`metric:youtube:UCX6OQ3DkcsbYNE6H8uQQuVA:subscriber_count:${hour(48).toISOString()}`);
    expect(signal.rawPayload).toMatchObject({ kind: "metric", metric: "subscriber_count", direction: 1, polarity: 1, samples: 48, min_samples: 24, window_hours: 168, delta_kind: "relative_rate", scale: 1, source: "youtube" });
    expect(signal.rawPayload.sigma).toBeCloseTo(burst.reading!.sigma, 2);
    // Every key is allow-listed, and subscriber_count does not opt in, so no
    // observed quantity travels with it.
    expect(Object.keys(signal.rawPayload).every((key) => (METRIC_PAYLOAD_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(signal.rawPayload).not.toHaveProperty("observed");
    expect(signal.rawPayload).not.toHaveProperty("baseline");
    // None of the underlying numbers travel: the level, the previous level, the delta, the mean, the sd.
    const serialized = JSON.stringify(signal);
    for (const forbidden of [String(burst.value), String(burst.previous), String(burst.delta), "mean", "sd", "value", "previous", "delta\""]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("publishes the observed count ONLY for a metric whose declaration opts in", () => {
    const countable: MetricConfig = { ...SUBSCRIBERS, metricKey: "news_volume_24h", label: "news volume", delta: "level", baselineWindowHours: 336, sdFloor: 1, publishObserved: true };
    const steady = Array.from({ length: 40 }, (_, i) => ({ value: 4 + (i % 2), recordedAt: hour(i) }));
    const surge = observeMetric({ metricKey: "news_volume_24h", config: countable, history: steady, current: { value: 12, recordedAt: hour(40) } });
    const signal = metricSignal({ person: { display_name: "Drake" }, sourceName: "rss", externalIdentifier: "x", observation: surge });

    expect(signal.rawPayload.observed).toBe(12);
    expect(typeof signal.rawPayload.baseline).toBe("number");
    // The same reading, the same metric, publication off: no count either way.
    const gated = metricSignal({
      person: { display_name: "Drake" },
      sourceName: "rss",
      externalIdentifier: "x",
      observation: observeMetric({ metricKey: "news_volume_24h", config: { ...countable, publishObserved: false }, history: steady, current: { value: 12, recordedAt: hour(40) } }),
    });
    expect(gated.rawPayload).not.toHaveProperty("observed");
    expect(gated.rawPayload).not.toHaveProperty("baseline");
  });

  it("direction is the declared polarity times the sign of the move, whatever the words say", () => {
    // The sentence describes the READING; direction describes what it does to
    // the score. A polarity -1 metric rising is a fall, and the words still
    // say it rose.
    const inverse = observeMetric({ metricKey: "subscriber_count", config: { ...SUBSCRIBERS, polarity: -1 }, history, current: { value: history[47].value + 5_000, recordedAt: hour(48) } });
    // A creator-platform metric on a musician: the stored headline keeps the creator nouns (Phase 30).
    const signal = metricSignal({ person: { display_name: "Drake", category: "musician" }, sourceName: "youtube", externalIdentifier: "x", observation: inverse });
    expect(signal.rawPayload).toMatchObject({ direction: -1, polarity: -1 });
    expect(signal.headline).toMatch(/gaining subscribers|piling onto/);

    const fall = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: history[47].value - 5_000, recordedAt: hour(48) } });
    const falling = metricSignal({ person: { display_name: "James", category: "creator" }, sourceName: "youtube", externalIdentifier: "x", observation: fall });
    expect(falling.rawPayload).toMatchObject({ direction: -1, polarity: 1 });
    expect(falling.headline).toMatch(/slowed|more slowly/);
    // The possessive follows one rule for the whole app.
    expect(falling.headline).not.toContain("James's");
  });

  it("refuses to build a signal for anything not emitted", () => {
    const thin = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history: history.slice(0, 5), current: { value: 5_000_000, recordedAt: hour(5) } });
    expect(() => metricSignal({ person: { display_name: "MrBeast" }, sourceName: "youtube", externalIdentifier: "x", observation: thin })).toThrow(/insufficient_baseline/);
  });

  it("formats sigma and windows for the headline", () => {
    expect(formatSigma(1.44)).toBe("+1.4σ");
    expect(formatSigma(-2.06)).toBe("-2.1σ");
    expect(formatSigma(0)).toBe("0.0σ");
    expect(formatSigma(500)).toBe("+99.9σ");
    expect(describeWindow(24)).toBe("day");
    expect(describeWindow(168)).toBe("week");
    expect(describeWindow(336)).toBe("fortnight");
    expect(describeWindow(720)).toBe("month");
    expect(describeWindow(72)).toBe("3 days");
    expect(describeWindow(36)).toBe("36 hours");
  });
});

describe("declared inputs", () => {
  it("names a derived metric's undeclared source as an input, so an unscored snapshot is not an oversight", () => {
    // YouTube's shape: upload_rate is derived from video_count, which carries no declaration of its own.
    const configs = readMetricConfigs({
      metrics: { upload_rate: { label: "upload cadence", polarity: 1, delta: "level", baseline_window_hours: 720, min_samples: 48, sd_floor: 0.15, scale: 0.6 } },
      derived: { upload_rate: { from: "video_count", kind: "rate", window_hours: 168, per_hours: 24, min_span_hours: 160 } },
    });
    expect(configs.inputs).toEqual({ video_count: "upload_rate" });
    expect(configs.problems).toEqual([]);

    // A source metric that IS declared is scored on its own terms and is not an input.
    const declared = readMetricConfigs({
      metrics: {
        news_volume_24h: { label: "news volume", polarity: 1, delta: "level", baseline_window_hours: 336, min_samples: 24, sd_floor: 0.5, scale: 0.7 },
        viral_moment_rate: { label: "viral-moment frequency", polarity: 1, delta: "level", baseline_window_hours: 720, min_samples: 48, sd_floor: 0.25, scale: 0.5 },
      },
      derived: { viral_moment_rate: { from: "news_volume_24h", kind: "spike_count", window_hours: 168, spike_std_devs: 2, spike_sd_floor: 0.5, min_source_samples: 24 } },
    });
    expect(declared.inputs).toEqual({});
  });
});
