import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { NO_DEADLINE } from "@/lib/engine/deadline";
import { createMemoryMemoryStore, type MemoryStore } from "@/lib/engine/memory/store";
import type { PersonMemory } from "@/lib/engine/memory/types";
import { resolveRoute, routedComplete, type RoutedRequest } from "@/lib/llm/routing";
import { LLMError, type LLMResponse } from "@/lib/llm/types";
import { noopUsageLogger, recordedCall, type LLMUsageLogger } from "@/lib/llm/usage";
import type { Json } from "@/types/database";

import { TickCallBudget, type DeferralReason } from "./budget";
import { metricScorer as defaultMetricScorer } from "./metric";
import { SENTIMENT_RESPONSE_SCHEMA, SENTIMENT_SYSTEM_PROMPT, buildSentimentUserPrompt } from "./prompts";
import { rulesBasedScorer } from "./rules";
import type { ScoringContext, ScoringOutcome, SentimentAnomaly, SentimentInput, SentimentResult, SentimentScorer } from "./types";

/**
 * LLMScorer — the Phase 4 SentimentScorer.
 *
 * The Engine calls scoreSignal() once per signal, exactly as it did with the
 * rules scorer. Internally the calls that arrive in the same event-loop turn
 * (a tick scores all its signals at once) are coalesced into one LLM call per
 * person, with that person's memory (profile, baseline patterns, recent
 * context) in the prompt, so the model can judge routine vs anomalous for
 * THIS person. The anomaly assessment is folded into confidence.
 *
 * Cost controls:
 *   - pre-filter: baseline signals and tiny "change" signals never reach the LLM
 *   - memory is loaded once per batch and cached for memoryCacheTtlMs
 *   - one call per person per batch (up to maxSignalsPerCall signals)
 *   - every call's token usage is logged, the in-flight half first
 *
 * THE TWO OUTCOMES (Phase 11). A chunk is either ATTEMPTED or DEFERRED, and
 * the difference decides whether its signals are processed this tick:
 *
 *   - attempted and the call FAILED (provider error, timeout, refusal, a
 *     malformed response, an id the model left out): the affected signals
 *     fall back to the rules scorer. That is a real answer; they are
 *     processed. The tick never fails because the LLM had a hiccup.
 *   - NOT ATTEMPTED, because the tick's deadline would not let a call finish,
 *     the tick's call budget is spent, the person already had their one call
 *     this tick, or the process-wide rate limit is hit: the signals are
 *     deferred. They resolve as DeferredSignal, the tick leaves them out of
 *     its commit, and a later tick scores them at one attempt's cost.
 *
 * Four gates, in this order, all before any money is spent:
 *   1. deadline    — do not START a call that cannot finish before the tick's
 *                    deadline (deadline − timeoutMs − overhead). Nothing is
 *                    ever aborted: aborting recovers no cost.
 *   2. person cap  — one call per person per tick (budget.ts).
 *   3. call budget — a plain per-tick count (budget.ts).
 *   4. rate limit  — the rolling process-wide window, a safety net only.
 */

export interface LLMScorerPerson {
  id: string;
  slug: string;
  displayName: string;
  category: string;
}

export interface LLMScorerDeps {
  /** Routed completion (defaults to routedComplete). */
  complete?: (request: RoutedRequest) => Promise<LLMResponse>;
  memoryStore?: MemoryStore | (() => Promise<MemoryStore>);
  usageLogger?: LLMUsageLogger | (() => Promise<LLMUsageLogger>);
  /** Resolves person details for a person id (name, slug, category). */
  resolvePerson?: (personId: string) => Promise<LLMScorerPerson | null>;
  fallback?: SentimentScorer;
  /** Scores metric signals, which never reach the model. Defaults to the shared MetricScorer. */
  metricScorer?: SentimentScorer;
  config?: EngineConfig["llm"];
  tickIntervalSeconds?: number;
  /** Memory events older than this are not shown to the model verbatim (config.memory.maxEventAgeDays). */
  memoryEventMaxAgeDays?: number;
  /** Delay before a batch is flushed, in ms. 0 = next macrotask. */
  batchDelayMs?: number;
  now?: () => number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface Pending {
  signal: SentimentInput;
  context: ScoringContext | null;
  resolve: (outcome: ScoringOutcome) => void;
}

interface ParsedSignalAssessment {
  id: string;
  label: SentimentResult["label"];
  confidence: number;
  anomaly: SentimentAnomaly;
  rationale: string;
}

const LABELS = new Set(["positive", "negative", "neutral"]);
const ANOMALIES = new Set(["routine", "notable", "anomalous"]);

/**
 * Time a call needs on top of its own timeout before it is truly under way:
 * the started-row write, the person lookup, the request leaving the process.
 * The deadline gate reserves it so a call admitted at the last moment still
 * finishes before the deadline.
 */
export const CALL_OVERHEAD_MS = 1_000;

function payloadField(payload: Json | null, key: string): Json | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

export class LLMScorer implements SentimentScorer {
  readonly name = "llm";

  private readonly complete: (request: RoutedRequest) => Promise<LLMResponse>;
  private readonly memoryStoreSource: MemoryStore | (() => Promise<MemoryStore>);
  private readonly usageLoggerSource: LLMUsageLogger | (() => Promise<LLMUsageLogger>);
  private readonly resolvePerson: (personId: string) => Promise<LLMScorerPerson | null>;
  private readonly fallback: SentimentScorer;
  private readonly metricScorer: SentimentScorer;
  private readonly config: EngineConfig["llm"];
  private readonly windowMs: number;
  private readonly memoryEventMaxAgeDays: number;
  private readonly batchDelayMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private pending: Pending[] = [];
  private flushScheduled = false;
  private windowTimestamps: number[] = [];
  /** Stats since construction, for observability. */
  readonly stats = { llmCalls: 0, fallbacks: 0, prefiltered: 0, deferred: 0 };

  constructor(deps: LLMScorerDeps = {}) {
    this.complete = deps.complete ?? ((request) => routedComplete(request));
    this.memoryStoreSource = deps.memoryStore ?? createMemoryMemoryStore();
    this.usageLoggerSource = deps.usageLogger ?? noopUsageLogger;
    this.resolvePerson = deps.resolvePerson ?? (async () => null);
    this.fallback = deps.fallback ?? rulesBasedScorer;
    this.metricScorer = deps.metricScorer ?? defaultMetricScorer;
    this.config = deps.config ?? DEFAULT_ENGINE_CONFIG.llm;
    this.windowMs = (deps.tickIntervalSeconds ?? DEFAULT_ENGINE_CONFIG.tick.intervalSeconds) * 1000;
    this.memoryEventMaxAgeDays = deps.memoryEventMaxAgeDays ?? DEFAULT_ENGINE_CONFIG.memory.maxEventAgeDays;
    this.batchDelayMs = deps.batchDelayMs ?? 0;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message, meta) => console.warn(`[llm-scorer] ${message}`, meta ?? ""));
  }

  // ---------------------------------------------------------------- public

  scoreSignal(signal: SentimentInput, context?: ScoringContext): Promise<ScoringOutcome> {
    const prefiltered = this.prefilter(signal);
    if (prefiltered) return prefiltered;

    return new Promise<ScoringOutcome>((resolve) => {
      this.pending.push({ signal, context: context ?? null, resolve });
      this.scheduleFlush();
    });
  }

  // ---------------------------------------------------------------- pre-filter

  /** Signals that must never cost an LLM call. */
  private prefilter(signal: SentimentInput): Promise<SentimentResult> | null {
    const kind = payloadField(signal.rawPayload, "kind");
    // A metric signal is scored from its explicit polarity and sigma; the
    // model never sees it, so no prompt can carry a metric to it either.
    if (kind === "metric") {
      this.stats.prefiltered += 1;
      return this.metricScorer.scoreSignal(signal) as Promise<SentimentResult>;
    }
    if (kind === "baseline") {
      this.stats.prefiltered += 1;
      return Promise.resolve({ label: "neutral", confidence: 0, direction: 0, rationale: "baseline signal: zero impact by design", scorer: "prefilter" });
    }
    if (signal.headline.trim().length < 8) {
      this.stats.prefiltered += 1;
      return Promise.resolve({ label: "neutral", confidence: 0, direction: 0, rationale: "empty headline", scorer: "prefilter" });
    }
    if (kind === "change") {
      const relative = payloadField(signal.rawPayload, "relativeChange");
      if (typeof relative === "number" && Math.abs(relative) < this.config.minRelativeChangeForLlm) {
        this.stats.prefiltered += 1;
        return this.scoreWithFallback(signal).then((result) => ({
          ...result,
          scorer: "rules",
          rationale: `${result.rationale ?? ""}; below LLM threshold (${(relative * 100).toFixed(3)}%)`.replace(/^; /, ""),
        }));
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- batching

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      void this.flush();
    }, this.batchDelayMs);
  }

  private async flush(): Promise<void> {
    const batch = this.pending.splice(0);
    if (batch.length === 0) return;

    // A batch normally belongs to one tick and carries one context. Two ticks
    // interleaving in one process (the manual route beside the cron) must not
    // share a budget, so the batch is split by context first.
    const byContext = new Map<ScoringContext | null, Pending[]>();
    for (const item of batch) {
      const list = byContext.get(item.context) ?? [];
      list.push(item);
      byContext.set(item.context, list);
    }
    for (const [context, items] of byContext) {
      // No context (a caller outside a tick): no deadline, but still a fresh budget per batch.
      await this.flushContext(items, context ?? { deadline: NO_DEADLINE, callBudget: new TickCallBudget(this.config.callBudgetPerTick) });
    }
  }

  private async flushContext(batch: Pending[], context: ScoringContext): Promise<void> {
    // Group by person; chunk large groups.
    const groups = new Map<string, Pending[]>();
    for (const item of batch) {
      const list = groups.get(item.signal.personId) ?? [];
      list.push(item);
      groups.set(item.signal.personId, list);
    }
    const chunks: Array<{ personId: string; items: Pending[] }> = [];
    for (const [personId, items] of groups) {
      for (let i = 0; i < items.length; i += this.config.maxSignalsPerCall) {
        chunks.push({ personId, items: items.slice(i, i + this.config.maxSignalsPerCall) });
      }
    }

    // Memory for everyone in the batch, in one read.
    let memories = new Map<string, PersonMemory>();
    try {
      const store = await this.resolve(this.memoryStoreSource);
      memories = await store.loadMany([...groups.keys()]);
    } catch (error) {
      this.log("memory unavailable; scoring without person context", { error: error instanceof Error ? error.message : String(error) });
    }

    const callCostMs = this.config.timeoutMs + CALL_OVERHEAD_MS;
    const tasks = chunks.map((chunk) => async () => {
      // Gate 1: the deadline. Checked when a worker picks the chunk up, so a
      // chunk queued behind slow calls is judged on the time actually left.
      if (!context.deadline.canStart(callCostMs)) {
        const left = context.deadline.remainingMs();
        this.defer(chunk.items, "deadline", `${(left / 1000).toFixed(1)}s left in the tick, a call may take ${(callCostMs / 1000).toFixed(0)}s`);
        return;
      }
      // Gates 2 and 3: one call per person per tick, then the tick's budget.
      const refused = context.callBudget.take(chunk.personId);
      if (refused === "person_cap") {
        this.defer(chunk.items, refused, "this person already had their call this tick");
        return;
      }
      if (refused) {
        this.defer(chunk.items, refused, `per-tick call budget of ${context.callBudget.limit} spent`);
        return;
      }
      // Gate 4: the process-wide rolling rate limit.
      if (!this.reserveWindowSlot()) {
        this.defer(chunk.items, "rate_limit", `rolling limit of ${this.config.rollingWindowMaxCalls} calls per ${this.windowMs / 1000}s reached`);
        return;
      }
      await this.scoreChunk(chunk.personId, chunk.items, memories.get(chunk.personId));
    });
    await runWithConcurrency(tasks, this.config.maxConcurrentCalls);
  }

  /** Rolling window: at most rollingWindowMaxCalls calls per tick interval, process-wide. A rate limit, never a per-tick budget. */
  private reserveWindowSlot(): boolean {
    const time = this.now();
    this.windowTimestamps = this.windowTimestamps.filter((t) => time - t < this.windowMs);
    if (this.windowTimestamps.length >= this.config.rollingWindowMaxCalls) return false;
    this.windowTimestamps.push(time);
    return true;
  }

  private async scoreChunk(personId: string, items: Pending[], memory: PersonMemory | undefined): Promise<void> {
    const signals = items.map((item) => item.signal);
    const person = (await this.resolvePerson(personId)) ?? { id: personId, slug: personId, displayName: personId, category: "person" };
    const memoryForPrompt = memory ?? { personId, profile: {}, baselinePatterns: {}, recentContext: { summary: "No notable events recorded yet.", notable_events: [] }, updatedAt: null };
    const tickNumber = signals.find((s) => s.tickNumber !== undefined)?.tickNumber ?? null;

    // The ledger, in both halves: the started row goes in before any money
    // is spent, so a call the process dies inside is still on record.
    let logger: LLMUsageLogger = noopUsageLogger;
    try {
      logger = await this.resolve(this.usageLoggerSource);
    } catch {
      // usage logging never affects scoring
    }
    const route = resolveRoute("sentiment");
    const attempt = { provider: route.providerName, model: route.model ?? "provider-default", taskType: "sentiment" as const, personId, tickNumber };

    let response: LLMResponse;
    try {
      this.stats.llmCalls += 1;
      response = await recordedCall(logger, attempt, () =>
        this.complete({
          taskType: "sentiment",
          systemPrompt: SENTIMENT_SYSTEM_PROMPT,
          userPrompt: buildSentimentUserPrompt(
            { displayName: person.displayName, slug: person.slug, category: person.category, memory: memoryForPrompt, today: new Date(this.now()), eventMaxAgeDays: this.memoryEventMaxAgeDays },
            signals,
          ),
          responseFormat: { type: "json", schema: SENTIMENT_RESPONSE_SCHEMA, name: "sentiment_assessment" },
          timeoutMs: this.config.timeoutMs,
        }),
      );
    } catch (error) {
      const reason = error instanceof LLMError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
      await this.fallbackFor(items, `LLM call failed (${reason})`);
      return;
    }

    const parsed = this.parseResponse(response.structuredData);
    if (!parsed) {
      await this.fallbackFor(items, "LLM response did not match the expected shape");
      return;
    }

    const byId = new Map(parsed.signals.map((s) => [s.id, s]));
    const unmatched: Pending[] = [];
    for (const item of items) {
      const assessment = byId.get(item.signal.id);
      if (!assessment) {
        unmatched.push(item);
        continue;
      }
      item.resolve(this.toResult(assessment, parsed.narrative));
    }
    if (unmatched.length > 0) await this.fallbackFor(unmatched, "LLM omitted the signal from its response");
  }

  private toResult(assessment: ParsedSignalAssessment, narrative: string | undefined): SentimentResult {
    const multiplier = {
      routine: this.config.routineConfidenceMultiplier,
      notable: this.config.notableConfidenceMultiplier,
      anomalous: this.config.anomalousConfidenceMultiplier,
    }[assessment.anomaly];
    const direction: SentimentResult["direction"] = assessment.label === "positive" ? 1 : assessment.label === "negative" ? -1 : 0;
    const confidence = direction === 0 ? 0 : Math.round(clamp01(assessment.confidence * multiplier) * 1000) / 1000;
    return {
      label: assessment.label,
      direction,
      confidence,
      anomaly: assessment.anomaly,
      rationale: assessment.rationale,
      narrative: narrative?.trim() || undefined,
      scorer: this.name,
    };
  }

  private parseResponse(data: unknown): { signals: ParsedSignalAssessment[]; narrative?: string } | null {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const record = data as Record<string, unknown>;
    if (!Array.isArray(record.signals)) return null;
    const signals: ParsedSignalAssessment[] = [];
    for (const entry of record.signals) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || typeof e.label !== "string" || !LABELS.has(e.label)) continue;
      const confidence = typeof e.confidence === "number" && Number.isFinite(e.confidence) ? clamp01(e.confidence) : 0.5;
      const anomaly = typeof e.anomaly === "string" && ANOMALIES.has(e.anomaly) ? (e.anomaly as SentimentAnomaly) : "notable";
      signals.push({
        id: e.id,
        label: e.label as SentimentResult["label"],
        confidence,
        anomaly,
        rationale: typeof e.rationale === "string" ? e.rationale.slice(0, 300) : "",
      });
    }
    return { signals, narrative: typeof record.narrative === "string" ? record.narrative.slice(0, 400) : undefined };
  }

  /** The signals were NOT attempted: they stay unprocessed and a later tick scores them. */
  private defer(items: Pending[], reason: DeferralReason, detail: string): void {
    this.stats.deferred += items.length;
    this.log(`deferring ${items.length} signal(s) to a later tick: ${reason} (${detail})`, { personId: items[0]?.signal.personId, reason });
    for (const item of items) item.resolve({ deferred: true, reason, detail });
  }

  /** The signals WERE attempted and the attempt failed: the rules scorer answers, and they are processed. */
  private async fallbackFor(items: Pending[], reason: string): Promise<void> {
    this.stats.fallbacks += items.length;
    this.log(`falling back to the rules scorer for ${items.length} signal(s): ${reason}`, { personId: items[0]?.signal.personId });
    for (const item of items) {
      try {
        const result = await this.scoreWithFallback(item.signal);
        item.resolve({ ...result, scorer: "rules-fallback", rationale: `${result.rationale ?? ""} [fallback: ${reason}]`.trim() });
      } catch (error) {
        item.resolve({ label: "neutral", confidence: 0, direction: 0, scorer: "rules-fallback", rationale: `fallback failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  /** The fallback scorer never defers; the cast records that contract. */
  private scoreWithFallback(signal: SentimentInput): Promise<SentimentResult> {
    return this.fallback.scoreSignal(signal) as Promise<SentimentResult>;
  }

  private async resolve<T>(source: T | (() => Promise<T>)): Promise<T> {
    return typeof source === "function" ? (source as () => Promise<T>)() : source;
  }
}

/**
 * Production LLM scorer: memory + usage logging through the service-role
 * client (created lazily so importing this module never touches env/Supabase).
 */
export function createDefaultLLMScorer(config: EngineConfig = DEFAULT_ENGINE_CONFIG): LLMScorer {
  let adminPromise: Promise<import("@/types").TypedSupabaseClient> | null = null;
  const admin = () => {
    adminPromise ??= import("@/lib/supabase-admin").then(({ createSupabaseAdminClient }) => createSupabaseAdminClient());
    return adminPromise;
  };
  let memoryStorePromise: Promise<MemoryStore> | null = null;
  let usageLoggerPromise: Promise<LLMUsageLogger> | null = null;
  const peopleCache = new Map<string, LLMScorerPerson>();

  return new LLMScorer({
    config: config.llm,
    tickIntervalSeconds: config.tick.intervalSeconds,
    memoryEventMaxAgeDays: config.memory.maxEventAgeDays,
    memoryStore: () => {
      memoryStorePromise ??= Promise.all([admin(), import("@/lib/engine/memory/store")]).then(([client, mod]) =>
        mod.withMemoryCache(mod.createSupabaseMemoryStore(client), config.llm.memoryCacheTtlMs),
      );
      return memoryStorePromise;
    },
    usageLogger: () => {
      usageLoggerPromise ??= Promise.all([admin(), import("@/lib/llm/usage")]).then(([client, mod]) => mod.createSupabaseUsageLogger(client));
      return usageLoggerPromise;
    },
    resolvePerson: async (personId) => {
      const cached = peopleCache.get(personId);
      if (cached) return cached;
      const client = await admin();
      const { data } = await client.from("people").select("id, slug, display_name, category").eq("id", personId).maybeSingle();
      if (!data) return null;
      const person = { id: data.id, slug: data.slug, displayName: data.display_name, category: data.category };
      peopleCache.set(personId, person);
      return person;
    },
  });
}
