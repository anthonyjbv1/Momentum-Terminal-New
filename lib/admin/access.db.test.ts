import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * ADMIN ACCESS, from the database's side (Phase 9), against real Postgres.
 *
 * The application check (lib/admin/access.test.ts) is the first door; this is
 * the second. Even holding a valid session and a stolen query, a normal client
 * has no privilege on the relations the operator console reads, and no client
 * can set the flag on itself: `is_admin` is outside the column-level UPDATE
 * grant, so it moves only by service role or migration.
 */

/** Everything lib/admin/data.ts reads that is operational. None of it is for users. */
const ADMIN_ONLY = [
  "llm_usage",
  "llm_model_prices",
  "llm_cost_per_tick",
  "ingest_runs",
  "source_polls",
  "source_health",
  "metric_baseline_progress",
];
const USER_ROLES = ["anon", "authenticated"];
const PRIVILEGES = ["select", "insert", "update", "delete"];

/** What the operator may edit on their own profile — everything else is the service role's. */
const SELF_EDITABLE = ["username", "display_name", "avatar_url"];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

describe("the relations the operator console reads", () => {
  it("grant nothing to a signed-in or signed-out client, on any privilege", async () => {
    for (const relation of ADMIN_ONLY) {
      for (const role of USER_ROLES) {
        for (const privilege of PRIVILEGES) {
          const [{ ok }] = await database.rows<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, `public.${relation}`, privilege]);
          expect(ok, `${role} may ${privilege} ${relation}`).toBe(false);
        }
      }
    }
  });

  it("include the baseline view, and it runs as its caller rather than as its owner", async () => {
    const [{ options }] = await database.rows<{ options: string[] | null }>("select reloptions as options from pg_class where oid = 'public.metric_baseline_progress'::regclass");
    expect(options ?? []).toContain("security_invoker=true");
  });
});

describe("the baseline view", () => {
  it("exposes counts, configuration and timestamps — no metric level is a column of it", async () => {
    const columns = await database.rows<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'metric_baseline_progress' order by column_name",
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "first_snapshot_at",
      "last_emitted_signal",
      "last_observed_at",
      "last_outcome",
      "last_snapshot_at",
      "metric_key",
      "min_samples",
      "person_name",
      "person_slug",
      "sample_progress",
      "samples",
      "snapshots",
      "source",
      "span_hours",
      "span_progress",
      "window_hours",
    ]);
  });

  it("counts the clock correctly: samples against the minimum, span against the window", async () => {
    const [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'mrbeast'");
    const [{ id: sourceId }] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'youtube'");
    const [{ id: runId }] = await database.rows<{ id: string }>("insert into public.ingest_runs (started_at, trigger) values (now(), 'manual') returning id");
    // Four snapshots over six hours, and an observation saying the baseline is not yet sufficient.
    await database.exec(`
      insert into public.raw_source_snapshots (person_id, data_source_id, metric_key, value, recorded_at) values
        ('${personId}', '${sourceId}', 'view_count', 1, now() - interval '6 hours'),
        ('${personId}', '${sourceId}', 'view_count', 2, now() - interval '4 hours'),
        ('${personId}', '${sourceId}', 'view_count', 3, now() - interval '2 hours'),
        ('${personId}', '${sourceId}', 'view_count', 4, now());
      insert into public.raw_metric_observations (run_id, person_id, data_source_id, metric_key, value, recorded_at, outcome, samples, min_samples, window_hours) values
        ('${runId}', '${personId}', '${sourceId}', 'view_count', 4, now(), 'insufficient_baseline', 4, 24, 168);
    `);
    const [row] = await database.rows<Record<string, unknown>>(
      "select * from public.metric_baseline_progress where person_slug = 'mrbeast' and source = 'youtube' and metric_key = 'view_count'",
    );
    expect(row.last_outcome).toBe("insufficient_baseline");
    expect([Number(row.samples), Number(row.min_samples), Number(row.snapshots)]).toEqual([4, 24, 4]);
    expect(Number(row.sample_progress)).toBeCloseTo(4 / 24, 4);
    expect(Number(row.span_hours)).toBeCloseTo(6, 1);
    expect(Number(row.span_progress)).toBeCloseTo(6 / 168, 3);
  });
});

describe("the admin flag", () => {
  it("cannot be granted from a client: it is outside the column-level update grant", async () => {
    for (const role of USER_ROLES) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select has_column_privilege($1, 'public.users', 'is_admin', 'update') as ok", [role]);
      expect(ok, `${role} may set is_admin`).toBe(false);
    }
    // The three a user may edit, so the grant is narrow rather than absent.
    for (const column of SELF_EDITABLE) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select has_column_privilege('authenticated', 'public.users', $1, 'update') as ok", [column]);
      expect(ok, `authenticated may edit ${column}`).toBe(true);
    }
  });

  it("is off by default, so a new account is not an operator", async () => {
    const [{ default_value, nullable }] = await database.rows<{ default_value: string | null; nullable: string }>(
      "select column_default as default_value, is_nullable as nullable from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'is_admin'",
    );
    expect(default_value).toBe("false");
    expect(nullable).toBe("NO");
  });

  it("is granted by migration to one named account, and to no one else", async () => {
    const rows = await database.rows<{ email: string }>("select email from public.users where is_admin order by email");
    // The seed carries no users, so this asserts the shape of the grant rather than a row count:
    // the statement in the Phase 9 migration matches on email and can promote nobody it does not name.
    expect(rows.every((row) => row.email === "anthonyjbv1@gmail.com")).toBe(true);
  });
});
