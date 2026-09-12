import type { SnapshotValue } from "@/lib/connectors/types";
import type { DataSource, Person, TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

import type { MetricDeltaKind, MetricOutcome } from "./metrics";

/**
 * Persistence boundary for the ingestion runner. The Supabase implementation
 * is used in production (service-role client, bypasses RLS); the in-memory
 * implementation makes the runner testable without a database.
 *
 * Raw metric levels go to raw_source_snapshots and raw_metric_observations:
 * service-role tables no user-facing surface reads. Only the store writes
 * them, and nothing here reads them back for anyone but the runner.
 */

export interface PersonMapping {
  person: Person;
  externalIdentifier: string;
}

export interface SignalRow {
  personId: string;
  dataSourceId: string;
  headline: string;
  rawPayload: Record<string, unknown>;
  occurredAt: Date;
  dedupeKey?: string;
}

/** A signal as stored: its id, and the dedupe key it was stored under. */
export interface StoredSignal {
  id: string;
  dedupeKey: string | null;
}

export interface SnapshotRow {
  personId: string;
  dataSourceId: string;
  metricKey: string;
  value: number;
  recordedAt: Date;
}

export type IngestTrigger = "manual" | "cron";

export interface RunMeta {
  startedAt: Date;
  trigger: IngestTrigger;
  forced: boolean;
  /** The source names the caller asked for, or null for every active source. */
  requestedSources: string[] | null;
}

export interface RunResult {
  finishedAt: Date;
  summary: Json;
  sourcesRun: number;
  signalsCreated: number;
  snapshotsRecorded: number;
  observations: number;
  errors: number;
}

export type PollStatus = "ok" | "error" | "skipped";

/** One poll: a source for one person, or a source-level decision (person null). */
export interface PollRow {
  runId: string;
  dataSourceId: string;
  personId: string | null;
  status: PollStatus;
  reason: string | null;
  latencyMs: number | null;
  signalsCreated: number;
  snapshotsRecorded: number;
  observations: number;
  startedAt: Date;
  finishedAt: Date;
}

/** One metric reading judged against its baseline. Raw: the level and its statistics live here and nowhere else. */
export interface ObservationRow {
  runId: string;
  personId: string;
  dataSourceId: string;
  metricKey: string;
  recordedAt: Date;
  value: number;
  previous: number | null;
  delta: number | null;
  deltaKind: MetricDeltaKind | null;
  observed: number | null;
  mean: number | null;
  sd: number | null;
  sdApplied: number | null;
  sigma: number | null;
  samples: number | null;
  minSamples: number | null;
  windowHours: number | null;
  outcome: MetricOutcome;
  signalId: string | null;
}

export interface IngestStore {
  /** data_sources rows with is_active = true. */
  listActiveSources(): Promise<DataSource[]>;
  /** Active person_data_sources mappings (active people only) for one source. */
  listMappings(dataSourceId: string): Promise<PersonMapping[]>;
  /** Newest snapshot for a (person, source, metric), or null. */
  latestSnapshot(personId: string, dataSourceId: string, metricKey: string): Promise<SnapshotValue | null>;
  /** Snapshots for a (person, source, metric) recorded at or after `since`, oldest first. */
  listSnapshots(personId: string, dataSourceId: string, metricKey: string, since: Date): Promise<SnapshotValue[]>;
  /** Insert signals (processed = false). Rows whose dedupe key already exists are skipped. Returns the rows stored. */
  insertSignals(rows: SignalRow[]): Promise<StoredSignal[]>;
  /** Insert snapshots. Exact duplicates (same person/source/metric/time) are skipped. Returns the number stored. */
  insertSnapshots(rows: SnapshotRow[]): Promise<number>;
  /** Opens an ingest_runs row and returns its id. */
  beginRun(meta: RunMeta): Promise<string>;
  /** Closes the run with its summary. */
  finishRun(runId: string, result: RunResult): Promise<void>;
  /** Records one poll. */
  recordPoll(poll: PollRow): Promise<void>;
  /** Records the observations of one poll. Returns the number stored. */
  recordObservations(rows: ObservationRow[]): Promise<number>;
  /** When the source was last polled successfully for anyone, or null. */
  lastSuccessfulPollAt(dataSourceId: string): Promise<Date | null>;
}

// ---------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------

export function createSupabaseIngestStore(client: TypedSupabaseClient): IngestStore {
  return {
    async listActiveSources() {
      const { data, error } = await client.from("data_sources").select("*").eq("is_active", true).order("name");
      if (error) throw new Error(`Failed to load active data sources: ${error.message}`);
      return data;
    },

    async listMappings(dataSourceId) {
      const { data, error } = await client
        .from("person_data_sources")
        .select("external_identifier, person:people!inner(*)")
        .eq("data_source_id", dataSourceId)
        .eq("is_active", true)
        .eq("person.is_active", true)
        .order("external_identifier");
      if (error) throw new Error(`Failed to load person mappings: ${error.message}`);
      return data.map((row) => ({ person: row.person, externalIdentifier: row.external_identifier }));
    },

    async latestSnapshot(personId, dataSourceId, metricKey) {
      const { data, error } = await client
        .from("raw_source_snapshots")
        .select("metric_key, value, recorded_at")
        .eq("person_id", personId)
        .eq("data_source_id", dataSourceId)
        .eq("metric_key", metricKey)
        .order("recorded_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to load snapshot ${metricKey}: ${error.message}`);
      if (!data) return null;
      return { metricKey: data.metric_key, value: Number(data.value), recordedAt: new Date(data.recorded_at) };
    },

    async listSnapshots(personId, dataSourceId, metricKey, since) {
      const { data, error } = await client
        .from("raw_source_snapshots")
        .select("metric_key, value, recorded_at")
        .eq("person_id", personId)
        .eq("data_source_id", dataSourceId)
        .eq("metric_key", metricKey)
        .gte("recorded_at", since.toISOString())
        .order("recorded_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(10_000);
      if (error) throw new Error(`Failed to load snapshot history ${metricKey}: ${error.message}`);
      return data.map((row) => ({ metricKey: row.metric_key, value: Number(row.value), recordedAt: new Date(row.recorded_at) }));
    },

    async insertSignals(rows) {
      if (rows.length === 0) return [];
      const { data, error } = await client
        .from("signals")
        .upsert(
          rows.map((row) => ({
            person_id: row.personId,
            data_source_id: row.dataSourceId,
            headline: row.headline,
            raw_payload: row.rawPayload as Json,
            occurred_at: row.occurredAt.toISOString(),
            dedupe_key: row.dedupeKey ?? null,
            processed: false,
          })),
          { onConflict: "data_source_id,dedupe_key", ignoreDuplicates: true },
        )
        .select("id, dedupe_key");
      if (error) throw new Error(`Failed to insert signals: ${error.message}`);
      return data.map((row) => ({ id: row.id, dedupeKey: row.dedupe_key }));
    },

    async insertSnapshots(rows) {
      if (rows.length === 0) return 0;
      const { data, error } = await client
        .from("raw_source_snapshots")
        .upsert(
          rows.map((row) => ({
            person_id: row.personId,
            data_source_id: row.dataSourceId,
            metric_key: row.metricKey,
            value: row.value,
            recorded_at: row.recordedAt.toISOString(),
          })),
          { onConflict: "person_id,data_source_id,metric_key,recorded_at", ignoreDuplicates: true },
        )
        .select("id");
      if (error) throw new Error(`Failed to insert snapshots: ${error.message}`);
      return data.length;
    },

    async beginRun(meta) {
      const { data, error } = await client
        .from("ingest_runs")
        .insert({
          started_at: meta.startedAt.toISOString(),
          trigger: meta.trigger,
          forced: meta.forced,
          requested_sources: meta.requestedSources,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to open the ingest run: ${error.message}`);
      return data.id;
    },

    async finishRun(runId, result) {
      const { error } = await client
        .from("ingest_runs")
        .update({
          finished_at: result.finishedAt.toISOString(),
          summary: result.summary,
          sources_run: result.sourcesRun,
          signals_created: result.signalsCreated,
          snapshots_recorded: result.snapshotsRecorded,
          observations: result.observations,
          errors: result.errors,
        })
        .eq("id", runId);
      if (error) throw new Error(`Failed to close the ingest run: ${error.message}`);
    },

    async recordPoll(poll) {
      const { error } = await client.from("source_polls").insert({
        run_id: poll.runId,
        data_source_id: poll.dataSourceId,
        person_id: poll.personId,
        status: poll.status,
        reason: poll.reason,
        latency_ms: poll.latencyMs,
        signals_created: poll.signalsCreated,
        snapshots_recorded: poll.snapshotsRecorded,
        observations: poll.observations,
        started_at: poll.startedAt.toISOString(),
        finished_at: poll.finishedAt.toISOString(),
      });
      if (error) throw new Error(`Failed to record the poll: ${error.message}`);
    },

    async recordObservations(rows) {
      if (rows.length === 0) return 0;
      const { data, error } = await client
        .from("raw_metric_observations")
        .insert(
          rows.map((row) => ({
            run_id: row.runId,
            person_id: row.personId,
            data_source_id: row.dataSourceId,
            metric_key: row.metricKey,
            recorded_at: row.recordedAt.toISOString(),
            value: row.value,
            previous: row.previous,
            delta: row.delta,
            delta_kind: row.deltaKind,
            observed: row.observed,
            mean: row.mean,
            sd: row.sd,
            sd_applied: row.sdApplied,
            sigma: row.sigma,
            samples: row.samples,
            min_samples: row.minSamples,
            window_hours: row.windowHours,
            outcome: row.outcome,
            signal_id: row.signalId,
          })),
        )
        .select("id");
      if (error) throw new Error(`Failed to record observations: ${error.message}`);
      return data.length;
    },

    async lastSuccessfulPollAt(dataSourceId) {
      const { data, error } = await client
        .from("source_polls")
        .select("finished_at")
        .eq("data_source_id", dataSourceId)
        .eq("status", "ok")
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to read the last poll: ${error.message}`);
      return data ? new Date(data.finished_at) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests, dry runs)
// ---------------------------------------------------------------------------

export interface MemoryIngestStoreSeed {
  sources?: DataSource[];
  /** dataSourceId -> mappings */
  mappings?: Record<string, PersonMapping[]>;
  snapshots?: SnapshotRow[];
  /** Pre-existing polls, e.g. to test the poll interval. */
  polls?: PollRow[];
}

export interface MemoryIngestStore extends IngestStore {
  readonly signals: Array<SignalRow & { id: string }>;
  readonly snapshots: SnapshotRow[];
  readonly runs: Array<RunMeta & { id: string; result: RunResult | null }>;
  readonly polls: PollRow[];
  readonly observations: ObservationRow[];
}

export function createMemoryIngestStore(seed: MemoryIngestStoreSeed = {}): MemoryIngestStore {
  const sources = [...(seed.sources ?? [])];
  const mappings = { ...(seed.mappings ?? {}) };
  const signals: MemoryIngestStore["signals"] = [];
  const snapshots: SnapshotRow[] = [...(seed.snapshots ?? [])];
  const runs: MemoryIngestStore["runs"] = [];
  const polls: PollRow[] = [...(seed.polls ?? [])];
  const observations: ObservationRow[] = [];
  let nextId = 1;
  const id = (prefix: string) => `${prefix}-${String(nextId++).padStart(4, "0")}`;

  const matching = (personId: string, dataSourceId: string, metricKey: string) =>
    snapshots.filter((s) => s.personId === personId && s.dataSourceId === dataSourceId && s.metricKey === metricKey);

  return {
    signals,
    snapshots,
    runs,
    polls,
    observations,

    async listActiveSources() {
      return sources.filter((source) => source.is_active).sort((a, b) => a.name.localeCompare(b.name));
    },

    async listMappings(dataSourceId) {
      return (mappings[dataSourceId] ?? []).filter((mapping) => mapping.person.is_active);
    },

    async latestSnapshot(personId, dataSourceId, metricKey) {
      const match = matching(personId, dataSourceId, metricKey).sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0];
      return match ? { metricKey, value: match.value, recordedAt: match.recordedAt } : null;
    },

    async listSnapshots(personId, dataSourceId, metricKey, since) {
      return matching(personId, dataSourceId, metricKey)
        .filter((s) => s.recordedAt.getTime() >= since.getTime())
        .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
        .map((s) => ({ metricKey, value: s.value, recordedAt: s.recordedAt }));
    },

    async insertSignals(rows) {
      const stored: StoredSignal[] = [];
      for (const row of rows) {
        const duplicate =
          row.dedupeKey !== undefined &&
          signals.some((s) => s.dataSourceId === row.dataSourceId && s.dedupeKey === row.dedupeKey);
        if (duplicate) continue;
        const signal = { ...row, id: id("sig") };
        signals.push(signal);
        stored.push({ id: signal.id, dedupeKey: row.dedupeKey ?? null });
      }
      return stored;
    },

    async insertSnapshots(rows) {
      let stored = 0;
      for (const row of rows) {
        const duplicate = snapshots.some(
          (s) =>
            s.personId === row.personId &&
            s.dataSourceId === row.dataSourceId &&
            s.metricKey === row.metricKey &&
            s.recordedAt.getTime() === row.recordedAt.getTime(),
        );
        if (duplicate) continue;
        snapshots.push(row);
        stored += 1;
      }
      return stored;
    },

    async beginRun(meta) {
      const run = { ...meta, id: id("run"), result: null };
      runs.push(run);
      return run.id;
    },

    async finishRun(runId, result) {
      const run = runs.find((r) => r.id === runId);
      if (run) run.result = result;
    },

    async recordPoll(poll) {
      polls.push(poll);
    },

    async recordObservations(rows) {
      observations.push(...rows);
      return rows.length;
    },

    async lastSuccessfulPollAt(dataSourceId) {
      const last = polls
        .filter((p) => p.dataSourceId === dataSourceId && p.status === "ok")
        .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())[0];
      return last ? last.finishedAt : null;
    },
  };
}
