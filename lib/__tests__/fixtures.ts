import type { DataSource, Person } from "@/types";

/** Shared fixtures for connector and runner tests. */

export function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "mrbeast",
    display_name: "MrBeast",
    full_name: "James Stephen Donaldson",
    bio: null,
    avatar_url: null,
    category: "creator",
    current_score: 50,
    base_score: 50,
    revert_target: 68,
    max_allocation_cents: 9000000,
    spread: 0.5,
    partnership_status: "unverified",
    consent_tier: 0,
    is_active: true,
    created_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

export function makeSource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "youtube",
    display_name: "YouTube",
    tier: 2,
    poll_interval_minutes: 60,
    is_active: true,
    config: null,
    created_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

export function youtubeChannelsResponse(stats: {
  subscriberCount?: string;
  viewCount?: string;
  videoCount?: string;
  hiddenSubscriberCount?: boolean;
}) {
  return {
    kind: "youtube#channelListResponse",
    items: [
      {
        kind: "youtube#channel",
        id: "UCX6OQ3DkcsbYNE6H8uQQuVA",
        snippet: { title: "MrBeast", customUrl: "@mrbeast" },
        statistics: {
          viewCount: "90000000000",
          subscriberCount: "516000000",
          hiddenSubscriberCount: false,
          videoCount: "900",
          ...stats,
        },
      },
    ],
  };
}

/** A fetch stub that returns the given JSON body (or a failure) and records calls. */
export function fakeFetch(body: unknown, init: { status?: number } = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return Object.assign(impl, { calls });
}
