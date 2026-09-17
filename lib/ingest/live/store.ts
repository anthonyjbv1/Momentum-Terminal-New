import type { TypedSupabaseClient } from "@/types";

import { createMemoryIngestStore, createSupabaseIngestStore, type IngestStore, type MemoryIngestStore, type MemoryIngestStoreSeed } from "../store";
import type { LiveSample, LiveSession } from "./rules";

/**
 * Persistence for live mode (Phase 16). Sessions and samples are the live
 * runner's own ledger — a sample is not a source poll (a source poll would
 * tell the ingestion runner the source was just polled and hold its hourly
 * metrics back for as long as anyone is on air) — and both tables are
 * service-role only: a sample is a raw viewer count.
 *
 * Everything else the runner needs (mappings, signals, snapshots, the run
 * that a session's closing metrics are observed under) is the ingestion
 * store's, reused unchanged.
 */

export type LiveIngestStore = Pick<IngestStore, "listActiveSources" | "listMappings" | "insertSignals" | "listSnapshots" | "insertSnapshots" | "beginRun" | "finishRun" | "recordObservations">;

export interface LiveStore extends LiveIngestStore {
  /** Sessions of one source with no ended_at. */
  listOpenSessions(dataSourceId: string): Promise<LiveSession[]>;
  createSession(session: Omit<LiveSession, "id">): Promise<LiveSession>;
  updateSession(session: LiveSession): Promise<void>;
  /** Samples of one session taken at or after `since`, oldest first. */
  listSamples(sessionId: string, since: Date): Promise<LiveSample[]>;
  insertSample(sample: LiveSample): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  person_id: string;
  data_source_id: string;
  stream_id: string;
  broadcaster_id: string;
  channel: string;
  started_at: string;
  first_seen_at: string;
  last_seen_at: string;
  last_sampled_at: string | null;
  ended_at: string | null;
  missed_checks: number;
  complete: boolean;
  sample_count: number;
  viewer_sum: number;
  viewer_latest: number | null;
  viewer_peak: number | null;
  peak_at: string | null;
  category_latest: string | null;
  category_switches: number;
  title_latest: string | null;
  clips_total: number;
  clips_counted_to: string | null;
  last_surge_at: string | null;
  last_drop_at: string | null;
  last_burst_at: string | null;
  largest_drop_fraction: number | null;
  signals_created: number;
}

const date = (value: string | null): Date | null => (value ? new Date(value) : null);
const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function readSessionRow(row: SessionRow): LiveSession {
  return {
    id: row.id,
    personId: row.person_id,
    dataSourceId: row.data_source_id,
    streamId: row.stream_id,
    broadcasterId: row.broadcaster_id,
    channel: row.channel,
    startedAt: new Date(row.started_at),
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    lastSampledAt: date(row.last_sampled_at),
    endedAt: date(row.ended_at),
    missedChecks: Number(row.missed_checks),
    complete: row.complete,
    sampleCount: Number(row.sample_count),
    viewerSum: Number(row.viewer_sum),
    viewerLatest: row.viewer_latest === null ? null : Number(row.viewer_latest),
    viewerPeak: row.viewer_peak === null ? null : Number(row.viewer_peak),
    peakAt: date(row.peak_at),
    categoryLatest: row.category_latest,
    categorySwitches: Number(row.category_switches),
    titleLatest: row.title_latest,
    clipsTotal: Number(row.clips_total),
    clipsCountedTo: date(row.clips_counted_to),
    lastSurgeAt: date(row.last_surge_at),
    lastDropAt: date(row.last_drop_at),
    lastBurstAt: date(row.last_burst_at),
    largestDropFraction: row.largest_drop_fraction === null ? null : Number(row.largest_drop_fraction),
    signalsCreated: Number(row.signals_created),
  };
}

function sessionRow(session: Omit<LiveSession, "id">): Omit<SessionRow, "id"> {
  return {
    person_id: session.personId,
    data_source_id: session.dataSourceId,
    stream_id: session.streamId,
    broadcaster_id: session.broadcasterId,
    channel: session.channel,
    started_at: session.startedAt.toISOString(),
    first_seen_at: session.firstSeenAt.toISOString(),
    last_seen_at: session.lastSeenAt.toISOString(),
    last_sampled_at: iso(session.lastSampledAt),
    ended_at: iso(session.endedAt),
    missed_checks: session.missedChecks,
    complete: session.complete,
    sample_count: session.sampleCount,
    viewer_sum: session.viewerSum,
    viewer_latest: session.viewerLatest,
    viewer_peak: session.viewerPeak,
    peak_at: iso(session.peakAt),
    category_latest: session.categoryLatest,
    category_switches: session.categorySwitches,
    title_latest: session.titleLatest,
    clips_total: session.clipsTotal,
    clips_counted_to: iso(session.clipsCountedTo),
    last_surge_at: iso(session.lastSurgeAt),
    last_drop_at: iso(session.lastDropAt),
    last_burst_at: iso(session.lastBurstAt),
    largest_drop_fraction: session.largestDropFraction,
    signals_created: session.signalsCreated,
  };
}

export function createSupabaseLiveStore(client: TypedSupabaseClient): LiveStore {
  const ingest = createSupabaseIngestStore(client);
  return {
    listActiveSources: ingest.listActiveSources,
    listMappings: ingest.listMappings,
    insertSignals: ingest.insertSignals,
    listSnapshots: ingest.listSnapshots,
    insertSnapshots: ingest.insertSnapshots,
    beginRun: ingest.beginRun,
    finishRun: ingest.finishRun,
    recordObservations: ingest.recordObservations,

    async listOpenSessions(dataSourceId) {
      const { data, error } = await client.from("live_sessions").select("*").eq("data_source_id", dataSourceId).is("ended_at", null).order("started_at");
      if (error) throw new Error(`Failed to load open live sessions: ${error.message}`);
      return data.map(readSessionRow);
    },

    async createSession(session) {
      const { data, error } = await client.from("live_sessions").insert(sessionRow(session)).select("*").single();
      if (error) throw new Error(`Failed to open the live session: ${error.message}`);
      return readSessionRow(data);
    },

    async updateSession(session) {
      const { id, ...rest } = session;
      const { error } = await client
        .from("live_sessions")
        .update({ ...sessionRow(rest), updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(`Failed to update the live session: ${error.message}`);
    },

    async listSamples(sessionId, since) {
      const { data, error } = await client.from("live_samples").select("*").eq("session_id", sessionId).gte("sampled_at", since.toISOString()).order("sampled_at").limit(2_000);
      if (error) throw new Error(`Failed to load live samples: ${error.message}`);
      return data.map((row) => ({
        sessionId: row.session_id,
        sampledAt: new Date(row.sampled_at),
        viewerCount: row.viewer_count === null ? null : Number(row.viewer_count),
        category: row.category,
        title: row.title,
        clipsWindowFrom: date(row.clips_window_from),
        clipsWindowTo: date(row.clips_window_to),
        clipsInWindow: Number(row.clips_in_window),
        clipsTruncated: row.clips_truncated,
        latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
        status: row.status === "error" ? "error" : "ok",
        error: row.error,
        signalsCreated: Number(row.signals_created),
      }));
    },

    async insertSample(sample) {
      const { error } = await client.from("live_samples").insert({
        session_id: sample.sessionId,
        sampled_at: sample.sampledAt.toISOString(),
        viewer_count: sample.viewerCount,
        category: sample.category,
        title: sample.title,
        clips_window_from: iso(sample.clipsWindowFrom),
        clips_window_to: iso(sample.clipsWindowTo),
        clips_in_window: sample.clipsInWindow,
        clips_truncated: sample.clipsTruncated,
        latency_ms: sample.latencyMs,
        status: sample.status,
        error: sample.error,
        signals_created: sample.signalsCreated,
      });
      if (error) throw new Error(`Failed to record the live sample: ${error.message}`);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests)
// ---------------------------------------------------------------------------

export interface MemoryLiveStoreSeed extends MemoryIngestStoreSeed {
  sessions?: LiveSession[];
  samples?: LiveSample[];
}

export interface MemoryLiveStore extends LiveStore {
  readonly ingest: MemoryIngestStore;
  readonly sessions: LiveSession[];
  readonly samples: LiveSample[];
}

export function createMemoryLiveStore(seed: MemoryLiveStoreSeed = {}): MemoryLiveStore {
  const ingest = createMemoryIngestStore(seed);
  const sessions: LiveSession[] = (seed.sessions ?? []).map((session) => ({ ...session }));
  const samples: LiveSample[] = [...(seed.samples ?? [])];
  let nextId = 1;
  return {
    ingest,
    sessions,
    samples,
    listActiveSources: ingest.listActiveSources,
    listMappings: ingest.listMappings,
    insertSignals: ingest.insertSignals,
    listSnapshots: ingest.listSnapshots,
    insertSnapshots: ingest.insertSnapshots,
    beginRun: ingest.beginRun,
    finishRun: ingest.finishRun,
    recordObservations: ingest.recordObservations,

    async listOpenSessions(dataSourceId) {
      return sessions.filter((session) => session.dataSourceId === dataSourceId && session.endedAt === null).map((session) => ({ ...session })).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    },
    async createSession(session) {
      const created = { ...session, id: `live-${String(nextId++).padStart(4, "0")}` };
      sessions.push(created);
      return { ...created };
    },
    async updateSession(session) {
      const index = sessions.findIndex((s) => s.id === session.id);
      if (index === -1) throw new Error(`no live session ${session.id}`);
      sessions[index] = { ...session };
    },
    async listSamples(sessionId, since) {
      return samples.filter((sample) => sample.sessionId === sessionId && sample.sampledAt.getTime() >= since.getTime()).sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
    },
    async insertSample(sample) {
      samples.push(sample);
    },
  };
}
