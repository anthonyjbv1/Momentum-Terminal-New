import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { parseTwitchDurationHours, resetTwitchTokenCache, summariseArchive, twitchConnector, type TwitchArchiveEntry } from "./twitch";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const person = makePerson({ slug: "kai-cenat", display_name: "Kai Cenat" });
const CHANNEL = "kaicenat";
const USER_ID = "144304front";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

interface Options {
  tokenStatus?: number;
  userStatus?: number;
  /** Absent means the channel is offline. */
  stream?: { id: string; title?: string; game_name?: string; viewer_count?: number; started_at?: string } | null;
  /** Absent means Helix returned no `total` at all. */
  followers?: number | null;
  archive?: Array<{ id: string; created_at: string; duration: string }>;
  /** Statuses returned by the helix reads, in order, before falling back to 200. */
  helixStatus?: number[];
}

/** A Helix double: records every call, answers the token and the four endpoints this connector uses. */
function twitchFetch(options: Options = {}) {
  const calls: Call[] = [];
  const statuses = [...(options.helixStatus ?? [])];
  let tokens = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers, body: typeof init?.body === "string" ? init.body : null });

    if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
      tokens += 1;
      if (options.tokenStatus && options.tokenStatus !== 200) return new Response("{}", { status: options.tokenStatus });
      return Response.json({ access_token: `token-${tokens}`, expires_in: 3600 });
    }
    if (url.includes("/helix/users")) {
      if (options.userStatus && options.userStatus !== 200) return Response.json({ message: "bad" }, { status: options.userStatus });
      return Response.json({ data: [{ id: USER_ID, login: CHANNEL, display_name: "KaiCenat" }] });
    }

    const status = statuses.shift() ?? 200;
    if (status !== 200) return Response.json({ message: status === 401 ? "Invalid OAuth token" : "nope" }, { status });

    if (url.includes("/helix/channels/followers")) {
      // With an app token Helix answers with an EMPTY data array and a total.
      return Response.json(options.followers === null ? { data: [] } : { total: options.followers ?? 12_400_000, data: [] });
    }
    if (url.includes("/helix/streams")) {
      return Response.json({ data: options.stream ? [options.stream] : [] });
    }
    if (url.includes("/helix/videos")) {
      return Response.json({ data: options.archive ?? [] });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return Object.assign(impl, { calls });
}

const context = (fetch: typeof globalThis.fetch, config: Record<string, unknown> = {}) => ({
  source: makeSource({ name: "twitch" }),
  config: config as Record<string, never>,
  snapshots: { latest: async () => null, record: () => undefined },
  now: NOW,
  fetch,
});

/** Four broadcasts inside the trailing week, two of them on the same day, and one long outside it. */
const ARCHIVE = [
  { id: "v4", created_at: "2026-09-15T02:00:00.000Z", duration: "6h30m0s" },
  { id: "v3", created_at: "2026-09-14T20:00:00.000Z", duration: "2h0m0s" },
  { id: "v2", created_at: "2026-09-14T03:00:00.000Z", duration: "1h30m0s" },
  { id: "v1", created_at: "2026-09-11T01:00:00.000Z", duration: "10h0m0s" },
  { id: "old", created_at: "2026-08-20T01:00:00.000Z", duration: "8h0m0s" },
];

describe("parseTwitchDurationHours", () => {
  it("reads every shape Helix writes, and refuses what it does not", () => {
    expect(parseTwitchDurationHours("3h20m5s")).toBeCloseTo(3 + 20 / 60 + 5 / 3600, 6);
    expect(parseTwitchDurationHours("45m10s")).toBeCloseTo(45 / 60 + 10 / 3600, 6);
    expect(parseTwitchDurationHours("58s")).toBeCloseTo(58 / 3600, 6);
    expect(parseTwitchDurationHours("2h")).toBe(2);
    // Not a duration: null, so the entry is dropped rather than counted as zero hours.
    expect(parseTwitchDurationHours("")).toBeNull();
    expect(parseTwitchDurationHours("12345")).toBeNull();
    expect(parseTwitchDurationHours("3 hours")).toBeNull();
  });
});

describe("summariseArchive", () => {
  const entries: TwitchArchiveEntry[] = ARCHIVE.map((video) => ({
    id: video.id,
    createdAt: new Date(video.created_at),
    hours: parseTwitchDurationHours(video.duration) ?? 0,
  }));

  it("totals hours and distinct days inside the window, and excludes what falls outside it", () => {
    const week = summariseArchive(entries, NOW, 168);
    // v4 6.5 + v3 2 + v2 1.5 + v1 10 = 20; "old" is a month back.
    expect(week.hours).toBeCloseTo(20, 6);
    // v3 and v2 share 09-14, so four broadcasts fall on three days.
    expect(week.days).toBe(3);
  });

  it("gives the same answer whatever hour of the day it is asked, which is the whole point", () => {
    // The same archive, read at four different moments inside one day. A window
    // aggregate must not depend on when the cron happened to fire; an
    // instantaneous reading would differ at every one of these.
    const readings = ["2026-09-15T00:30:00.000Z", "2026-09-15T06:00:00.000Z", "2026-09-15T12:00:00.000Z", "2026-09-15T23:00:00.000Z"].map((at) =>
      summariseArchive(entries, new Date(at), 168),
    );
    // Only v4 (02:00 on the 15th) is not yet in the past at 00:30, so that
    // reading legitimately differs; the three later ones agree exactly.
    expect(readings.slice(1).map((reading) => [reading.hours, reading.days])).toEqual([
      [20, 3],
      [20, 3],
      [20, 3],
    ]);
  });

  it("counts a broadcast whole in the window it started in, never split across two", () => {
    const straddling: TwitchArchiveEntry[] = [{ id: "v", createdAt: new Date("2026-09-08T11:00:00.000Z"), hours: 12 }];
    // Started 169 hours ago: outside a 168-hour window entirely, not partially inside it.
    expect(summariseArchive(straddling, NOW, 168)).toEqual({ hours: 0, days: 0 });
    expect(summariseArchive(straddling, NOW, 170).hours).toBe(12);
  });
});

describe("twitchConnector", () => {
  const saved = { id: process.env.TWITCH_CLIENT_ID, secret: process.env.TWITCH_CLIENT_SECRET };
  beforeEach(() => {
    resetTwitchTokenCache();
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
  });
  afterEach(() => {
    if (saved.id === undefined) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
    else process.env.TWITCH_CLIENT_SECRET = saved.secret;
    resetTwitchTokenCache();
  });

  it("is unavailable, with a reason, when either credential is missing", () => {
    delete process.env.TWITCH_CLIENT_SECRET;
    expect(twitchConnector.available?.()).toEqual({ ok: false, reason: "TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set" });
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    expect(twitchConnector.available?.()).toEqual({ ok: true });
  });

  it("authenticates with the client-credentials grant and sends the client id on every Helix read", async () => {
    const fetch = twitchFetch({ archive: ARCHIVE });
    await twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch));
    const token = fetch.calls[0];
    expect(token.url).toBe("https://id.twitch.tv/oauth2/token");
    expect(token.body).toContain("grant_type=client_credentials");
    expect(token.body).toContain("client_id=client-id");
    for (const call of fetch.calls.slice(1)) {
      expect(call.headers["client-id"], call.url).toBe("client-id");
      expect(call.headers.authorization, call.url).toBe("Bearer token-1");
    }
  });

  it("reads the follower total and both window aggregates", async () => {
    const fetch = twitchFetch({ followers: 12_400_000, archive: ARCHIVE });
    const readings = await twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch));
    expect(readings).toEqual([
      { metricKey: "follower_count", value: 12_400_000 },
      { metricKey: "stream_hours_7d", value: 20 },
      { metricKey: "stream_days_7d", value: 3 },
    ]);
  });

  it("registers no instantaneous viewer metric — the spiky number is an event, never a level", async () => {
    const fetch = twitchFetch({ archive: ARCHIVE, stream: { id: "s1", viewer_count: 84_000 } });
    const readings = (await twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch))) ?? [];
    expect(readings.map((reading) => reading.metricKey)).not.toContain("viewer_count");
    expect(readings.map((reading) => reading.metricKey)).not.toContain("concurrent_viewers");
  });

  it("takes the archive window from config", async () => {
    const fetch = twitchFetch({ archive: ARCHIVE });
    const readings = (await twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch, { archive_window_hours: 720 }))) ?? [];
    // A month-wide window picks up the August broadcast too: 20 + 8.
    expect(readings.find((reading) => reading.metricKey === "stream_hours_7d")?.value).toBeCloseTo(28, 6);
  });

  it("records no aggregate at all when the archive is empty, rather than a false zero", async () => {
    const fetch = twitchFetch({ followers: 12_400_000, archive: [] });
    const readings = (await twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch))) ?? [];
    // "VODs are off" and "did not stream this week" are different facts. Writing
    // 0 would make a busy week read as a collapse once VODs came back.
    expect(readings).toEqual([{ metricKey: "follower_count", value: 12_400_000 }]);
  });

  it("fails loudly when nothing at all is readable, naming what was tried", async () => {
    const fetch = twitchFetch({ followers: null, archive: [] });
    await expect(twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch))).rejects.toThrow(/yielded no metric/);
    await expect(twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch))).rejects.toThrow(/VODs being disabled/);
  });

  it("emits one signal per broadcast, keyed on the stream id so consecutive polls do not repeat it", async () => {
    const stream = { id: "48211", title: "MAFIATHON 3 DAY 9", game_name: "Just Chatting", viewer_count: 184_211, started_at: "2026-09-15T06:00:00.000Z" };
    const fetch = twitchFetch({ stream });
    const signals = (await twitchConnector.fetchForPerson(person, CHANNEL, context(fetch))) ?? [];
    expect(signals).toHaveLength(1);
    expect(signals[0].dedupeKey).toBe("twitch:stream:48211");
    expect(signals[0].headline).toBe('Kai Cenat is live on Twitch playing Just Chatting to 184,211 viewers: "MAFIATHON 3 DAY 9".');
    // Dated to when the broadcast began, not to when we happened to notice it.
    expect(signals[0].occurredAt.toISOString()).toBe("2026-09-15T06:00:00.000Z");
    expect(signals[0].rawPayload).toMatchObject({ kind: "stream", stream_id: "48211", viewer_count: 184_211 });
  });

  it("emits nothing when the channel is offline", async () => {
    const fetch = twitchFetch({ stream: null });
    expect(await twitchConnector.fetchForPerson(person, CHANNEL, context(fetch))).toEqual([]);
  });

  it("refreshes the app token once on a 401 and retries", async () => {
    const fetch = twitchFetch({ helixStatus: [401], archive: ARCHIVE });
    const readings = (await twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch))) ?? [];
    expect(readings.length).toBeGreaterThan(0);
    expect(fetch.calls.filter((call) => call.url.includes("oauth2/token"))).toHaveLength(2);
    expect(fetch.calls.at(-1)?.headers.authorization).toBe("Bearer token-2");
  });

  it("surfaces an unresolvable channel as a 404 rather than as silence", async () => {
    const fetch = twitchFetch({ userStatus: 404 });
    await expect(twitchConnector.fetchMetrics?.(person, CHANNEL, context(fetch))).rejects.toThrow(/Twitch API responded 404/);
  });

  it("refuses an empty identifier", async () => {
    const fetch = twitchFetch();
    await expect(twitchConnector.fetchMetrics?.(person, "   ", context(fetch))).rejects.toThrow(/No Twitch channel configured for kai-cenat/);
  });
});

/** A Helix double for live mode: /streams answers from a list, /clips pages through what the test hands it. */
function liveFetch(options: { streams?: Array<Record<string, unknown>>; pages?: Array<{ data: Array<{ id: string; created_at: string }>; cursor?: string }> } = {}) {
  const calls: Call[] = [];
  const pages = [...(options.pages ?? [])];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : null });
    if (url.startsWith("https://id.twitch.tv/oauth2/token")) return Response.json({ access_token: "token-1", expires_in: 3600 });
    if (url.includes("/helix/streams")) return Response.json({ data: options.streams ?? [] });
    if (url.includes("/helix/clips")) {
      const page = pages.shift() ?? { data: [] };
      return Response.json({ data: page.data, pagination: page.cursor ? { cursor: page.cursor } : {} });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return Object.assign(impl, { calls, urls: (fragment: string) => calls.filter((call) => call.url.includes(fragment)).map((call) => call.url) });
}

describe("twitchConnector.live (Phase 16)", () => {
  const saved = { id: process.env.TWITCH_CLIENT_ID, secret: process.env.TWITCH_CLIENT_SECRET };
  beforeEach(() => {
    resetTwitchTokenCache();
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
  });
  afterEach(() => {
    if (saved.id === undefined) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
    else process.env.TWITCH_CLIENT_SECRET = saved.secret;
    resetTwitchTokenCache();
  });

  const live = { id: "48211", user_id: "144304", user_login: "kaicenat", type: "live", title: "MAFIATHON 3 DAY 9", game_name: "Just Chatting", viewer_count: 184_211, started_at: "2026-09-15T06:00:00.000Z" };

  it("detects every asked-for broadcaster in ONE request: logins lowercased, numeric identifiers as ids, the unlisted offline", async () => {
    const fetch = liveFetch({ streams: [live, { id: "9", user_id: "777", user_login: "adinross", type: "", viewer_count: 5 }] });
    const statuses = await twitchConnector.live!.detect(["KaiCenat", "adinross", "555", "nobody"], context(fetch));
    expect(fetch.urls("/helix/streams")).toEqual(["https://api.twitch.tv/helix/streams?user_login=kaicenat&user_login=adinross&user_id=555&user_login=nobody&first=100"]);
    expect(statuses.map((status) => [status.externalIdentifier, status.stream?.id ?? null])).toEqual([
      ["KaiCenat", "48211"],
      // Listed with type "" (Helix's "in error"): not live.
      ["adinross", null],
      ["555", null],
      ["nobody", null],
    ]);
    expect(statuses[0].stream).toEqual({ id: "48211", broadcasterId: "144304", channel: "kaicenat", title: "MAFIATHON 3 DAY 9", category: "Just Chatting", viewerCount: 184_211, startedAt: new Date("2026-09-15T06:00:00.000Z") });
  });

  it("batches a hundred identifiers per request, so knowing who is live is one Helix point a minute per hundred broadcasters", async () => {
    const fetch = liveFetch({ streams: [] });
    const many = Array.from({ length: 101 }, (_, i) => `channel${i}`);
    const statuses = await twitchConnector.live!.detect(many, context(fetch));
    expect(fetch.urls("/helix/streams")).toHaveLength(2);
    expect(statuses).toHaveLength(101);
    expect(statuses.every((status) => status.stream === null)).toBe(true);
  });

  it("counts clips inside an exact window: the request is widened to whole minutes (Helix ignores seconds) and each clip is judged by its own created_at", async () => {
    const from = new Date("2026-09-18T01:10:30.000Z");
    const to = new Date("2026-09-18T01:12:30.000Z");
    const fetch = liveFetch({
      pages: [
        {
          data: [
            { id: "before", created_at: "2026-09-18T01:10:29.000Z" },
            { id: "at-from", created_at: "2026-09-18T01:10:30.000Z" },
            { id: "inside", created_at: "2026-09-18T01:11:59.000Z" },
            { id: "at-to", created_at: "2026-09-18T01:12:30.000Z" },
            { id: "after", created_at: "2026-09-18T01:13:00.000Z" },
          ],
        },
      ],
    });
    const counted = await twitchConnector.live!.countClips("144304", from, to, context(fetch));
    expect(counted).toEqual({ count: 2, truncated: false, requests: 1 });
    const url = new URL(fetch.urls("/helix/clips")[0]);
    expect(url.searchParams.get("broadcaster_id")).toBe("144304");
    expect(url.searchParams.get("started_at")).toBe("2026-09-18T01:09:00.000Z");
    expect(url.searchParams.get("ended_at")).toBe("2026-09-18T01:14:00.000Z");
    expect(url.searchParams.get("first")).toBe("100");
    // An empty window costs nothing.
    expect(await twitchConnector.live!.countClips("144304", to, from, context(fetch))).toEqual({ count: 0, truncated: false, requests: 0 });
  });

  it("pages through a busy window with the cursor, and past the page cap reports the count as a floor", async () => {
    const from = new Date("2026-09-18T01:00:00.000Z");
    const to = new Date("2026-09-18T01:10:00.000Z");
    const clip = (i: number) => ({ id: `c${i}`, created_at: "2026-09-18T01:05:00.000Z" });
    const page = (n: number, cursor?: string) => ({ data: Array.from({ length: n }, (_, i) => clip(i)), cursor });
    const fetch = liveFetch({ pages: [page(100, "p2"), page(100, "p3"), page(40)] });
    expect(await twitchConnector.live!.countClips("144304", from, to, context(fetch))).toEqual({ count: 240, truncated: false, requests: 3 });
    expect(new URL(fetch.urls("/helix/clips")[1]).searchParams.get("after")).toBe("p2");
    const busy = liveFetch({ pages: [page(100, "p2"), page(100, "p3"), page(100, "p4"), page(100, "p5")] });
    expect(await twitchConnector.live!.countClips("144304", from, to, context(busy))).toEqual({ count: 300, truncated: true, requests: 3 });
    const capped = liveFetch({ pages: [page(100, "p2"), page(100, "p3")] });
    expect(await twitchConnector.live!.countClips("144304", from, to, context(capped, { live: { clip_max_pages: 1 } }))).toEqual({ count: 100, truncated: true, requests: 1 });
  });

  it("builds the live event under the same key as the hourly poll, so whichever sees the stream first stores it once", () => {
    const signal = twitchConnector.live!.liveSignal(person, { id: "48211", broadcasterId: "144304", channel: "kaicenat", title: "MAFIATHON 3 DAY 9", category: "Just Chatting", viewerCount: 184_211, startedAt: new Date("2026-09-15T06:00:00.000Z") }, NOW);
    expect(signal.dedupeKey).toBe("twitch:stream:48211");
    expect(signal.headline).toBe('Kai Cenat is live on Twitch playing Just Chatting to 184,211 viewers: "MAFIATHON 3 DAY 9".');
    expect(signal.rawPayload).toMatchObject({ kind: "stream", stream_id: "48211", channel: "kaicenat", viewer_count: 184_211 });
  });
});
