import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

import { FORECAST_MIN_VOTES, FORECAST_RATE_LIMIT_PER_HOUR, FORECAST_REASONS, readCastResult, readForecastSummary } from "./model";

/**
 * FORECAST on real Postgres (Phase 19): capture, the trail, the privacy
 * boundary, the rate limit, the pause switch, the minimum-count gate — and
 * the one hard rule, that votes influence nothing the Engine reads or writes.
 */

let database: TestDatabase;
let mrbeast: string;
let drake: string;
let allPeople: string[];

async function createUser(email: string): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return row.id;
}

async function cast(userId: string, personId: string, direction: string, reason: string) {
  await database.actAs(userId);
  const [{ result }] = await database.rows<{ result: unknown }>("select public.cast_forecast_vote($1, $2, $3) as result", [personId, direction, reason]);
  return readCastResult(result);
}

async function summary(personId: string) {
  await database.actAs(null);
  const [{ result }] = await database.rows<{ result: unknown }>("select public.forecast_summary($1) as result", [personId]);
  return readForecastSummary(result, personId);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const people = await database.rows<{ id: string; slug: string }>("select id, slug from public.people where is_active order by slug");
  mrbeast = people.find((p) => p.slug === "mrbeast")!.id;
  drake = people.find((p) => p.slug === "drake")!.id;
  allPeople = people.map((p) => p.id);
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe("the two numbers", () => {
  it("are the same in SQL and TypeScript: twenty people an hour, five votes before a split shows", async () => {
    const [row] = await database.rows<{ limit: number; min: number }>("select public.forecast_rate_limit_per_hour() as limit, public.forecast_min_votes() as min");
    expect(row.limit).toBe(FORECAST_RATE_LIMIT_PER_HOUR);
    expect(row.min).toBe(FORECAST_MIN_VOTES);
    expect(FORECAST_RATE_LIMIT_PER_HOUR).toBe(20);
    expect(FORECAST_MIN_VOTES).toBe(5);
  });
});

describe("casting a forecast", () => {
  let alice: string;

  beforeAll(async () => {
    alice = await createUser("alice@example.com");
  });

  it("records the direction, the reason and the person's score at that moment; the actor is the session, never a parameter", async () => {
    await database.rows("update public.people set current_score = 61.6342 where id = $1", [mrbeast]);
    const result = await cast(alice, mrbeast, "rising", "professional");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.vote).toMatchObject({ personId: mrbeast, direction: "rising", reason: "professional", scoreAtVote: 61.6342, supersededAt: null });
    const [row] = await database.rows<{ user_id: string; score_at_vote: string }>("select user_id, score_at_vote from public.forecast_votes where id = $1", [result.vote.id]);
    expect(row.user_id).toBe(alice);
    expect(Number(row.score_at_vote)).toBe(61.6342);
  });

  it("refuses without a session, and refuses a direction or reason outside the locked vocabulary as a returned value", async () => {
    await database.actAs(null);
    await expect(database.rows("select public.cast_forecast_vote($1, 'rising', 'media')", [mrbeast])).rejects.toThrow(/Not authenticated/);
    expect(await cast(alice, mrbeast, "bullish", "media")).toMatchObject({ ok: false, code: "invalid" });
    expect(await cast(alice, mrbeast, "up", "media")).toMatchObject({ ok: false, code: "invalid" });
    expect(await cast(alice, mrbeast, "rising", "vibes")).toMatchObject({ ok: false, code: "invalid" });
    for (const reason of FORECAST_REASONS) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select $1 = any (array['professional','social','financial','cultural','performance','media','other']) as ok", [reason]);
      expect(ok, reason).toBe(true);
    }
    expect(await cast(alice, "00000000-0000-4000-8000-000000000000", "rising", "media")).toMatchObject({ ok: false, code: "unknown_person" });
  });

  it("RE-VOTING SUPERSEDES WITH THE TRAIL KEPT: one active vote per user per person, the old one dated rather than deleted", async () => {
    // Alice changes her mind about MrBeast, twice; the same forecast again is a no-op.
    await database.rows("update public.people set current_score = 62.5 where id = $1", [mrbeast]);
    const second = await cast(alice, mrbeast, "falling", "media");
    expect(second).toMatchObject({ ok: true, changed: true });
    const same = await cast(alice, mrbeast, "falling", "media");
    expect(same).toMatchObject({ ok: true, changed: false });
    if (!second.ok || !same.ok) return;
    expect(same.vote.id).toBe(second.vote.id);

    const trail = await database.rows<{ direction: string; reason: string; score_at_vote: string; superseded_at: string | null }>(
      "select direction, reason, score_at_vote, superseded_at from public.forecast_votes where user_id = $1 and person_id = $2 order by created_at",
      [alice, mrbeast],
    );
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ direction: "rising", reason: "professional" });
    expect(Number(trail[0].score_at_vote)).toBe(61.6342);
    expect(trail[0].superseded_at).not.toBeNull();
    expect(trail[1]).toMatchObject({ direction: "falling", reason: "media", superseded_at: null });
    expect(Number(trail[1].score_at_vote)).toBe(62.5);

    // The active-vote invariant is a database constraint, not a convention.
    await expect(
      database.rows("insert into public.forecast_votes (user_id, person_id, direction, reason, score_at_vote) values ($1, $2, 'rising', 'other', 1)", [alice, mrbeast]),
    ).rejects.toThrow(/forecast_votes_one_active_idx/);
  });

  it("RATE LIMIT, server-side: at most twenty distinct people in a trailing hour; re-voting the same person is free", async () => {
    const busy = await createUser("busy@example.com");
    // Twenty distinct people. The roster has sixteen, so four are made up for the test.
    const extra: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [{ id }] = await database.rows<{ id: string }>(
        "insert into public.people (slug, display_name, category) values ($1, $2, 'creator') returning id",
        [`extra-${i}`, `Extra ${i}`],
      );
      extra.push(id);
    }
    const twenty = [...allPeople, ...extra].slice(0, 20);
    expect(twenty).toHaveLength(20);
    for (const personId of twenty) expect(await cast(busy, personId, "rising", "other")).toMatchObject({ ok: true });
    // The twenty-first person is refused; changing a forecast on one of the twenty is not.
    const [{ id: twentyFirst }] = await database.rows<{ id: string }>("insert into public.people (slug, display_name, category) values ('extra-21', 'Extra 21', 'creator') returning id");
    expect(await cast(busy, twentyFirst, "rising", "other")).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await cast(busy, twenty[0], "falling", "other")).toMatchObject({ ok: true, changed: true });
    // An hour later the window has moved on.
    await database.rows("update public.forecast_votes set created_at = created_at - interval '61 minutes' where user_id = $1", [busy]);
    expect(await cast(busy, twentyFirst, "rising", "other")).toMatchObject({ ok: true });
    await database.rows("delete from public.forecast_votes where user_id = $1", [busy]);
    await database.rows("delete from public.people where slug like 'extra-%'");
  });

  it("PAUSE: a paused person refuses new forecasts; the flag ships false for everyone", async () => {
    const [{ paused }] = await database.rows<{ paused: number }>("select count(*) filter (where forecast_paused)::int as paused from public.people");
    expect(paused).toBe(0);
    await database.rows("update public.people set forecast_paused = true where id = $1", [drake]);
    expect(await cast(alice, drake, "rising", "cultural")).toMatchObject({ ok: false, code: "paused" });
    await database.rows("update public.people set forecast_paused = false where id = $1", [drake]);
    expect(await cast(alice, drake, "rising", "cultural")).toMatchObject({ ok: true });
  });
});

describe("the privacy boundary", () => {
  it("RLS: a user reads their own votes and nobody else's; nobody can write a vote directly; anon reads nothing", async () => {
    const bob = await createUser("bob@example.com");
    const alice = (await database.rows<{ id: string }>("select id from auth.users where email = 'alice@example.com'"))[0].id;
    expect(await cast(bob, mrbeast, "rising", "social")).toMatchObject({ ok: true });

    // The policy applies to the authenticated role; the harness runs as the
    // owner, so it is exercised through set role with the acting user set.
    await database.exec("set role authenticated");
    try {
      await database.actAs(bob);
      const own = await database.rows<{ user_id: string }>("select user_id from public.forecast_votes");
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((row) => row.user_id === bob)).toBe(true);

      await database.actAs(alice);
      const hers = await database.rows<{ user_id: string }>("select user_id from public.forecast_votes");
      expect(hers.length).toBeGreaterThan(0);
      expect(hers.every((row) => row.user_id === alice)).toBe(true);
      expect(hers.some((row) => row.user_id === bob)).toBe(false);

      // No write path except the RPC.
      await expect(database.rows("insert into public.forecast_votes (user_id, person_id, direction, reason, score_at_vote) values ($1, $2, 'rising', 'other', 1)", [alice, drake])).rejects.toThrow();
      await expect(database.rows("update public.forecast_votes set direction = 'rising' where user_id = $1", [alice])).rejects.toThrow();
      await expect(database.rows("delete from public.forecast_votes where user_id = $1", [alice])).rejects.toThrow();

      await database.actAs(null);
      expect(await database.rows("select user_id from public.forecast_votes")).toEqual([]);
    } finally {
      await database.exec("reset role");
      await database.actAs(null);
    }

    await database.exec("set role anon");
    try {
      await expect(database.rows("select user_id from public.forecast_votes")).rejects.toThrow();
      await expect(database.rows("select public.forecast_summary($1)", [mrbeast])).rejects.toThrow();
    } finally {
      await database.exec("reset role");
    }
  });
});

describe("the aggregate", () => {
  it("MINIMUM COUNT: below five active votes only the total is returned, never the split; at five the split and the top reasons appear", async () => {
    // MrBeast holds alice (falling/media) and bob (rising/social) from above.
    let s = await summary(mrbeast);
    expect(s).toMatchObject({ total: 2, minVotes: 5, revealed: false, rising: null, falling: null, risingReasons: null, fallingReasons: null });
    // The raw JSON carries no split either — the gate is in the database, not the reader.
    const [{ raw }] = await database.rows<{ raw: Record<string, unknown> }>("select public.forecast_summary($1) as raw", [mrbeast]);
    expect(raw.rising).toBeNull();
    expect(raw.falling).toBeNull();

    const voters = await Promise.all(["c", "d", "e"].map((name) => createUser(`${name}@example.com`)));
    expect(await cast(voters[0], mrbeast, "rising", "professional")).toMatchObject({ ok: true });
    expect(await cast(voters[1], mrbeast, "rising", "professional")).toMatchObject({ ok: true });
    s = await summary(mrbeast);
    expect(s.revealed).toBe(false);
    expect(s.total).toBe(4);

    expect(await cast(voters[2], mrbeast, "rising", "media")).toMatchObject({ ok: true });
    s = await summary(mrbeast);
    expect(s).toMatchObject({ total: 5, revealed: true, rising: 4, falling: 1 });
    expect(s.risingReasons).toEqual([
      { reason: "professional", count: 2 },
      { reason: "media", count: 1 },
      { reason: "social", count: 1 },
    ]);
    expect(s.fallingReasons).toEqual([{ reason: "media", count: 1 }]);

    // A superseded vote leaves the aggregate; the trail behind it does not count twice.
    expect(await cast(voters[2], mrbeast, "falling", "financial")).toMatchObject({ ok: true, changed: true });
    s = await summary(mrbeast);
    expect(s).toMatchObject({ total: 5, rising: 3, falling: 2 });
    expect(s.fallingReasons).toEqual([
      { reason: "financial", count: 1 },
      { reason: "media", count: 1 },
    ]);
  });
});

describe("THE ONE HARD RULE: votes influence nothing", () => {
  it("every read the Engine makes and the write it commits are identical with a full table of votes and with none", async () => {
    const readEverything = async () => ({
      people: await database.rows("select id, current_score, revert_target, target_offset, spread, buy_price, sell_price from public.people where is_active order by slug"),
      volume: await database.rows("select * from public.person_signal_volume(14) order by person_id"),
      signals: await database.rows("select id, processed, impact_score, sentiment_label, sentiment_confidence from public.signals order by id"),
      ticks: await database.rows("select tick_number, mood, people_updated from public.engine_ticks order by tick_number"),
      events: await database.rows("select person_id, force, impact from public.score_events order by created_at, person_id, force"),
    });
    const tickPayload = (expected: number) =>
      JSON.stringify({
        expected_tick_number: expected,
        started_at: "2026-09-19T12:00:00.000Z",
        finished_at: "2026-09-19T12:00:01.000Z",
        mood: 0.12,
        summary: {},
        people: allPeople.map((id, index) => ({ id, score: 55 + index * 0.25, spread: 0.5 })),
        signals: [],
        events: allPeople.map((id) => ({ person_id: id, force: "gravity", impact: 0.05, details: {} })),
      });

    // With votes: every person holds several, of both directions.
    const voters = await Promise.all(["v1", "v2", "v3"].map((name) => createUser(`${name}@example.com`)));
    for (const personId of allPeople) {
      for (const [index, voter] of voters.entries()) {
        expect(await cast(voter, personId, index === 0 ? "falling" : "rising", "other")).toMatchObject({ ok: true });
      }
    }
    const [{ count }] = await database.rows<{ count: number }>("select count(*)::int as count from public.forecast_votes where superseded_at is null");
    expect(count).toBeGreaterThanOrEqual(allPeople.length * 3);

    const [{ next }] = await database.rows<{ next: number }>("select coalesce(max(tick_number), 0)::int + 1 as next from public.engine_ticks");
    await database.rows("select public.apply_engine_tick($1::jsonb)", [tickPayload(next)]);
    const withVotes = await readEverything();

    // Without: the votes gone, the same tick applied again from the same starting point.
    await database.rows("delete from public.forecast_votes");
    await database.rows("delete from public.score_events where tick_number = $1", [next]);
    await database.rows("delete from public.score_history where tick_number = $1", [next]);
    await database.rows("delete from public.engine_ticks where tick_number = $1", [next]);
    await database.rows("select public.apply_engine_tick($1::jsonb)", [tickPayload(next)]);
    const withoutVotes = await readEverything();

    expect(withoutVotes).toEqual(withVotes);
    // And no table the tick writes gained a column that could carry a vote.
    const columns = await database.rows<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('people', 'score_events', 'score_history', 'engine_ticks', 'signals', 'entity_memory', 'narratives') and column_name ilike '%forecast%'",
    );
    expect(columns).toEqual([{ table_name: "people", column_name: "forecast_paused" }]);
  });
});
