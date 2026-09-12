import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@/lib/engine/config";
import { createMemoryMemoryStore, type MemoryStore } from "@/lib/engine/memory/store";
import type { PersonMemory } from "@/lib/engine/memory/types";
import { routedComplete, type RoutedRequest } from "@/lib/llm/routing";
import { LLMError, type LLMResponse } from "@/lib/llm/types";
import { noopUsageLogger, usageFromResponse, type LLMUsageLogger } from "@/lib/llm/usage";
import type { Json } from "@/types/database";

import { metricScorer as defaultMetricScorer } from "./metric";
import { SENTIMENT_RESPONSE_SCHEMA, SENTIMENT_SYSTEM_PROMPT, buildSentimentUserPrompt } from "./prompts";
import { rulesBasedScorer } from "./rules";
import type { SentimentAnomaly, SentimentInput, SentimentResult, SentimentScorer } from "./types";

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
 *   - a hard per-tick call cap; beyond it signals use the rules scorer
 *   - every call's token usage is logged
 *
 * Resilience: any provider error, timeout, refusal or malformed response makes
 * the affected signals fall back to the rules scorer. The tick never fails
 * because the LLM had a hiccup; the fallback is logged.
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
  /** Delay before a batch is flushed, in ms. 0 = next macrotask. */
  batchDelayMs?: number;
  now?: () => number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface Pending {
  signal: SentimentInput;
  resolve: (result: SentimentResult) => void;
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
  private readonly batchDelayMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private pending: Pending[] = [];
  private flushScheduled = false;
  private callTimestamps: number[] = [];
  /** Stats since construction, for observability. */
  readonly stats = { llmCalls: 0, fallbacks: 0, prefiltered: 0, capped: 0 };

  constructor(deps: LLMScorerDeps = {}) {
    this.complete = deps.complete ?? ((request) => routedComplete(request));
    this.memoryStoreSource = deps.memoryStore ?? createMemoryMemoryStore();
    this.usageLoggerSource = deps.usageLogger ?? noopUsageLogger;
    this.resolvePerson = deps.resolvePerson ?? (async () => null);
    this.fallback = deps.fallback ?? rulesBasedScorer;
    this.metricScorer = deps.metricScorer ?? defaultMetricScorer;
    this.config = deps.config ?? DEFAULT_ENGINE_CONFIG.llm;
    this.windowMs = (deps.tickIntervalSeconds ?? DEFAULT_ENGINE_CONFIG.tick.intervalSeconds) * 1000;
    this.batchDelayMs = deps.batchDelayMs ?? 0;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message, meta) => console.warn(`[llm-scorer] ${message}`, meta ?? ""));
  }

  // ---------------------------------------------------------------- public

  scoreSignal(signal: SentimentInput): Promise<SentimentResult> {
    const prefiltered = this.prefilter(signal);
    if (prefiltered) return prefiltered;

    return new Promise<SentimentResult>((resolve) => {
      this.pending.push({ signal, resolve });
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
      return this.metricScorer.scoreSignal(signal);
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
        return this.fallback.scoreSignal(signal).then((result) => ({
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

    const tasks = chunks.map((chunk) => async () => {
      if (!this.reserveCall()) {
        this.stats.capped += 1;
        await this.fallbackFor(chunk.items, "per-tick LLM call cap reached");
        return;
      }
      await this.scoreChunk(chunk.personId, chunk.items, memories.get(chunk.personId));
    });
    await runWithConcurrency(tasks, this.config.maxConcurrentCalls);
  }

  /** Rolling window: at most maxCallsPerTick calls per tick interval. */
  private reserveCall(): boolean {
    const time = this.now();
    this.callTimestamps = this.callTimestamps.filter((t) => time - t < this.windowMs);
    if (this.callTimestamps.length >= this.config.maxCallsPerTick) return false;
    this.callTimestamps.push(time);
    return true;
  }

  private async scoreChunk(personId: string, items: Pending[], memory: PersonMemory | undefined): Promise<void> {
    const signals = items.map((item) => item.signal);
    const person = (await this.resolvePerson(personId)) ?? { id: personId, slug: personId, displayName: personId, category: "person" };
    const memoryForPrompt = memory ?? { personId, profile: {}, baselinePatterns: {}, recentContext: { summary: "No notable events recorded yet.", notable_events: [] }, updatedAt: null };

    let response: LLMResponse;
    try {
      this.stats.llmCalls += 1;
      response = await this.complete({
        taskType: "sentiment",
        systemPrompt: SENTIMENT_SYSTEM_PROMPT,
        userPrompt: buildSentimentUserPrompt({ displayName: person.displayName, slug: person.slug, category: person.category, memory: memoryForPrompt }, signals),
        responseFormat: { type: "json", schema: SENTIMENT_RESPONSE_SCHEMA, name: "sentiment_assessment" },
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      const reason = error instanceof LLMError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
      await this.fallbackFor(items, `LLM call failed (${reason})`);
      return;
    }

    try {
      const logger = await this.resolve(this.usageLoggerSource);
      await logger.log(usageFromResponse(response, { taskType: "sentiment", personId, tickNumber: signals.find((s) => s.tickNumber !== undefined)?.tickNumber ?? null }));
    } catch {
      // usage logging never affects scoring
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

  private async fallbackFor(items: Pending[], reason: string): Promise<void> {
    this.stats.fallbacks += items.length;
    this.log(`falling back to the rules scorer for ${items.length} signal(s): ${reason}`, { personId: items[0]?.signal.personId });
    for (const item of items) {
      try {
        const result = await this.fallback.scoreSignal(item.signal);
        item.resolve({ ...result, scorer: "rules-fallback", rationale: `${result.rationale ?? ""} [fallback: ${reason}]`.trim() });
      } catch (error) {
        item.resolve({ label: "neutral", confidence: 0, direction: 0, scorer: "rules-fallback", rationale: `fallback failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
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
  const peopleCache = new Map<string, LLMScorerPerson>();

  return new LLMScorer({
    config: config.llm,
    tickIntervalSeconds: config.tick.intervalSeconds,
    memoryStore: () => {
      memoryStorePromise ??= Promise.all([admin(), import("@/lib/engine/memory/store")]).then(([client, mod]) =>
        mod.withMemoryCache(mod.createSupabaseMemoryStore(client), config.llm.memoryCacheTtlMs),
      );
      return memoryStorePromise;
    },
    usageLogger: () => Promise.all([admin(), import("@/lib/llm/usage")]).then(([client, mod]) => mod.createSupabaseUsageLogger(client)),
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
