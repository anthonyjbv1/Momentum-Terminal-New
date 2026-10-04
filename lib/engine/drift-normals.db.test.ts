import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * THE DRIFT'S NORMALS (migration 20261006090000, the drift redesign), on the
 * migrations as production will have them: drift_signal_normals() sums the
 * Signals force's rows per listed person since the given instant, and
 * nothing else — no other force, no earlier row, no unlisted person — and
 * is callable by the service role alone.
 */

let database: TestDatabase;
const ids: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string }>("select id from public.people order by slug limit 3")) ids.push(row.id);
  await database.rows("insert into public.engine_ticks (tick_number, started_at, finished_at) values (1, now() - interval '10 days', now() - interval '10 days'), (2, now() - interval '2 days', now() - interval '2 days'), (3, now() - interval '1 hour', now() - interval '1 hour')");
  const insert = (tick: number, person: string, force: string, impact: number, daysAgo: number) =>
    database.rows("insert into public.score_events (tick_number, person_id, force, impact, details, created_at) values ($1, $2, $3, $4, '{}'::jsonb, now() - make_interval(days => $5))", [tick, person, force, impact, daysAgo]);
  // Person A: three Signals rows in the window (+1.2, −0.4, +0.3), one before it, one gravity row the sum must ignore.
  await insert(2, ids[0], "signals", 1.2, 2);
  await insert(2, ids[0], "signals", -0.4, 2);
  await insert(3, ids[0], "signals", 0.3, 0);
  await insert(1, ids[0], "signals", 5, 10);
  await insert(3, ids[0], "gravity", 0.05, 0);
  // Person B: Signals rows only before the window. Person C: nothing.
  await insert(1, ids[1], "signals", 2, 10);
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("drift_signal_normals()", () => {
  it("sums the Signals force per listed person since the instant: gross, signed, count, first and last", async () => {
    const rows = await database.rows<{ person_id: string; gross_impact: string; signed_impact: string; events: number; first_at: string; last_at: string }>(
      "select person_id, gross_impact::text, signed_impact::text, events, first_at::text, last_at::text from public.drift_signal_normals($1::uuid[], now() - interval '7 days') order by person_id",
      [ids],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].person_id).toBe(ids[0]);
    expect(Number(rows[0].gross_impact)).toBeCloseTo(1.9, 9);
    expect(Number(rows[0].signed_impact)).toBeCloseTo(1.1, 9);
    expect(rows[0].events).toBe(3);
    expect(rows[0].first_at < rows[0].last_at).toBe(true);
  });

  it("reads the whole window when asked, and only the people asked for", async () => {
    const all = await database.rows<{ person_id: string; events: number }>("select person_id, events from public.drift_signal_normals($1::uuid[], now() - interval '30 days') order by person_id", [ids]);
    expect(all.map((row) => [row.person_id === ids[0] ? "A" : "B", row.events]).sort()).toEqual([
      ["A", 4],
      ["B", 1],
    ]);
    const only = await database.rows<{ person_id: string }>("select person_id from public.drift_signal_normals($1::uuid[], now() - interval '30 days')", [[ids[1]]]);
    expect(only).toEqual([{ person_id: ids[1] }]);
    expect(await database.rows("select * from public.drift_signal_normals($1::uuid[], now() - interval '30 days')", [[ids[2]]])).toEqual([]);
  });

  it("is the service role's read alone", async () => {
    const [fn] = await database.rows<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.drift_signal_normals(uuid[], timestamptz)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.drift_signal_normals(uuid[], timestamptz)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.drift_signal_normals(uuid[], timestamptz)', 'execute') as service`,
    );
    expect([fn.anon, fn.authenticated, fn.service]).toEqual([false, false, true]);
  });
});
