import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Json } from "@/types/database";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/connectors/twitch", () => ({ fetchTwitchToken: async () => "token" }));

import { resolveIdentities } from "./identity";

/**
 * IDENTITY RESOLUTION (2026-10-09): a mapping's resolve block is answered by
 * the platform and written onto the mapping as identity; a failure is
 * written, never thrown; a fresh answer is not re-asked for a day.
 */

interface Row {
  id: string;
  person_id: string;
  external_identifier: string | null;
  config: Json | null;
  people: { slug: string };
  data_sources: { name: string; config: Json | null };
}

function fakeClient(rows: Row[]) {
  const updates: Array<{ id: string; config: Json }> = [];
  const client = {
    from(table: string) {
      if (table !== "person_data_sources") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({ not: () => ({ limit: async () => ({ data: rows, error: null }) }) }),
        update: (patch: { config: Json }) => ({
          eq: async (_column: string, id: string) => {
            updates.push({ id, config: patch.config });
            const row = rows.find((r) => r.id === id);
            if (row) row.config = patch.config;
            return { error: null };
          },
        }),
      };
    },
  };
  return { client: client as never, updates };
}

function fakeFetch(routes: Array<{ match: string; status?: number; body?: unknown; text?: string }>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    if (route.text !== undefined) return new Response(route.text, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const NOW = new Date("2026-10-09T01:00:00Z");
const saved = { ...process.env };
beforeEach(() => {
  process.env.TWITCH_CLIENT_ID = "cid";
  process.env.TWITCH_CLIENT_SECRET = "secret";
  process.env.YOUTUBE_API_KEY = "yt-key";
  process.env.APISPORTS_API_KEY = "as-key";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("resolveIdentities", () => {
  it("resolves a Twitch login to its id and last archive, a YouTube handle to its channel, an NFL name to candidates, and probes a feed", async () => {
    const rows: Row[] = [
      // One resolve block, two platforms: the Twitch mapping carries the YouTube handles.
      { id: "m1", person_id: "p1", external_identifier: "zackrawrr", config: { resolve: { login: "zackrawrr", handles: ["@AsmongoldTV", "@AsmongoldClips"] } }, people: { slug: "asmongold" }, data_sources: { name: "twitch", config: {} } },
      { id: "m2", person_id: "p4", external_identifier: "jynxzi", config: { resolve: { login: "jynxzi", handle: "@Jynxzi" } }, people: { slug: "jynxzi" }, data_sources: { name: "twitch", config: {} } },
      { id: "m3", person_id: "p2", external_identifier: "pending", config: { resolve: { player_search: "Smith-Njigba", team_search: "Seattle", season: 2026 } }, people: { slug: "jaxon-smith-njigba" }, data_sources: { name: "apisports", config: { host: "v1.american-football.api-sports.io" } } },
      { id: "m4", person_id: "p3", external_identifier: "https://news.google.com/x", config: { resolve: { probe_url: "https://news.google.com/rss/search?q=probe" } }, people: { slug: "adin-ross" }, data_sources: { name: "rss", config: {} } },
    ];
    const { client, updates } = fakeClient(rows);
    const { fetchImpl, calls } = fakeFetch([
      { match: "helix/users?login=zackrawrr", body: { data: [{ id: "552120296", login: "zackrawrr", display_name: "Zackrawrr", created_at: "2020-06-01T00:00:00Z" }] } },
      { match: "helix/videos?user_id=552120296&type=archive", body: { data: [{ created_at: "2026-10-08T18:00:00Z", title: "WoW Forever", duration: "6h2m" }] } },
      { match: "youtube/v3/channels?part=snippet%2Cstatistics&forHandle=%40AsmongoldTV", body: { items: [{ id: "UCQeRaTukNYft1_6AZPACnog", snippet: { title: "Asmongold TV", customUrl: "@asmongoldtv" }, statistics: { subscriberCount: "4000000", videoCount: "9000" } }] } },
      { match: "youtube/v3/channels?part=snippet%2Cstatistics&forHandle=%40AsmongoldClips", body: { items: [{ id: "UCMwJJL5FJFuTRT55ksbQ4GQ", snippet: { title: "Asmongold Clips", customUrl: "@asmongoldclips" }, statistics: { subscriberCount: "2000000", videoCount: "30000" } }] } },
      { match: "helix/users?login=jynxzi", body: { data: [{ id: "411377640", login: "jynxzi", display_name: "Jynxzi", created_at: "2019-01-01T00:00:00Z" }] } },
      { match: "helix/videos?user_id=411377640&type=archive", body: { data: [] } },
      { match: "youtube/v3/channels?part=snippet%2Cstatistics&forHandle=%40Jynxzi", body: { items: [{ id: "UC6BfARTPllDG1IjDJvM7dMg", snippet: { title: "Jynxzi", customUrl: "@jynxzi" }, statistics: { subscriberCount: "5000000", videoCount: "800" } }] } },
      { match: "/players?search=Smith-Njigba&season=2026", body: { errors: [], response: [{ id: 3771, name: "Jaxon Smith-Njigba", position: "WR", group: "Offense", number: 11 }] } },
      { match: "/teams?search=Seattle", body: { errors: [], response: [{ id: 29, name: "Seattle Seahawks", code: "SEA" }] } },
      { match: "news.google.com/rss/search?q=probe", text: `<rss><channel><item><title>Fresh one</title><pubDate>${new Date(NOW.getTime() - 3_600_000).toUTCString()}</pubDate></item><item><title>Old one</title><pubDate>${new Date(NOW.getTime() - 30 * 86_400_000).toUTCString()}</pubDate></item></channel></rss>` },
    ]);
    const result = await resolveIdentities({ client, fetch: fetchImpl, now: NOW });
    expect(result).toEqual({ considered: 4, resolved: ["asmongold/twitch", "jynxzi/twitch", "jaxon-smith-njigba/apisports", "adin-ross/rss"], failed: [] });
    expect(updates).toHaveLength(4);
    const by = (id: string) => (updates.find((u) => u.id === id)!.config as { identity: Record<string, unknown>; resolve?: unknown; handles?: unknown }) ;
    expect(by("m1").identity).toEqual({
      twitch: { id: "552120296", login: "zackrawrr", display_name: "Zackrawrr", account_created_at: "2020-06-01T00:00:00Z", last_live_at: "2026-10-08T18:00:00Z", last_live_title: "WoW Forever", last_live_duration: "6h2m" },
      youtube: [
        { channel_id: "UCQeRaTukNYft1_6AZPACnog", title: "Asmongold TV", handle: "@asmongoldtv", subscribers: "4000000", videos: "9000" },
        { channel_id: "UCMwJJL5FJFuTRT55ksbQ4GQ", title: "Asmongold Clips", handle: "@asmongoldclips", subscribers: "2000000", videos: "30000" },
      ],
      resolved_at: NOW.toISOString(),
    });
    expect(by("m1").resolve).toEqual({ login: "zackrawrr", handles: ["@AsmongoldTV", "@AsmongoldClips"] });
    // A single handle resolves to one object, and a streamer with no archive has no last-live date.
    expect(by("m2").identity).toMatchObject({ twitch: { id: "411377640", last_live_at: null }, youtube: { channel_id: "UC6BfARTPllDG1IjDJvM7dMg", title: "Jynxzi" } });
    expect(by("m3").identity).toMatchObject({ apisports: { season: 2026, players: [{ id: 3771, name: "Jaxon Smith-Njigba", position: "WR", group: "Offense", number: 11 }], teams: [{ id: 29, name: "Seattle Seahawks" }] } });
    expect(by("m4").identity).toMatchObject({ feed: { items: 2, newer_than_7d: 1, first_titles: ["Fresh one", "Old one"] } });
    // The keys travel in the right place and never in a message.
    expect(calls.some((url) => url.includes("key=yt-key"))).toBe(true);
    expect(JSON.stringify(updates)).not.toContain("yt-key");
  });

  it("writes a failure onto the mapping without throwing, and leaves a fresh identity alone for a day", async () => {
    const rows: Row[] = [
      { id: "m1", person_id: "p1", external_identifier: "nobody", config: { resolve: { login: "nobody" } }, people: { slug: "nobody" }, data_sources: { name: "twitch", config: {} } },
      { id: "m2", person_id: "p2", external_identifier: "x", config: { resolve: { handle: "@x" }, identity: { youtube: { channel_id: "UC1" }, resolved_at: new Date(NOW.getTime() - 3_600_000).toISOString() } }, people: { slug: "fresh" }, data_sources: { name: "youtube_trending", config: {} } },
      { id: "m3", person_id: "p3", external_identifier: "y", config: { resolve: { handle: "@y", force: true }, identity: { resolved_at: NOW.toISOString() } }, people: { slug: "forced" }, data_sources: { name: "youtube_trending", config: {} } },
    ];
    const { client, updates } = fakeClient(rows);
    const { fetchImpl, calls } = fakeFetch([
      { match: "helix/users?login=nobody", body: { data: [] } },
      { match: "forHandle=%40y", body: { items: [{ id: "UCy", snippet: { title: "Y" } }] } },
    ]);
    const result = await resolveIdentities({ client, fetch: fetchImpl, now: NOW });
    expect(result.considered).toBe(3);
    expect(result.resolved).toEqual(["forced/youtube_trending"]);
    expect(result.failed).toEqual([{ slug: "nobody", source: "twitch", reason: 'Twitch login "nobody" not found' }]);
    expect((updates.find((u) => u.id === "m1")!.config as { identity: { error: string } }).identity.error).toBe('Twitch login "nobody" not found');
    expect(updates.some((u) => u.id === "m2")).toBe(false);
    expect(calls.some((url) => url.includes("forHandle=%40x"))).toBe(false);
  });
});
