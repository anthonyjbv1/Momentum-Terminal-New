import { connectorRegistry, type ConnectorRegistry } from "@/lib/connectors/registry";
import type { ConnectorContext, MetricReading, RawSignal, SnapshotStore } from "@/lib/connectors/types";
import type { DataSource } from "@/types";
import type { Json } from "@/types/database";

import { deriveMetric, metricSignal, observeMetric, readMetricConfigs, type MetricConfigs, type MetricObservation, type SnapshotPoint } from "./metrics";
import type { IngestStore, IngestTrigger, ObservationRow, PollRow, PollStatus, SignalRow, SnapshotRow } from "./store";

/**
 * The ingestion runner.
 *
 * For every data_sources row with is_active = true that has a registered,
 * available connector, it loads the active person_data_sources mappings and
 * polls the connector once per person:
 *
 *   events    fetchForPerson → RawSignals, stored as they are (processed = false)
 *   metrics   fetchMetrics → raw levels → snapshot → delta against the
 *             person's previous snapshots → normalised against their own
 *             trailing baseline (lib/ingest/metrics.ts) → a signal only when
 *             the baseline is sufficient and the reading is outside the band
 *   derived   config.derived metrics computed from another metric's history,
 *             then normalised the same way
 *
 * Nothing here names a source. What a metric means is on its data_sources
 * row; adding or removing a source is a row and a credential.
 *
 * Observability: the run, every poll (source, person, outcome, latency) and
 * every observation (level, delta, baseline statistics, sigma, outcome,
 * the signal it produced) are written through the store and logged, so a
 * score move can be reconstructed from the signal back to the poll.
 *
 * A source whose connector reports missing credentials is inactive for the
 * run: recorded, logged, skipped; the rest of the run is unaffected. One
 * person's failure never stops the run either.
 *
 * Trusted server code only — the store is backed by the service-role client.
 */

export interface IngestLogLine {
  event: "run" | "source" | "poll" | "observation" | "signal";
  [key: string]: unknown;
}

export interface IngestOptions {
  store: IngestStore;
  /** Defaults to the shared connector registry. Injectable for tests. */
  registry?: ConnectorRegistry;
  /** Only run these source names (e.g. ["youtube"]). Defaults to every active source. */
  sources?: string[];
  /** Wall-clock time for the run. Defaults to new Date(). */
  now?: Date;
  /** fetch implementation handed to connectors. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout for connector HTTP calls. Default 20s. */
  timeoutMs?: number;
  /** Poll every source even if it was polled within its interval. */
  force?: boolean;
  trigger?: IngestTrigger;
  /** Structured log sink. Defaults to console.info with an [ingest] prefix. */
  log?: (line: IngestLogLine) => void;
}

export interface SourceRunSummary {
  name: string;
  people: number;
  signalsCreated: number;
  eventSignals: number;
  metricSignals: number;
  snapshotsRecorded: number;
  observations: number;
  errors: number;
}

export interface IngestError {
  source: string;
  person?: string;
  message: string;
}

export interface IngestSummary {
  runId: string;
  trigger: IngestTrigger;
  forced: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sourcesRun: SourceRunSummary[];
  sourcesSkipped: Array<{ name: string; reason: string }>;
  /** Malformed metric declarations found in data_sources.config; those metrics were snapshot-only. */
  configProblems: Array<{ source: string; problem: string }>;
  totals: {
    sources: number;
    people: number;
    signalsCreated: number;
    snapshotsRecorded: number;
    observations: number;
    errors: number;
  };
  errors: IngestError[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
const HOUR_MS = 3_600_000;

function asConfigObject(config: Json | null): Record<string, Json | undefined> {
  return config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function defaultLog(line: IngestLogLine): void {
  console.info(`[ingest] ${JSON.stringify(line)}`);
}

/** How far back the history of one metric must be loaded: its own window, and any derived window that reads it. */
function lookbackHours(metricKey: string, configs: MetricConfigs): number {
  const own = configs.metrics.find((m) => m.metricKey === metricKey)?.baselineWindowHours ?? 0;
  const derived = configs.derived.filter((d) => d.from === metricKey).map((d) => d.windowHours);
  return Math.max(1, own, ...derived);
}

function observationRow(runId: string, personId: string, source: DataSource, observation: MetricObservation, signalId: string | null): ObservationRow {
  const reading = observation.reading;
  return {
    runId,
    personId,
    dataSourceId: source.id,
    metricKey: observation.metricKey,
    recordedAt: observation.recordedAt,
    value: observation.value,
    previous: observation.previous,
    delta: observation.delta,
    deltaKind: observation.deltaKind,
    observed: observation.observed,
    mean: reading?.mean ?? null,
    sd: reading?.sd ?? null,
    sdApplied: reading?.sdApplied ?? null,
    sigma: reading?.sigma ?? null,
    samples: reading?.samples ?? null,
    minSamples: reading?.minSamples ?? null,
    windowHours: observation.windowHours,
    outcome: observation.outcome,
    signalId,
  };
}

export async function runIngestion(options: IngestOptions): Promise<IngestSummary> {
  const {
    store,
    registry = connectorRegistry,
    now = new Date(),
    fetch: baseFetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    force = false,
    trigger = "manual",
    log = defaultLog,
  } = options;
  const wallClockStart = Date.now();
  const requested = options.sources && options.sources.length > 0 ? [...options.sources] : null;

  const fetchWithTimeout: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });

  const runId = await store.beginRun({ startedAt: now, trigger, forced: force, requestedSources: requested });

  const sourcesRun: SourceRunSummary[] = [];
  const sourcesSkipped: IngestSummary["sourcesSkipped"] = [];
  const configProblems: IngestSummary["configProblems"] = [];
  const errors: IngestError[] = [];

  /** A source-level outcome: recorded as a poll with no person, and in the summary. */
  const skipSource = async (source: DataSource, reason: string) => {
    sourcesSkipped.push({ name: source.name, reason });
    log({ event: "source", run: runId, source: source.name, status: "skipped", reason });
    await store.recordPoll({
      runId,
      dataSourceId: source.id,
      personId: null,
      status: "skipped",
      reason,
      latencyMs: null,
      signalsCreated: 0,
      snapshotsRecorded: 0,
      observations: 0,
      startedAt: now,
      finishedAt: now,
    });
  };

  let activeSources = await store.listActiveSources();
  if (requested) {
    const wanted = new Set(requested);
    activeSources = activeSources.filter((source) => wanted.has(source.name));
  }

  for (const source of activeSources) {
    const connector = registry.get(source.name);
    if (!connector) {
      await skipSource(source, "no connector registered for this source");
      continue;
    }

    const availability = connector.available?.() ?? { ok: true };
    if (!availability.ok) {
      await skipSource(source, `inactive: ${availability.reason}`);
      continue;
    }

    if (!force) {
      const last = await store.lastSuccessfulPollAt(source.id);
      if (last) {
        const minutesAgo = (now.getTime() - last.getTime()) / 60_000;
        if (minutesAgo < source.poll_interval_minutes) {
          await skipSource(source, `polled ${Math.floor(minutesAgo)} min ago; interval ${source.poll_interval_minutes} min (pass force to poll now)`);
          continue;
        }
      }
    }

    let mappings;
    try {
      mappings = await store.listMappings(source.id);
    } catch (error) {
      errors.push({ source: source.name, message: errorMessage(error) });
      sourcesRun.push({ name: source.name, people: 0, signalsCreated: 0, eventSignals: 0, metricSignals: 0, snapshotsRecorded: 0, observations: 0, errors: 1 });
      continue;
    }

    if (mappings.length === 0) {
      await skipSource(source, "no active person_data_sources mappings");
      continue;
    }

    const config = asConfigObject(source.config);
    const configs = readMetricConfigs(config);
    for (const problem of configs.problems) {
      configProblems.push({ source: source.name, problem });
      log({ event: "source", run: runId, source: source.name, status: "config_problem", problem });
    }

    const summary: SourceRunSummary = {
      name: source.name,
      people: mappings.length,
      signalsCreated: 0,
      eventSignals: 0,
      metricSignals: 0,
      snapshotsRecorded: 0,
      observations: 0,
      errors: 0,
    };

    for (const { person, externalIdentifier } of mappings) {
      const pollStarted = Date.now();
      const pendingSnapshots: SnapshotRow[] = [];
      const snapshots: SnapshotStore = {
        latest: (metricKey) => store.latestSnapshot(person.id, source.id, metricKey),
        record: (metricKey, value, recordedAt = now) =>
          pendingSnapshots.push({ personId: person.id, dataSourceId: source.id, metricKey, value, recordedAt }),
      };
      const context: ConnectorContext = { source, config, snapshots, now, fetch: fetchWithTimeout };
      const poll: Omit<PollRow, "status" | "reason" | "latencyMs" | "finishedAt"> = {
        runId,
        dataSourceId: source.id,
        personId: person.id,
        signalsCreated: 0,
        snapshotsRecorded: 0,
        observations: 0,
        // Poll times are measured from the run's `now`, so a run with an
        // injected clock stays consistent with itself and reproducible.
        startedAt: new Date(now.getTime() + (Date.now() - wallClockStart)),
      };
      let status: PollStatus = "ok";
      let reason: string | null = null;

      try {
        // 1. Poll ---------------------------------------------------------------
        const events: RawSignal[] = await connector.fetchForPerson(person, externalIdentifier, context);
        const readings: MetricReading[] = connector.fetchMetrics ? await connector.fetchMetrics(person, externalIdentifier, context) : [];

        // 2. Snapshot + history -------------------------------------------------
        const current = new Map<string, SnapshotPoint>();
        const history = new Map<string, SnapshotPoint[]>();
        for (const reading of readings) {
          if (!Number.isFinite(reading.value)) continue;
          const recordedAt = reading.recordedAt ?? now;
          current.set(reading.metricKey, { value: reading.value, recordedAt });
          const since = new Date(recordedAt.getTime() - lookbackHours(reading.metricKey, configs) * HOUR_MS);
          history.set(
            reading.metricKey,
            (await store.listSnapshots(person.id, source.id, reading.metricKey, since)).map((s) => ({ value: s.value, recordedAt: s.recordedAt })),
          );
        }

        // 3. Derived metrics, from another metric's history plus its fresh reading --
        for (const derived of configs.derived) {
          const base = current.get(derived.from);
          if (!base) {
            log({ event: "observation", run: runId, source: source.name, person: person.slug, metric: derived.metricKey, outcome: "skipped", reason: `source metric ${derived.from} not read this run` });
            continue;
          }
          const result = deriveMetric(derived, [...(history.get(derived.from) ?? []), base], now);
          if (!result.ok) {
            log({ event: "observation", run: runId, source: source.name, person: person.slug, metric: derived.metricKey, outcome: "skipped", reason: result.reason });
            continue;
          }
          current.set(derived.metricKey, { value: result.value, recordedAt: now });
          const since = new Date(now.getTime() - lookbackHours(derived.metricKey, configs) * HOUR_MS);
          history.set(
            derived.metricKey,
            (await store.listSnapshots(person.id, source.id, derived.metricKey, since)).map((s) => ({ value: s.value, recordedAt: s.recordedAt })),
          );
        }

        // 4. Normalise: every reading against the person's own trailing baseline --
        const observations: Array<{ observation: MetricObservation; signal: RawSignal | null }> = [];
        for (const [metricKey, point] of current) {
          const metricConfig = configs.metrics.find((m) => m.metricKey === metricKey) ?? null;
          const observation = observeMetric({ metricKey, config: metricConfig, history: history.get(metricKey) ?? [], current: point });
          const signal = observation.outcome === "emitted" ? metricSignal({ person, sourceName: source.name, externalIdentifier, observation }) : null;
          observations.push({ observation, signal });
          log({
            event: "observation",
            run: runId,
            source: source.name,
            person: person.slug,
            metric: metricKey,
            outcome: observation.outcome,
            value: observation.value,
            previous: observation.previous,
            delta: observation.delta,
            deltaKind: observation.deltaKind,
            observed: observation.observed,
            mean: observation.reading?.mean ?? null,
            sd: observation.reading?.sd ?? null,
            sdApplied: observation.reading?.sdApplied ?? null,
            sigma: observation.reading?.sigma ?? null,
            samples: observation.reading?.samples ?? null,
            minSamples: observation.reading?.minSamples ?? null,
            windowHours: observation.windowHours,
          });
        }

        // 5. Persist -----------------------------------------------------------
        const metricSignals = observations.flatMap((o) => (o.signal ? [o.signal] : []));
        const toRow = (signal: RawSignal): SignalRow => ({
          personId: person.id,
          dataSourceId: source.id,
          headline: signal.headline,
          rawPayload: signal.rawPayload,
          occurredAt: signal.occurredAt,
          dedupeKey: signal.dedupeKey,
        });
        const stored = await store.insertSignals([...events, ...metricSignals].map(toRow));
        const idByDedupeKey = new Map(stored.filter((s) => s.dedupeKey !== null).map((s) => [s.dedupeKey as string, s.id]));
        const metricStored = metricSignals.filter((s) => s.dedupeKey && idByDedupeKey.has(s.dedupeKey)).length;
        summary.signalsCreated += stored.length;
        summary.metricSignals += metricStored;
        summary.eventSignals += stored.length - metricStored;
        poll.signalsCreated = stored.length;

        const snapshotRows: SnapshotRow[] = [
          ...pendingSnapshots,
          ...[...current].map(([metricKey, point]) => ({ personId: person.id, dataSourceId: source.id, metricKey, value: point.value, recordedAt: point.recordedAt })),
        ];
        poll.snapshotsRecorded = await store.insertSnapshots(snapshotRows);
        summary.snapshotsRecorded += poll.snapshotsRecorded;

        poll.observations = await store.recordObservations(
          observations.map(({ observation, signal }) => observationRow(runId, person.id, source, observation, signal?.dedupeKey ? (idByDedupeKey.get(signal.dedupeKey) ?? null) : null)),
        );
        summary.observations += poll.observations;

        for (const { observation, signal } of observations) {
          if (!signal) continue;
          log({
            event: "signal",
            run: runId,
            source: source.name,
            person: person.slug,
            metric: observation.metricKey,
            sigma: signal.rawPayload.sigma,
            direction: signal.rawPayload.direction,
            polarity: signal.rawPayload.polarity,
            signalId: signal.dedupeKey ? (idByDedupeKey.get(signal.dedupeKey) ?? null) : null,
            stored: Boolean(signal.dedupeKey && idByDedupeKey.has(signal.dedupeKey)),
            headline: signal.headline,
          });
        }
      } catch (error) {
        status = "error";
        reason = errorMessage(error);
        summary.errors += 1;
        errors.push({ source: source.name, person: person.slug, message: reason });
      }

      const latencyMs = Date.now() - pollStarted;
      const finishedAt = new Date(poll.startedAt.getTime() + latencyMs);
      log({ event: "poll", run: runId, source: source.name, person: person.slug, status, reason, latencyMs, signals: poll.signalsCreated, snapshots: poll.snapshotsRecorded, observations: poll.observations });
      try {
        await store.recordPoll({ ...poll, status, reason, latencyMs, finishedAt });
      } catch (error) {
        errors.push({ source: source.name, person: person.slug, message: `poll log failed: ${errorMessage(error)}` });
      }
    }

    sourcesRun.push(summary);
  }

  const durationMs = Math.max(0, Date.now() - wallClockStart);
  const finishedAt = new Date(now.getTime() + durationMs);
  const totals = {
    sources: sourcesRun.length,
    people: sourcesRun.reduce((sum, s) => sum + s.people, 0),
    signalsCreated: sourcesRun.reduce((sum, s) => sum + s.signalsCreated, 0),
    snapshotsRecorded: sourcesRun.reduce((sum, s) => sum + s.snapshotsRecorded, 0),
    observations: sourcesRun.reduce((sum, s) => sum + s.observations, 0),
    errors: errors.length,
  };
  const summary: IngestSummary = {
    runId,
    trigger,
    forced: force,
    startedAt: now.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    sourcesRun,
    sourcesSkipped,
    configProblems,
    totals,
    errors,
  };

  log({ event: "run", run: runId, trigger, forced: force, durationMs, ...totals, skipped: sourcesSkipped.length });
  try {
    await store.finishRun(runId, {
      finishedAt,
      summary: summary as unknown as Json,
      sourcesRun: totals.sources,
      signalsCreated: totals.signalsCreated,
      snapshotsRecorded: totals.snapshotsRecorded,
      observations: totals.observations,
      errors: totals.errors,
    });
  } catch (error) {
    summary.errors.push({ source: "run", message: `run log failed: ${errorMessage(error)}` });
    summary.totals.errors = summary.errors.length;
  }
  return summary;
}
