import { describe, expect, it } from "vitest";

import { METRIC_PAYLOAD_KEYS, deriveMetric, describeWindow, formatSigma, metricSignal, observationSeries, observeMetric, readMetricConfigs, type MetricConfig, type SnapshotPoint } from "./metrics";

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
      SUBSCRIBERS,
      { metricKey: "popularity", label: "popularity", polarity: 1, delta: "level", baselineWindowHours: 720, minSamples: 48, sdFloor: 0.1, scale: 1, thresholdStdDevs: 1.5 },
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
    expect(readMetricConfigs({})).toEqual({ metrics: [], derived: [], problems: [] });
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

  it("speaks in sigma against the person's own window and carries direction and magnitude only", () => {
    const signal = metricSignal({ person: { display_name: "MrBeast" }, sourceName: "youtube", externalIdentifier: "UCX6OQ3DkcsbYNE6H8uQQuVA", observation: burst });
    expect(signal.headline).toMatch(/^MrBeast's YouTube subscriber growth is running \+\d+\.\dσ above their own trailing week$/);
    expect(signal.headline).not.toMatch(/\d{4,}|\d{1,3}(,\d{3})+|\d(\.\d+)?\s?[KMB]\b/);
    expect(signal.occurredAt).toEqual(hour(48));
    expect(signal.dedupeKey).toBe(`metric:youtube:UCX6OQ3DkcsbYNE6H8uQQuVA:subscriber_count:${hour(48).toISOString()}`);
    expect(Object.keys(signal.rawPayload).sort()).toEqual([...METRIC_PAYLOAD_KEYS].sort());
    expect(signal.rawPayload).toMatchObject({ kind: "metric", metric: "subscriber_count", direction: 1, polarity: 1, samples: 48, min_samples: 24, window_hours: 168, delta_kind: "relative_rate", scale: 1, source: "youtube" });
    expect(signal.rawPayload.sigma).toBeCloseTo(burst.reading!.sigma, 2);
    // None of the underlying numbers travel: the level, the previous level, the delta, the mean, the sd.
    const serialized = JSON.stringify(signal);
    for (const forbidden of [String(burst.value), String(burst.previous), String(burst.delta), "mean", "sd", "value", "previous", "delta\""]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("direction is the declared polarity times the sign of the move", () => {
    const inverse = observeMetric({ metricKey: "subscriber_count", config: { ...SUBSCRIBERS, polarity: -1 }, history, current: { value: history[47].value + 5_000, recordedAt: hour(48) } });
    const signal = metricSignal({ person: { display_name: "Drake" }, sourceName: "youtube", externalIdentifier: "x", observation: inverse });
    expect(signal.rawPayload).toMatchObject({ direction: -1, polarity: -1 });
    expect(signal.headline).toContain("above");
    const fall = observeMetric({ metricKey: "subscriber_count", config: SUBSCRIBERS, history, current: { value: history[47].value - 5_000, recordedAt: hour(48) } });
    expect(metricSignal({ person: { display_name: "James" }, sourceName: "youtube", externalIdentifier: "x", observation: fall }).headline).toMatch(/^James' YouTube subscriber growth is running -\d+\.\dσ below/);
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
