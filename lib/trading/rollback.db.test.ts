import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * PHASE 27 WAS REVERSIBLE, AND PHASE 29 SUPERSEDES THAT.
 *
 * supabase/rollback/ holds the down migration that took units back to whole
 * shares. Until Phase 29 these tests ran it against a traded-on database and
 * against one holding a fraction (which it refused). Phase 29 — the market
 * price — renamed positions.entry_score, replaced the flat CHECK constraints
 * the down file restores with the cost-curve identities, and gave
 * place_order() an eighth argument, so running that file on a Phase 29 schema
 * would install flat functions over curve-priced rows. The file now refuses
 * on such a schema, having changed nothing, and that refusal is what these
 * tests pin. Phase 29b added Phase 29's own down file; run after it, this
 * file applies again (lib/trading/phase29-down.db.test.ts).
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
  await database.exec("update public.market_tier_settings set min_hold_seconds = 0");
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
  premium: string;
}

/** The same money figures the production reconciliation reads, per user, plus the dealer's state. */
async function figures(userId: string, personId: string): Promise<Figures> {
  const [row] = await database.rows<Figures>(
    `select (select wallet_balance_cents from public.users where id = $1)::text as cash,
            (select coalesce(sum(p.amount_cents - coalesce((select sum(c.cost_cents) from public.position_closes c where c.position_id = p.id), 0)), 0)
               from public.positions p where p.user_id = $1 and p.is_open)::text as basis,
            (select coalesce(sum(c.pnl_cents), 0) from public.position_closes c where c.user_id = $1)::text as realized,
            (select coalesce(sum(case when t.type = 'DEPOSIT' then t.amount_cents when t.type = 'WITHDRAWAL' then -t.amount_cents else 0 end), 0)
               from public.transactions t where t.user_id = $1)::text as credit,
            (select coalesce(sum(p.open_units), 0) from public.positions p where p.user_id = $1 and p.is_open)::text as open_units,
            (select coalesce(sum(c.units), 0) from public.position_closes c where c.user_id = $1)::text as closed_units,
            (select coalesce(sum(o.units), 0) from public.trade_orders o where o.user_id = $1)::text as order_units,
            (select premium_cents from public.people where id = $2)::text as premium`,
    [userId, personId],
  );
  return row;
}

describe("the Phase 27 rollback under Phase 29", () => {
  it("refuses on a Phase 29 schema, naming the reason, and changes nothing", async () => {
    const { userId, drake } = await seed();
    // Three whole-share orders through the compatibility path, one of them a
    // partial close, so a lot has been cut, a basis split and the dealer moved.
    await database.rows("select public.place_order($1::uuid, 'BUY', 4)", [drake]);
    await database.rows("select public.place_order($1::uuid, 'BUY', 2)", [drake]);
    await database.rows("select public.place_order($1::uuid, 'SELL', 3)", [drake]);

    const before = await figures(userId, drake);
    expect(before.open_units).toBe(String(3 * SHARE));
    expect(before.closed_units).toBe(String(3 * SHARE));

    await expect(database.exec(ROLLBACK)).rejects.toThrow(/Phase 29 .* supersedes/i);

    // The refusal is the whole transaction: every figure is exactly as it was,
    // the schema included.
    expect(await figures(userId, drake)).toEqual(before);
    const [columns] = await database.rows<{ premium: string; entry_points: string; entry_score: string; eight_arg: string }>(
      `select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name = 'premium_cents')::text as premium,
              (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'entry_price_points')::text as entry_points,
              (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'entry_score')::text as entry_score,
              (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'place_order' and p.pronargs = 8)::text as eight_arg`,
    );
    expect(columns).toEqual({ premium: "1", entry_points: "1", entry_score: "0", eight_arg: "1" });
  });

  it("refuses before it reaches the fractional-quantity guard", async () => {
    const { userId, drake } = await seed();
    await database.rows("select public.place_order($1::uuid, 'BUY', $2::bigint, null::bigint, null, null::bigint, 'milli')", [drake, 250]);
    const before = await figures(userId, drake);

    await expect(database.exec(ROLLBACK)).rejects.toThrow(/Phase 29/i);

    expect(await figures(userId, drake)).toEqual(before);
    expect(before.open_units).toBe("250");
  });
}, 120_000);
