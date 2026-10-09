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

describe("admin_audit_log.performed_by (2026-10-09)", () => {
  it("accepts a row that names who performed an action outside the admin functions, and refuses a row that names nobody", async () => {
    const [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'kai-cenat'");
    await database.operator(
      "insert into public.admin_audit_log (actor_id, performed_by, action, target_person_id, note, details) values (null, 'Claude Code', 'hide_signal', $1, 'correction', '{\"instructed_by\": \"Anthony\"}')",
      [personId],
    );
    const rows = await database.operator<{ actor_id: string | null; performed_by: string; note: string }>("select actor_id, performed_by, note from public.admin_audit_log where performed_by = 'Claude Code'");
    expect(rows).toEqual([{ actor_id: null, performed_by: "Claude Code", note: "correction" }]);
    await expect(database.operator("insert into public.admin_audit_log (actor_id, performed_by, action, note, details) values (null, null, 'hide_signal', 'nobody', '{}')")).rejects.toThrow(/admin_audit_log_actor_or_performer/);
    await expect(database.operator("insert into public.admin_audit_log (actor_id, performed_by, action, note, details) values (null, '  ', 'hide_signal', 'blank', '{}')")).rejects.toThrow(/admin_audit_log_performed_by_nonempty|admin_audit_log_actor_or_performer/);
  });
});
