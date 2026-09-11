import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer, type TestServer } from "@/lib/__tests__/postgres";

/**
 * Concurrent orders on a real, multi-connection Postgres server. The wallet
 * row lock in place_order() is what stops two sessions spending the same
 * balance; this is the test that would fail without it. PGlite cannot run
 * it (one session), so this file boots embedded-postgres.
 */

let server: TestServer;
let userId: string;
let drake: string;

type Result = { ok: true; balance_cents: number; order: Record<string, unknown> } | { ok: false; code: string };

async function place(side: "BUY" | "SELL", units: number): Promise<Result> {
  const client = await server.session(userId);
  try {
    const { rows } = await client.query<{ r: Result }>("select public.place_order($1::uuid, $2, $3::bigint) as r", [drake, side, units]);
    return rows[0].r;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  server = await createTestServer();
  const admin = await server.pool.connect();
  try {
    ({ id: userId } = (await admin.query<{ id: string }>("insert into auth.users (email) values ('race@example.com') returning id")).rows[0]);
    ({ id: drake } = (await admin.query<{ id: string }>("select id from public.people where slug = 'drake'")).rows[0]);
    await admin.query("update public.people set current_score = 50, spread = 0.5 where id = $1", [drake]); // Buy 5050¢
    await admin.query("update public.platform_settings set close_cooldown_seconds = 0 where id");
  } finally {
    admin.release();
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe("concurrent orders on one wallet", () => {
  it("two simultaneous Buys that together exceed the balance: exactly one fills", async () => {
    // 12 × 5050 = 60,600 each; both would be 121,200 against 100,000.
    const [a, b] = await Promise.all([place("BUY", 12), place("BUY", 12)]);
    const fills = [a, b].filter((r) => r.ok);
    const rejections = [a, b].filter((r) => !r.ok);
    expect(fills).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ code: "insufficient_balance" });
    const { rows } = await server.pool.query<{ balance: string; lots: string }>(
      "select (select wallet_balance_cents from public.users where id = $1)::text as balance, (select count(*) from public.positions where user_id = $1)::text as lots",
      [userId],
    );
    expect(rows[0]).toEqual({ balance: "39400", lots: "1" });
  });

  it("ten simultaneous Buys: the balance is spent exactly once, never below zero, nothing lost", async () => {
    // 39,400 left; 3 × 5050 = 15,150 per order: two fit (30,300), the third would need 45,450.
    const results = await Promise.all(Array.from({ length: 10 }, () => place("BUY", 3)));
    const fills = results.filter((r) => r.ok);
    expect(fills).toHaveLength(2);
    expect(results.filter((r) => !r.ok).every((r) => r.code === "insufficient_balance")).toBe(true);
    const { rows } = await server.pool.query<{ balance: string; open_cost: string; ledger: string }>(
      `select (select wallet_balance_cents from public.users where id = $1)::text as balance,
              (select coalesce(sum(open_units * entry_price_cents), 0) from public.positions where user_id = $1 and is_open)::text as open_cost,
              (select coalesce(sum(case when type in ('DEPOSIT', 'REDEMPTION') then amount_cents else -amount_cents end), 0) from public.transactions where user_id = $1)::text as ledger`,
      [userId],
    );
    expect(rows[0].balance).toBe("9100");
    expect(Number(rows[0].balance) + Number(rows[0].open_cost)).toBe(100000);
    expect(rows[0].ledger).toBe(rows[0].balance);
  });

  it("two simultaneous Sells of the whole position: one closes it, the other finds nothing to close", async () => {
    // 18 units held across three lots.
    const [a, b] = await Promise.all([place("SELL", 18), place("SELL", 18)]);
    const fills = [a, b].filter((r) => r.ok);
    expect(fills).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: "exceeds_position" });
    const { rows } = await server.pool.query<{ open: string; closes: string; balance: string }>(
      `select (select coalesce(sum(open_units), 0) from public.positions where user_id = $1 and is_open)::text as open,
              (select coalesce(sum(units), 0) from public.position_closes where user_id = $1)::text as closes,
              (select wallet_balance_cents from public.users where id = $1)::text as balance`,
      [userId],
    );
    // Sold 18 at the Sell quote 4950: 9,100 + 89,100 = 98,200, the round trip costing the spread.
    expect(rows[0]).toEqual({ open: "0", closes: "18", balance: "98200" });
  });
}, 120_000);
