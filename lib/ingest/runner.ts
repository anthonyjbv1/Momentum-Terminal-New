import { connectorRegistry, type ConnectorRegistry } from "@/lib/connectors/registry";
import type { ConnectorContext, SnapshotStore } from "@/lib/connectors/types";
import type { Json } from "@/types/database";

import type { IngestStore, SnapshotRow } from "./store";

/**
 * The ingestion runner.
 *
 * For every data_sources row with is_active = true that has a registered
 * connector, it loads the active person_data_sources mappings, calls the
 * connector once per person, stores the returned RawSignals (processed =
 * false) and persists the snapshots the connector recorded. One person's
 * failure never stops the run: it is captured in the summary.
 *
 * Trusted server code only — the store is backed by the service-role client.
 */

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
}

export interface SourceRunSummary {
  name: string;
  people: number;
  signalsCreated: number;
  snapshotsRecorded: number;
  errors: number;
}

export interface IngestError {
  source: string;
  person?: string;
  message: string;
}

export interface IngestSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sourcesRun: SourceRunSummary[];
  sourcesSkipped: Array<{ name: string; reason: string }>;
  totals: {
    sources: number;
    people: number;
    signalsCreated: number;
    snapshotsRecorded: number;
    errors: number;
  };
  errors: IngestError[];
}

const DEFAULT_TIMEOUT_MS = 20_000;

function asConfigObject(config: Json | null): Record<string, Json | undefined> {
  return config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runIngestion(options: IngestOptions): Promise<IngestSummary> {
  const {
    store,
    registry = connectorRegistry,
    now = new Date(),
    fetch: baseFetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const startedAt = Date.now();

  const fetchWithTimeout: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });

  const sourcesRun: SourceRunSummary[] = [];
  const sourcesSkipped: IngestSummary["sourcesSkipped"] = [];
  const errors: IngestError[] = [];

  let activeSources = await store.listActiveSources();
  if (options.sources && options.sources.length > 0) {
    const wanted = new Set(options.sources);
    activeSources = activeSources.filter((source) => wanted.has(source.name));
  }

  for (const source of activeSources) {
    const connector = registry.get(source.name);
    if (!connector) {
      sourcesSkipped.push({ name: source.name, reason: "no connector registered for this source" });
      continue;
    }

    let mappings;
    try {
      mappings = await store.listMappings(source.id);
    } catch (error) {
      errors.push({ source: source.name, message: errorMessage(error) });
      sourcesRun.push({ name: source.name, people: 0, signalsCreated: 0, snapshotsRecorded: 0, errors: 1 });
      continue;
    }

    if (mappings.length === 0) {
      sourcesSkipped.push({ name: source.name, reason: "no active person_data_sources mappings" });
      continue;
    }

    const summary: SourceRunSummary = {
      name: source.name,
      people: mappings.length,
      signalsCreated: 0,
      snapshotsRecorded: 0,
      errors: 0,
    };
    const config = asConfigObject(source.config);

    for (const { person, externalIdentifier } of mappings) {
      const pendingSnapshots: SnapshotRow[] = [];
      const snapshots: SnapshotStore = {
        latest: (metricKey) => store.latestSnapshot(person.id, source.id, metricKey),
        record: (metricKey, value, recordedAt = now) =>
          pendingSnapshots.push({ personId: person.id, dataSourceId: source.id, metricKey, value, recordedAt }),
      };
      const context: ConnectorContext = { source, config, snapshots, now, fetch: fetchWithTimeout };

      try {
        const rawSignals = await connector.fetchForPerson(person, externalIdentifier, context);

        summary.signalsCreated += await store.insertSignals(
          rawSignals.map((signal) => ({
            personId: person.id,
            dataSourceId: source.id,
            headline: signal.headline,
            rawPayload: signal.rawPayload,
            occurredAt: signal.occurredAt,
            dedupeKey: signal.dedupeKey,
          })),
        );
        summary.snapshotsRecorded += await store.insertSnapshots(pendingSnapshots);
      } catch (error) {
        summary.errors += 1;
        errors.push({ source: source.name, person: person.slug, message: errorMessage(error) });
      }
    }

    sourcesRun.push(summary);
  }

  const finishedAt = Date.now();
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    sourcesRun,
    sourcesSkipped,
    totals: {
      sources: sourcesRun.length,
      people: sourcesRun.reduce((sum, s) => sum + s.people, 0),
      signalsCreated: sourcesRun.reduce((sum, s) => sum + s.signalsCreated, 0),
      snapshotsRecorded: sourcesRun.reduce((sum, s) => sum + s.snapshotsRecorded, 0),
      errors: errors.length,
    },
    errors,
  };
}
