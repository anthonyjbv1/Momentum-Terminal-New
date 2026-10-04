import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * THE FEED'S SPARKLINES IN ONE READ (migration 20261004120000), on the
 * migrations as production has them: person_score_series_many() returns,
 * person for person and slice for slice, exactly what person_score_series()
 * returns for each of them with the same window and points; a person with
 * no ticks in the window has no rows in either; the read is bounded to the
 * ids asked for; and the function is not callable by anon.
 */

let database: TestDatabase;
const people: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string }>("select id from public.people order by slug limit 4")) people.push(row.id);
  // Three people ticking every 30 seconds for the last three hours, at different rhythms; the fourth stays silent.
  for (const [index, person] of people.slice(0, 3).entries()) {
    await database.rows(
      `insert into public.score_history (person_id, score, tick_number, recorded_at)
       select $1, 50 + (g % (5 + $2::int)) * 0.25 + $2::int, g, now() - interval '3 hours' + g * interval '30 seconds' from generate_series(1, 360) g`,
      [person, index],
    );
  }
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("person_score_series_many()", () => {
  it("returns, for every person asked for, exactly the rows person_score_series() returns one by one", async () => {
    for (const [since, points] of [
      ["now() - interval '1 hour'", 12],
      ["now() - interval '200 minutes'", 91],
      ["now() - interval '3 hours'", 360],
    ] as const) {
      const [diff] = await database.rows<{ many_rows: number; single_rows: number; differing: number; only_many: number; only_single: number }>(
        `with many as (select * from public.person_score_series_many($1::uuid[], ${since}, ${points})),
              single as (select p.id as person_id, s.* from unnest($1::uuid[]) p(id) cross join lateral public.person_score_series(p.id, ${since}, ${points}) s)
         select (select count(*) from many)::int as many_rows,
                (select count(*) from single)::int as single_rows,
                count(*) filter (where m.score is distinct from s.score or m.open is distinct from s.open or m.samples is distinct from s.samples)::int as differing,
                count(*) filter (where s.person_id is null)::int as only_many,
                count(*) filter (where m.person_id is null)::int as only_single
           from many m full outer join single s on s.person_id = m.person_id and s.bucket_at = m.bucket_at`,
        [people],
      );
      expect(diff.many_rows).toBeGreaterThan(points / 2);
      expect(diff.many_rows).toBe(diff.single_rows);
      expect([diff.differing, diff.only_many, diff.only_single]).toEqual([0, 0, 0]);
    }
  });

  it("reads only the people asked for, and a silent person has no rows", async () => {
    const rows = await database.rows<{ person_id: string; n: number }>(
      "select person_id, count(*)::int as n from public.person_score_series_many($1::uuid[], now() - interval '1 hour', 12) group by person_id",
      [[people[0], people[3]]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].person_id).toBe(people[0]);
    expect(rows[0].n).toBeGreaterThan(5);
  });

  it("is a read the browser roles cannot make anonymously", async () => {
    const [fn] = await database.rows<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.person_score_series_many(uuid[], timestamptz, integer)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.person_score_series_many(uuid[], timestamptz, integer)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.person_score_series_many(uuid[], timestamptz, integer)', 'execute') as service`,
    );
    expect([fn.anon, fn.authenticated, fn.service]).toEqual([false, true, true]);
  });
});
