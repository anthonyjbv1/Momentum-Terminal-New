import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * PHASE 27 IS REVERSIBLE, AND THIS IS WHAT SAYS SO.
 *
 * supabase/rollback/ holds a down migration that takes units back to whole
 * shares. A rollback file nobody has run is a claim, not a property, so these
 * tests run it: against a database that has been traded on, and against one
 * holding a fraction, which it must refuse rather than round away.
 *
 * The rollback lives outside supabase/migrations/ so nothing applies it by
 * accident, which is also why it is read from disk here by name.
 */

const ROLLBACK = readFileSync(
  join(__dirname, "..", "..", "supabase", "rollback", "20260922211703_phase27_fractional_units_down.sql"),
  "utf8",
);

const SHARE = 1000;

let database: TestDatabase;

afterEach(async () => {
  await database?.close();
});

/** A user with a balance, and Drake quoted at a round $50.50 / $49.50. */
async function seed(): Promise<{ userId: string; drake: string }> {
  database = await createTestDatabase();
  const [user] = await database.rows<{ id: string }>("insert into auth.users (email) values ('rollback@example.com') returning id");
  const [drake] = await database.rows<{ id: string }>("select id from public.people where slug = 'drake'");
  await database.exec("update public.platform_settings set close_cooldown_seconds = 0 where id");
  await database.rows("update public.people set current_score = 50, spread = 0.5 where id = $1", [drake.id]);
  await database.actAs(user.id);
  return { userId: user.id, drake: drake.id };
}

interface Figures {
  cash: string;
  basis: string;
  realized: string;
  credit: string;
  open_units: string;
  closed_units: string;
  order_units: string;
}

/** The same money figures the production reconciliation reads, per user. */
async function figures(userId: string): Promise<Figures> {
  const [row] = await database.rows<Figures>(
    `select (select wallet_balance_cents from public.users where id = $1)::text as cash,
            (select coalesce(sum(p.amount_cents - coalesce((select sum(c.cost_cents) from public.position_closes c where c.position_id = p.id), 0)), 0)
               from public.positions p where p.user_id = $1 and p.is_open)::text as basis,
            (select coalesce(sum(c.pnl_cents), 0) from public.position_closes c where c.user_id = $1)::text as realized,
            (select coalesce(sum(case when t.type = 'DEPOSIT' then t.amount_cents when t.type = 'WITHDRAWAL' then -t.amount_cents else 0 end), 0)
               from public.transactions t where t.user_id = $1)::text as credit,
            (select coalesce(sum(p.open_units), 0) from public.positions p where p.user_id = $1 and p.is_open)::text as open_units,
            (select coalesce(sum(c.units), 0) from public.position_closes c where c.user_id = $1)::text as closed_units,
            (select coalesce(sum(o.units), 0) from public.trade_orders o where o.user_id = $1)::text as order_units`,
    [userId],
  );
  return row;
}

describe("the Phase 27 rollback", () => {
  it("takes a traded-on database back to whole shares with every cent intact", async () => {
    const { userId, drake } = await seed();
    // Three whole-share orders through the compatibility path, one of them a
    // partial close, so a lot has been cut and a basis has been split.
    await database.rows("select public.place_order($1::uuid, 'BUY', 4)", [drake]);
    await database.rows("select public.place_order($1::uuid, 'BUY', 2)", [drake]);
    await database.rows("select public.place_order($1::uuid, 'SELL', 3)", [drake]);

    const before = await figures(userId);
    expect(before.open_units).toBe(String(3 * SHARE));
    expect(before.closed_units).toBe(String(3 * SHARE));

    await database.exec(ROLLBACK);

    const after = await figures(userId);
    // Every cent is the same number it was.
    expect(after.cash).toBe(before.cash);
    expect(after.basis).toBe(before.basis);
    expect(after.realized).toBe(before.realized);
    expect(after.credit).toBe(before.credit);
    // Every quantity is a thousandth of what it was: whole shares again.
    expect(after.open_units).toBe("3");
    expect(after.closed_units).toBe("3");
    expect(after.order_units).toBe(String(Number(before.order_units) / SHARE));
  });

  it("leaves the pre-Phase-27 shape behind it: no basis column, no scale column, the five-argument order", async () => {
    const { drake } = await seed();
    await database.rows("select public.place_order($1::uuid, 'BUY', 2)", [drake]);
    await database.exec(ROLLBACK);

    const [columns] = await database.rows<{ open_cost: string; scale: string; spend: string; minimum: string }>(
      `select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'open_cost_cents')::text as open_cost,
              (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'trade_orders' and column_name = 'quantity_scale')::text as scale,
              (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'trade_orders' and column_name = 'requested_spend_cents')::text as spend,
              (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name = 'min_order_cents')::text as minimum`,
    );
    expect(columns).toEqual({ open_cost: "0", scale: "0", spend: "0", minimum: "0" });

    const [functions] = await database.rows<{ scale_fn: string; seven_arg: string; five_arg: string }>(
      `select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'units_per_share')::text as scale_fn,
              has_function_privilege('authenticated', 'public.place_order(uuid, text, bigint, bigint, text)', 'execute')::text as five_arg,
              (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'place_order' and p.pronargs = 7)::text as seven_arg`,
    );
    expect(functions).toEqual({ scale_fn: "0", five_arg: "true", seven_arg: "0" });

    // And the restored order still works, in whole shares.
    const [{ r }] = await database.rows<{ r: { ok: boolean; order: { units: number } } }>(
      "select public.place_order($1::uuid, 'BUY', 1) as r",
      [drake],
    );
    expect(r.ok).toBe(true);
    expect(r.order.units).toBe(1);
  });

  it("refuses, changing nothing, when anyone holds a fraction of a share", async () => {
    const { userId, drake } = await seed();
    // 0.25 of a share: nothing whole-share units can express.
    await database.rows("select public.place_order($1::uuid, 'BUY', $2::bigint, null::bigint, null, null::bigint, 'milli')", [drake, 250]);
    const before = await figures(userId);

    await expect(database.exec(ROLLBACK)).rejects.toThrow(/fractional quantities exist/i);

    // The refusal is the whole transaction: the holding is exactly as it was.
    expect(await figures(userId)).toEqual(before);
    expect(before.open_units).toBe("250");
  });
}, 120_000);
