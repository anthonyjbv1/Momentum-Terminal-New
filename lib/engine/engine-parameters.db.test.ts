import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * ENGINE PARAMETERS (migration 20261009090000), against a real Postgres with
 * every migration applied verbatim: the seed row carries the rate as it has
 * stood in code (0.35); a direct write is refused, naming the function; the
 * admin function sets a value in (0, 5] and writes admin_audit_log (actor,
 * reason, before and after) in the same transaction; a refused value leaves
 * no audit row and no change.
 */

let database: TestDatabase;
let admin: string;
let member: string;

interface Result {
  ok: boolean;
  parameter?: string;
  from?: number | null;
  to?: number;
}

async function createUser(email: string, isAdmin: boolean): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  if (isAdmin) await database.rows("update public.users set is_admin = true where id = $1", [row.id]);
  return row.id;
}

async function set(actor: string | null, key: string, value: unknown, reason: string): Promise<Result> {
  await database.actAs(actor);
  try {
    const [row] = await database.rows<{ r: Result }>("select public.admin_set_engine_parameter($1, $2::jsonb, $3) as r", [key, JSON.stringify(value), reason]);
    return row.r;
  } finally {
    await database.actAs(null);
  }
}

async function current(): Promise<unknown> {
  const [row] = await database.rows<{ value: unknown }>("select value from public.engine_parameters where key = 'gravity_rate'");
  return row?.value;
}

async function auditRows(): Promise<Array<{ actor_id: string; note: string; details: { parameter: string; from: unknown; to: unknown } }>> {
  return database.rows("select actor_id, note, details from public.admin_audit_log where action = 'set_engine_parameter' order by id");
}

beforeAll(async () => {
  database = await createTestDatabase();
  admin = await createUser("operator@example.com", true);
  member = await createUser("member@example.com", false);
}, 120_000);

afterAll(async () => {
  await database.close();
});

describe("engine_parameters", () => {
  it("is seeded with gravity_rate 0.35, the rate as it stood in code", async () => {
    expect(await current()).toBe(0.35);
  });

  it("refuses a direct write, from any role, naming the function", async () => {
    for (const sql of [
      "update public.engine_parameters set value = '0.08'::jsonb where key = 'gravity_rate'",
      "delete from public.engine_parameters where key = 'gravity_rate'",
      "insert into public.engine_parameters (key, value) values ('gravity_rate', '0.1'::jsonb) on conflict (key) do update set value = excluded.value",
    ]) {
      await expect(database.rows(sql)).rejects.toThrow(/admin_set_engine_parameter\(\)/);
    }
    expect(await current()).toBe(0.35);
    // The test helper's door (the admin functions' setting) lets a fixture through, as the guards intend.
    await database.operator("update public.engine_parameters set value = '0.35'::jsonb where key = 'gravity_rate'");
  });

  it("the admin function sets the rate and logs before and after, with the actor and the reason", async () => {
    const result = await set(admin, "gravity_rate", 0.08, "replay 2026-10-09: half-life 8.7 h");
    expect(result).toMatchObject({ ok: true, parameter: "gravity_rate", from: 0.35, to: 0.08 });
    expect(await current()).toBe(0.08);
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: admin, note: "replay 2026-10-09: half-life 8.7 h", details: { parameter: "gravity_rate", from: 0.35, to: 0.08 } });
    // Back to the seed, logged as well.
    expect((await set(admin, "gravity_rate", 0.35, "back to the code default")).to).toBe(0.35);
    expect(await auditRows()).toHaveLength(2);
  });

  it("refuses a bad value, an unknown key, an empty reason and a non-admin, leaving no audit row", async () => {
    await expect(set(admin, "gravity_rate", 0, "zero")).rejects.toThrow(/above 0 and at most 5/);
    await expect(set(admin, "gravity_rate", 35, "a typo")).rejects.toThrow(/above 0 and at most 5/);
    await expect(set(admin, "gravity_rate", "0.08", "a string")).rejects.toThrow(/must be a number/);
    await expect(set(admin, "signals_base_impact", 1.5, "not a parameter")).rejects.toThrow(/must be gravity_rate/);
    await expect(set(admin, "gravity_rate", 0.08, "   ")).rejects.toThrow(/reason is required/);
    await expect(set(member, "gravity_rate", 0.08, "not an admin")).rejects.toThrow(/Not an admin/);
    await expect(set(null, "gravity_rate", 0.08, "nobody")).rejects.toThrow(/Not authenticated/);
    expect(await current()).toBe(0.35);
    expect(await auditRows()).toHaveLength(2);
  });

  it("the table is the service role's alone", async () => {
    const [row] = await database.rows<{ anon: boolean; authenticated: boolean; service: boolean }>(
      "select has_table_privilege('anon', 'public.engine_parameters', 'select') as anon, has_table_privilege('authenticated', 'public.engine_parameters', 'select') as authenticated, has_table_privilege('service_role', 'public.engine_parameters', 'select, update') as service",
    );
    expect(row).toEqual({ anon: false, authenticated: false, service: true });
  });
});
