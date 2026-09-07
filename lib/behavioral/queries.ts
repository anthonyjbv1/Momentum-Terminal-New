import "server-only";

import type { SupabaseAdminClient } from "@/lib/supabase-admin";
import type { Json } from "@/types/database";

import { isBehavioralEventType, type BehavioralEventType, type SwipeAction } from "./events";

/**
 * Read side of the behavioral log: the data access layer a recommendation
 * algorithm will sit on. Typed query functions only; no ranking, no model.
 *
 * SERVICE ROLE ONLY. Every function takes a SupabaseAdminClient, and the SQL
 * functions they call (behavioral_user_history, behavioral_person_engagement,
 * behavioral_co_engagement) grant EXECUTE to service_role alone, so a
 * signed-in user's client cannot reach other users' behavior even by calling
 * the RPC directly. Never return these results to a browser without deciding,
 * per feature, what a user is allowed to see about themselves; never expose
 * another user's history.
 *
 * Only canonical event types (BEHAVIORAL_EVENT_TYPES) are counted; anything
 * else that reached the table is ignored here.
 */

export const DEFAULT_LOOKBACK_DAYS = 90;

/** The interactions that count as "engaged with a person" for co-engagement. */
export const CO_ENGAGEMENT_EVENT_TYPES: readonly BehavioralEventType[] = [
  "view_person",
  "time_spent",
  "expand_signal",
  "take_position",
  "follow_person",
];

function sinceIso(since: Date | undefined, lookbackDays = DEFAULT_LOOKBACK_DAYS): string {
  return (since ?? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)).toISOString();
}

// ---------------------------------------------------------------------------
// getUserInteractionHistory
// ---------------------------------------------------------------------------

export interface BehavioralEventRecord {
  id: string;
  eventType: string;
  personId: string | null;
  sessionId: string | null;
  metadata: Json | null;
  createdAt: string;
}

export interface PersonInteractionSummary {
  personId: string;
  eventCounts: Partial<Record<BehavioralEventType, number>>;
  views: number;
  timeSpentMs: number;
  expands: number;
  positionsTaken: number;
  positionsClosed: number;
  follows: number;
  unfollows: number;
  swipes: number;
  /** follows minus unfollows in the window. */
  netFollows: number;
  firstInteractedAt: string;
  lastInteractedAt: string;
}

export interface UserInteractionHistory {
  userId: string;
  since: string;
  totals: Partial<Record<BehavioralEventType, number>>;
  /** Per person, most recently interacted first. */
  people: PersonInteractionSummary[];
  /** Raw recent events, newest first, for sequence features. */
  recent: BehavioralEventRecord[];
}

export interface InteractionHistoryOptions {
  since?: Date;
  eventTypes?: BehavioralEventType[];
  /** How many raw events to return in `recent` (default 100, max 1000). */
  recentLimit?: number;
}

export async function getUserInteractionHistory(
  client: SupabaseAdminClient,
  userId: string,
  options: InteractionHistoryOptions = {},
): Promise<UserInteractionHistory> {
  const since = sinceIso(options.since);
  const recentLimit = Math.min(Math.max(options.recentLimit ?? 100, 0), 1000);

  const [aggregates, recentRows] = await Promise.all([
    client.rpc("behavioral_user_history", {
      p_user_id: userId,
      p_since: since,
      p_event_types: options.eventTypes,
    }),
    client
      .from("behavioral_events")
      .select("id, event_type, person_id, session_id, metadata, created_at")
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(recentLimit),
  ]);
  if (aggregates.error) throw new Error(`behavioral_user_history failed: ${aggregates.error.message}`);
  if (recentRows.error) throw new Error(`behavioral_events query failed: ${recentRows.error.message}`);

  const totals: Partial<Record<BehavioralEventType, number>> = {};
  const people = new Map<string, PersonInteractionSummary>();

  for (const row of aggregates.data ?? []) {
    if (!isBehavioralEventType(row.event_type)) continue;
    const eventType = row.event_type;
    const count = Number(row.event_count);
    totals[eventType] = (totals[eventType] ?? 0) + count;
    if (!row.person_id) continue;

    const summary = people.get(row.person_id) ?? emptyPersonSummary(row.person_id, row.first_at, row.last_at);
    summary.eventCounts[eventType] = (summary.eventCounts[eventType] ?? 0) + count;
    switch (eventType) {
      case "view_person":
        summary.views += count;
        break;
      case "time_spent":
        summary.timeSpentMs += Number(row.total_duration_ms);
        break;
      case "expand_signal":
        summary.expands += count;
        break;
      case "take_position":
        summary.positionsTaken += count;
        break;
      case "close_position":
        summary.positionsClosed += count;
        break;
      case "follow_person":
        summary.follows += count;
        break;
      case "unfollow_person":
        summary.unfollows += count;
        break;
      case "swipe":
        summary.swipes += count;
        break;
      default:
        break;
    }
    summary.netFollows = summary.follows - summary.unfollows;
    if (row.first_at < summary.firstInteractedAt) summary.firstInteractedAt = row.first_at;
    if (row.last_at > summary.lastInteractedAt) summary.lastInteractedAt = row.last_at;
    people.set(row.person_id, summary);
  }

  return {
    userId,
    since,
    totals,
    people: [...people.values()].sort((a, b) => b.lastInteractedAt.localeCompare(a.lastInteractedAt)),
    recent: (recentRows.data ?? []).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      personId: row.person_id,
      sessionId: row.session_id,
      metadata: row.metadata,
      createdAt: row.created_at,
    })),
  };
}

function emptyPersonSummary(personId: string, firstAt: string, lastAt: string): PersonInteractionSummary {
  return {
    personId,
    eventCounts: {},
    views: 0,
    timeSpentMs: 0,
    expands: 0,
    positionsTaken: 0,
    positionsClosed: 0,
    follows: 0,
    unfollows: 0,
    swipes: 0,
    netFollows: 0,
    firstInteractedAt: firstAt,
    lastInteractedAt: lastAt,
  };
}

// ---------------------------------------------------------------------------
// getPersonEngagement
// ---------------------------------------------------------------------------

export interface PersonEngagement {
  personId: string;
  since: string;
  totalEvents: number;
  /** Distinct users with any event on this person in the window. */
  uniqueUsers: number;
  timeSpentMs: number;
  /** Per event type: events and distinct users (exact, not summed over details). */
  byType: Partial<Record<BehavioralEventType, { events: number; users: number }>>;
  positions: { high: number; low: number };
  swipes: Partial<Record<SwipeAction, number>>;
  /** follow_person minus unfollow_person events in the window. */
  netFollows: number;
}

export async function getPersonEngagement(
  client: SupabaseAdminClient,
  personId: string,
  options: { since?: Date } = {},
): Promise<PersonEngagement> {
  const since = sinceIso(options.since);
  const { data, error } = await client.rpc("behavioral_person_engagement", { p_person_id: personId, p_since: since });
  if (error) throw new Error(`behavioral_person_engagement failed: ${error.message}`);

  const engagement: PersonEngagement = {
    personId,
    since,
    totalEvents: 0,
    uniqueUsers: 0,
    timeSpentMs: 0,
    byType: {},
    positions: { high: 0, low: 0 },
    swipes: {},
    netFollows: 0,
  };

  for (const row of data ?? []) {
    const level = Number(row.grouping_level);
    if (level === 3) {
      // grand total: event_type is null
      engagement.totalEvents = Number(row.event_count);
      engagement.uniqueUsers = Number(row.unique_users);
      engagement.timeSpentMs = Number(row.total_duration_ms);
      continue;
    }
    if (!isBehavioralEventType(row.event_type)) continue;
    const eventType = row.event_type;

    if (level === 1) {
      engagement.byType[eventType] = { events: Number(row.event_count), users: Number(row.unique_users) };
      continue;
    }

    // level 0: (event_type, detail)
    if (eventType === "take_position") {
      if (row.detail === "HIGH") engagement.positions.high += Number(row.event_count);
      else if (row.detail === "LOW") engagement.positions.low += Number(row.event_count);
    } else if (eventType === "swipe" && row.detail) {
      const action = row.detail as SwipeAction;
      engagement.swipes[action] = (engagement.swipes[action] ?? 0) + Number(row.event_count);
    }
  }

  engagement.netFollows = (engagement.byType.follow_person?.events ?? 0) - (engagement.byType.unfollow_person?.events ?? 0);
  return engagement;
}

// ---------------------------------------------------------------------------
// getCoEngagementPairs
// ---------------------------------------------------------------------------

export interface CoEngagementPair {
  personA: string;
  personB: string;
  /** Users who engaged with both. */
  sharedUsers: number;
  usersA: number;
  usersB: number;
  /** sharedUsers / (usersA + usersB − sharedUsers): 0..1 overlap of the two audiences. */
  jaccard: number;
}

export interface CoEngagementOptions {
  since?: Date;
  /** Which interactions count as engagement (default CO_ENGAGEMENT_EVENT_TYPES). */
  eventTypes?: readonly BehavioralEventType[];
  /** Pairs with fewer shared users are left out (default 2). */
  minSharedUsers?: number;
  /** Max pairs, strongest first (default 200, max 1000). */
  limit?: number;
}

export async function getCoEngagementPairs(
  client: SupabaseAdminClient,
  options: CoEngagementOptions = {},
): Promise<CoEngagementPair[]> {
  const { data, error } = await client.rpc("behavioral_co_engagement", {
    p_since: sinceIso(options.since),
    p_event_types: [...(options.eventTypes ?? CO_ENGAGEMENT_EVENT_TYPES)],
    p_min_shared_users: options.minSharedUsers ?? 2,
    p_limit: Math.min(Math.max(options.limit ?? 200, 1), 1000),
  });
  if (error) throw new Error(`behavioral_co_engagement failed: ${error.message}`);

  return (data ?? []).map((row) => {
    const shared = Number(row.shared_users);
    const usersA = Number(row.users_a);
    const usersB = Number(row.users_b);
    const union = usersA + usersB - shared;
    return {
      personA: row.person_a,
      personB: row.person_b,
      sharedUsers: shared,
      usersA,
      usersB,
      jaccard: union > 0 ? shared / union : 0,
    };
  });
}
