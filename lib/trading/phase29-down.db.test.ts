import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS_DIR } from "@/lib/__tests__/migrations";
import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * PHASE 29 IS REVERSIBLE (Phase 29b).
 *
 * supabase/rollback/20260925012938_phase29_market_price_down.sql takes the
 * schema from Phase 29 + 29b back to exactly what Phase 28 left. "Exactly" is
 * checked here, not asserted: a database migrated only as far as Phase 28 and
 * one migrated all the way and then rolled back are compared object by
 * object — every column (type, nullability, default or generation
 * expression, comment, grants), constraint, index, function (full definition,
 * grants, comment), trigger, policy, table (RLS, grants, comment) and view.
 * Only column ORDER is not compared: a dropped column cannot be put back in
 * its old slot, and nothing reads the table by position.
 *
 * Then the data: rows written before Phase 29, and rows written while it was
 * live on a flat market, come through with every pre-Phase-29 column intact,
 * and the restored seven-argument place_order() trades on them. And every
 * refusal: already reversed, a premium still standing, curve-filled rows the
 * Phase 27 CHECKs reject (and the NOT VALID path that keeps them), and
 * Phase-29-only data not yet exported. Each refusal changes nothing.
 */

const PHASE29 = "20260925012938_phase29_market_price.sql";
const PHASE29B = "20260925103634_phase29b_post_ship_fixes.sql";
const DOWN = readFileSync(join(__dirname, "..", "..", "supabase", "rollback", "20260925012938_phase29_market_price_down.sql"), "utf8");
const SHARE = 1000;

let databases: TestDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.map((database) => database.close()));
  databases = [];
});

async function open(before?: string): Promise<TestDatabase> {
  const database = await createTestDatabase(before ? { before } : {});
  databases.push(database);
  return database;
}

async function migrate(database: TestDatabase, file: string): Promise<void> {
  await database.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

/** Runs the down file; a refusal leaves its explicit transaction aborted, so it is rolled back here. */
async function runDown(database: TestDatabase): Promise<void> {
  try {
    await database.exec(DOWN);
  } catch (error) {
    await database.exec("rollback");
    throw error;
  }
}

type Snapshot = Record<string, string[]>;

/** The public schema, object by object, as text. */
async function snapshot(database: TestDatabase): Promise<Snapshot> {
  const lines = async (sql: string) => (await database.rows<{ line: string }>(sql)).map((row) => row.line);
  return {
    columns: await lines(`
      select c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
             || case when a.attnotnull then ' not null' else '' end
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
             || case when a.attgenerated = 's' then ' stored' else '' end
             || case when a.attidentity <> '' then ' identity ' || a.attidentity::text else '' end
             || coalesce(' comment ' || col_description(c.oid, a.attnum), '')
             || coalesce(' acl ' || a.attacl::text, '') as line
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p', 'f')
         and a.attnum > 0 and not a.attisdropped
       order by 1`),
    constraints: await lines(`
      select conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) as line
        from pg_constraint where connamespace = 'public'::regnamespace order by 1`),
    indexes: await lines(`select indexdef as line from pg_indexes where schemaname = 'public' order by 1`),
    functions: await lines(`
      select p.oid::regprocedure::text || E'\\n' || pg_get_functiondef(p.oid)
             || E'\\nacl ' || coalesce(p.proacl::text, '') || E'\\ncomment ' || coalesce(obj_description(p.oid, 'pg_proc'), '') as line
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') order by 1`),
    triggers: await lines(`
      select t.tgrelid::regclass::text || ' ' || pg_get_triggerdef(t.oid) as line
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and c.relnamespace = 'public'::regnamespace order by 1`),
    policies: await lines(`
      select tablename || ' ' || policyname || ' ' || cmd || ' ' || roles::text || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') as line
        from pg_policies where schemaname = 'public' order by 1`),
    tables: await lines(`
      select relname || ' ' || relkind::text || ' rls=' || relrowsecurity || ' acl=' || coalesce(relacl::text, '') || ' comment=' || coalesce(obj_description(oid, 'pg_class'), '') as line
        from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v', 'm', 'S', 'p') order by 1`),
    views: await lines(`select viewname || ' ' || definition as line from pg_views where schemaname = 'public' order by 1`),
    types: await lines(`select typname || ' ' || typtype::text as line from pg_type where typnamespace = 'public'::regnamespace and typtype in ('e', 'd') order by 1`),
  };
}

/** What differs, both ways, so a failure names the object rather than printing two schemas. */
function difference(expected: Snapshot, actual: Snapshot): Record<string, { missing: string[]; extra: string[] }> {
  const out: Record<string, { missing: string[]; extra: string[] }> = {};
  for (const key of Object.keys(expected)) {
    const have = new Set(actual[key]);
    const want = new Set(expected[key]);
    const missing = expected[key].filter((line) => !have.has(line));
    const extra = actual[key].filter((line) => !want.has(line));
    if (missing.length || extra.length) out[key] = { missing, extra };
  }
  return out;
}

async function user(database: TestDatabase, email: string): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return row.id;
}

async function personId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = await database.rows<{ id: string }>("select id from public.people where slug = $1", [slug]);
  return row.id;
}

/** The seven-argument place_order, as the Phase 28 app calls it. */
async function order7(database: TestDatabase, userId: string, person: string, side: "BUY" | "SELL", units: number): Promise<Record<string, unknown>> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: Record<string, unknown> }>("select public.place_order($1::uuid, $2, $3::bigint, null::bigint, 'test', null::bigint, 'milli') as r", [person, side, units]);
  await database.actAs(null);
  return row.r;
}

/** Every row of the tables that predate Phase 29, restricted to the columns that predate it. */
async function preexistingRows(database: TestDatabase, columns: Snapshot["columns"]): Promise<Record<string, unknown[]>> {
  const byTable = new Map<string, string[]>();
  for (const line of columns) {
    const [qualified] = line.split(" ");
    const [table, column] = qualified.split(".");
    if (!["people", "users", "platform_settings", "trade_orders", "positions", "position_closes", "transactions", "portfolio_history", "trade_events"].includes(table)) continue;
    if (column === "buy_price" || column === "sell_price" || column === "updated_at") continue;
    byTable.set(table, [...(byTable.get(table) ?? []), column]);
  }
  // While Phase 29 is applied, positions.entry_score is entry_price_points.
  const [renamed] = await database.rows<{ n: string }>(
    "select count(*)::text as n from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'entry_price_points'",
  );
  const out: Record<string, unknown[]> = {};
  for (const [table, cols] of byTable) {
    const list = cols.map((column) => (table === "positions" && column === "entry_score" && renamed.n === "1" ? `"entry_price_points" as "entry_score"` : `"${column}"`)).join(", ");
    out[table] = (await database.rows(`select ${list} from public.${table} order by 1, 2`)).map((row) => JSON.stringify(row));
  }
  return out;
}

describe("the Phase 29 rollback", () => {
  it("takes the schema back to exactly what Phase 28 left", async () => {
    const before = await snapshot(await open(PHASE29));
    const database = await open();
    // The comparison is not blind: with Phase 29 applied it sees the difference everywhere it should.
    expect(Object.keys(difference(before, await snapshot(database)))).toEqual(expect.arrayContaining(["columns", "constraints", "indexes", "functions", "triggers", "policies", "tables"]));
    await runDown(database);
    const after = await snapshot(database);
    expect(difference(before, after)).toEqual({});
  }, 180_000);

  it("keeps every row: data from before Phase 29 and from while it ran flat survives, and the Phase 28 place_order trades again", async () => {
    const database = await open(PHASE29);
    const pre = await snapshot(database);
    await database.exec("update public.platform_settings set close_cooldown_seconds = 0 where id");
    const drake = await personId(database, "drake");
    const mrbeast = await personId(database, "mrbeast");
    await database.rows("update public.people set current_score = 50, spread = 0.5 where id = $1", [drake]);
    const alice = await user(database, "alice@example.com");
    // Before Phase 29: a buy, another, a partial close.
    expect((await order7(database, alice, drake, "BUY", 4 * SHARE)).ok).toBe(true);
    expect((await order7(database, alice, drake, "BUY", 2 * SHARE)).ok).toBe(true);
    expect((await order7(database, alice, drake, "SELL", 3 * SHARE)).ok).toBe(true);
    const rowsBefore29 = await preexistingRows(database, pre.columns);

    // Phase 29 and 29b go on; the market is run flat (the soft rollback) and traded on.
    await migrate(database, PHASE29);
    await migrate(database, PHASE29B);
    await database.exec("update public.market_tier_settings set pricing_mode = 'flat', min_hold_seconds = 0");
    const bob = await user(database, "bob@example.com");
    expect((await order7(database, bob, mrbeast, "BUY", 5 * SHARE)).ok).toBe(true);
    expect((await order7(database, alice, drake, "SELL", 1 * SHARE)).ok).toBe(true);
    const rowsBeforeDown = await preexistingRows(database, pre.columns);

    // Trading on Phase 29 wrote its own records (the house book, the detectors' events): exported first, by declaration.
    await expect(runDown(database)).rejects.toThrow(/house_ledger/);
    await database.exec("set momentum.phase29_down_data_exported = 'yes'");
    await runDown(database);

    expect(difference(pre, await snapshot(database))).toEqual({});
    const rowsAfter = await preexistingRows(database, pre.columns);
    // Everything that existed before Phase 29 is exactly as it was, save what Phase 29's own trading changed.
    for (const table of ["transactions", "portfolio_history", "trade_events", "trade_orders", "position_closes"]) {
      for (const row of rowsBefore29[table]) expect(rowsAfter[table], table).toContain(row);
    }
    // And everything the flat-market Phase 29 wrote to those tables is still there, column for column.
    expect(rowsAfter).toEqual(rowsBeforeDown);

    // The Phase 28 app's order path works on the restored schema, at score ± spread.
    const filled = await order7(database, bob, drake, "BUY", 2 * SHARE);
    expect(filled).toMatchObject({ ok: true });
    expect((filled.order as Record<string, unknown>).fill_price_cents).toBe(5050);
  }, 180_000);

  it("leaves the schema the Phase 27 rollback was written for, so that file applies again after this one", async () => {
    const database = await open();
    await database.exec("update public.platform_settings set close_cooldown_seconds = 0 where id");
    await database.exec("update public.market_tier_settings set pricing_mode = 'flat', min_hold_seconds = 0");
    const alice = await user(database, "alice@example.com");
    const drake = await personId(database, "drake");
    expect((await order7(database, alice, drake, "BUY", 3 * SHARE)).ok).toBe(true);
    await database.exec("set momentum.phase29_down_data_exported = 'yes'");
    await runDown(database);

    await database.exec(readFileSync(join(__dirname, "..", "..", "supabase", "rollback", "20260922211703_phase27_fractional_units_down.sql"), "utf8"));
    const [lot] = await database.rows<{ units: string }>("select units::text as units from public.positions where user_id = $1", [alice]);
    expect(lot.units).toBe("3");
  }, 180_000);

  it("refuses to run twice, changing nothing", async () => {
    const database = await open();
    await runDown(database);
    const reversed = await snapshot(database);
    await expect(runDown(database)).rejects.toThrow(/Phase 29 is not applied/);
    expect(await snapshot(database)).toEqual(reversed);
  }, 180_000);

  it("refuses while a premium stands, then the named flat mode and one decay step clear the way", async () => {
    const database = await open();
    await database.exec("update public.market_tier_settings set min_hold_seconds = 0");
    const alice = await user(database, "alice@example.com");
    const drake = await personId(database, "drake");
    await database.actAs(alice);
    await database.rows("select public.place_order($1::uuid, 'BUY', $2::bigint, null::bigint, 'test', null::bigint, 'milli')", [drake, 30 * SHARE]);
    await database.actAs(null);
    const schema = await snapshot(database);

    await expect(runDown(database)).rejects.toThrow(/1 people still carry a premium or dealer inventory/);
    expect(await snapshot(database)).toEqual(schema);

    await database.exec("update public.market_tier_settings set pricing_mode = 'flat'");
    await database.rows("select public.apply_market_decay(now(), 1)");
    const [row] = await database.rows<{ premium: string; inventory: string }>("select premium_cents::text as premium, market_inventory_units::text as inventory from public.people where id = $1", [drake]);
    expect(row).toEqual({ premium: "0", inventory: "0" });
  }, 180_000);

  it("refuses curve-filled rows by count, and with not_valid keeps them and checks every row after", async () => {
    const database = await open();
    await database.exec("update public.market_tier_settings set min_hold_seconds = 0");
    await database.exec("update public.platform_settings set close_cooldown_seconds = 0 where id");
    const alice = await user(database, "alice@example.com");
    const drake = await personId(database, "drake");
    await database.rows("update public.people set current_score = 50, spread = 0.5 where id = $1", [drake]);
    await database.actAs(alice);
    // 10 shares up the curve at depth 300,000: gross 50,517, the average 5052 × 10 = 50,520. Not a product.
    const [curve] = await database.rows<{ r: { ok: boolean; order: { gross_cents: number; fill_price_cents: number } } }>(
      "select public.place_order($1::uuid, 'BUY', $2::bigint, null::bigint, 'test', null::bigint, 'milli') as r",
      [drake, 10 * SHARE],
    );
    await database.actAs(null);
    expect(curve.r.ok).toBe(true);
    expect(curve.r.order.gross_cents).not.toBe(curve.r.order.fill_price_cents * 10);
    await database.exec("update public.market_tier_settings set pricing_mode = 'flat'");
    await database.rows("select public.apply_market_decay(now(), 1)");
    await database.exec("set momentum.phase29_down_data_exported = 'yes'");
    const schema = await snapshot(database);

    await expect(runDown(database)).rejects.toThrow(/1 lots and 1 orders were filled along the curve/);
    expect(await snapshot(database)).toEqual(schema);

    await database.exec("set momentum.phase29_down_curve_rows = 'not_valid'");
    await runDown(database);
    const checks = await database.rows<{ name: string; valid: boolean }>(
      "select conname as name, convalidated as valid from pg_constraint where conname in ('positions_amount_is_cost', 'trade_orders_gross_is_notional') order by 1",
    );
    expect(checks).toEqual([
      { name: "positions_amount_is_cost", valid: false },
      { name: "trade_orders_gross_is_notional", valid: false },
    ]);
    // The curve-filled rows are kept as filled; a new row that breaks the rule is refused.
    const [kept] = await database.rows<{ n: string }>("select count(*)::text as n from public.trade_orders where gross_cents = $1", [curve.r.order.gross_cents]);
    expect(kept.n).toBe("1");
    await expect(database.exec("update public.trade_orders set gross_cents = gross_cents + 1")).rejects.toThrow(/trade_orders_gross_is_notional/);
  }, 180_000);

  it("refuses to delete Phase-29-only data until it has been exported", async () => {
    const database = await open();
    await database.exec(`
      insert into public.alerts (type, severity, evidence) values ('manual', 'low', '{}'::jsonb);
      insert into public.surveillance_events (recorded_at, detector, severity, evidence) values (now(), 'manual', 'low', '{}'::jsonb);
    `);
    const schema = await snapshot(database);
    await expect(runDown(database)).rejects.toThrow(/1 alerts, 1 surveillance_events/);
    expect(await snapshot(database)).toEqual(schema);

    await database.exec("set momentum.phase29_down_data_exported = 'yes'");
    await runDown(database);
    const [gone] = await database.rows<{ alerts: string | null }>("select to_regclass('public.alerts')::text as alerts");
    expect(gone.alerts).toBeNull();
  }, 180_000);
});
