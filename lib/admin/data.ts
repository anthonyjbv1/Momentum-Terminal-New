import "server-only";

import { DEFAULT_ENGINE_CONFIG, engineConfigFromEnv } from "@/lib/engine/config";
import { readSignalVolumeRow, volumeSpread, type PersonSignalVolume, type VolumeSpread, type VolumeSpreadRow } from "@/lib/engine/signal-volume";
import { HIGH_IMPACT_THRESHOLD } from "@/lib/feed/feed-model";
import { getEngineEnvOverrides, isEngineCronEnabled, isIngestCronEnabled, isTargetDriftEnabled } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { requireAdmin } from "./auth";

/**
 * THE OPERATOR'S READS.
 *
 * Every function here calls requireAdmin() before it builds the service-role
 * client, so a non-admin never reaches a query — the 404 happens first. The
 * service role is what makes these reads possible at all: the tables behind
 * them (ingest_runs, source_polls, llm_usage, llm_model_prices, the health
 * views) grant nothing to anon or authenticated, so there is no path to this
 * data from a normal client even with a session.
 *
 * THE PRIVACY RULE HOLDS HERE. Admin is a user-facing path, so this file names
 * neither of the two raw metric tables (they belong to lib/ingest/store.ts and
 * to nothing else). Baseline progress comes from metric_baseline_progress, a
 * view whose columns are counts, configuration and timestamps — a raw level is
 * not selectable through it because it is not a column of it.
 *
 * Aggregation happens in TypeScript over a bounded read rather than in SQL, so
 * the operator tool adds no views to the schema; the bounds are named below
 * and are far above present volume.
 */

/** Rows read per aggregate. Above anything the closed test can produce; a hard stop if that stops being true. */
const USAGE_ROW_CAP = 20_000;
const EVENT_ROW_CAP = 20_000;
const RECENT_LIMIT = 25;
/** Observe-only readings read per request: one a day per person, so this is years of them. */
const OBSERVE_ONLY_ROW_CAP = 4_000;

export type Window = "24h" | "7d" | "30d" | "all";

export const WINDOWS: ReadonlyArray<{ id: Window; label: string; hours: number | null }> = [
  { id: "24h", label: "24 hours", hours: 24 },
  { id: "7d", label: "7 days", hours: 24 * 7 },
  { id: "30d", label: "30 days", hours: 24 * 30 },
  { id: "all", label: "all time", hours: null },
];

export function windowStart(window: Window, now = Date.now()): Date | null {
  const hours = WINDOWS.find((w) => w.id === window)?.hours ?? null;
  return hours === null ? null : new Date(now - hours * 3_600_000);
}

async function adminClient() {
  await requireAdmin();
  return createSupabaseAdminClient();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// ---------------------------------------------------------------------------
// a) LLM cost and usage
// ---------------------------------------------------------------------------

export interface CostRow {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  /** True when no price row matched this model exactly, so its cost is unknown rather than zero. */
  unpriced: boolean;
}

export interface LlmCostReport {
  window: Window;
  /** Every attempt: completed, failed and still-started rows alike. */
  totalCalls: number;
  completedCalls: number;
  /** Calls that threw (a timeout, a provider error). Billed for their input; previously invisible. */
  failedCalls: number;
  /**
   * Calls written before they were made and never settled. A row stays here
   * only when the process died with the call in flight — billed, and before
   * Phase 11 never recorded. Anything above zero is the failure mode showing.
   */
  startedCalls: number;
  totalCostUsd: number;
  /** Completed calls whose model string matched no price row. Never folded into the total: unknown is not zero. */
  unpricedCalls: number;
  unpricedModels: string[];
  byModel: CostRow[];
  byTask: CostRow[];
  perTick: Array<{
    tickNumber: number | null;
    calls: number;
    completed: number;
    failed: number;
    started: number;
    costUsd: number | null;
    unpricedCalls: number;
    sentiment: number;
    anomaly: number;
    narrative: number;
    memory: number;
    lastCallAt: string | null;
  }>;
  /** Daily cost, oldest first, for the trend. */
  trend: Array<{ day: string; calls: number; costUsd: number }>;
}

export async function readLlmCost(window: Window): Promise<LlmCostReport> {
  const client = await adminClient();
  const since = windowStart(window);

  let usageQuery = client
    .from("llm_usage")
    .select("model, task_type, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, created_at, status")
    .order("created_at", { ascending: false })
    .limit(USAGE_ROW_CAP);
  if (since) usageQuery = usageQuery.gte("created_at", since.toISOString());

  const [usage, prices, perTick] = await Promise.all([
    usageQuery,
    client.from("llm_model_prices").select("model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok"),
    client.from("llm_cost_per_tick").select("*").order("tick_number", { ascending: false, nullsFirst: false }).limit(RECENT_LIMIT),
  ]);
  for (const [label, result] of Object.entries({ usage, prices, perTick })) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  // Prices match the model string EXACTLY, the same rule llm_cost_per_tick uses.
  const priceOf = new Map((prices.data ?? []).map((p) => [p.model, p]));
  const attempts = usage.data ?? [];
  // Only a completed call has tokens and an echoed model string; the other
  // two states are counted, never costed or matched against a price row.
  const rows = attempts.filter((row) => row.status === "completed");

  const cost = (row: (typeof rows)[number]): number | null => {
    const price = priceOf.get(row.model);
    if (!price) return null;
    return (
      (row.input_tokens * Number(price.input_per_mtok) +
        row.output_tokens * Number(price.output_per_mtok) +
        row.cache_read_input_tokens * Number(price.cache_read_per_mtok) +
        row.cache_creation_input_tokens * Number(price.cache_write_per_mtok)) /
      1_000_000
    );
  };

  const group = (keyOf: (row: (typeof rows)[number]) => string): CostRow[] => {
    const buckets = new Map<string, CostRow>();
    for (const row of rows) {
      const key = keyOf(row);
      const bucket = buckets.get(key) ?? { key, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpriced: false };
      const rowCost = cost(row);
      bucket.calls += 1;
      bucket.inputTokens += row.input_tokens;
      bucket.outputTokens += row.output_tokens;
      bucket.cacheReadTokens += row.cache_read_input_tokens;
      bucket.cacheWriteTokens += row.cache_creation_input_tokens;
      if (rowCost === null) bucket.unpriced = true;
      else bucket.costUsd = (bucket.costUsd ?? 0) + rowCost;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.calls - a.calls || a.key.localeCompare(b.key));
  };

  const unpricedModels = [...new Set(rows.filter((row) => !priceOf.has(row.model)).map((row) => row.model))].sort();
  const byDay = new Map<string, { day: string; calls: number; costUsd: number }>();
  for (const row of attempts) {
    const day = row.created_at.slice(0, 10);
    const bucket = byDay.get(day) ?? { day, calls: 0, costUsd: 0 };
    bucket.calls += 1;
    bucket.costUsd += row.status === "completed" ? (cost(row) ?? 0) : 0;
    byDay.set(day, bucket);
  }

  return {
    window,
    totalCalls: attempts.length,
    completedCalls: rows.length,
    failedCalls: attempts.filter((row) => row.status === "failed").length,
    startedCalls: attempts.filter((row) => row.status === "started").length,
    totalCostUsd: sum(rows.map((row) => cost(row) ?? 0)),
    unpricedCalls: rows.filter((row) => !priceOf.has(row.model)).length,
    unpricedModels,
    byModel: group((row) => row.model),
    byTask: group((row) => row.task_type),
    perTick: (perTick.data ?? []).map((tick) => ({
      tickNumber: tick.tick_number === null ? null : Number(tick.tick_number),
      calls: Number(tick.calls ?? 0),
      completed: Number(tick.completed_calls ?? 0),
      failed: Number(tick.failed_calls ?? 0),
      started: Number(tick.started_calls ?? 0),
      costUsd: tick.cost_usd === null ? null : Number(tick.cost_usd),
      unpricedCalls: Number(tick.unpriced_calls ?? 0),
      sentiment: Number(tick.sentiment_calls ?? 0),
      anomaly: Number(tick.anomaly_calls ?? 0),
      narrative: Number(tick.narrative_calls ?? 0),
      memory: Number(tick.memory_calls ?? 0),
      lastCallAt: tick.last_call_at,
    })),
    trend: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

// ---------------------------------------------------------------------------
// b) Ingestion health
// ---------------------------------------------------------------------------

export interface SourceHealthRow {
  name: string;
  displayName: string;
  tier: number;
  isActive: boolean;
  peopleMapped: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastSkipReason: string | null;
  polls24h: number;
  errors24h: number;
  errorRate24h: number | null;
  avgLatencyMs24h: number | null;
  signals24h: number;
  blocked24h: number;
  collapsed24h: number;
  excluded24h: number;
}

export interface BaselineRow {
  personSlug: string;
  source: string;
  metricKey: string;
  lastOutcome: string | null;
  samples: number | null;
  minSamples: number | null;
  sampleProgress: number | null;
  windowHours: number | null;
  snapshots: number | null;
  spanHours: number | null;
  spanProgress: number | null;
  lastObservedAt: string | null;
}

/** One publisher feed of the Phase 13 catalogue, with what its last fetch found. Configuration and counts: no article text, no metric level. */
/**
 * One figure a source records and never scores (Phase 17): the latest reading,
 * and how far its series has filled.
 *
 * The privacy rule still holds. This does not come from either raw table — it
 * comes from observe_only_snapshots, whose WHERE clause admits a row only while
 * its source row lists that metric key in config.observe_only. A level that
 * contributes to a score is structurally unable to appear here: the edit that
 * lets a key count is the same edit that removes it from this view.
 */
export interface ObserveOnlyRow {
  personSlug: string;
  source: string;
  identifier: string | null;
  metricKey: string;
  /** The latest reading. Today that is a public company's closing price. */
  value: number;
  recordedAt: string;
  /** Readings in the window read, and the oldest of them: how far the baseline has filled. */
  samples: number;
  firstAt: string;
}

export interface PublisherFeedRow {
  id: string;
  domain: string;
  url: string;
  section: string;
  topics: string[];
  mode: string;
  isActive: boolean;
  note: string | null;
  lastFetchedAt: string | null;
  lastStatus: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  itemCount: number | null;
  datedCount: number | null;
  describedCount: number | null;
  matchedCount: number | null;
  newestPublishedAt: string | null;
  discoveredUrl: string | null;
  consecutiveFailures: number;
}

/**
 * One live session (Phase 16): a broadcast being followed, or recently
 * finished. The audience figures here are the ones the session's own event
 * headlines already carry ("live to 40,327 viewers"), not a metric level.
 */
export interface LiveSessionRow {
  id: string;
  personSlug: string;
  source: string;
  channel: string;
  startedAt: string;
  endedAt: string | null;
  lastSampledAt: string | null;
  complete: boolean;
  samples: number;
  viewerLatest: number | null;
  viewerPeak: number | null;
  averageViewers: number | null;
  category: string | null;
  categorySwitches: number;
  clipsTotal: number;
  clipsPerHour: number | null;
  signalsCreated: number;
}

export interface IngestionReport {
  sources: SourceHealthRow[];
  runs: Array<{ id: string; startedAt: string; finishedAt: string | null; trigger: string; forced: boolean; sourcesRun: number; signalsCreated: number; snapshotsRecorded: number; observations: number; errors: number; blockedDropped: number; duplicatesCollapsed: number }>;
  recentErrors: Array<{ at: string; source: string; person: string | null; reason: string }>;
  baselines: BaselineRow[];
  feeds: PublisherFeedRow[];
  /** Live mode: open sessions first, then the most recently ended. */
  liveSessions: LiveSessionRow[];
  /** Recorded, displayed, never scored (Phase 17): one row per person and metric, latest first. */
  observeOnly: ObserveOnlyRow[];
}

export async function readIngestion(): Promise<IngestionReport> {
  const client = await adminClient();
  const [sources, runs, errors, baselines, feeds, live, observeOnly] = await Promise.all([
    client.from("source_health").select("*").order("name"),
    client.from("ingest_runs").select("*").order("started_at", { ascending: false }).limit(RECENT_LIMIT),
    client
      .from("source_polls")
      .select("finished_at, reason, data_source:data_sources!inner(name), person:people(slug)")
      .eq("status", "error")
      .order("finished_at", { ascending: false })
      .limit(RECENT_LIMIT),
    client.from("metric_baseline_progress").select("*"),
    client.from("publisher_feeds").select("*").order("domain").order("section").order("url"),
    client
      .from("live_sessions")
      .select("id, channel, started_at, ended_at, last_sampled_at, complete, sample_count, viewer_sum, viewer_latest, viewer_peak, category_latest, category_switches, clips_total, signals_created, data_source:data_sources!inner(name), person:people!inner(slug)")
      .order("ended_at", { ascending: true, nullsFirst: true })
      .order("started_at", { ascending: false })
      .limit(RECENT_LIMIT),
    client.from("observe_only_snapshots").select("*").order("recorded_at", { ascending: false }).limit(OBSERVE_ONLY_ROW_CAP),
  ]);
  for (const [label, result] of Object.entries({ sources, runs, errors, baselines, feeds, live, observeOnly })) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  // Newest first, so the first row of each series is its latest reading.
  const observeOnlyByKey = new Map<string, ObserveOnlyRow>();
  for (const row of observeOnly.data ?? []) {
    if (row.person_slug === null || row.source === null || row.metric_key === null || row.value === null || row.recorded_at === null) continue;
    const key = `${row.person_slug}|${row.source}|${row.metric_key}`;
    const seen = observeOnlyByKey.get(key);
    if (seen) {
      seen.samples += 1;
      seen.firstAt = row.recorded_at;
      continue;
    }
    observeOnlyByKey.set(key, {
      personSlug: row.person_slug,
      source: row.source,
      identifier: row.identifier,
      metricKey: row.metric_key,
      value: Number(row.value),
      recordedAt: row.recorded_at,
      samples: 1,
      firstAt: row.recorded_at,
    });
  }

  return {
    observeOnly: [...observeOnlyByKey.values()].sort((a, b) => a.source.localeCompare(b.source) || a.metricKey.localeCompare(b.metricKey) || a.personSlug.localeCompare(b.personSlug)),
    liveSessions: (live.data ?? []).map((row) => {
      const samples = Number(row.sample_count ?? 0);
      const end = row.ended_at ? Date.parse(row.ended_at) : Date.now();
      const hours = Math.max(0, (end - Date.parse(row.started_at)) / 3_600_000);
      return {
        id: row.id,
        personSlug: row.person.slug,
        source: row.data_source.name,
        channel: row.channel,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        lastSampledAt: row.last_sampled_at,
        complete: row.complete,
        samples,
        viewerLatest: row.viewer_latest === null ? null : Number(row.viewer_latest),
        viewerPeak: row.viewer_peak === null ? null : Number(row.viewer_peak),
        averageViewers: samples > 0 ? Math.round(Number(row.viewer_sum) / samples) : null,
        category: row.category_latest,
        categorySwitches: Number(row.category_switches ?? 0),
        clipsTotal: Number(row.clips_total ?? 0),
        clipsPerHour: hours > 0 ? Math.round((Number(row.clips_total ?? 0) / hours) * 10) / 10 : null,
        signalsCreated: Number(row.signals_created ?? 0),
      };
    }),
    feeds: (feeds.data ?? []).map((row) => ({
      id: row.id,
      domain: row.domain,
      url: row.url,
      section: row.section,
      topics: row.topics ?? [],
      mode: row.mode,
      isActive: row.is_active,
      note: row.note,
      lastFetchedAt: row.last_fetched_at,
      lastStatus: row.last_status,
      lastHttpStatus: row.last_http_status,
      lastError: row.last_error,
      itemCount: row.last_item_count,
      datedCount: row.last_dated_count,
      describedCount: row.last_described_count,
      matchedCount: row.last_matched_count,
      newestPublishedAt: row.last_newest_published_at,
      discoveredUrl: row.discovered_url,
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
    })),
    sources: (sources.data ?? []).map((row) => ({
      // source_health is a view, so the generator types every column nullable; the
      // three below are NOT NULL on data_sources and cannot actually be null.
      name: row.name ?? "—",
      displayName: row.display_name ?? "—",
      tier: row.tier ?? 0,
      isActive: row.is_active ?? false,
      peopleMapped: Number(row.people_mapped ?? 0),
      lastPollAt: row.last_poll_at,
      lastSuccessAt: row.last_success_at,
      lastErrorAt: row.last_error_at,
      lastError: row.last_error,
      lastSkipReason: row.last_skip_reason,
      polls24h: Number(row.polls_24h ?? 0),
      errors24h: Number(row.errors_24h ?? 0),
      errorRate24h: row.error_rate_24h === null ? null : Number(row.error_rate_24h),
      avgLatencyMs24h: row.avg_latency_ms_24h === null ? null : Number(row.avg_latency_ms_24h),
      signals24h: Number(row.signals_24h ?? 0),
      blocked24h: Number(row.blocked_24h ?? 0),
      collapsed24h: Number(row.collapsed_24h ?? 0),
      excluded24h: Number(row.excluded_24h ?? 0),
    })),
    runs: (runs.data ?? []).map((run) => ({
      id: run.id,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      trigger: run.trigger,
      forced: run.forced,
      sourcesRun: Number(run.sources_run ?? 0),
      signalsCreated: Number(run.signals_created ?? 0),
      snapshotsRecorded: Number(run.snapshots_recorded ?? 0),
      observations: Number(run.observations ?? 0),
      errors: Number(run.errors ?? 0),
      blockedDropped: Number(run.blocked_dropped ?? 0),
      duplicatesCollapsed: Number(run.duplicates_collapsed ?? 0),
    })),
    recentErrors: (errors.data ?? []).map((row) => ({
      at: row.finished_at,
      source: row.data_source.name,
      person: row.person?.slug ?? null,
      reason: row.reason ?? "(no reason recorded)",
    })),
    baselines: (baselines.data ?? [])
      .map((row) => ({
        // A view's columns are all nullable to the type generator; these three are the
        // join keys and cannot actually be null, so the fallbacks are belt and braces.
        personSlug: row.person_slug ?? "—",
        source: row.source ?? "—",
        metricKey: row.metric_key ?? "—",
        lastOutcome: row.last_outcome,
        samples: row.samples === null ? null : Number(row.samples),
        minSamples: row.min_samples === null ? null : Number(row.min_samples),
        sampleProgress: row.sample_progress === null ? null : Number(row.sample_progress),
        windowHours: row.window_hours === null ? null : Number(row.window_hours),
        snapshots: row.snapshots === null ? null : Number(row.snapshots),
        spanHours: row.span_hours === null ? null : Number(row.span_hours),
        spanProgress: row.span_progress === null ? null : Number(row.span_progress),
        lastObservedAt: row.last_observed_at,
      }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.metricKey.localeCompare(b.metricKey) || a.personSlug.localeCompare(b.personSlug)),
  };
}

// ---------------------------------------------------------------------------
// c) Engine state
// ---------------------------------------------------------------------------

/** What one tick did with its work, read back from engine_ticks.summary.scoring (null on a tick written before Phase 11). */
export interface TickWork {
  selected: number;
  attempted: number;
  deferred: number;
  fallbacks: number;
  llmCalls: number;
  backlogAfter: number;
  /** The tick left signals unprocessed, by deferral or by the per-tick bounds. It committed anyway. */
  partial: boolean;
}

export interface EngineReport {
  /** The two schedules, separately gated, never conflated. */
  engineCronEnabled: boolean;
  ingestCronEnabled: boolean;
  /** The drifting Gravity target (Phase 14): ENGINE_TARGET_DRIFT_ENABLED, exactly "true". */
  targetDriftEnabled: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastTickNumber: number | null;
  avgTickMs: number | null;
  /** Unprocessed signals of active people right now: what the next tick will see. THE number to watch. */
  backlog: number;
  recentTicks: Array<{
    tickNumber: number;
    startedAt: string;
    durationMs: number | null;
    mood: number | null;
    peopleUpdated: number;
    signalsProcessed: number;
    work: TickWork | null;
    movers: Array<{ slug: string; change: number }>;
  }>;
  scores: Array<{
    slug: string;
    displayName: string;
    score: number;
    /** The target Gravity uses: seed plus offset. */
    revertTarget: number;
    /** The seeded revert_target. */
    seedTarget: number;
    /** The drifting target's offset the last tick wrote; 0 while the drift is off. */
    targetOffset: number;
    /** How many active source mappings the person has: 0 means nothing can ever produce a signal for them. */
    activeSources: number;
    lastTickAt: string | null;
    /** Phase 19: the per-person kill switch on the crowd layer. Read-only here; flipped by SQL like every other lever. */
    forecastPaused: boolean;
  }>;
  /**
   * The per-person volume weight and the two symptoms of a stale reference
   * (Phase 18++). `engaged` counts the people the weight is live for, which
   * is how the 2026-09-25 / 09-26 transition is watched rather than inferred.
   */
  volume: Omit<VolumeSpread, "rows"> & { rows: Array<VolumeSpreadRow & { slug: string; displayName: string }> };
}

function readTickWork(summary: unknown): TickWork | null {
  const scoring = (summary as { scoring?: Record<string, unknown> } | null)?.scoring;
  if (!scoring || typeof scoring !== "object") return null;
  const n = (key: string) => (typeof scoring[key] === "number" ? (scoring[key] as number) : 0);
  return {
    selected: n("selected"),
    attempted: n("attempted"),
    deferred: n("deferred"),
    fallbacks: n("fallbacks"),
    llmCalls: n("llmCalls"),
    backlogAfter: n("backlogAfter"),
    partial: scoring.partial === true,
  };
}

export async function readEngine(): Promise<EngineReport> {
  const client = await adminClient();
  const [ticks, people, count] = await Promise.all([
    client.from("engine_ticks").select("*").order("tick_number", { ascending: false }).limit(RECENT_LIMIT),
    client.from("people").select("id, slug, display_name, current_score, revert_target, target_offset, last_tick_at, forecast_paused").eq("is_active", true).order("current_score", { ascending: false }).order("slug"),
    client.from("engine_ticks").select("tick_number", { count: "exact", head: true }),
  ]);
  for (const [label, result] of Object.entries({ ticks, people, count })) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }
  const mappings = await client.from("person_data_sources").select("person_id").eq("is_active", true);
  if (mappings.error) throw new Error(`person_data_sources: ${mappings.error.message}`);
  const sourcesByPerson = new Map<string, number>();
  for (const row of mappings.data ?? []) sourcesByPerson.set(row.person_id, (sourcesByPerson.get(row.person_id) ?? 0) + 1);
  // The same count the tick itself takes at load: unprocessed signals of active people.
  const backlog = await client
    .from("signals")
    .select("id", { count: "exact", head: true })
    .eq("processed", false)
    .in("person_id", (people.data ?? []).map((person) => person.id));
  if (backlog.error) throw new Error(`backlog: ${backlog.error.message}`);

  // The volume weight, as the next tick would compute it: the same RPC and
  // the same config the tick reads, so the console cannot drift from it.
  const config = engineConfigFromEnv(getEngineEnvOverrides());
  const volumeRows = await client.rpc("person_signal_volume", { p_days: config.signals.volume.windowDays });
  if (volumeRows.error) throw new Error(`person_signal_volume: ${volumeRows.error.message}`);
  const volumes = new Map<string, PersonSignalVolume>((volumeRows.data ?? []).map(readSignalVolumeRow));
  const spread = volumeSpread(volumes, config.signals.volume);
  const nameByPerson = new Map((people.data ?? []).map((person) => [person.id, { slug: person.slug, displayName: person.display_name }]));

  const rows = ticks.data ?? [];
  const durations = rows.map((tick) => (tick.finished_at && tick.started_at ? new Date(tick.finished_at).getTime() - new Date(tick.started_at).getTime() : null)).filter((ms): ms is number => ms !== null);

  return {
    engineCronEnabled: isEngineCronEnabled(),
    ingestCronEnabled: isIngestCronEnabled(),
    targetDriftEnabled: isTargetDriftEnabled(),
    tickCount: count.count ?? 0,
    lastTickAt: rows[0]?.started_at ?? null,
    lastTickNumber: rows[0] ? Number(rows[0].tick_number) : null,
    avgTickMs: durations.length > 0 ? Math.round(sum(durations) / durations.length) : null,
    backlog: backlog.count ?? 0,
    recentTicks: rows.map((tick) => {
      const summary = (tick.summary ?? null) as { people?: Array<{ slug?: string; change?: number }> } | null;
      const movers = (summary?.people ?? [])
        .filter((person): person is { slug: string; change: number } => typeof person.slug === "string" && typeof person.change === "number" && Math.abs(person.change) >= 0.01)
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
        .slice(0, 5);
      return {
        tickNumber: Number(tick.tick_number),
        startedAt: tick.started_at,
        durationMs: tick.finished_at && tick.started_at ? new Date(tick.finished_at).getTime() - new Date(tick.started_at).getTime() : null,
        mood: tick.mood === null ? null : Number(tick.mood),
        peopleUpdated: Number(tick.people_updated ?? 0),
        signalsProcessed: Number(tick.signals_processed ?? 0),
        work: readTickWork(tick.summary),
        movers,
      };
    }),
    scores: (people.data ?? []).map((person) => ({
      slug: person.slug,
      displayName: person.display_name,
      score: Number(person.current_score),
      revertTarget: Number(person.revert_target) + Number(person.target_offset ?? 0),
      seedTarget: Number(person.revert_target),
      targetOffset: Number(person.target_offset ?? 0),
      activeSources: sourcesByPerson.get(person.id) ?? 0,
      lastTickAt: person.last_tick_at,
      forecastPaused: person.forecast_paused === true,
    })),
    volume: {
      ...spread,
      rows: spread.rows
        .filter((row) => nameByPerson.has(row.personId))
        .map((row) => ({ ...row, slug: nameByPerson.get(row.personId)!.slug, displayName: nameByPerson.get(row.personId)!.displayName })),
    },
  };
}

// ---------------------------------------------------------------------------
// d) Risk levers — read-only
// ---------------------------------------------------------------------------

export interface Lever {
  name: string;
  value: string;
  source: string;
  note: string;
}

export async function readLevers(): Promise<Lever[]> {
  const client = await adminClient();
  const { data, error } = await client.from("platform_settings").select("*").maybeSingle();
  if (error) throw new Error(`platform_settings: ${error.message}`);

  const levers: Lever[] = [
    { name: "Shorting", value: data?.shorting_enabled ? "ENABLED" : "disabled", source: "platform_settings.shorting_enabled", note: "Sell-to-open is refused by place_order() and by a trigger while this is false." },
    { name: "Price tolerance", value: `${data?.price_tolerance_cents ?? "—"}¢`, source: "platform_settings.price_tolerance_cents", note: "How far the server quote may move from the client's before an order is rejected." },
    { name: "Max units per person", value: (data?.max_units_per_person ?? "—").toLocaleString(), source: "platform_settings.max_units_per_person", note: "Ceiling on one account's open units in one person." },
    { name: "Max open-interest share", value: String(data?.max_open_interest_share ?? "—"), source: "platform_settings.max_open_interest_share", note: "Ceiling on one account's share of a person's open interest. 1 = no limit." },
    { name: "Max daily close", value: `$${(((data?.max_daily_close_cents ?? 0) as number) / 100).toLocaleString()}`, source: "platform_settings.max_daily_close_cents", note: "Ceiling on realised value closed by one account in a day." },
    { name: "Close cooldown", value: `${data?.close_cooldown_seconds ?? "—"}s`, source: "platform_settings.close_cooldown_seconds", note: "Minimum hold before a position may be closed. Policy floor is one full tick (30 s)." },
    { name: "Notable-move threshold", value: `${HIGH_IMPACT_THRESHOLD} points`, source: "lib/feed/feed-model.ts", note: "A recorded move at or beyond this takes the pinned treatment in the Feed." },
    { name: "Max signal impact per tick", value: `±${DEFAULT_ENGINE_CONFIG.signals.maxAbsImpactPerTick} points`, source: "lib/engine/config.ts", note: "Brake on the Signals force, whatever the volume of evidence." },
    {
      name: "Target drift",
      value: isTargetDriftEnabled() ? "ENABLED" : "disabled",
      source: "ENGINE_TARGET_DRIFT_ENABLED",
      note: `Gravity's target drifts from the seed with sustained signal evidence: half-life ${DEFAULT_ENGINE_CONFIG.targetDrift.halfLifeHours} h, bound ±${DEFAULT_ENGINE_CONFIG.targetDrift.bound} points, full coverage at ${DEFAULT_ENGINE_CONFIG.targetDrift.fullCoverageImpactPerHour} points of signal impact an hour. Off, every target is its seed.`,
    },
  ];
  return levers;
}

// ---------------------------------------------------------------------------
// e) User behaviour
// ---------------------------------------------------------------------------

export interface BehaviourReport {
  window: Window;
  totalEvents: number;
  activeUsers: number;
  sessions: number;
  byType: Array<{ type: string; count: number }>;
  topPeople: Array<{ slug: string; displayName: string; views: number; dwellSeconds: number }>;
  feed: { impressions: number; entriesSeen: number; dwellSeconds: number; deepestScrollPercent: number | null; filterChanges: number; tapThroughs: number; expands: number };
  trade: { sheetsOpened: number; confirmed: number; abandoned: number; rejected: number; abandonRate: number | null; closes: number };
}

export async function readBehaviour(window: Window): Promise<BehaviourReport> {
  const client = await adminClient();
  const since = windowStart(window);

  let query = client.from("behavioral_events").select("event_type, user_id, session_id, person_id, metadata, created_at").order("created_at", { ascending: false }).limit(EVENT_ROW_CAP);
  if (since) query = query.gte("created_at", since.toISOString());

  const [events, people] = await Promise.all([query, client.from("people").select("id, slug, display_name")]);
  for (const [label, result] of Object.entries({ events, people })) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  const rows = events.data ?? [];
  const nameOf = new Map((people.data ?? []).map((person) => [person.id, person]));
  const meta = (row: (typeof rows)[number]) => (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {});
  const ofType = (type: string) => rows.filter((row) => row.event_type === type);
  const numberFrom = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  const byType = new Map<string, number>();
  for (const row of rows) byType.set(row.event_type, (byType.get(row.event_type) ?? 0) + 1);

  const dwellByPerson = new Map<string, number>();
  let feedDwell = 0;
  for (const row of ofType("time_spent")) {
    const seconds = numberFrom(meta(row).seconds) || numberFrom(meta(row).duration_seconds);
    if (meta(row).surface === "feed") feedDwell += seconds;
    else if (row.person_id) dwellByPerson.set(row.person_id, (dwellByPerson.get(row.person_id) ?? 0) + seconds);
  }

  const viewsByPerson = new Map<string, number>();
  for (const row of ofType("view_person")) {
    if (row.person_id) viewsByPerson.set(row.person_id, (viewsByPerson.get(row.person_id) ?? 0) + 1);
  }

  const scrollDepths = ofType("scroll_depth").map((row) => numberFrom(meta(row).percent) || numberFrom(meta(row).depth_percent));
  const sheetsOpened = ofType("open_trade_sheet").length;
  const confirmed = ofType("take_position").length;
  const abandoned = ofType("abandon_trade_sheet").length;

  return {
    window,
    totalEvents: rows.length,
    activeUsers: new Set(rows.map((row) => row.user_id)).size,
    sessions: new Set(rows.map((row) => row.session_id).filter((id): id is string => typeof id === "string")).size,
    byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    topPeople: [...new Set([...viewsByPerson.keys(), ...dwellByPerson.keys()])]
      .map((id) => ({
        slug: nameOf.get(id)?.slug ?? id,
        displayName: nameOf.get(id)?.display_name ?? "(unknown)",
        views: viewsByPerson.get(id) ?? 0,
        dwellSeconds: Math.round(dwellByPerson.get(id) ?? 0),
      }))
      .sort((a, b) => b.views - a.views || b.dwellSeconds - a.dwellSeconds)
      .slice(0, 15),
    feed: {
      impressions: ofType("view_entry").length,
      entriesSeen: new Set(ofType("view_entry").map((row) => String(meta(row).entry_id ?? ""))).size,
      dwellSeconds: Math.round(feedDwell),
      deepestScrollPercent: scrollDepths.length > 0 ? Math.max(...scrollDepths) : null,
      filterChanges: ofType("filter_change").length,
      tapThroughs: ofType("view_person").filter((row) => meta(row).source === "feed_tap").length,
      expands: ofType("expand_signal").length,
    },
    trade: {
      sheetsOpened,
      confirmed,
      abandoned,
      rejected: ofType("reject_trade").length,
      // The number that says whether the flow works: of the sheets that ended one way or the other, how many backed out.
      abandonRate: abandoned + confirmed > 0 ? abandoned / (abandoned + confirmed) : null,
      closes: ofType("close_position").length,
    },
  };
}
