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

// ---------------------------------------------------------------------------
// Closed vocabularies. These mirror CHECK constraints in the schema; keep them
// in sync when a migration changes the allowed values.
// ---------------------------------------------------------------------------
export type PersonCategory = "creator" | "musician" | "athlete" | "executive" | "founder";
export type PartnershipStatus = "unverified" | "pending" | "partner";
export type PositionDirection = "HIGH" | "LOW";
export type TransactionType = "DEPOSIT" | "ALLOCATION" | "REDEMPTION" | "WITHDRAWAL";
export type SentimentLabel = "positive" | "negative" | "neutral";

/** Known event types. The column is intentionally unconstrained, so new types are allowed. */
export type BehavioralEventType =
  | "view_person"
  | "expand_signal"
  | "take_position"
  | "time_spent"
  | "follow"
  | (string & {});
