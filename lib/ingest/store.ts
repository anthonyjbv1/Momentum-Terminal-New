import type { FeedCatalogEntry, FeedHealthReport, SnapshotValue } from "@/lib/connectors/types";
import type { DataSource, Person, TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

import { outcomeReported } from "./metrics";
import { METRIC_REGISTERS, type MetricRegister } from "@/lib/signals/register";

import type { MetricDeltaKind, MetricOutcome, PreviousObservation } from "./metrics";
import type { PublisherDomainRow } from "./publishers";

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
  /** person_data_sources.config: the per-subject half of a source's configuration. Absent is the same as none. */
  config?: Record<string, Json | undefined>;
}

export interface SignalRow {
  personId: string;
  dataSourceId: string;
  headline: string;
  rawPayload: Record<string, unknown>;
  occurredAt: Date;
  dedupeKey?: string;
  /** The credibility tier resolved for this item (RSS: from the publisher domain). Null or absent = the data source's tier applies. */
  tier?: number | null;
}

/** A signal as stored: its id, and the dedupe key it was stored under. */
export interface StoredSignal {
  id: string;
  dedupeKey: string | null;
}

/** An event signal already stored for a person and source, as story deduplication sees it. */
export interface StoredSignalStory {
  id: string;
  dedupeKey: string | null;
  headline: string;
  /** raw_payload.outlet, when the connector recorded one (the outlet suffix to strip before comparing). */
  outlet: string | null;
  tier: number | null;
  processed: boolean;
  occurredAt: Date;
}

/** A better publisher's copy of a story the Engine has not read yet, written over the stored signal. */
export interface SignalUpgrade {
  tier: number;
  headline: string;
  rawPayload: Record<string, unknown>;
}

export interface SnapshotRow {
  personId: string;
  dataSourceId: string;
  metricKey: string;
  value: number;
  recordedAt: Date;
}

/** What opened a run: the manual endpoint, the scheduled ingestion, or live mode closing a session (Phase 16). */
export type IngestTrigger = "manual" | "cron" | "live";

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
  /** Items dropped before scoring because their publisher domain is blocked. */
  blockedDropped: number;
  /** Items collapsed into a story already kept, in the run or inside the lookback. */
  duplicatesCollapsed: number;
  /** Items refused as being about a different entity that shares the subject's name. */
  excludedFiltered: number;
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
  blockedDropped: number;
  duplicatesCollapsed: number;
  excludedFiltered: number;
  startedAt: Date;
  finishedAt: Date;
  /** What the connector accounted for on this poll, by key (Phase 29d): source_polls.detail. Absent or empty: nothing. */
  detail?: Record<string, Json> | null;
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
  /** The register this observation leaves on the record (Phase 24); null when it leaves none. */
  register: MetricRegister | null;
  signalId: string | null;
}

/** What one fetch of a catalogue row found, plus what the runner adds: how many items named a subject, and the failure streak. */
export interface FeedHealthRow extends FeedHealthReport {
  matchedCount: number;
  consecutiveFailures: number;
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
  /**
   * The most recent observation of each metric for a (person, source), keyed
   * by metric key: what the emit-on-change rule (Phase 21) compares this
   * reading against. Metrics never observed are absent.
   */
  lastObservations(personId: string, dataSourceId: string): Promise<Map<string, PreviousObservation>>;
  /** Insert signals (processed = false). Rows whose dedupe key already exists are skipped. Returns the rows stored. */
  insertSignals(rows: SignalRow[]): Promise<StoredSignal[]>;
  /** The publisher allowlist: every publisher_domains row. */
  listPublisherDomains(): Promise<PublisherDomainRow[]>;
  /** Event signals (not metric signals) of one person across the given sources (a story family) that occurred at or after `since`, oldest first, for story deduplication. */
  listRecentSignals(personId: string, dataSourceIds: string[], since: Date): Promise<StoredSignalStory[]>;
  /** The active publisher feed catalogue, least recently fetched first. */
  listFeeds(): Promise<FeedCatalogEntry[]>;
  /** Writes what a run found onto the catalogue rows. */
  recordFeedHealth(rows: FeedHealthRow[]): Promise<void>;
  /** Rewrites a stored, still unprocessed signal to a better publisher's copy of the same story. Returns whether a row changed (false once the Engine has read it). */
  upgradeSignal(id: string, upgrade: SignalUpgrade): Promise<boolean>;
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
  /**
   * When each person was last polled successfully for this source, among the
   * polls that finished at or after `since`, keyed by person id (after Phase
   * 29e). A person absent from the map has waited longer than the window, so
   * the runner puts them first.
   */
  lastSuccessfulPollsByPerson(dataSourceId: string, since: Date): Promise<Map<string, Date>>;
  /**
   * A run that was opened at or after `since` and never closed: the overlap
   * guard for the scheduled job. Older unfinished rows are presumed dead (a
   * crashed invocation never closes its row) and are not returned.
   */
  openRunStartedSince(since: Date): Promise<{ id: string; startedAt: Date } | null>;
}

/**
 * The newest observation per metric, out of rows ordered newest first.
 *
 * Pure, so the rule the runner compares against is testable without a
 * database: the first row seen for a key is that metric's last observation.
 */
export function readLastObservations(
  rows: Array<{ metric_key: string; observed: number | string | null; outcome: string | null; register?: string | null }>,
): Map<string, PreviousObservation> {
  const latest = new Map<string, PreviousObservation>();
  for (const row of rows) {
    if (latest.has(row.metric_key)) continue;
    const observed = row.observed === null ? null : Number(row.observed);
    // A row written before Phase 24 carries no register, and an unrecognised
    // one is never guessed at. Either way the record holds no band, so the
    // next reading is judged by the identity rule alone and emits on its own
    // register — which is the right behaviour on the deploy that adds this.
    const register = METRIC_REGISTERS.find((candidate) => candidate === row.register) ?? null;
    latest.set(row.metric_key, {
      observed: observed !== null && Number.isFinite(observed) ? observed : null,
      register,
      reported: outcomeReported((row.outcome ?? "") as MetricOutcome),
    });
  }
  return latest;
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
        .select("external_identifier, config, person:people!inner(*)")
        .eq("data_source_id", dataSourceId)
        .eq("is_active", true)
        .eq("person.is_active", true)
        .order("external_identifier");
      if (error) throw new Error(`Failed to load person mappings: ${error.message}`);
      return data.map((row) => ({
        person: row.person,
        externalIdentifier: row.external_identifier,
        config: (row.config ?? {}) as Record<string, Json | undefined>,
      }));
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

    async lastObservations(personId, dataSourceId) {
      // Newest first across every metric of this source, then the first row
      // per key wins. A source declares a handful of metrics, so a hundred
      // rows reaches back past all of them several times over.
      const { data, error } = await client
        .from("raw_metric_observations")
        .select("metric_key, observed, outcome, register, recorded_at")
        .eq("person_id", personId)
        .eq("data_source_id", dataSourceId)
        .order("recorded_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(`Failed to load the last observations: ${error.message}`);
      return readLastObservations(data ?? []);
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
            tier: row.tier ?? null,
            processed: false,
          })),
          // Unique per source AND person (Phase 29d): an item two people share — a ticker, an article — is kept for each.
          { onConflict: "data_source_id,person_id,dedupe_key", ignoreDuplicates: true },
        )
        .select("id, dedupe_key");
      if (error) throw new Error(`Failed to insert signals: ${error.message}`);
      return data.map((row) => ({ id: row.id, dedupeKey: row.dedupe_key }));
    },

    async listPublisherDomains() {
      const { data, error } = await client.from("publisher_domains").select("domain, status, tier").order("domain");
      if (error) throw new Error(`Failed to load the publisher allowlist: ${error.message}`);
      return data.map((row) => ({ domain: row.domain, status: row.status === "blocked" ? "blocked" : "allowed", tier: row.tier }));
    },

    async listRecentSignals(personId, dataSourceIds, since) {
      if (dataSourceIds.length === 0) return [];
      const { data, error } = await client
        .from("signals")
        .select("id, dedupe_key, headline, raw_payload, tier, processed, occurred_at")
        .eq("person_id", personId)
        .in("data_source_id", dataSourceIds)
        .gte("occurred_at", since.toISOString())
        .order("occurred_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(2_000);
      if (error) throw new Error(`Failed to load recent signals: ${error.message}`);
      return data
        .filter((row) => !(row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload) && row.raw_payload.kind === "metric"))
        .map((row) => {
          const payload = row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload) ? row.raw_payload : null;
          return {
            id: row.id,
            dedupeKey: row.dedupe_key,
            headline: row.headline,
            outlet: payload && typeof payload.outlet === "string" ? payload.outlet : null,
            tier: row.tier,
            processed: row.processed,
            occurredAt: new Date(row.occurred_at),
          };
        });
    },

    async upgradeSignal(id, upgrade) {
      const { data, error } = await client
        .from("signals")
        .update({ tier: upgrade.tier, headline: upgrade.headline, raw_payload: upgrade.rawPayload as Json })
        .eq("id", id)
        .eq("processed", false)
        .select("id");
      if (error) throw new Error(`Failed to upgrade signal ${id}: ${error.message}`);
      return data.length > 0;
    },

    async listFeeds() {
      const { data, error } = await client
        .from("publisher_feeds")
        .select("id, domain, url, section, topics, mode, etag, last_modified, last_fetched_at, last_status, consecutive_failures")
        .eq("is_active", true)
        .order("last_fetched_at", { ascending: true, nullsFirst: true })
        .order("url");
      if (error) throw new Error(`Failed to load the publisher feed catalogue: ${error.message}`);
      return data.map((row) => ({
        id: row.id,
        domain: row.domain,
        url: row.url,
        section: row.section,
        topics: row.topics ?? [],
        mode: row.mode === "discover" ? "discover" : "feed",
        etag: row.etag,
        lastModified: row.last_modified,
        lastFetchedAt: row.last_fetched_at ? new Date(row.last_fetched_at) : null,
        lastStatus: row.last_status,
        consecutiveFailures: Number(row.consecutive_failures ?? 0),
      }));
    },

    async recordFeedHealth(rows) {
      if (rows.length === 0) return;
      // ONE round trip for the whole catalogue. The first version did one
      // update per row in batches of ten, and on a minute when the database
      // answered in seconds rather than milliseconds those ninety-four updates
      // ran the scheduled function into the platform's 60-second kill. The
      // function touches only the health columns, so an operator's edit to the
      // configuration columns is never overwritten.
      const { error } = await client.rpc("record_feed_health", {
        rows: rows.map((row) => ({
          id: row.id,
          fetched_at: row.fetchedAt.toISOString(),
          status: row.status,
          http_status: row.httpStatus,
          error: row.error,
          item_count: row.itemCount,
          dated_count: row.datedCount,
          described_count: row.describedCount,
          matched_count: row.matchedCount,
          newest_published_at: row.newestPublishedAt ? row.newestPublishedAt.toISOString() : null,
          discovered_url: row.discoveredUrl,
          etag: row.etag,
          last_modified: row.lastModified,
          consecutive_failures: row.consecutiveFailures,
        })) as Json,
      });
      if (error) throw new Error(`Failed to record feed health: ${error.message}`);
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
          blocked_dropped: result.blockedDropped,
          duplicates_collapsed: result.duplicatesCollapsed,
          excluded_filtered: result.excludedFiltered,
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
        blocked_dropped: poll.blockedDropped,
        duplicates_collapsed: poll.duplicatesCollapsed,
        excluded_filtered: poll.excludedFiltered,
        started_at: poll.startedAt.toISOString(),
        finished_at: poll.finishedAt.toISOString(),
        detail: poll.detail && Object.keys(poll.detail).length > 0 ? (poll.detail as Json) : null,
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
            register: row.register,
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

    async lastSuccessfulPollsByPerson(dataSourceId, since) {
      // Newest first inside the window (source_polls_source_finished_idx), so the first row seen per person is their latest.
      const { data, error } = await client
        .from("source_polls")
        .select("person_id, finished_at")
        .eq("data_source_id", dataSourceId)
        .eq("status", "ok")
        .not("person_id", "is", null)
        .gte("finished_at", since.toISOString())
        .order("finished_at", { ascending: false })
        .limit(1000);
      if (error) throw new Error(`Failed to read the people's last polls: ${error.message}`);
      const latest = new Map<string, Date>();
      for (const row of data) {
        if (row.person_id && !latest.has(row.person_id)) latest.set(row.person_id, new Date(row.finished_at));
      }
      return latest;
    },

    async openRunStartedSince(since) {
      const { data, error } = await client
        .from("ingest_runs")
        .select("id, started_at")
        .is("finished_at", null)
        .gte("started_at", since.toISOString())
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to check for a run in flight: ${error.message}`);
      return data ? { id: data.id, startedAt: new Date(data.started_at) } : null;
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
  /** The publisher allowlist. Empty = every domain unknown, nothing blocked. */
  publisherDomains?: PublisherDomainRow[];
  /** The publisher feed catalogue. Health written by a run is applied to these entries, as it is to the rows in production. */
  feeds?: FeedCatalogEntry[];
}

export interface MemoryIngestStore extends IngestStore {
  readonly signals: Array<SignalRow & { id: string; tier: number | null; processed: boolean }>;
  readonly snapshots: SnapshotRow[];
  readonly runs: Array<RunMeta & { id: string; result: RunResult | null }>;
  readonly polls: PollRow[];
  readonly observations: ObservationRow[];
  readonly publisherDomains: PublisherDomainRow[];
  readonly feeds: FeedCatalogEntry[];
  readonly feedHealth: FeedHealthRow[];
}

export function createMemoryIngestStore(seed: MemoryIngestStoreSeed = {}): MemoryIngestStore {
  const sources = [...(seed.sources ?? [])];
  const mappings = { ...(seed.mappings ?? {}) };
  const signals: MemoryIngestStore["signals"] = [];
  const snapshots: SnapshotRow[] = [...(seed.snapshots ?? [])];
  const runs: MemoryIngestStore["runs"] = [];
  const polls: PollRow[] = [...(seed.polls ?? [])];
  const observations: ObservationRow[] = [];
  const publisherDomains: PublisherDomainRow[] = [...(seed.publisherDomains ?? [])];
  const feeds: FeedCatalogEntry[] = (seed.feeds ?? []).map((entry) => ({ ...entry }));
  const feedHealth: FeedHealthRow[] = [];
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
    publisherDomains,
    feeds,
    feedHealth,

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

    async lastObservations(personId, dataSourceId) {
      // Newest first, ties broken by insertion order (the later row wins), so
      // this reads the same way the indexed query does in production.
      const rows = observations
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.personId === personId && row.dataSourceId === dataSourceId)
        .sort((a, b) => b.row.recordedAt.getTime() - a.row.recordedAt.getTime() || b.index - a.index)
        .map(({ row }) => ({ metric_key: row.metricKey, observed: row.observed, outcome: row.outcome, register: row.register }));
      return readLastObservations(rows);
    },

    async insertSignals(rows) {
      const stored: StoredSignal[] = [];
      for (const row of rows) {
        // The database's rule (Phase 29d): unique per source and person; a row without a key never conflicts.
        const duplicate =
          row.dedupeKey !== undefined &&
          signals.some((s) => s.dataSourceId === row.dataSourceId && s.personId === row.personId && s.dedupeKey === row.dedupeKey);
        if (duplicate) continue;
        const signal = { ...row, id: id("sig"), tier: row.tier ?? null, processed: false };
        signals.push(signal);
        stored.push({ id: signal.id, dedupeKey: row.dedupeKey ?? null });
      }
      return stored;
    },

    async listPublisherDomains() {
      return [...publisherDomains];
    },

    async listRecentSignals(personId, dataSourceIds, since) {
      return signals
        .filter((s) => s.personId === personId && dataSourceIds.includes(s.dataSourceId) && s.occurredAt.getTime() >= since.getTime() && s.rawPayload.kind !== "metric")
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
        .map((s) => ({ id: s.id, dedupeKey: s.dedupeKey ?? null, headline: s.headline, outlet: typeof s.rawPayload.outlet === "string" ? s.rawPayload.outlet : null, tier: s.tier, processed: s.processed, occurredAt: s.occurredAt }));
    },

    async upgradeSignal(signalId, upgrade) {
      const signal = signals.find((s) => s.id === signalId && !s.processed);
      if (!signal) return false;
      signal.tier = upgrade.tier;
      signal.headline = upgrade.headline;
      signal.rawPayload = upgrade.rawPayload;
      return true;
    },

    async listFeeds() {
      return feeds
        .map((entry) => ({ ...entry }))
        .sort((a, b) => (a.lastFetchedAt?.getTime() ?? 0) - (b.lastFetchedAt?.getTime() ?? 0) || a.url.localeCompare(b.url));
    },

    async recordFeedHealth(rows) {
      for (const row of rows) {
        feedHealth.push(row);
        const entry = feeds.find((feed) => feed.id === row.id);
        if (!entry) continue;
        entry.lastFetchedAt = row.fetchedAt;
        entry.lastStatus = row.status;
        entry.etag = row.etag;
        entry.lastModified = row.lastModified;
        entry.consecutiveFailures = row.consecutiveFailures;
      }
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

    async lastSuccessfulPollsByPerson(dataSourceId, since) {
      const latest = new Map<string, Date>();
      for (const poll of polls) {
        if (poll.dataSourceId !== dataSourceId || poll.status !== "ok" || !poll.personId || poll.finishedAt.getTime() < since.getTime()) continue;
        const seen = latest.get(poll.personId);
        if (!seen || poll.finishedAt.getTime() > seen.getTime()) latest.set(poll.personId, poll.finishedAt);
      }
      return latest;
    },

    async openRunStartedSince(since) {
      const open = runs
        .filter((r) => r.result === null && r.startedAt.getTime() >= since.getTime())
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      return open ? { id: open.id, startedAt: open.startedAt } : null;
    },
  };
}
