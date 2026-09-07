import type { SentimentLabel } from "@/types";
import type { Json } from "@/types/database";

/**
 * Per-entity memory: what the Engine knows about each person. Stored in
 * person_memory as three jsonb documents.
 */

export interface MemoryProfile {
  role?: string;
  summary?: string;
  momentum_drivers?: string[];
  context?: string;
  [key: string]: Json | undefined;
}

export interface MemoryBaselinePatterns {
  typical_signal_volume?: string;
  typical_change_magnitude?: string;
  routine?: string[];
  notable?: string[];
  noise_note?: string;
  [key: string]: Json | undefined;
}

export interface MemoryNotableEvent {
  /** ISO timestamp of the event. */
  at: string;
  headline: string;
  label: SentimentLabel;
  /** Score impact the Engine applied. */
  impact: number;
  anomaly?: string;
  source?: string;
}

export interface MemoryRecentContext {
  /** Rolling prose summary of what has happened recently. */
  summary: string;
  /** Newest first, capped; older events are folded into the summary. */
  notable_events: MemoryNotableEvent[];
  last_updated_tick?: number;
  updated_at?: string;
}

export interface PersonMemory {
  personId: string;
  profile: MemoryProfile;
  baselinePatterns: MemoryBaselinePatterns;
  recentContext: MemoryRecentContext;
  updatedAt: string | null;
}

export const EMPTY_RECENT_CONTEXT: MemoryRecentContext = {
  summary: "No notable events recorded yet.",
  notable_events: [],
};

export function emptyMemory(personId: string): PersonMemory {
  return { personId, profile: {}, baselinePatterns: {}, recentContext: { ...EMPTY_RECENT_CONTEXT, notable_events: [] }, updatedAt: null };
}

function asObject(value: Json | null | undefined): Record<string, Json | undefined> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Tolerant parse of a person_memory row (missing or malformed fields become empty). */
export function parseMemoryRow(row: {
  person_id: string;
  profile: Json | null;
  baseline_patterns: Json | null;
  recent_context: Json | null;
  updated_at: string | null;
}): PersonMemory {
  const recent = asObject(row.recent_context);
  const events = Array.isArray(recent.notable_events) ? (recent.notable_events as unknown as MemoryNotableEvent[]) : [];
  return {
    personId: row.person_id,
    profile: asObject(row.profile) as MemoryProfile,
    baselinePatterns: asObject(row.baseline_patterns) as MemoryBaselinePatterns,
    recentContext: {
      summary: typeof recent.summary === "string" ? recent.summary : EMPTY_RECENT_CONTEXT.summary,
      notable_events: events.filter((e) => e && typeof e.headline === "string"),
      last_updated_tick: typeof recent.last_updated_tick === "number" ? recent.last_updated_tick : undefined,
      updated_at: typeof recent.updated_at === "string" ? recent.updated_at : undefined,
    },
    updatedAt: row.updated_at,
  };
}
