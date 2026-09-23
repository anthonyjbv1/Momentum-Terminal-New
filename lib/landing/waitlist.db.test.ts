import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * THE WAITLIST IN THE DATABASE (Phase 28), against real Postgres.
 *
 * The table grants nothing to any client; the only way in is join_waitlist()
 * through the service role, which is idempotent, case-insensitive, and
 * returns a real position. And the anonymous behavioural event: a row with
 * no user must carry a session, and no signed-in user can see it.
 */

const USER_ROLES = ["anon", "authenticated"];
const PRIVILEGES = ["select", "insert", "update", "delete"];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

async function join(email: string, extra: Record<string, unknown> = {}) {
  const [{ result }] = await database.rows<{ result: { created: boolean; position: number | string; joined_at: string } }>(
    "select public.join_waitlist($1, $2, $3::jsonb, $4) as result",
    [email, extra.source ?? null, extra.utm ? JSON.stringify(extra.utm) : null, extra.referrer ?? null],
  );
  return { ...result, position: Number(result.position) };
}

describe("join_waitlist()", () => {
  it("a new address is stored once, lowercased, with its campaign fields, at position 1", async () => {
    const first = await join("  First@Example.COM ", { source: "landing_hero", utm: { source: "x", campaign: "launch", junk: "ignored" }, referrer: "https://news.example/story" });
    expect(first.created).toBe(true);
    expect(first.position).toBe(1);
    const rows = await database.rows<Record<string, unknown>>("select email::text as email, source, utm_source, utm_medium, utm_campaign, referrer, consent_at is not null as consented from public.waitlist");
    expect(rows).toEqual([{ email: "first@example.com", source: "landing_hero", utm_source: "x", utm_medium: null, utm_campaign: "launch", referrer: "https://news.example/story", consented: true }]);
  });

  it("a duplicate, however capitalised, adds no row and answers with the position it already holds", async () => {
    const again = await join("FIRST@example.com", { source: "landing_footer" });
    expect(again.created).toBe(false);
    expect(again.position).toBe(1);
    const [{ count }] = await database.rows<{ count: string }>("select count(*) from public.waitlist");
    expect(Number(count)).toBe(1);
    // The original row is untouched: the second form's name did not overwrite the first's.
    const [{ source }] = await database.rows<{ source: string }>("select source from public.waitlist");
    expect(source).toBe("landing_hero");
  });

  it("the position is the real row count at or before the row, stable across calls", async () => {
    const second = await join("second@example.com");
    const third = await join("third@example.com");
    expect([second.created, second.position, third.created, third.position]).toEqual([true, 2, true, 3]);
    expect((await join("second@example.com")).position).toBe(2);
    expect((await join("first@example.com")).position).toBe(1);
  });

  it("refuses what is not an address, and the table's own check agrees", async () => {
    for (const bad of ["", "nope", "a@b", "a b@example.com", `${"a".repeat(250)}@example.com`]) {
      await expect(database.rows("select public.join_waitlist($1)", [bad]), JSON.stringify(bad)).rejects.toThrow(/not an email address/);
    }
    await expect(database.exec("insert into public.waitlist (email) values ('not-an-email')")).rejects.toThrow(/waitlist_email_shape/);
    await expect(database.exec("insert into public.waitlist (email, source) values ('long@example.com', repeat('s', 65))")).rejects.toThrow(/waitlist_source_length/);
  });

  it("the column itself is case-insensitive, so a direct write of a differently-cased duplicate is refused by the unique constraint", async () => {
    await expect(database.exec("insert into public.waitlist (email) values ('FIRST@EXAMPLE.COM')")).rejects.toThrow(/waitlist_email_unique/);
  });
});

describe("no client can reach the waitlist", () => {
  it("anon and authenticated hold no privilege on the table, on any operation", async () => {
    for (const role of USER_ROLES) {
      for (const privilege of PRIVILEGES) {
        const [{ ok }] = await database.rows<{ ok: boolean }>("select has_table_privilege($1, 'public.waitlist', $2) as ok", [role, privilege]);
        expect(ok, `${role} may ${privilege} waitlist`).toBe(false);
      }
    }
    const [{ rls }] = await database.rows<{ rls: boolean }>("select relrowsecurity as rls from pg_class where oid = 'public.waitlist'::regclass");
    expect(rls).toBe(true);
    const policies = await database.rows("select policyname from pg_policies where schemaname = 'public' and tablename = 'waitlist'");
    expect(policies).toEqual([]);
  });

  it("anon and authenticated cannot execute join_waitlist(); the service role can", async () => {
    for (const role of USER_ROLES) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select has_function_privilege($1, 'public.join_waitlist(text, text, jsonb, text)', 'execute') as ok", [role]);
      expect(ok, `${role} may call join_waitlist`).toBe(false);
    }
    const [{ ok }] = await database.rows<{ ok: boolean }>("select has_function_privilege('service_role', 'public.join_waitlist(text, text, jsonb, text)', 'execute') as ok");
    expect(ok).toBe(true);
  });

  it("as anon, a select or an insert on the table is refused outright", async () => {
    await database.exec("begin; set local role anon;");
    try {
      await expect(database.rows("select * from public.waitlist")).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec("rollback;");
    }
    await database.exec("begin; set local role anon;");
    try {
      await expect(database.rows("insert into public.waitlist (email) values ('anon@example.com')")).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec("rollback;");
    }
    await database.exec("begin; set local role authenticated;");
    try {
      await expect(database.rows("select public.join_waitlist('auth@example.com')")).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec("rollback;");
    }
  });
});

describe("anonymous behavioural events", () => {
  const SESSION = "33333333-3333-4333-8333-333333333333";

  it("a view_landing row with no user is accepted when it carries a session id", async () => {
    await database.exec(`insert into public.behavioral_events (user_id, session_id, event_type, metadata) values (null, '${SESSION}', 'view_landing', '{"surface":"landing"}')`);
    const rows = await database.rows<{ user_id: string | null; session_id: string; event_type: string }>("select user_id, session_id, event_type from public.behavioral_events where event_type = 'view_landing'");
    expect(rows).toEqual([{ user_id: null, session_id: SESSION, event_type: "view_landing" }]);
  });

  it("a row with neither a user nor a session is refused: an event always names somebody", async () => {
    await expect(database.exec("insert into public.behavioral_events (user_id, session_id, event_type) values (null, null, 'view_landing')")).rejects.toThrow(/behavioral_events_actor_check/);
  });

  it("a signed-in user cannot read an anonymous row: refused outright, or filtered to nothing by the select-own policy", async () => {
    await database.actAs("44444444-4444-4444-8444-444444444444");
    await database.exec("begin; set local role authenticated;");
    try {
      // The harness grants `authenticated` nothing on the table, so the read is refused
      // before the policy runs; on a database where the role holds SELECT, the
      // select-own policy (user_id = auth.uid(), never true of a null) filters it to nothing.
      const rows = await database.rows("select id from public.behavioral_events where event_type = 'view_landing'").catch((error: Error) => error);
      if (rows instanceof Error) expect(rows.message).toMatch(/permission denied/);
      else expect(rows).toEqual([]);
    } finally {
      await database.exec("rollback;");
      await database.actAs(null);
    }
  });
});
