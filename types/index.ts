import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables, TablesInsert, TablesUpdate } from "./database";

export type { Database, Tables, TablesInsert, TablesUpdate };

/** Supabase client bound to the generated Database schema. */
export type TypedSupabaseClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Row aliases — one per table, named for how the domain talks about them.
// ---------------------------------------------------------------------------
export type UserProfile = Tables<"users">;
export type Person = Tables<"people">;
export type DataSource = Tables<"data_sources">;
export type PersonDataSource = Tables<"person_data_sources">;
export type InversePair = Tables<"inverse_pairs">;
export type Position = Tables<"positions">;
export type Transaction = Tables<"transactions">;
export type Signal = Tables<"signals">;
export type ScoreHistoryEntry = Tables<"score_history">;
export type PortfolioHistoryEntry = Tables<"portfolio_history">;
export type BehavioralEvent = Tables<"behavioral_events">;
/** RAW metric levels. Service role only; never read by a user-facing surface (Phase 7). */
export type RawSourceSnapshot = Tables<"raw_source_snapshots">;
export type RawMetricObservation = Tables<"raw_metric_observations">;
export type IngestRun = Tables<"ingest_runs">;
export type SourcePoll = Tables<"source_polls">;

// ---------------------------------------------------------------------------
// Closed vocabularies. These mirror CHECK constraints in the schema; keep them
// in sync when a migration changes the allowed values.
// ---------------------------------------------------------------------------
export type PersonCategory = "creator" | "musician" | "athlete" | "executive" | "founder";
export type PartnershipStatus = "unverified" | "pending" | "partner";
export type PositionDirection = "HIGH" | "LOW";
export type TransactionType = "DEPOSIT" | "ALLOCATION" | "REDEMPTION" | "WITHDRAWAL";
export type SentimentLabel = "positive" | "negative" | "neutral";

/**
 * Behavioral event vocabulary (Phase 5). The database only checks the format
 * of event_type; the canonical list is BEHAVIORAL_EVENT_TYPES in
 * lib/behavioral/events.ts, so new types need no migration.
 */
export type { BehavioralEventType } from "@/lib/behavioral/events";

// ---------------------------------------------------------------------------
// Engine (Phase 3)
// ---------------------------------------------------------------------------
export type EngineTick = Tables<"engine_ticks">;
export type ScoreEvent = Tables<"score_events">;
export type TradeEventRow = Tables<"trade_events">;
export type TradeSide = "BUY" | "SELL";
/** Enforced by score_events_force_check. */
export type ScoreEventForce = "gravity" | "signals" | "market_mood" | "conviction" | "trading_activity" | "inverse_pair";

// ---------------------------------------------------------------------------
// LLM reasoning layer + memory (Phase 4)
// ---------------------------------------------------------------------------
export type PersonMemoryRow = Tables<"person_memory">;
export type LlmUsageRow = Tables<"llm_usage">;
export type NarrativeRow = Tables<"narratives">;
export type LlmTaskType = "sentiment" | "anomaly" | "narrative" | "memory";
export type NarrativeSource = "llm" | "template";
