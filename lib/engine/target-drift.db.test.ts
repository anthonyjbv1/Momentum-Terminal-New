import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * THE DRIFTING TARGET, on real Postgres (Phase 14): the state columns, the
 * tick that writes them, and the two configuration items that shipped with
 * them (the idle intervals off the multiple, the trigger grants revoked).
 */

let database: TestDatabase;
let personId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'mrbeast'");
}, 120_000);

afterAll(async () => {
  await database?.close();
});

function tick(expected: number, people: Array<Record<string, unknown>>) {
  return JSON.stringify({
    expected_tick_number: expected,
    started_at: "2026-09-17T21:00:00.000Z",
    finished_at: "2026-09-17T21:00:01.000Z",
    mood: 0,
    summary: {},
    people,
    signals: [],
    events: [],
  });
}

describe("the drifting target's state", () => {
  it("lives on the people row, dormant by default: no evidence, a zero offset, the seed untouched", async () => {
    const rows = await database.rows<{ slug: string; revert_target: string; target_attention: string | null; target_direction: string | null; target_offset: string }>(
      "select slug, revert_target, target_attention, target_direction, target_offset from public.people order by slug",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.target_attention, row.slug).toBeNull();
      expect(row.target_direction, row.slug).toBeNull();
      expect(Number(row.target_offset), row.slug).toBe(0);
      expect(Number(row.revert_target)).toBeGreaterThan(0);
    }
  });

  it("is written by apply_engine_tick beside the score, and an older payload without it writes the dormant state", async () => {
    const [{ result }] = await database.rows<{ result: { tick_number: number; people_updated: number } }>("select public.apply_engine_tick($1::jsonb) as result", [
      tick(1, [{ id: personId, score: 61.6342, spread: 0.5, target_attention: 0.153, target_direction: -0.021, target_offset: -1.25 }]),
    ]);
    expect(result).toMatchObject({ tick_number: 1, people_updated: 1 });
    let [row] = await database.rows<{ current_score: string; target_attention: string; target_direction: string; target_offset: string }>(
      "select current_score, target_attention, target_direction, target_offset from public.people where id = $1",
      [personId],
    );
    // Four decimals survive the round trip.
    expect(Number(row.current_score)).toBe(61.6342);
    expect(Number(row.target_attention)).toBe(0.153);
    expect(Number(row.target_direction)).toBe(-0.021);
    expect(Number(row.target_offset)).toBe(-1.25);

    await database.rows("select public.apply_engine_tick($1::jsonb)", [tick(2, [{ id: personId, score: 61.64, spread: 0.5 }])]);
    [row] = await database.rows("select current_score, target_attention, target_direction, target_offset from public.people where id = $1", [personId]);
    expect(row.target_attention).toBeNull();
    expect(row.target_direction).toBeNull();
    expect(Number(row.target_offset)).toBe(0);
  });
});

describe("the two items from the queue", () => {
  it("leaves no sub-daily source, active or idle, on a multiple of the fifteen-minute cron period", async () => {
    const rows = await database.rows<{ name: string; poll_interval_minutes: number; is_active: boolean }>("select name, poll_interval_minutes, is_active from public.data_sources order by name");
    const byName = Object.fromEntries(rows.map((row) => [row.name, Number(row.poll_interval_minutes)]));
    expect(byName.forbes).toBe(55);
    expect(byName.newsdata).toBe(55);
    // Billboard's weekly interval (10080) is also a multiple; at that length the lost race costs fifteen minutes a week, not a doubled interval, and it is left as it is.
    for (const row of rows) {
      const interval = Number(row.poll_interval_minutes);
      if (interval < 1440) expect(interval % 15, `${row.name} (${row.is_active ? "active" : "idle"})`).not.toBe(0);
    }
  });

  it("lets neither user role execute the two SECURITY DEFINER trigger functions, and keeps them wired to their triggers", async () => {
    for (const fn of ["public.positions_enforce_direction()", "public.trade_orders_snapshot_portfolio()"]) {
      for (const role of ["anon", "authenticated"]) {
        const [{ ok }] = await database.rows<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn]);
        expect(ok, `${role} may execute ${fn}`).toBe(false);
      }
    }
    const triggers = await database.rows<{ tgname: string; proname: string }>(
      "select t.tgname, p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.proname in ('positions_enforce_direction', 'trade_orders_snapshot_portfolio') order by 1",
    );
    expect(triggers.map((t) => t.proname).sort()).toEqual(["positions_enforce_direction", "trade_orders_snapshot_portfolio"]);
  });
});
