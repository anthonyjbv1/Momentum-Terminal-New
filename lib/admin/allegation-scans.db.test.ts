import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/** The detection scans' store (2026-10-09): service role only, every run kept with its working. */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe("allegation_scans", () => {
  it("keeps a run with its params, counts, flagged stories and disagreements, newest first, and grants the user roles nothing", async () => {
    await database.operator(
      "insert into public.allegation_scans (run_by, params, counts, flagged, disagreements, llm_calls) values (null, '{\"days\": 30, \"person\": \"kai-cenat\", \"stories\": 212}', '{\"terms\": 7, \"model\": 6, \"both\": 6, \"disagreements\": 1, \"wouldHold\": 5}', '[{\"id\": \"a\"}]', '[{\"id\": \"a\", \"terms\": \"sexual_abuse\", \"model\": \"none\"}]', 11)",
    );
    const rows = await database.operator<{ params: { person: string }; counts: { terms: number }; n: number; llm_calls: number }>(
      "select params, counts, jsonb_array_length(disagreements) as n, llm_calls from public.allegation_scans order by run_at desc",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ params: { person: "kai-cenat" }, counts: { terms: 7 }, n: 1, llm_calls: 11 });
    for (const role of ["anon", "authenticated"]) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select has_table_privilege($1, 'public.allegation_scans', 'select') as ok", [role]);
      expect(ok, `${role} may read allegation_scans`).toBe(false);
    }
    const [{ rls }] = await database.rows<{ rls: boolean }>("select relrowsecurity as rls from pg_class where oid = 'public.allegation_scans'::regclass");
    expect(rls).toBe(true);
  });
});
