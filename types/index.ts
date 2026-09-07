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
export type SourceSnapshot = Tables<"source_snapshots">;

// ---------------------------------------------------------------------------
// Closed vocabularies. These mirror CHECK constraints in the schema; keep them
// in sync when a migration changes the allowed values.
// ---------------------------------------------------------------------------
export type PersonCategory = "creator" | "musician" | "athlete" | "executive" | "founder";
export type PartnershipStatus = "unverified" | "pending" | "partner";
export type PositionDirection = "HIGH" | "LOW";
export type TransactionType = "DEPOSIT" | "ALLOCATION" | "REDEMPTION" | "WITHDRAWAL";
export type SentimentLabel = "positive" | "negative" | "neutral";

/** Enforced by behavioral_events_event_type_check. Extend the constraint (migration) before adding a value here. */
export type BehavioralEventType = "view_person" | "expand_signal" | "take_position" | "time_spent" | "follow";

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
