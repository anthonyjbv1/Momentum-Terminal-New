import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { metricScorer } from "@/lib/engine/sentiment/metric";
import type { Json } from "@/types/database";
import { DEFAULT_THRESHOLD_STD_DEVS, METRIC_PAYLOAD_KEYS, metricSignal, observeMetric, type MetricConfig } from "@/lib/ingest/metrics";
import { REGISTER_BANDS } from "@/lib/signals/register";
import { metricSentence } from "@/lib/signals/metric-language";

/**
 * PHASE 21+ IS A DISPLAY CHANGE. These are the tests that say so.
 *
 * The language layer chooses words for a reading that has already been judged.
 * It must not be able to change what a metric measures, what emits, where a
 * threshold sits, or what a signal is worth to the score — and no consumer
 * surface may show σ.
 */

const BASE: MetricConfig = {
  metricKey: "news_volume_24h",
  label: "news volume",
  polarity: 1,
  delta: "level",
  baselineWindowHours: 336,
  minSamples: 24,
  sdFloor: 1,
  scale: 1,
  thresholdStdDevs: DEFAULT_THRESHOLD_STD_DEVS,
  publishObserved: true,
};

const T0 = new Date("2026-09-19T00:00:00.000Z");
const hour = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const steady = Array.from({ length: 40 }, (_, i) => ({ value: 4 + (i % 2), recordedAt: hour(i) }));

describe("the language layer cannot move a score", () => {
  it("publishing a count changes the words and NOTHING the Engine reads", async () => {
    const current = { value: 12, recordedAt: hour(40) };
    const shown = observeMetric({ metricKey: BASE.metricKey, config: BASE, history: steady, current });
    const hidden = observeMetric({ metricKey: BASE.metricKey, config: { ...BASE, publishObserved: false }, history: steady, current });

    // The observation is identical either way: same outcome, same sigma, same
    // everything the deadband and the emission rule look at.
    expect(shown.outcome).toBe(hidden.outcome);
    expect(shown.reading!.sigma).toBe(hidden.reading!.sigma);
    expect(shown.observed).toBe(hidden.observed);
    expect(shown.reading!.mean).toBe(hidden.reading!.mean);
    expect(shown.reading!.threshold).toBe(hidden.reading!.threshold);

    const withCount = metricSignal({ person: { display_name: "Drake" }, sourceName: "rss", externalIdentifier: "x", observation: shown });
    const without = metricSignal({ person: { display_name: "Drake" }, sourceName: "rss", externalIdentifier: "x", observation: hidden });

    // Only the words and the two published numbers differ.
    expect(withCount.rawPayload.sigma).toBe(without.rawPayload.sigma);
    expect(withCount.rawPayload.direction).toBe(without.rawPayload.direction);
    expect(withCount.rawPayload.scale).toBe(without.rawPayload.scale);
    expect(withCount.dedupeKey).toBe(without.dedupeKey);
    expect(withCount.occurredAt).toEqual(without.occurredAt);

    // And the Engine scores them identically, because it reads sigma, polarity
    // and scale — never the headline and never the counts.
    const scoreOf = (signal: { headline: string; rawPayload: Record<string, unknown> }) =>
      metricScorer.scoreSignal({ id: "s1", personId: "p1", sourceName: "rss", sourceTier: 3, headline: signal.headline, rawPayload: signal.rawPayload as Json });
    const [a, b] = await Promise.all([scoreOf(withCount), scoreOf(without)]);
    expect({ ...a, rationale: "" }).toEqual({ ...b, rationale: "" });
  });

  it("the deadband and the emission rule are untouched by Phase 21+", () => {
    // Pinned here as well as in metrics.test.ts, because this is the phase
    // that must not have moved them.
    expect(DEFAULT_THRESHOLD_STD_DEVS).toBe(2.0);
    const inside = observeMetric({ metricKey: BASE.metricKey, config: BASE, history: steady, current: { value: 5, recordedAt: hour(40) } });
    const outside = observeMetric({ metricKey: BASE.metricKey, config: BASE, history: steady, current: { value: 12, recordedAt: hour(40) } });
    expect(inside.outcome).toBe("inside_band");
    expect(outside.outcome).toBe("emitted");
  });

  it("words never reach the scorer: the same sigma scores the same however it is phrased", async () => {
    const payload = { kind: "metric", metric: "news_volume_24h", label: "news volume", sigma: 2.9, direction: 1, polarity: 1, window_hours: 336, scale: 1, source: "rss" };
    const score = (extra: Record<string, unknown> = {}, headline = "anything") =>
      metricScorer.scoreSignal({ id: "s1", personId: "p1", sourceName: "rss", sourceTier: 3, headline, rawPayload: { ...payload, ...extra } as Json });
    const plain = await score();
    // A published count changes nothing the scorer reads.
    const counted = await score({ observed: 12, baseline: 4 }, "12 stories on Drake today — 3x their usual pace");
    expect(counted.direction).toBe(plain.direction);
    expect(counted.confidence).toBe(plain.confidence);
    expect(counted.anomaly).toBe(plain.anomaly);
    expect(counted.label).toBe(plain.label);
  });
});

describe("Phase 24 changed WHEN a metric speaks, and nothing about what a spoken one is worth", () => {
  it("leaves the deadband and the register bands exactly where they were", () => {
    expect(DEFAULT_THRESHOLD_STD_DEVS).toBe(2.0);
    expect(REGISTER_BANDS).toEqual({ spiking: 3.5, concrete: 2.5 });
  });

  it("never lets the register reach a signal payload, so the Engine cannot read one", () => {
    expect(METRIC_PAYLOAD_KEYS as readonly string[]).not.toContain("register");
    const observation = observeMetric({ metricKey: BASE.metricKey, config: BASE, history: steady, current: { value: 12, recordedAt: hour(40) } });
    expect(observation.register).toBe("spiking");
    const signal = metricSignal({ person: { display_name: "Drake" }, sourceName: "rss", externalIdentifier: "x", observation });
    expect(Object.keys(signal.rawPayload)).not.toContain("register");
  });

  it("scores an emitted signal identically whatever the record behind it held", async () => {
    // The rule decides whether a reading is SAID. Once said, the signal and
    // its score are the ones Phase 7 defined and Phase 21+ left alone.
    const current = { value: 12, recordedAt: hour(40) };
    const fresh = observeMetric({ metricKey: BASE.metricKey, config: BASE, history: steady, current });
    const afterQuiet = observeMetric({
      metricKey: BASE.metricKey,
      config: BASE,
      history: steady,
      current,
      previousObservation: { observed: 5, register: "elevated", reported: true },
    });
    expect(fresh.outcome).toBe("emitted");
    expect(afterQuiet.outcome).toBe("emitted");

    const build = (observation: typeof fresh) => metricSignal({ person: { display_name: "Drake" }, sourceName: "rss", externalIdentifier: "x", observation });
    expect(build(fresh).rawPayload).toEqual(build(afterQuiet).rawPayload);
    expect(build(fresh).headline).toBe(build(afterQuiet).headline);

    const scoreOf = (signal: { headline: string; rawPayload: Record<string, unknown> }) =>
      metricScorer.scoreSignal({ id: "s1", personId: "p1", sourceName: "rss", sourceTier: 3, headline: signal.headline, rawPayload: signal.rawPayload as Json });
    const [a, b] = await Promise.all([scoreOf(build(fresh)), scoreOf(build(afterQuiet))]);
    expect(a).toEqual(b);
  });

  it("keeps the words out of the rule: the sentence a reading gets does not decide whether it is said", () => {
    // Two readings in the same band, worded differently because one publishes
    // a count and the other does not. Both are suppressed all the same.
    const current = { value: 12, recordedAt: hour(40) };
    const record = { observed: 11, register: "spiking" as const, reported: true };
    const shown = observeMetric({ metricKey: BASE.metricKey, config: BASE, history: steady, current, previousObservation: record });
    const hidden = observeMetric({ metricKey: BASE.metricKey, config: { ...BASE, publishObserved: false }, history: steady, current, previousObservation: record });
    expect(shown.outcome).toBe("same_register");
    expect(hidden.outcome).toBe(shown.outcome);
    expect(hidden.register).toBe(shown.register);
  });
});

/** Every source file under the app, excluding dependencies, build output and tests. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", "supabase", "public"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry) && !full.includes("__tests__")) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("σ does not appear in the consumer app", () => {
  it("is named by no page and no component, in code or in copy", () => {
    const root = join(__dirname, "..", "..");
    const offenders = sourceFiles(root)
      .filter((file) => /^(app|components)\//.test(relative(root, file)))
      // /admin is the operator console, where σ belongs and stays.
      .filter((file) => !relative(root, file).includes("admin"))
      .filter((file) => /σ/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("survives every band and every metric, for a sample of real readings", () => {
    // The language module has its own exhaustive sweep; this is the end-to-end
    // one, through the function ingestion actually calls.
    for (const sigma of [-6, -3.6, -2.1, 2.0, 2.4, 2.9, 3.6, 9]) {
      for (const name of ["Drake", "Mark Zuckerberg", "Kai Cenat"]) {
        const sentence = metricSentence({ name, metric: "news_volume_24h", label: "news volume", sigma, windowHours: 336, observed: 12, baseline: 4, day: "2026-09-20" });
        expect(sentence, sentence).not.toMatch(/σ|sigma|standard deviation|trailing|baseline/i);
      }
    }
  });

  it("keeps σ where it belongs: the operator console still formats it", async () => {
    const { formatSigma } = await import("@/lib/ingest/metrics");
    expect(formatSigma(2.86)).toBe("+2.9σ");
    // And the admin console reads the raw ledger's own numbers, which is the
    // one place the statistic is the point.
    const root = join(__dirname, "..", "..");
    const adminReadsOutcomes = readFileSync(join(root, "components/admin/ingestion.tsx"), "utf8");
    expect(adminReadsOutcomes).toContain("unchanged");
  });
});
