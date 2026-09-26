import { connectorRegistry, type ConnectorRegistry } from "@/lib/connectors/registry";
import type { ConnectorContext, ConnectorQuality, ExcludedItem, FeedCatalog, FeedCatalogEntry, FeedHealthReport, MetricReading, RawSignal, SnapshotStore } from "@/lib/connectors/types";
import type { DataSource } from "@/types";
import type { Json } from "@/types/database";

import { admitEvents, recentSince } from "./events";
import { deriveMetric, metricSignal, observeMetric, readMetricConfigs, type MetricConfigs, type MetricObservation, type PreviousObservation, type SnapshotPoint } from "./metrics";
import { buildPublisherPolicy } from "./publishers";
import type { FeedHealthRow, IngestStore, IngestTrigger, ObservationRow, PollRow, PollStatus, SignalRow, SnapshotRow } from "./store";
import { STORY_DEDUP_LOOKBACK_HOURS } from "./stories";

/**
 * The ingestion runner.
 *
 * For every data_sources row with is_active = true that has a registered,
 * available connector, it loads the active person_data_sources mappings and
 * polls the connector once per person:
 *
 *   events    fetchForPerson → RawSignals → admitted (lib/ingest/events.ts):
 *             an event that names a publisher domain is resolved through the
 *             publisher allowlist (blocked → dropped before scoring, known →
 *             its tier, unknown → the floor tier), and events that carry
 *             story text are collapsed with the other copies of the same
 *             story, in the poll and among the signals stored inside the
 *             lookback, keeping the highest-tier copy → stored as they are
 *             (processed = false), with the per-item tier
 *   metrics   fetchMetrics → raw levels → snapshot → delta against the
 *             person's previous snapshots → normalised against their own
 *             trailing baseline (lib/ingest/metrics.ts) → a signal only when
 *             the baseline is sufficient, the reading is outside the band,
 *             and it is not the reading already on the record
 *   derived   config.derived metrics computed from another metric's history,
 *             then normalised the same way
 *
 * Nothing here names a source or a domain. What a metric means is on its
 * data_sources row; the publisher allowlist is the publisher_domains table;
 * adding or removing a source is a row and a credential.
 *
 * Observability: the run, every poll (source, person, outcome, latency,
 * what it produced, what it dropped and collapsed), every observation
 * (level, delta, baseline statistics, sigma, outcome, the signal it
 * produced), every blocked drop and every collapse are written through the
 * store and logged, so a score move can be reconstructed from the signal
 * back to the poll, and a missing story back to the item it collapsed into.
 *
 * A source whose connector reports missing credentials is inactive for the
 * run: recorded, logged, skipped; the rest of the run is unaffected. One
 * person's failure never stops the run either.
 *
 * Trusted server code only — the store is backed by the service-role client.
 */

export interface IngestLogLine {
  event: "run" | "source" | "poll" | "observation" | "signal" | "drop" | "collapse" | "upgrade" | "exclude" | "feed" | "note" | "detail" | "observe_only" | "feed_markers_kept";
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
  /**
   * Wall-clock budget for the whole run, in milliseconds. Once it is spent, the
   * sources and people not yet polled are recorded as skipped and the run is
   * CLOSED with what it has — the same rule the Engine's tick follows. Without
   * it a slow minute at the database runs the scheduled function into the
   * platform's kill, which loses the run's ledger and every remaining source.
   * Absent means unbounded (the manual endpoint).
   */
  budgetMs?: number;
  /** Wall clock, injectable for tests. */
  clock?: () => number;
  /**
   * How many of a source's people are polled at once (Phase 15). Overrides
   * the source row's `poll_concurrency`; the code default is 1, sequential,
   * which sixteen Google News fetches at two seconds each would not fit in
   * the scheduled run's budget. Bounded to [1, MAX_POLL_CONCURRENCY].
   */
  pollConcurrency?: number;
  /**
   * How far past the budget a SHARED-FETCH source (connector.sharedFetch: the
   * publisher catalogue) may keep starting its people once it has started
   * (after Phase 29e). Its expensive read is already paid for, and each
   * person after it is a second of matching and writes; skipping them only
   * deferred their items. Past budget + grace even these are skipped, so a
   * slow database cannot carry the run into the platform's kill. Defaults to
   * SHARED_FETCH_GRACE_MS; meaningless without a budget.
   */
  sharedFetchGraceMs?: number;
  /**
   * The Phase 31 signal-quality rules for the news connectors (stale refusal,
   * namesake and obituary guards, name-conditional exclusions). Absent, which
   * is the default and what SIGNAL_QUALITY_ENABLED unset means, none of them
   * runs: lib/ingest/quality.ts reads the switch for the routes.
   */
  quality?: ConnectorQuality;
}

/** The default grace past the run budget for a shared-fetch source's people. */
export const SHARED_FETCH_GRACE_MS = 10_000;

/** How far back the runner looks for each person's last successful poll when ordering a source's people. */
export const PERSON_ORDER_WINDOW_MS = 6 * 3_600_000;

/** The most people one source polls at once, whatever the configuration says: a courtesy to the hosts as much as a bound on the function. */
export const MAX_POLL_CONCURRENCY = 8;

/**
 * OBSERVE-ONLY METRIC KEYS (Phase 17): `config.observe_only` on the source row.
 *
 * A reading whose key is listed here is RECORDED as a raw snapshot and goes no
 * further: no observation row, no signal, no force, no memory, no score
 * history. Its series still fills, so its baseline is ready the day it is
 * allowed to count, and there is no trail to unwind if it never is.
 *
 * It exists for figures the platform must be able to see and must not score.
 * The first is a public company's daily close: the platform's regulatory
 * positioning rests on its indexes deriving no value from any registered
 * financial instrument, so a Momentum Score that moved because a stock moved
 * would be the exact exposure that positioning denies. A flag defaulting on
 * would stop future contribution and leave the history it already made; this
 * leaves none to begin with.
 *
 * It is CONFIGURATION rather than code, in one place that every source and
 * every connector passes through, so a connector cannot opt out of it and
 * turning a figure on is a row update: drop its key from `observe_only` and
 * declare it in `config.metrics`. Nothing is deployed.
 */
export function readObserveOnly(config: Record<string, Json | undefined>): Set<string> {
  const raw = config.observe_only;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((key): key is string => typeof key === "string" && /^[a-z0-9_]+$/.test(key)));
}

/** The source row's poll_concurrency (a positive integer), else the runner's default of 1, bounded. */
export function pollConcurrencyFor(config: Record<string, Json | undefined>, override?: number): number {
  const candidate = override ?? config.poll_concurrency;
  const value = typeof candidate === "number" && Number.isFinite(candidate) ? Math.floor(candidate) : 1;
  return Math.max(1, Math.min(MAX_POLL_CONCURRENCY, value));
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
  /** Items dropped before scoring because their publisher domain is blocked. */
  blockedDropped: number;
  /** Items collapsed into a story already kept, in this run or inside the lookback. */
  duplicatesCollapsed: number;
  /** Items refused as being about a different entity sharing the subject's name. */
  excludedFiltered: number;
  /** For a source that reads the publisher feed catalogue: what this run's fetch of it found. */
  feeds?: { fetched: number; ok: number; failed: number; discovered: number; matched: number };
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
    blockedDropped: number;
    duplicatesCollapsed: number;
    excludedFiltered: number;
  };
  errors: IngestError[];
  /** The wall-clock budget the run was given, and whether it ran out before every due source was polled. */
  budget: { ms: number | null; exhausted: boolean };
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

/** One observation as the raw ledger records it. Shared with live mode, which observes a session's closing metrics the same way. */
export function observationRow(runId: string, personId: string, source: DataSource, observation: MetricObservation, signalId: string | null): ObservationRow {
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
    register: observation.register,
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
    budgetMs,
    clock = Date.now,
    pollConcurrency,
    sharedFetchGraceMs = SHARED_FETCH_GRACE_MS,
    quality,
  } = options;
  const wallClockStart = clock();
  const requested = options.sources && options.sources.length > 0 ? [...options.sources] : null;
  const elapsedMs = () => clock() - wallClockStart;
  let budgetExhausted = false;
  /** True once the budget is spent; sticky, so nothing new starts after the first refusal. */
  const outOfBudget = () => {
    if (budgetExhausted) return true;
    if (budgetMs !== undefined && elapsedMs() >= budgetMs) budgetExhausted = true;
    return budgetExhausted;
  };
  const budgetReason = () => `run budget of ${budgetMs} ms exhausted after ${elapsedMs()} ms; polled on the next fire`;

  const fetchWithTimeout: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });

  const runId = await store.beginRun({ startedAt: now, trigger, forced: force, requestedSources: requested });

  // The publisher allowlist, read once per run: configuration, never code.
  const publishers = buildPublisherPolicy(await store.listPublisherDomains());

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
      blockedDropped: 0,
      duplicatesCollapsed: 0,
      excludedFiltered: 0,
      startedAt: now,
      finishedAt: now,
    });
  };

  // Every active source, before the caller's filter: a story family spans the
  // sources that are active, whether or not this run was asked to poll them.
  const allActiveSources = await store.listActiveSources();
  let activeSources = allActiveSources;
  if (requested) {
    const wanted = new Set(requested);
    activeSources = activeSources.filter((source) => wanted.has(source.name));
  }

  // Least recently polled first, then by name. Under a budget the order is
  // what decides who waits, and a source that has waited longest (the hourly
  // ones, on the fire that makes them due) must not queue behind the ones
  // polled a quarter of an hour ago. The same read serves the interval check.
  const lastPolled = new Map(await Promise.all(activeSources.map(async (source) => [source.id, await store.lastSuccessfulPollAt(source.id)] as const)));
  // And each person's, per source (after Phase 29e): inside a source the
  // person who has waited longest goes first, so a budget that runs out defers
  // a different tail each time rather than the end of the alphabet every time.
  const personOrderSince = new Date(now.getTime() - PERSON_ORDER_WINDOW_MS);
  const lastPolledPeople = new Map(await Promise.all(activeSources.map(async (source) => [source.id, await store.lastSuccessfulPollsByPerson(source.id, personOrderSince)] as const)));
  activeSources = [...activeSources].sort((a, b) => (lastPolled.get(a.id)?.getTime() ?? 0) - (lastPolled.get(b.id)?.getTime() ?? 0) || a.name.localeCompare(b.name));

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
      const last = lastPolled.get(source.id) ?? null;
      if (last) {
        const minutesAgo = (now.getTime() - last.getTime()) / 60_000;
        if (minutesAgo < source.poll_interval_minutes) {
          await skipSource(source, `polled ${Math.floor(minutesAgo)} min ago; interval ${source.poll_interval_minutes} min (pass force to poll now)`);
          continue;
        }
      }
    }

    if (outOfBudget()) {
      await skipSource(source, budgetReason());
      continue;
    }

    let mappings;
    try {
      mappings = await store.listMappings(source.id);
    } catch (error) {
      errors.push({ source: source.name, message: errorMessage(error) });
      sourcesRun.push({ name: source.name, people: 0, signalsCreated: 0, eventSignals: 0, metricSignals: 0, snapshotsRecorded: 0, observations: 0, errors: 1, blockedDropped: 0, duplicatesCollapsed: 0, excludedFiltered: 0 });
      continue;
    }

    if (mappings.length === 0) {
      await skipSource(source, "no active person_data_sources mappings");
      continue;
    }

    const config = asConfigObject(source.config);
    const configs = readMetricConfigs(config);
    // Keys this source records and never scores (Phase 17). Read once per source.
    const observeOnly = readObserveOnly(config);
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
      blockedDropped: 0,
      duplicatesCollapsed: 0,
      excludedFiltered: 0,
    };

    // The story family. Sources whose events are copies of the same stories
    // (the publisher's own feed and the aggregator's search over it) are
    // deduplicated against each other, so one story is one signal however many
    // doors it comes in through. A source that declares no family deduplicates
    // against itself alone.
    const familyIds = connector.storyFamily
      ? allActiveSources.filter((candidate) => registry.get(candidate.name)?.storyFamily === connector.storyFamily).map((candidate) => candidate.id)
      : [source.id];
    if (!familyIds.includes(source.id)) familyIds.push(source.id);

    // The publisher feed catalogue: loaded on first use, and what every fetch
    // found is written back onto its row once the source has been polled, with
    // how many of its items named a subject. Read by the connectors that share
    // feeds; the others never ask for it.
    // The listing is shared as a promise, so people polled at once cannot each read it.
    const catalogue: { entries: FeedCatalogEntry[] | null; pending: Promise<FeedCatalogEntry[]> | null } = { entries: null, pending: null };
    const feedReports = new Map<string, FeedHealthReport>();
    // Whether any of this source's people has started (a shared read may be under way), and how many of them this run did not serve.
    let sourceStarted = false;
    let missedPeople = 0;
    const feedMatches = new Map<string, number>();
    const feeds: FeedCatalog = {
      list: () =>
        (catalogue.pending ??= store.listFeeds().then((entries) => {
          catalogue.entries = entries;
          return entries;
        })),
      report: (health) => feedReports.set(health.id, health),
      matched: (feedId, count) => feedMatches.set(feedId, (feedMatches.get(feedId) ?? 0) + count),
    };

    // One person's poll, start to finish. Run `concurrency` at a time below:
    // every step here is the person's own (their fetch, their admission,
    // their snapshots, their poll row); the source-level counters are plain
    // additions, and the catalogue is fetched once whoever asks first.
    const pollMapping = async ({ person, externalIdentifier, config: personConfig }: (typeof mappings)[number]): Promise<void> => {
      // A shared-fetch source that has started finishes its people, inside
      // the grace (after Phase 29e): see sharedFetchGraceMs.
      const finishing = connector.sharedFetch === true && sourceStarted && budgetMs !== undefined && elapsedMs() < budgetMs + sharedFetchGraceMs;
      if (outOfBudget() && !finishing) {
        // Recorded per person, so the console shows who waited and why; the
        // source's last successful poll is whoever went before, so the source
        // is due again on the next fire and the queue resumes there, with
        // whoever waited longest first.
        missedPeople += 1;
        const reason = budgetReason();
        log({ event: "poll", run: runId, source: source.name, person: person.slug, status: "skipped", reason });
        await store.recordPoll({ runId, dataSourceId: source.id, personId: person.id, status: "skipped", reason, latencyMs: null, signalsCreated: 0, snapshotsRecorded: 0, observations: 0, blockedDropped: 0, duplicatesCollapsed: 0, excludedFiltered: 0, startedAt: new Date(now.getTime() + elapsedMs()), finishedAt: new Date(now.getTime() + elapsedMs()) });
        return;
      }
      sourceStarted = true;
      const pollStarted = clock();
      const pendingSnapshots: SnapshotRow[] = [];
      const snapshots: SnapshotStore = {
        latest: (metricKey) => store.latestSnapshot(person.id, source.id, metricKey),
        record: (metricKey, value, recordedAt = now) =>
          pendingSnapshots.push({ personId: person.id, dataSourceId: source.id, metricKey, value, recordedAt }),
      };
      // Items the connector refuses as being about somebody else. Queued here,
      // counted and logged below, exactly as blocked domains are.
      const excluded: ExcludedItem[] = [];
      // What the connector wants the operator to know about an otherwise ok
      // poll (Phase 16): written onto the poll row's reason and logged.
      const notes: string[] = [];
      // The connector's structured account of the poll (Phase 29d): onto source_polls.detail and the log, never the reason.
      const details: Record<string, Json> = {};
      const context: ConnectorContext = {
        source,
        config,
        snapshots,
        now,
        fetch: fetchWithTimeout,
        publishers,
        personConfig,
        exclude: (item) => excluded.push(item),
        feeds,
        note: (message) => notes.push(message),
        detail: (key, value) => {
          details[key] = value;
        },
        remainingBudgetMs: () => (budgetMs === undefined ? null : Math.max(0, budgetMs - elapsedMs())),
        quality,
      };
      const poll: Omit<PollRow, "status" | "reason" | "latencyMs" | "finishedAt"> = {
        runId,
        dataSourceId: source.id,
        personId: person.id,
        signalsCreated: 0,
        snapshotsRecorded: 0,
        observations: 0,
        blockedDropped: 0,
        duplicatesCollapsed: 0,
        excludedFiltered: 0,
        // Poll times are measured from the run's `now`, so a run with an
        // injected clock stays consistent with itself and reproducible.
        startedAt: new Date(now.getTime() + elapsedMs()),
      };
      let status: PollStatus = "ok";
      let reason: string | null = null;

      try {
        // 1. Poll ---------------------------------------------------------------
        // Events and metrics are two reads of one source, and a failure in the
        // second must not throw away the first: for a whole day the API-Sports
        // connector fetched every finished game and lost them all to a metric
        // it could not parse. A metrics failure is recorded on the poll as an
        // error, its queued snapshots are discarded, and the events go through.
        const events: RawSignal[] = await connector.fetchForPerson(person, externalIdentifier, context);
        let readings: MetricReading[] = [];
        let metricsError: string | null = null;
        if (connector.fetchMetrics) {
          const queuedBefore = pendingSnapshots.length;
          try {
            readings = await connector.fetchMetrics(person, externalIdentifier, context);
          } catch (error) {
            metricsError = errorMessage(error);
            pendingSnapshots.length = queuedBefore;
          }
        }

        // 1b. Admit -------------------------------------------------------------
        // Each event's publisher is resolved through the allowlist (a blocked
        // domain is dropped here, before anything scores it) and copies of
        // one story are collapsed, against this poll and against what is
        // already stored inside the lookback. Every drop and collapse is
        // logged with what it was dropped for or collapsed into.
        const since = recentSince(events, now, STORY_DEDUP_LOOKBACK_HOURS);
        const recent = since ? await store.listRecentSignals(person.id, familyIds, since) : [];
        const admission = admitEvents({ events, person, sourceTier: source.tier, policy: publishers, recent });
        for (const { signal, publisher } of admission.blocked) {
          log({ event: "drop", run: runId, source: source.name, person: person.slug, reason: "blocked_domain", domain: publisher.domain, matched: publisher.matched, headline: signal.headline, dedupeKey: signal.dedupeKey ?? null });
        }
        for (const collapse of admission.collapsed) {
          log({
            event: "collapse",
            run: runId,
            source: source.name,
            person: person.slug,
            headline: collapse.signal.headline,
            publisherDomain: collapse.signal.publisherDomain ?? null,
            tier: collapse.tier,
            similarity: Number(collapse.similarity.toFixed(3)),
            into:
              collapse.into.kind === "stored"
                ? { kind: "stored", signalId: collapse.into.id, tier: collapse.into.tier }
                : { kind: "run", headline: collapse.into.signal.headline, publisherDomain: collapse.into.signal.publisherDomain ?? null, dedupeKey: collapse.into.signal.dedupeKey ?? null },
            upgraded: collapse.upgrade !== null,
          });
          if (collapse.upgrade) {
            const changed = await store.upgradeSignal(collapse.upgrade.id, { tier: collapse.upgrade.tier, headline: collapse.upgrade.headline, rawPayload: collapse.upgrade.rawPayload });
            log({ event: "upgrade", run: runId, source: source.name, person: person.slug, signalId: collapse.upgrade.id, tier: collapse.upgrade.tier, from: collapse.into.kind === "stored" ? collapse.into.tier : null, headline: collapse.upgrade.headline, changed });
          }
        }
        for (const item of excluded) {
          log({ event: "exclude", run: runId, source: source.name, person: person.slug, reason: item.reason, term: item.term, headline: item.headline });
        }
        poll.excludedFiltered = excluded.length;
        summary.excludedFiltered += excluded.length;
        poll.blockedDropped = admission.blocked.length;
        poll.duplicatesCollapsed = admission.collapsed.length;
        summary.blockedDropped += admission.blocked.length;
        summary.duplicatesCollapsed += admission.collapsed.length;

        // 2. Snapshot + history -------------------------------------------------
        const current = new Map<string, SnapshotPoint>();
        const history = new Map<string, SnapshotPoint[]>();
        for (const reading of readings) {
          if (!Number.isFinite(reading.value)) continue;
          const recordedAt = reading.recordedAt ?? now;
          if (observeOnly.has(reading.metricKey)) {
            // Recorded and nothing else: it never reaches `current`, so it gets
            // no observation, no signal and no force. The log line carries the
            // key and not the level — the figure is meant to touch as little as
            // possible, and the admin console reads it from the view built for it.
            pendingSnapshots.push({ personId: person.id, dataSourceId: source.id, metricKey: reading.metricKey, value: reading.value, recordedAt });
            log({ event: "observe_only", run: runId, source: source.name, person: person.slug, metric: reading.metricKey, recordedAt: recordedAt.toISOString() });
            continue;
          }
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
        // One read per person and source for the whole metric set: what each
        // metric last put on the record, so a reading that repeats it is told
        // once rather than every quarter of an hour (Phase 21).
        const previousObservations = current.size > 0 ? await store.lastObservations(person.id, source.id) : new Map<string, PreviousObservation>();
        const observations: Array<{ observation: MetricObservation; signal: RawSignal | null }> = [];
        for (const [metricKey, point] of current) {
          const metricConfig = configs.metrics.find((m) => m.metricKey === metricKey) ?? null;
          const observation = observeMetric({
            metricKey,
            config: metricConfig,
            history: history.get(metricKey) ?? [],
            current: point,
            previousObservation: previousObservations.get(metricKey) ?? null,
          });
          const signal = observation.outcome === "emitted" ? metricSignal({ person, sourceName: source.name, externalIdentifier, observation }) : null;
          observations.push({ observation, signal });
          log({
            event: "observation",
            run: runId,
            source: source.name,
            person: person.slug,
            metric: metricKey,
            outcome: observation.outcome,
            // A metric with no declaration that feeds a derived one is a declared input, not an oversight.
            ...(configs.inputs[metricKey] ? { inputFor: configs.inputs[metricKey] } : {}),
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
        const toRow = (signal: RawSignal, tier: number | null = null): SignalRow => ({
          personId: person.id,
          dataSourceId: source.id,
          headline: signal.headline,
          rawPayload: signal.rawPayload,
          occurredAt: signal.occurredAt,
          dedupeKey: signal.dedupeKey,
          tier,
        });
        const stored = await store.insertSignals([...admission.accepted.map(({ signal, tier }) => toRow(signal, tier)), ...metricSignals.map((signal) => toRow(signal))]);
        const idByDedupeKey = new Map(stored.filter((s) => s.dedupeKey !== null).map((s) => [s.dedupeKey as string, s.id]));
        const metricStored = metricSignals.filter((s) => s.dedupeKey && idByDedupeKey.has(s.dedupeKey)).length;
        summary.signalsCreated += stored.length;
        summary.metricSignals += metricStored;
        summary.eventSignals += stored.length - metricStored;
        poll.signalsCreated = stored.length;

        for (const { signal, tier, publisher } of admission.accepted) {
          // Events with a resolved publisher are logged with their domain and tier, so the resolution can be read off the run.
          if (!publisher) continue;
          const signalId = signal.dedupeKey ? (idByDedupeKey.get(signal.dedupeKey) ?? null) : null;
          log({ event: "signal", run: runId, source: source.name, person: person.slug, kind: "event", headline: signal.headline, publisherDomain: publisher.domain, tier, tierBasis: publisher.status, signalId, stored: signalId !== null });
        }

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

        if (metricsError) {
          status = "error";
          reason = `metrics: ${metricsError}`;
          summary.errors += 1;
          errors.push({ source: source.name, person: person.slug, message: reason });
        }
      } catch (error) {
        status = "error";
        reason = errorMessage(error);
        summary.errors += 1;
        errors.push({ source: source.name, person: person.slug, message: reason });
      }

      if (status === "error") missedPeople += 1;
      for (const message of notes) log({ event: "note", run: runId, source: source.name, person: person.slug, message });
      for (const [key, value] of Object.entries(details)) log({ event: "detail", run: runId, source: source.name, person: person.slug, key, value });
      // A note rides on an ok poll's reason, so a source that is limping reads as such in the console; an error keeps its own reason.
      if (status === "ok" && notes.length > 0) reason = notes.join(" | ");

      const latencyMs = clock() - pollStarted;
      const finishedAt = new Date(poll.startedAt.getTime() + latencyMs);
      log({ event: "poll", run: runId, source: source.name, person: person.slug, status, reason, latencyMs, signals: poll.signalsCreated, snapshots: poll.snapshotsRecorded, observations: poll.observations, notes: notes.length });
      try {
        await store.recordPoll({ ...poll, status, reason, latencyMs, finishedAt, detail: details });
      } catch (error) {
        errors.push({ source: source.name, person: person.slug, message: `poll log failed: ${errorMessage(error)}` });
      }
    };

    // The people, `concurrency` at a time, longest wait first (after Phase
    // 29e; a person with no successful poll in the window first of all, ties
    // by identifier): each worker takes the next person off the queue as it
    // finishes, so a slow host delays one lane rather than everyone behind it.
    const waited = lastPolledPeople.get(source.id) ?? new Map<string, Date>();
    const queue = [...mappings].sort(
      (a, b) => (waited.get(a.person.id)?.getTime() ?? 0) - (waited.get(b.person.id)?.getTime() ?? 0) || a.externalIdentifier.localeCompare(b.externalIdentifier),
    );
    const concurrency = pollConcurrencyFor(config, pollConcurrency);
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) await pollMapping(next);
      }),
    );

    // Feed health, once per source: every fetch the catalogue saw this run,
    // logged and written back. A feed that keeps failing carries its streak so
    // the connector can back off; any other outcome resets it.
    if (feedReports.size > 0) {
      const previous = new Map<string, FeedCatalogEntry>((catalogue.entries ?? []).map((entry) => [entry.id, entry]));
      // A run that did not serve everyone keeps each feed's old caching
      // markers (after Phase 29e). With the new ones saved, a feed that is
      // unchanged at the next fire answers 304 and hands the people who missed
      // this run nothing until it next changes; with the old ones it answers
      // with the whole feed again, at the cost of one full download.
      const keepMarkers = missedPeople > 0;
      const rows: FeedHealthRow[] = [...feedReports.values()].map((health) => {
        const failed = health.status === "error" || health.status === "not_feed";
        const before = previous.get(health.id);
        const markers = keepMarkers ? { etag: before?.etag ?? null, lastModified: before?.lastModified ?? null } : {};
        return { ...health, ...markers, matchedCount: feedMatches.get(health.id) ?? 0, consecutiveFailures: failed ? (before?.consecutiveFailures ?? 0) + 1 : 0 };
      });
      if (keepMarkers) log({ event: "feed_markers_kept", run: runId, source: source.name, missedPeople, feeds: rows.length });
      for (const row of rows) {
        const entry = previous.get(row.id);
        log({
          event: "feed",
          run: runId,
          source: source.name,
          feed: entry?.url ?? row.id,
          domain: entry?.domain ?? null,
          section: entry?.section ?? null,
          mode: entry?.mode ?? null,
          status: row.status,
          httpStatus: row.httpStatus,
          items: row.itemCount,
          dated: row.datedCount,
          described: row.describedCount,
          matched: row.matchedCount,
          newest: row.newestPublishedAt ? row.newestPublishedAt.toISOString() : null,
          discovered: row.discoveredUrl,
          error: row.error,
        });
      }
      summary.feeds = {
        fetched: rows.length,
        ok: rows.filter((row) => row.status === "ok" || row.status === "not_modified").length,
        failed: rows.filter((row) => row.status === "error" || row.status === "not_feed" || row.status === "empty" || row.status === "undated" || row.status === "no_feed_found").length,
        discovered: rows.filter((row) => row.status === "discovered").length,
        matched: rows.reduce((sum, row) => sum + row.matchedCount, 0),
      };
      try {
        await store.recordFeedHealth(rows);
      } catch (error) {
        errors.push({ source: source.name, message: `feed health failed: ${errorMessage(error)}` });
      }
    }

    sourcesRun.push(summary);
  }

  const durationMs = Math.max(0, elapsedMs());
  const finishedAt = new Date(now.getTime() + durationMs);
  const totals = {
    sources: sourcesRun.length,
    people: sourcesRun.reduce((sum, s) => sum + s.people, 0),
    signalsCreated: sourcesRun.reduce((sum, s) => sum + s.signalsCreated, 0),
    snapshotsRecorded: sourcesRun.reduce((sum, s) => sum + s.snapshotsRecorded, 0),
    observations: sourcesRun.reduce((sum, s) => sum + s.observations, 0),
    errors: errors.length,
    blockedDropped: sourcesRun.reduce((sum, s) => sum + s.blockedDropped, 0),
    duplicatesCollapsed: sourcesRun.reduce((sum, s) => sum + s.duplicatesCollapsed, 0),
    excludedFiltered: sourcesRun.reduce((sum, s) => sum + s.excludedFiltered, 0),
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
    budget: { ms: budgetMs ?? null, exhausted: budgetExhausted },
  };

  log({ event: "run", run: runId, trigger, forced: force, durationMs, ...totals, skipped: sourcesSkipped.length, budgetMs: budgetMs ?? null, budgetExhausted });
  try {
    await store.finishRun(runId, {
      finishedAt,
      summary: summary as unknown as Json,
      sourcesRun: totals.sources,
      signalsCreated: totals.signalsCreated,
      snapshotsRecorded: totals.snapshotsRecorded,
      observations: totals.observations,
      errors: totals.errors,
      blockedDropped: totals.blockedDropped,
      duplicatesCollapsed: totals.duplicatesCollapsed,
      excludedFiltered: totals.excludedFiltered,
    });
  } catch (error) {
    summary.errors.push({ source: "run", message: `run log failed: ${errorMessage(error)}` });
    summary.totals.errors = summary.errors.length;
  }
  return summary;
}
