import { connectorRegistry, type ConnectorRegistry } from "@/lib/connectors/registry";
import type { ConnectorContext, LiveCapability, LiveStatus, LiveStream, RawSignal } from "@/lib/connectors/types";
import type { DataSource } from "@/types";
import type { Json } from "@/types/database";

import { metricSignal, observeMetric, readMetricConfigs, type MetricConfigs } from "../metrics";
import { observationRow } from "../runner";
import type { ObservationRow, PersonMapping, SignalRow } from "../store";
import {
  applySample,
  audienceDelta,
  audienceMoment,
  clipMoment,
  clipWindow,
  liveMomentSignal,
  minutesBetween,
  openSession,
  readLiveConfig,
  sampleDue,
  sessionAggregates,
  sessionMetricReadings,
  streamSummarySignal,
  type LiveConfig,
  type LiveSession,
} from "./rules";
import type { LiveStore } from "./store";

/**
 * THE LIVE RUNNER (Phase 16). Runs once a minute (vercel.json) and does, per
 * source that declares live mode and whose connector can follow a broadcast:
 *
 *   1. DETECT   one request for every mapped broadcaster of the source: who
 *               is on air right now. A failed check changes nothing: it is
 *               not evidence that anyone went offline.
 *   2. RECONCILE, per broadcaster (the state is the person's own session
 *               row, never a flag on the source, so any number of them can
 *               be live at once):
 *                 live, no session       open one; store the "is live" event
 *                                        under the same key the hourly poll
 *                                        would use; take the first sample
 *                 live, same stream      sample when the interval is due
 *                 live, a new stream id  close the old session, open the new
 *                 not listed, open       count a miss; close after the
 *                                        configured misses (Helix drops a
 *                                        live channel from the list now and
 *                                        then, and one miss is not an end)
 *   3. SAMPLE   the viewer count and category (from the detect response,
 *               free), the clips created since the last window (one request
 *               per broadcaster, lagged for indexing), the session's
 *               aggregates, and the moments (lib/ingest/live/rules.ts):
 *               each moment is one event signal with its own declared
 *               direction and confidence, scored by the Engine without a
 *               model call.
 *   4. CLOSE    the closing summary event (in language the sentiment path
 *               reads), and, for a COMPLETE session, the two per-session
 *               metrics through the ordinary metric pipeline (snapshot,
 *               observation against the person's trailing sessions, a signal
 *               only when sufficient and outside the band), under one
 *               ingest_runs row of trigger "live" opened for the fire.
 *
 * WHAT IT DOES NOT WRITE. No source_polls row: the ingestion runner reads
 * the source's last successful poll to decide whether its hourly metrics
 * are due, and a sample every two minutes would hold them back for as long
 * as anyone was on air. Samples are the live ledger (live_samples).
 *
 * THE CRON, PLAINLY. The fifteen-minute ingestion cron cannot do this: a
 * function cannot sleep across invocations, the route's maxDuration is 60 s
 * and Fluid's ceiling 800 s is under fifteen minutes, so "poll every two
 * minutes" from a fifteen-minute schedule is not available. Live mode has
 * its own every-minute cron, which the plan already allows (the Engine's
 * heartbeat runs on one). Its idle cost is one Helix point and a few
 * database reads a minute; the pricing is in the README.
 */

export interface LiveLogLine {
  event: "check" | "session" | "sample" | "signal" | "observation" | "run";
  [key: string]: unknown;
}

export interface LiveRunOptions {
  store: LiveStore;
  registry?: ConnectorRegistry;
  /** Only these source names. Defaults to every active source that declares live mode. */
  sources?: string[];
  now?: Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Wall-clock budget: no sample starts past it; what is not sampled is sampled on the next fire. */
  budgetMs?: number;
  clock?: () => number;
  log?: (line: LiveLogLine) => void;
}

export interface LivePersonSummary {
  slug: string;
  live: boolean;
  sampled: boolean;
  viewerCount: number | null;
  sessionId: string | null;
}

export interface LiveSourceSummary {
  name: string;
  status: "checked" | "skipped" | "error";
  reason?: string;
  broadcasters: number;
  live: number;
  sessionsOpened: number;
  sessionsClosed: number;
  samples: number;
  samplesSkipped: number;
  signalsCreated: number;
  snapshotsRecorded: number;
  observations: number;
  /** Upstream requests: the detect batches plus every clip page. */
  upstreamRequests: number;
  errors: number;
  people: LivePersonSummary[];
}

export interface LiveRunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sources: LiveSourceSummary[];
  totals: {
    sources: number;
    broadcasters: number;
    live: number;
    sessionsOpened: number;
    sessionsClosed: number;
    samples: number;
    signalsCreated: number;
    upstreamRequests: number;
    errors: number;
  };
  errors: Array<{ source: string; person?: string; message: string }>;
  /** The ingest_runs row opened for this fire, when a session closed with metrics to observe. */
  runId: string | null;
  budget: { ms: number | null; exhausted: boolean };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function asConfigObject(config: Json | null): Record<string, Json | undefined> {
  return config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLog(line: LiveLogLine): void {
  console.info(`[live] ${JSON.stringify(line)}`);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function emptySummary(source: DataSource): LiveSourceSummary {
  return { name: source.name, status: "checked", broadcasters: 0, live: 0, sessionsOpened: 0, sessionsClosed: 0, samples: 0, samplesSkipped: 0, signalsCreated: 0, snapshotsRecorded: 0, observations: 0, upstreamRequests: 0, errors: 0, people: [] };
}

export async function runLiveMode(options: LiveRunOptions): Promise<LiveRunSummary> {
  const { store, registry = connectorRegistry, now = new Date(), fetch: baseFetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, budgetMs, clock = Date.now, log = defaultLog } = options;
  const wallClockStart = clock();
  const elapsedMs = () => clock() - wallClockStart;
  let budgetExhausted = false;
  const outOfBudget = () => {
    if (budgetExhausted) return true;
    if (budgetMs !== undefined && elapsedMs() >= budgetMs) budgetExhausted = true;
    return budgetExhausted;
  };
  const budgetReason = () => `budget of ${budgetMs} ms exhausted after ${elapsedMs()} ms; on the next fire`;
  const fetchWithTimeout: typeof fetch = (input, init) => baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });

  const requested = options.sources && options.sources.length > 0 ? new Set(options.sources) : null;
  const sources = (await store.listActiveSources()).filter((source) => !requested || requested.has(source.name));
  const summaries: LiveSourceSummary[] = [];
  const errors: LiveRunSummary["errors"] = [];

  // One run row for the fire, opened only when a closing session has
  // metrics to observe: an idle minute writes nothing.
  let runId: string | null = null;
  const runTotals = { signals: 0, snapshots: 0, observations: 0, sources: new Set<string>() };
  const openRun = async (sourceName: string) => {
    runTotals.sources.add(sourceName);
    return (runId ??= await store.beginRun({ startedAt: now, trigger: "live", forced: false, requestedSources: [sourceName] }));
  };

  for (const source of sources) {
    const connector = registry.get(source.name);
    const config = asConfigObject(source.config);
    const live = readLiveConfig(config);
    // No live block, or off: the source is polled on its interval and nothing else. Silent, by design.
    if (!connector?.live || !live) continue;
    const capability = connector.live;
    const summary = emptySummary(source);
    const skip = (reason: string) => {
      summary.status = "skipped";
      summary.reason = reason;
      log({ event: "check", source: source.name, status: "skipped", reason });
      summaries.push(summary);
    };
    const availability = connector.available?.() ?? { ok: true };
    if (!availability.ok) {
      skip(`inactive: ${availability.reason}`);
      continue;
    }
    if (outOfBudget()) {
      skip(budgetReason());
      continue;
    }
    const mappings = await store.listMappings(source.id);
    summary.broadcasters = mappings.length;
    if (mappings.length === 0) {
      skip("no active person_data_sources mappings");
      continue;
    }
    const context: ConnectorContext = { source, config, snapshots: { latest: async () => null, record: () => undefined }, now, fetch: fetchWithTimeout };
    const metricConfigs = readMetricConfigs(config);
    const open = await store.listOpenSessions(source.id);

    // 1. Detect ------------------------------------------------------------------
    const checkStarted = clock();
    let statuses: Map<string, LiveStatus>;
    try {
      const list = await capability.detect(
        mappings.map((mapping) => mapping.externalIdentifier),
        context,
      );
      statuses = new Map(list.map((status) => [status.externalIdentifier.trim().toLowerCase(), status]));
      summary.upstreamRequests += Math.max(1, Math.ceil(mappings.length / 100));
    } catch (error) {
      // Nothing changes: a failed check is not evidence that anyone went offline.
      summary.status = "error";
      summary.reason = `detect: ${errorMessage(error)}`;
      summary.errors += 1;
      errors.push({ source: source.name, message: summary.reason });
      log({ event: "check", source: source.name, status: "error", reason: summary.reason, latencyMs: clock() - checkStarted });
      summaries.push(summary);
      continue;
    }
    summary.live = [...statuses.values()].filter((status) => status.stream !== null).length;
    log({ event: "check", source: source.name, status: "ok", broadcasters: mappings.length, live: summary.live, latencyMs: clock() - checkStarted, openSessions: open.length });

    const closeAndCount = async (session: LiveSession, mapping: PersonMapping, cfg: LiveConfig, endedAt: Date) => {
      const result = await closeSession({ session, mapping, cfg, endedAt, source, capability, context, store, metricConfigs, openRun, log });
      summary.sessionsClosed += 1;
      summary.signalsCreated += result.signalsCreated;
      summary.snapshotsRecorded += result.snapshots;
      summary.observations += result.observations;
      summary.upstreamRequests += result.requests;
      runTotals.signals += result.metricSignals;
      runTotals.snapshots += result.snapshots;
      runTotals.observations += result.observations;
    };

    // 2. Reconcile, per broadcaster -------------------------------------------------
    for (const mapping of mappings) {
      const stream = statuses.get(mapping.externalIdentifier.trim().toLowerCase())?.stream ?? null;
      const cfg = readLiveConfig(config, mapping.config) ?? live;
      let session = open.find((candidate) => candidate.personId === mapping.person.id) ?? null;
      const personSummary: LivePersonSummary = { slug: mapping.person.slug, live: stream !== null, sampled: false, viewerCount: stream?.viewerCount ?? null, sessionId: session?.id ?? null };
      summary.people.push(personSummary);
      try {
        if (stream && session && session.streamId !== stream.id) {
          // A new broadcast: the old one ended somewhere between its last sighting and now.
          const endedAt = new Date(Math.max(session.lastSeenAt.getTime(), Math.min(now.getTime(), stream.startedAt?.getTime() ?? now.getTime())));
          await closeAndCount(session, mapping, cfg, endedAt);
          session = null;
        }
        if (stream) {
          if (!session) {
            session = await store.createSession(openSession({ personId: mapping.person.id, dataSourceId: source.id, stream, now, config: cfg }));
            personSummary.sessionId = session.id;
            summary.sessionsOpened += 1;
            const stored = await store.insertSignals([toRow(capability.liveSignal(mapping.person, stream, now), mapping.person.id, source.id)]);
            session.signalsCreated += stored.length;
            summary.signalsCreated += stored.length;
            log({ event: "session", source: source.name, person: mapping.person.slug, status: "opened", sessionId: session.id, streamId: stream.id, startedAt: session.startedAt.toISOString(), complete: session.complete, viewerCount: stream.viewerCount, category: stream.category, liveEventStored: stored.length > 0 });
          }
          if (!sampleDue(session, now, cfg)) {
            await store.updateSession({ ...session, lastSeenAt: now, missedChecks: 0 });
          } else if (outOfBudget()) {
            summary.samplesSkipped += 1;
            log({ event: "sample", source: source.name, person: mapping.person.slug, sessionId: session.id, status: "skipped", reason: budgetReason() });
            await store.updateSession({ ...session, lastSeenAt: now, missedChecks: 0 });
          } else {
            const result = await sampleSession({ session, mapping, stream, cfg, source, capability, context, store, clock, log, now });
            personSummary.sampled = true;
            summary.samples += 1;
            summary.signalsCreated += result.signalsCreated;
            summary.upstreamRequests += result.requests;
            if (result.error) summary.errors += 1;
          }
        } else if (session) {
          const missed = session.missedChecks + 1;
          if (missed >= cfg.endAfterMissedChecks) {
            await closeAndCount(session, mapping, cfg, session.lastSeenAt);
          } else {
            await store.updateSession({ ...session, missedChecks: missed });
            log({ event: "session", source: source.name, person: mapping.person.slug, status: "missed", sessionId: session.id, missedChecks: missed, endAfter: cfg.endAfterMissedChecks });
          }
        }
      } catch (error) {
        summary.errors += 1;
        errors.push({ source: source.name, person: mapping.person.slug, message: errorMessage(error) });
        log({ event: "session", source: source.name, person: mapping.person.slug, status: "error", reason: errorMessage(error) });
      }
    }

    // 3. Orphans: a session whose mapping is gone is closed at its last sighting, with no summary (there is no one to write it about).
    for (const orphan of open.filter((session) => !mappings.some((mapping) => mapping.person.id === session.personId))) {
      try {
        await store.updateSession({ ...orphan, endedAt: orphan.lastSeenAt });
        summary.sessionsClosed += 1;
        log({ event: "session", source: source.name, status: "orphan_closed", sessionId: orphan.id, personId: orphan.personId });
      } catch (error) {
        summary.errors += 1;
        errors.push({ source: source.name, message: `orphan ${orphan.id}: ${errorMessage(error)}` });
      }
    }

    summaries.push(summary);
  }

  const durationMs = Math.max(0, elapsedMs());
  const finishedAt = new Date(now.getTime() + durationMs);
  const totals: LiveRunSummary["totals"] = {
    sources: summaries.length,
    broadcasters: summaries.reduce((sum, s) => sum + s.broadcasters, 0),
    live: summaries.reduce((sum, s) => sum + s.live, 0),
    sessionsOpened: summaries.reduce((sum, s) => sum + s.sessionsOpened, 0),
    sessionsClosed: summaries.reduce((sum, s) => sum + s.sessionsClosed, 0),
    samples: summaries.reduce((sum, s) => sum + s.samples, 0),
    signalsCreated: summaries.reduce((sum, s) => sum + s.signalsCreated, 0),
    upstreamRequests: summaries.reduce((sum, s) => sum + s.upstreamRequests, 0),
    errors: errors.length,
  };
  const result: LiveRunSummary = {
    startedAt: now.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    sources: summaries,
    totals,
    errors,
    runId,
    budget: { ms: budgetMs ?? null, exhausted: budgetExhausted },
  };
  if (runId) {
    try {
      await store.finishRun(runId, {
        finishedAt,
        summary: result as unknown as Json,
        sourcesRun: runTotals.sources.size,
        signalsCreated: runTotals.signals,
        snapshotsRecorded: runTotals.snapshots,
        observations: runTotals.observations,
        errors: errors.length,
        blockedDropped: 0,
        duplicatesCollapsed: 0,
        excludedFiltered: 0,
      });
    } catch (error) {
      result.errors.push({ source: "run", message: `run log failed: ${errorMessage(error)}` });
      result.totals.errors = result.errors.length;
    }
  }
  // Only a fire that did something is logged as a run; an idle minute is its check lines.
  if (totals.live > 0 || totals.sessionsClosed > 0 || totals.errors > 0) log({ event: "run", durationMs, ...totals, runId, budgetMs: budgetMs ?? null, budgetExhausted });
  return result;
}

function toRow(signal: RawSignal, personId: string, dataSourceId: string): SignalRow {
  return { personId, dataSourceId, headline: signal.headline, rawPayload: signal.rawPayload, occurredAt: signal.occurredAt, dedupeKey: signal.dedupeKey, tier: null };
}

interface SampleInput {
  session: LiveSession;
  mapping: PersonMapping;
  stream: LiveStream;
  cfg: LiveConfig;
  source: DataSource;
  capability: LiveCapability;
  context: ConnectorContext;
  store: LiveStore;
  clock: () => number;
  log: (line: LiveLogLine) => void;
  now: Date;
}

/** One sample of one session: the clip window, the moments, the row, the session's aggregates. */
async function sampleSession(input: SampleInput): Promise<{ signalsCreated: number; requests: number; error: string | null }> {
  const { session, mapping, stream, cfg, source, capability, context, store, clock, log, now } = input;
  const started = clock();
  const window = clipWindow(session, now, cfg);
  let clips: { from: Date; to: Date; count: number } | null = null;
  let truncated = false;
  let requests = 0;
  let error: string | null = null;
  if (window) {
    try {
      const counted = await capability.countClips(session.broadcasterId, window.from, window.to, context);
      clips = { ...window, count: counted.count };
      truncated = counted.truncated;
      requests = counted.requests;
    } catch (caught) {
      // The window is not advanced: it is counted on the next sample instead.
      error = `clips: ${errorMessage(caught)}`;
    }
  }

  const lookbackMinutes = Math.max(cfg.deltaWindowMinutes, cfg.clipWindowMinutes) + cfg.clipLagMinutes + cfg.sampleIntervalMinutes + 1;
  const prior = await store.listSamples(session.id, new Date(now.getTime() - lookbackMinutes * MINUTE_MS));
  const current = { sampledAt: now, viewerCount: stream.viewerCount };

  const signals: RawSignal[] = [];
  const audience = audienceMoment(session, prior, current, cfg);
  if (audience) signals.push(liveMomentSignal(mapping.person, session, audience, now, source.name));
  const burst = clips ? clipMoment(session, prior, clips, now, cfg) : null;
  if (burst) signals.push(liveMomentSignal(mapping.person, session, burst, now, source.name));

  let next = applySample(session, { now, stream, clips }, cfg);
  const delta = audienceDelta(prior, current, cfg);
  if (delta && delta.fraction < 0 && (next.largestDropFraction === null || delta.fraction < next.largestDropFraction)) next = { ...next, largestDropFraction: round3(delta.fraction) };
  if (audience?.moment === "audience_surge") next = { ...next, lastSurgeAt: now };
  if (audience?.moment === "audience_drop") next = { ...next, lastDropAt: now };
  if (burst) next = { ...next, lastBurstAt: now };

  const stored = signals.length > 0 ? await store.insertSignals(signals.map((signal) => toRow(signal, mapping.person.id, source.id))) : [];
  next = { ...next, signalsCreated: next.signalsCreated + stored.length };
  const latencyMs = clock() - started;
  await store.insertSample({
    sessionId: session.id,
    sampledAt: now,
    viewerCount: stream.viewerCount,
    category: stream.category,
    title: stream.title,
    clipsWindowFrom: clips?.from ?? null,
    clipsWindowTo: clips?.to ?? null,
    clipsInWindow: clips?.count ?? 0,
    clipsTruncated: truncated,
    latencyMs,
    status: error ? "error" : "ok",
    error,
    signalsCreated: stored.length,
  });
  await store.updateSession(next);

  log({
    event: "sample",
    source: source.name,
    person: mapping.person.slug,
    sessionId: session.id,
    status: error ? "error" : "ok",
    reason: error,
    latencyMs,
    minutesIn: Math.round(minutesBetween(session.startedAt, now)),
    viewerCount: stream.viewerCount,
    peak: next.viewerPeak,
    category: stream.category,
    categorySwitches: next.categorySwitches,
    clipsWindow: clips ? { from: clips.from.toISOString(), to: clips.to.toISOString(), count: clips.count, truncated } : null,
    clipsTotal: next.clipsTotal,
    delta: delta ? { fraction: round3(delta.fraction), minutes: Math.round(delta.minutes) } : null,
    signals: stored.length,
    complete: next.complete,
  });
  for (const signal of signals) {
    const payload = signal.rawPayload as { moment?: string; direction?: number; confidence?: number; rationale?: string };
    log({ event: "signal", source: source.name, person: mapping.person.slug, sessionId: session.id, kind: "live_moment", moment: payload.moment, direction: payload.direction, confidence: payload.confidence, rationale: payload.rationale, headline: signal.headline, stored: stored.some((row) => row.dedupeKey === signal.dedupeKey) });
  }
  return { signalsCreated: stored.length, requests, error };
}

interface CloseInput {
  session: LiveSession;
  mapping: PersonMapping;
  cfg: LiveConfig;
  endedAt: Date;
  source: DataSource;
  capability: LiveCapability;
  context: ConnectorContext;
  store: LiveStore;
  metricConfigs: MetricConfigs;
  openRun: (sourceName: string) => Promise<string>;
  log: (line: LiveLogLine) => void;
}

/** A session's end: the last clip window, the summary event, and the session metrics through the metric pipeline. */
async function closeSession(input: CloseInput): Promise<{ signalsCreated: number; metricSignals: number; snapshots: number; observations: number; requests: number }> {
  const { mapping, cfg, endedAt, source, capability, context, store, metricConfigs, openRun, log } = input;
  let session = input.session;
  let requests = 0;
  // The clips between the last window and the end, if the window is not empty.
  const tail = clipWindow(session, new Date(endedAt.getTime() + cfg.clipLagMinutes * MINUTE_MS), cfg);
  if (tail) {
    try {
      const counted = await capability.countClips(session.broadcasterId, tail.from, tail.to, context);
      requests = counted.requests;
      session = { ...session, clipsTotal: session.clipsTotal + counted.count, clipsCountedTo: tail.to };
    } catch (error) {
      log({ event: "session", source: source.name, person: mapping.person.slug, sessionId: session.id, status: "tail_clips_failed", reason: errorMessage(error) });
    }
  }
  session = { ...session, endedAt };
  const aggregates = sessionAggregates(session, endedAt);

  // The summary: an ordinary event, unless the session was shorter than the warm-up (a false start says nothing).
  let signalsCreated = 0;
  if (aggregates.hours * 60 >= cfg.warmupMinutes) {
    const stored = await store.insertSignals([toRow(streamSummarySignal(mapping.person, session, endedAt, source.name, source.display_name), mapping.person.id, source.id)]);
    signalsCreated += stored.length;
  }

  // The session metrics, complete sessions only, through the metric pipeline.
  const readings = sessionMetricReadings(session, endedAt, cfg);
  let metricSignals = 0;
  let snapshots = 0;
  let observations = 0;
  if (readings.length > 0) {
    const runId = await openRun(source.name);
    const rows: Array<{ observation: ReturnType<typeof observeMetric>; signal: RawSignal | null }> = [];
    for (const reading of readings) {
      const metricConfig = metricConfigs.metrics.find((metric) => metric.metricKey === reading.metricKey) ?? null;
      const since = new Date(endedAt.getTime() - Math.max(1, metricConfig?.baselineWindowHours ?? 1) * HOUR_MS);
      const history = (await store.listSnapshots(mapping.person.id, source.id, reading.metricKey, since)).map((snapshot) => ({ value: snapshot.value, recordedAt: snapshot.recordedAt }));
      const observation = observeMetric({ metricKey: reading.metricKey, config: metricConfig, history, current: { value: reading.value, recordedAt: endedAt } });
      const signal = observation.outcome === "emitted" ? metricSignal({ person: mapping.person, sourceName: source.name, externalIdentifier: mapping.externalIdentifier, observation }) : null;
      rows.push({ observation, signal });
      log({
        event: "observation",
        source: source.name,
        person: mapping.person.slug,
        sessionId: session.id,
        metric: reading.metricKey,
        outcome: observation.outcome,
        sigma: observation.reading?.sigma ?? null,
        samples: observation.reading?.samples ?? null,
        minSamples: observation.reading?.minSamples ?? null,
        windowHours: observation.windowHours,
      });
    }
    const stored = await store.insertSignals(rows.flatMap(({ signal }) => (signal ? [toRow(signal, mapping.person.id, source.id)] : [])));
    const idByKey = new Map(stored.filter((row) => row.dedupeKey !== null).map((row) => [row.dedupeKey as string, row.id]));
    metricSignals = stored.length;
    signalsCreated += stored.length;
    snapshots = await store.insertSnapshots(readings.map((reading) => ({ personId: mapping.person.id, dataSourceId: source.id, metricKey: reading.metricKey, value: reading.value, recordedAt: endedAt })));
    const observationRows: ObservationRow[] = rows.map(({ observation, signal }) => observationRow(runId, mapping.person.id, source, observation, signal?.dedupeKey ? (idByKey.get(signal.dedupeKey) ?? null) : null));
    observations = await store.recordObservations(observationRows);
  }

  session = { ...session, signalsCreated: session.signalsCreated + signalsCreated };
  await store.updateSession(session);
  log({
    event: "session",
    source: source.name,
    person: mapping.person.slug,
    sessionId: session.id,
    status: "closed",
    streamId: session.streamId,
    startedAt: session.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    complete: session.complete,
    ...aggregates,
    samples: session.sampleCount,
    signals: signalsCreated,
    metricsObserved: readings.map((reading) => reading.metricKey),
  });
  return { signalsCreated, metricSignals, snapshots, observations, requests };
}
