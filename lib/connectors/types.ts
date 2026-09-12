import type { DataSource, Person } from "@/types";
import type { Json } from "@/types/database";

/**
 * A single standardized data point produced by a connector.
 *
 * Signals are stored exactly as returned, with processed = false. Scoring,
 * sentiment and impact are the Engine's job in a later phase — connectors
 * never rank or weigh anything.
 */
export interface RawSignal {
  /** Self-contained, human-readable sentence, e.g. "MrBeast crosses 516M subscribers on YouTube". */
  headline: string;
  /** Everything the connector knows about the event: the numbers behind the headline, the API response, ids. */
  rawPayload: Record<string, unknown>;
  /** When the event happened (article publish time; poll time for a stats snapshot). */
  occurredAt: Date;
  /**
   * Optional idempotency key, unique per data source (article GUID, milestone
   * id). Re-running ingestion never stores the same key twice.
   */
  dedupeKey?: string;
}

/** A stored metric value. */
export interface SnapshotValue {
  metricKey: string;
  value: number;
  recordedAt: Date;
}

/**
 * A raw metric level as a connector read it (a subscriber count, a popularity
 * index, a follower total). The runner snapshots it into the raw table,
 * differences it against the previous snapshot, normalises it against the
 * person's own trailing baseline and, only then, may emit a signal that
 * carries direction and normalised magnitude and never this value.
 */
export interface MetricReading {
  /** Snake-case key, must match a metric declared in data_sources.config.metrics to produce a signal. */
  metricKey: string;
  value: number;
  /** Defaults to the run's `now`. */
  recordedAt?: Date;
}

/** Whether a connector can run at all: its credentials are present, or it needs none. */
export type ConnectorAvailability = { ok: true } | { ok: false; reason: string };

/** Snapshot access scoped to one (person, data source) pair. */
export interface SnapshotStore {
  /** Newest stored value for a metric, or null on first contact. */
  latest(metricKey: string): Promise<SnapshotValue | null>;
  /** Queue a value; the runner persists queued values once the connector returns successfully. */
  record(metricKey: string, value: number, recordedAt?: Date): void;
}

/** Everything a connector may need beyond the person and their identifier. */
export interface ConnectorContext {
  /** The data_sources row for this connector (tier, poll interval, config, ...). */
  source: DataSource;
  /** data_sources.config as a plain object ({} when null): thresholds and options. Never secrets — those come from env. */
  config: Record<string, Json | undefined>;
  /** Snapshot store scoped to this person + source, for delta detection. */
  snapshots: SnapshotStore;
  /** Wall-clock time of this run. Use it instead of new Date() so runs are reproducible and testable. */
  now: Date;
  /** fetch implementation with a timeout applied. Use it instead of global fetch so it can be mocked. */
  fetch: typeof fetch;
}

/**
 * Contract every data source module implements. One module per source under
 * lib/connectors/, registered in lib/connectors/registry.ts. The ingestion
 * runner reads active sources from the data_sources table and calls the
 * matching connector for every active person_data_sources mapping.
 *
 * A connector may produce EVENTS (fetchForPerson: news items, comments, real
 * text the sentiment scorer reads), METRICS (fetchMetrics: raw levels the
 * runner normalises before anything sees them), or both. What a metric means
 * (its polarity, baseline window, minimum sample, scaling) is not the
 * connector's business: it is declared on the data_sources row.
 */
export interface DataConnector {
  /** Must equal data_sources.name (e.g. "youtube"). */
  readonly name: string;
  /**
   * Fetch fresh data about one person and translate it into RawSignals.
   * Throw (ideally a ConnectorError) on failure; the runner records the error
   * and continues with the next person.
   */
  fetchForPerson(person: Person, externalIdentifier: string, context: ConnectorContext): Promise<RawSignal[]>;
  /**
   * Read the person's current metric levels. Optional: event-only connectors
   * omit it. Throw on failure as above.
   */
  fetchMetrics?(person: Person, externalIdentifier: string, context: ConnectorContext): Promise<MetricReading[]>;
  /**
   * Can this connector run at all? A connector whose credentials are missing
   * reports why; the runner then treats the source as inactive for the run
   * and the system carries on without it. Omitted means always available.
   */
  available?(): ConnectorAvailability;
}

/** Error raised by connectors for upstream API problems. */
export class ConnectorError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
