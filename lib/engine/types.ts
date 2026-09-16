import type { DeferralReason } from "@/lib/engine/sentiment/budget";
import type { SentimentResult } from "@/lib/engine/sentiment/types";
import type { InversePair, Person } from "@/types";
import type { Json } from "@/types/database";

/** The five forces plus the second-pass inverse-pair adjustment. */
export type ForceName = "gravity" | "signals" | "market_mood" | "conviction" | "trading_activity" | "inverse_pair";

export const FORCE_NAMES: readonly ForceName[] = [
  "gravity",
  "signals",
  "market_mood",
  "conviction",
  "trading_activity",
  "inverse_pair",
];

/** One force's contribution to one person's score this tick. */
export interface ForceEntry {
  force: ForceName;
  impact: number;
  details: Record<string, unknown>;
}

/** An unprocessed signal as the Engine sees it (joined with its data source). */
export interface EngineSignal {
  id: string;
  personId: string;
  headline: string;
  rawPayload: Json | null;
  sourceName: string;
  sourceTier: number;
  occurredAt: Date;
  createdAt: Date;
}

/** A signal after the SentimentScorer and the Signals force have looked at it. */
export interface ScoredSignal {
  signal: EngineSignal;
  sentiment: SentimentResult;
  /** Points added to the person's score by this signal. */
  impact: number;
}

/** A Buy or Sell on the trade tape. */
export interface TradeEvent {
  personId: string;
  side: "BUY" | "SELL";
  amountCents: number;
  createdAt: Date;
}

/** Processed-signal activity in the spread window, per person. */
export interface SignalActivity {
  personId: string;
  count: number;
  /** Mean sentiment confidence of those signals (0 when none). */
  averageConfidence: number;
}

/** Everything one tick needs, loaded up front so the math is pure. */
export interface TickContext {
  now: Date;
  people: Person[];
  /** Unprocessed signals of active people, oldest first, up to tick.loadCeiling. The tick selects from these. */
  signals: EngineSignal[];
  /** How many unprocessed signals active people have in total: the backlog, whatever the ceiling let through. */
  backlog: number;
  /** Open capital per person, in cents. */
  openCapitalCentsByPerson: Map<string, number>;
  signalActivityByPerson: Map<string, SignalActivity>;
  /** Trade events inside the Trading Activity history window. */
  tradeEvents: TradeEvent[];
  inversePairs: InversePair[];
  /** Highest tick_number persisted so far (0 before the first tick). */
  lastTickNumber: number;
}

export interface PersonTickResult {
  person: Person;
  previousScore: number;
  deltaHours: number;
  /** Concentration = open capital / max_allocation. */
  concentration: number;
  forces: ForceEntry[];
  scoredSignals: ScoredSignal[];
  /** Sum of the Signals force this tick (input to Market Mood and inverse pairs). */
  signalsImpact: number;
  /** Score after the five forces, clamped. */
  firstPassScore: number;
  /** Inverse-pair adjustment applied in the second pass. */
  inverseAdjustment: number;
  /** Final clamped score. */
  newScore: number;
  spread: number;
  buyPrice: number;
  sellPrice: number;
}

export interface PersonSummary {
  id: string;
  slug: string;
  displayName: string;
  revertTarget: number;
  previousScore: number;
  newScore: number;
  change: number;
  spread: number;
  buyPrice: number;
  sellPrice: number;
  /** Non-zero force contributions. */
  forces: Partial<Record<ForceName, number>>;
  signalsProcessed: number;
}

/** What started the tick: a manual call to /api/engine/tick or the scheduled cron heartbeat. */
export type TickTrigger = "manual" | "cron";

/**
 * HOW MUCH OF THE WORK THE TICK DID, and what it left behind. Persisted in
 * engine_ticks.summary so a partial commit is visible as one, and the
 * backlog can be watched tick by tick.
 */
export interface TickScoringSummary {
  /** Unprocessed signals of active people when the tick loaded. */
  backlogBefore: number;
  /** Rows the tick read (bounded by tick.loadCeiling). */
  loaded: number;
  /** Signals the tick took on after the per-person and per-tick bounds. */
  selected: number;
  /** Signals sent to the model this tick: scored by it, or fallen back after a failed attempt. */
  attempted: number;
  llmScored: number;
  /** Attempted, and the attempt failed: scored by rules, processed. */
  fallbacks: number;
  /** Scored without the model by design: metric, baseline, tiny change, or the rules scorer. */
  withoutModel: number;
  /** Selected but NOT attempted: left unprocessed for a later tick. */
  deferred: number;
  deferredByReason: Partial<Record<DeferralReason, number>>;
  /** Model calls this tick, against the budget. */
  llmCalls: number;
  llmCallBudget: number;
  /** Signals this tick commits as processed. */
  processed: number;
  /** Unprocessed signals left after this tick. The number to watch. */
  backlogAfter: number;
  /** True when the tick left signals unprocessed, by deferral or by the bounds. */
  partial: boolean;
  /** Wall-clock budget the tick had, and how much of it was left when scoring finished. */
  budgetMs: number | null;
  remainingMs: number | null;
}

export interface TickSummary {
  tickNumber: number;
  dryRun: boolean;
  trigger?: TickTrigger;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Market Mood this tick (before the per-person fraction). */
  mood: number;
  peopleUpdated: number;
  signalsProcessed: number;
  scoring: TickScoringSummary;
  people: PersonSummary[];
  signals: Array<{
    id: string;
    personSlug: string;
    headline: string;
    label: SentimentResult["label"];
    confidence: number;
    direction: SentimentResult["direction"];
    impact: number;
    /** Which scorer produced the assessment ("rules", "llm", "prefilter", "rules-fallback"). */
    scorer?: string;
    rationale?: string;
    anomaly?: SentimentResult["anomaly"];
    /** The Engine's one-sentence explanation from LLM reasoning, reused by narratives. */
    narrative?: string;
  }>;
  /** Signals the tick selected but did not attempt; they stay unprocessed. */
  deferred: Array<{ id: string; personSlug: string; reason: DeferralReason; detail: string }>;
}

/** What the store persists atomically. */
export interface TickPersistence {
  expectedTickNumber: number;
  startedAt: Date;
  finishedAt: Date;
  mood: number;
  summary: TickSummary;
  people: Array<{ id: string; score: number; spread: number }>;
  signals: Array<{ id: string; impactScore: number; sentimentLabel: SentimentResult["label"]; sentimentConfidence: number }>;
  events: Array<{ personId: string; force: ForceName; impact: number; details: Record<string, unknown> }>;
}

export interface TickPersistenceResult {
  tickNumber: number;
  peopleUpdated: number;
  signalsProcessed: number;
  scoreEvents: number;
}
