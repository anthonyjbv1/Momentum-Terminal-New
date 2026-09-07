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
