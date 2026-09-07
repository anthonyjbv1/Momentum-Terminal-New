import type { SnapshotValue } from "@/lib/connectors/types";
import type { DataSource, Person, TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

/**
 * Persistence boundary for the ingestion runner. The Supabase implementation
 * is used in production (service-role client, bypasses RLS); the in-memory
 * implementation makes the runner testable without a database.
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

export interface SnapshotRow {
  personId: string;
  dataSourceId: string;
  metricKey: string;
  value: number;
  recordedAt: Date;
}

export interface IngestStore {
  /** data_sources rows with is_active = true. */
  listActiveSources(): Promise<DataSource[]>;
  /** Active person_data_sources mappings (active people only) for one source. */
  listMappings(dataSourceId: string): Promise<PersonMapping[]>;
  /** Newest snapshot for a (person, source, metric), or null. */
  latestSnapshot(personId: string, dataSourceId: string, metricKey: string): Promise<SnapshotValue | null>;
  /** Insert signals (processed = false). Rows whose dedupe key already exists are skipped. Returns the number stored. */
  insertSignals(rows: SignalRow[]): Promise<number>;
  /** Insert snapshots. Exact duplicates (same person/source/metric/time) are skipped. Returns the number stored. */
  insertSnapshots(rows: SnapshotRow[]): Promise<number>;
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
        .eq("person.is_active", true);
      if (error) throw new Error(`Failed to load person mappings: ${error.message}`);
      return data.map((row) => ({ person: row.person, externalIdentifier: row.external_identifier }));
    },

    async latestSnapshot(personId, dataSourceId, metricKey) {
      const { data, error } = await client
        .from("source_snapshots")
        .select("metric_key, value, recorded_at")
        .eq("person_id", personId)
        .eq("data_source_id", dataSourceId)
        .eq("metric_key", metricKey)
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to load snapshot ${metricKey}: ${error.message}`);
      if (!data) return null;
      return { metricKey: data.metric_key, value: Number(data.value), recordedAt: new Date(data.recorded_at) };
    },

    async insertSignals(rows) {
      if (rows.length === 0) return 0;
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
        .select("id");
      if (error) throw new Error(`Failed to insert signals: ${error.message}`);
      return data.length;
    },

    async insertSnapshots(rows) {
      if (rows.length === 0) return 0;
      const { data, error } = await client
        .from("source_snapshots")
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
}

export interface MemoryIngestStore extends IngestStore {
  readonly signals: SignalRow[];
  readonly snapshots: SnapshotRow[];
}

export function createMemoryIngestStore(seed: MemoryIngestStoreSeed = {}): MemoryIngestStore {
  const sources = [...(seed.sources ?? [])];
  const mappings = { ...(seed.mappings ?? {}) };
  const signals: SignalRow[] = [];
  const snapshots: SnapshotRow[] = [...(seed.snapshots ?? [])];

  return {
    signals,
    snapshots,

    async listActiveSources() {
      return sources.filter((source) => source.is_active).sort((a, b) => a.name.localeCompare(b.name));
    },

    async listMappings(dataSourceId) {
      return (mappings[dataSourceId] ?? []).filter((mapping) => mapping.person.is_active);
    },

    async latestSnapshot(personId, dataSourceId, metricKey) {
      const match = snapshots
        .filter((s) => s.personId === personId && s.dataSourceId === dataSourceId && s.metricKey === metricKey)
        .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0];
      return match ? { metricKey, value: match.value, recordedAt: match.recordedAt } : null;
    },

    async insertSignals(rows) {
      let stored = 0;
      for (const row of rows) {
        const duplicate =
          row.dedupeKey !== undefined &&
          signals.some((s) => s.dataSourceId === row.dataSourceId && s.dedupeKey === row.dedupeKey);
        if (duplicate) continue;
        signals.push(row);
        stored += 1;
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
  };
}
