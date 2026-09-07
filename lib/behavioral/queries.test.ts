import { describe, expect, it, vi } from "vitest";

import type { SupabaseAdminClient } from "@/lib/supabase-admin";

import { CO_ENGAGEMENT_EVENT_TYPES, getCoEngagementPairs, getPersonEngagement, getUserInteractionHistory } from "./queries";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAKE = "11111111-1111-4111-8111-111111111111";
const KENDRICK = "22222222-2222-4222-8222-222222222222";

interface FakeClientOptions {
  rpc?: Record<string, unknown[]>;
  rows?: unknown[];
}

/** Just enough of the Supabase client surface for the query helpers. */
function fakeAdmin(options: FakeClientOptions = {}) {
  const rpc = vi.fn(async (name: string) => ({ data: options.rpc?.[name] ?? [], error: null }));
  const calls: Record<string, unknown[]> = {};
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((column: string, value: unknown) => {
      calls.eq = [column, value];
      return chain;
    }),
    gte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(async (limit: number) => {
      calls.limit = [limit];
      return { data: options.rows ?? [], error: null };
    }),
  };
  const from = vi.fn(() => chain);
  const client = { rpc, from } as unknown as SupabaseAdminClient;
  return { client, rpc, chain, calls };
}

describe("getUserInteractionHistory", () => {
  it("folds per-(person, type) aggregates into a per-person summary and totals", async () => {
    const { client, rpc, calls } = fakeAdmin({
      rpc: {
        behavioral_user_history: [
          { person_id: DRAKE, event_type: "view_person", event_count: 3, total_duration_ms: 0, first_at: "2026-09-01T00:00:00Z", last_at: "2026-09-06T00:00:00Z" },
          { person_id: DRAKE, event_type: "time_spent", event_count: 2, total_duration_ms: 9000, first_at: "2026-09-02T00:00:00Z", last_at: "2026-09-05T00:00:00Z" },
          { person_id: DRAKE, event_type: "take_position", event_count: 1, total_duration_ms: 0, first_at: "2026-09-03T00:00:00Z", last_at: "2026-09-03T00:00:00Z" },
          { person_id: DRAKE, event_type: "follow_person", event_count: 2, total_duration_ms: 0, first_at: "2026-09-03T00:00:00Z", last_at: "2026-09-03T00:00:00Z" },
          { person_id: DRAKE, event_type: "unfollow_person", event_count: 1, total_duration_ms: 0, first_at: "2026-09-04T00:00:00Z", last_at: "2026-09-04T00:00:00Z" },
          { person_id: KENDRICK, event_type: "view_person", event_count: 1, total_duration_ms: 0, first_at: "2026-09-07T00:00:00Z", last_at: "2026-09-07T00:00:00Z" },
          { person_id: DRAKE, event_type: "brand_new_type", event_count: 9, total_duration_ms: 0, first_at: "2026-09-07T00:00:00Z", last_at: "2026-09-07T00:00:00Z" },
          { person_id: null, event_type: "search", event_count: 4, total_duration_ms: 0, first_at: "2026-09-01T00:00:00Z", last_at: "2026-09-07T00:00:00Z" },
        ],
      },
      rows: [{ id: "e1", event_type: "search", person_id: null, session_id: null, metadata: { query: "drake" }, created_at: "2026-09-07T00:00:00Z" }],
    });

    const history = await getUserInteractionHistory(client, USER, { since: new Date("2026-08-01T00:00:00Z"), recentLimit: 5 });

    expect(rpc).toHaveBeenCalledWith("behavioral_user_history", { p_user_id: USER, p_since: "2026-08-01T00:00:00.000Z", p_event_types: undefined });
    expect(calls.eq).toEqual(["user_id", USER]);
    expect(calls.limit).toEqual([5]);

    expect(history.totals).toEqual({ view_person: 4, time_spent: 2, take_position: 1, follow_person: 2, unfollow_person: 1, search: 4 });
    expect(history.people.map((person) => person.personId)).toEqual([KENDRICK, DRAKE]); // most recent first
    expect(history.people[1]).toMatchObject({
      personId: DRAKE,
      views: 3,
      timeSpentMs: 9000,
      positionsTaken: 1,
      follows: 2,
      unfollows: 1,
      netFollows: 1,
      firstInteractedAt: "2026-09-01T00:00:00Z",
      lastInteractedAt: "2026-09-06T00:00:00Z",
      eventCounts: { view_person: 3, time_spent: 2, take_position: 1, follow_person: 2, unfollow_person: 1 },
    });
    expect(history.recent).toEqual([
      { id: "e1", eventType: "search", personId: null, sessionId: null, metadata: { query: "drake" }, createdAt: "2026-09-07T00:00:00Z" },
    ]);
  });

  it("surfaces database errors", async () => {
    const { client, rpc } = fakeAdmin();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } } as never);
    await expect(getUserInteractionHistory(client, USER)).rejects.toThrow("permission denied");
  });
});

describe("getPersonEngagement", () => {
  it("reads the three grouping levels into exact per-type and per-detail numbers", async () => {
    const { client, rpc } = fakeAdmin({
      rpc: {
        behavioral_person_engagement: [
          { event_type: null, detail: null, event_count: 12, unique_users: 5, total_duration_ms: 42000, grouping_level: 3 },
          { event_type: "view_person", detail: null, event_count: 6, unique_users: 5, total_duration_ms: 0, grouping_level: 1 },
          { event_type: "view_person", detail: null, event_count: 6, unique_users: 5, total_duration_ms: 0, grouping_level: 0 },
          { event_type: "take_position", detail: null, event_count: 3, unique_users: 2, total_duration_ms: 0, grouping_level: 1 },
          { event_type: "take_position", detail: "HIGH", event_count: 2, unique_users: 2, total_duration_ms: 0, grouping_level: 0 },
          { event_type: "take_position", detail: "LOW", event_count: 1, unique_users: 1, total_duration_ms: 0, grouping_level: 0 },
          { event_type: "swipe", detail: null, event_count: 2, unique_users: 2, total_duration_ms: 0, grouping_level: 1 },
          { event_type: "swipe", detail: "left", event_count: 1, unique_users: 1, total_duration_ms: 0, grouping_level: 0 },
          { event_type: "swipe", detail: "right", event_count: 1, unique_users: 1, total_duration_ms: 0, grouping_level: 0 },
          { event_type: "follow_person", detail: null, event_count: 1, unique_users: 1, total_duration_ms: 0, grouping_level: 1 },
          { event_type: "follow_person", detail: null, event_count: 1, unique_users: 1, total_duration_ms: 0, grouping_level: 0 },
        ],
      },
    });

    const engagement = await getPersonEngagement(client, DRAKE, { since: new Date("2026-09-01T00:00:00Z") });

    expect(rpc).toHaveBeenCalledWith("behavioral_person_engagement", { p_person_id: DRAKE, p_since: "2026-09-01T00:00:00.000Z" });
    expect(engagement).toEqual({
      personId: DRAKE,
      since: "2026-09-01T00:00:00.000Z",
      totalEvents: 12,
      uniqueUsers: 5,
      timeSpentMs: 42000,
      byType: {
        view_person: { events: 6, users: 5 },
        take_position: { events: 3, users: 2 },
        swipe: { events: 2, users: 2 },
        follow_person: { events: 1, users: 1 },
      },
      positions: { high: 2, low: 1 },
      swipes: { left: 1, right: 1 },
      netFollows: 1,
    });
  });
});

describe("getCoEngagementPairs", () => {
  it("passes the engagement types and computes jaccard", async () => {
    const { client, rpc } = fakeAdmin({
      rpc: { behavioral_co_engagement: [{ person_a: DRAKE, person_b: KENDRICK, shared_users: 3, users_a: 4, users_b: 5 }] },
    });
    const pairs = await getCoEngagementPairs(client, { since: new Date("2026-09-01T00:00:00Z"), minSharedUsers: 3, limit: 5000 });
    expect(rpc).toHaveBeenCalledWith("behavioral_co_engagement", {
      p_since: "2026-09-01T00:00:00.000Z",
      p_event_types: [...CO_ENGAGEMENT_EVENT_TYPES],
      p_min_shared_users: 3,
      p_limit: 1000,
    });
    expect(pairs).toEqual([{ personA: DRAKE, personB: KENDRICK, sharedUsers: 3, usersA: 4, usersB: 5, jaccard: 0.5 }]);
  });
});
