import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

import { STARTING_BALANCE_CENTS, pointsToCents } from "./model";

/**
 * The trading flow's SQL, run against a real Postgres with the migrations
 * applied verbatim. Everything financial lives in place_order(), so this is
 * where correctness is decided: integer cents, server-read quotes, the
 * tolerance band, FIFO closes to the cent, the weighted-average basis, the
 * shorting gate in both states, every risk lever at its boundary, the
 * balance floor, atomicity and rounding. Concurrency (two sessions on one
 * wallet) lives in trading.concurrency.test.ts on a multi-connection server.
 */

let database: TestDatabase;
const people = new Map<string, string>();

interface Rejection {
  ok: false;
  code: string;
  message: string;
  quote: Record<string, unknown> | null;
  [key: string]: unknown;
}
interface Fill {
  ok: true;
  order: Record<string, unknown> & { fills: Array<Record<string, unknown>> };
  balance_cents: number;
  position: Record<string, unknown>;
  quote: Record<string, unknown>;
}
type OrderResult = Rejection | Fill;

async function createUser(email: string): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return row.id;
}

async function balance(userId: string): Promise<number> {
  const [row] = await database.rows<{ b: string }>("select wallet_balance_cents::text as b from public.users where id = $1", [userId]);
  return Number(row.b);
}

/** Brings a wallet to an exact figure through the ledger, so the small-number arithmetic below stays readable at any starting balance. */
async function setBalance(userId: string, target: number): Promise<void> {
  const current = await balance(userId);
  if (current === target) return;
  await database.rows("insert into public.transactions (user_id, type, amount_cents) values ($1, $2, $3)", [userId, current > target ? "WITHDRAWAL" : "DEPOSIT", Math.abs(current - target)]);
  await database.rows("update public.users set wallet_balance_cents = $2, buying_power_cents = $2 where id = $1", [userId, target]);
}

async function setQuote(slug: string, score: number, spread = 0.5): Promise<void> {
  await database.rows("update public.people set current_score = $1, spread = $2 where slug = $3", [score, spread, slug]);
}

async function settings(patch: Record<string, unknown>): Promise<void> {
  const sets = Object.keys(patch)
    .map((key, index) => `${key} = $${index + 1}`)
    .join(", ");
  await database.rows(`update public.platform_settings set ${sets}, updated_at = now() where id`, Object.values(patch));
}

async function order(userId: string, slug: string, side: "BUY" | "SELL", units: number, quoted: number | null = null, surface = "test"): Promise<OrderResult> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: OrderResult }>("select public.place_order($1::uuid, $2, $3::bigint, $4::bigint, $5) as r", [
    people.get(slug),
    side,
    units,
    quoted,
    surface,
  ]);
  return row.r;
}

function fill(result: OrderResult): Fill {
  if (!result.ok) throw new Error(`expected a fill, got ${result.code}: ${result.message}`);
  return result;
}

function rejection(result: OrderResult): Rejection {
  if (result.ok) throw new Error("expected a rejection, got a fill");
  return result;
}

async function openLots(userId: string, slug: string) {
  return database.rows<{ id: string; direction: string; units: string; open_units: string; entry_price_cents: string; opened_at: string }>(
    `select id, direction, units::text, open_units::text, entry_price_cents::text, opened_at::text
       from public.positions where user_id = $1 and person_id = $2 and is_open order by opened_at, id`,
    [userId, people.get(slug)],
  );
}

async function summary(userId: string, slug: string): Promise<Record<string, unknown>> {
  const [row] = await database.rows<{ s: Record<string, unknown> }>("select public.position_summary_for($1::uuid, $2::uuid) as s", [userId, people.get(slug)]);
  return row.s;
}

/** Sum of everything a user has ever put in or taken out, from the ledger. */
async function ledgerNet(userId: string): Promise<number> {
  const [row] = await database.rows<{ n: string }>(
    `select coalesce(sum(case when type in ('DEPOSIT', 'REDEMPTION') then amount_cents else -amount_cents end), 0)::text as n
       from public.transactions where user_id = $1`,
    [userId],
  );
  return Number(row.n);
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  // Inert during these tests unless a case sets it.
  await settings({ close_cooldown_seconds: 0 });
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("money is integer cents", () => {
  it("every monetary and unit column is a bigint; nothing in the schema is floating point", async () => {
    const monetary = await database.rows<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and (column_name like '%cents%' or column_name in ('units', 'open_units', 'opened_units', 'closed_units'))
        order by table_name, column_name`,
    );
    expect(monetary.length).toBeGreaterThan(15);
    for (const column of monetary) {
      expect(`${column.table_name}.${column.column_name}: ${column.data_type}`).toBe(`${column.table_name}.${column.column_name}: bigint`);
    }
    const floating = await database.rows<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'public' and data_type in ('real', 'double precision', 'money')`,
    );
    expect(floating).toEqual([]);
  });

  it("converts points to cents exactly the way the interface does", async () => {
    for (const value of [50.5, 49.5, 0.01, 99.99, 50.005, 12.345, 35]) {
      const [row] = await database.rows<{ c: string }>("select public.points_to_cents($1::numeric)::text as c", [value]);
      expect(Number(row.c)).toBe(pointsToCents(value));
    }
  });

  it("grants the starting balance at signup, through the ledger", async () => {
    const userId = await createUser("starter@example.com");
    expect(await balance(userId)).toBe(STARTING_BALANCE_CENTS);
    expect(await ledgerNet(userId)).toBe(STARTING_BALANCE_CENTS);
    const [row] = await database.rows<{ s: string }>("select public.starting_balance_cents()::text as s");
    expect(Number(row.s)).toBe(STARTING_BALANCE_CENTS);
  });
});

describe("place_order: opening", () => {
  let alice: string;

  beforeAll(async () => {
    alice = await createUser("alice@example.com");
    await setBalance(alice, 100000); // $1,000: the figures below are about the arithmetic, not the wallet's size
    await setQuote("drake", 50, 0.5); // Buy 50.50 → 5050¢, Sell 49.50 → 4950¢
  });

  it("fills at the server-read Buy quote, snapshots it on the lot, and moves every ledger together", async () => {
    const result = fill(await order(alice, "drake", "BUY", 10, 5050, "profile"));
    expect(result.order).toMatchObject({ side: "BUY", units: 10, fill_price_cents: 5050, gross_cents: 50500, opened_units: 10, opened_direction: "HIGH", cost_cents: 50500, closed_units: 0, realized_pnl_cents: 0 });
    expect(result.balance_cents).toBe(100000 - 50500);
    expect(await balance(alice)).toBe(49500);

    const lots = await openLots(alice, "drake");
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ direction: "HIGH", units: "10", open_units: "10", entry_price_cents: "5050" });

    const [ledger] = await database.rows<{ type: string; amount: string; order_id: string }>(
      "select type, amount_cents::text as amount, order_id from public.transactions where user_id = $1 and type = 'ALLOCATION'",
      [alice],
    );
    expect(ledger).toEqual({ type: "ALLOCATION", amount: "50500", order_id: result.order.id });
    const [tape] = await database.rows<{ side: string; amount: string }>("select side, amount_cents::text as amount from public.trade_events where user_id = $1", [alice]);
    expect(tape).toEqual({ side: "BUY", amount: "50500" });
    const [stored] = await database.rows<{ surface: string; quoted: string }>("select surface, quoted_price_cents::text as quoted from public.trade_orders where id = $1", [result.order.id]);
    expect(stored).toEqual({ surface: "profile", quoted: "5050" });
  });

  it("never fills at a stale price: outside the tolerance band it re-quotes instead", async () => {
    // The user saw 50.39; the server's quote is 50.50: 11¢ apart, the band is 10¢.
    const moved = rejection(await order(alice, "drake", "BUY", 1, 5039));
    expect(moved.code).toBe("price_moved");
    expect(moved.fill_price_cents).toBe(5050);
    expect(moved.quote).toMatchObject({ buy_cents: 5050, sell_cents: 4950, tolerance_cents: 10 });
    expect(await balance(alice)).toBe(49500);
    // Exactly at the band it fills, at the SERVER's price, not the displayed one.
    const edge = fill(await order(alice, "drake", "BUY", 1, 5040));
    expect(edge.order.fill_price_cents).toBe(5050);
    expect(await balance(alice)).toBe(49500 - 5050);
  });

  it("refuses to take a balance negative, in the RPC and in the table", async () => {
    // 44,450¢ left; 9 shares at 5050 = 45,450.
    const short = rejection(await order(alice, "drake", "BUY", 9));
    expect(short.code).toBe("insufficient_balance");
    expect(short.max_units).toBe(8);
    expect(short.message).toContain("enough for 8 shares");
    expect(await balance(alice)).toBe(44450);
    await expect(database.rows("update public.users set wallet_balance_cents = -1 where id = $1", [alice])).rejects.toThrow(/users_wallet_balance_nonneg/);
  });

  it("requires a signed-in user and a valid order", async () => {
    await database.actAs(null);
    await expect(database.rows("select public.place_order($1::uuid, 'BUY', 1)", [people.get("drake")])).rejects.toThrow(/Not authenticated/);
    await database.actAs(alice);
    await expect(database.rows("select public.place_order($1::uuid, 'HOLD', 1)", [people.get("drake")])).rejects.toThrow(/BUY or SELL/);
    await expect(database.rows("select public.place_order($1::uuid, 'BUY', 0)", [people.get("drake")])).rejects.toThrow(/positive integer/);
    const unknown = rejection(await order(alice, "nobody", "BUY", 1));
    expect(unknown.code).toBe("unknown_person");
  });
});

describe("place_order: closing, FIFO and P&L to the cent", () => {
  let bob: string;

  beforeAll(async () => {
    bob = await createUser("bob@example.com");
    await setBalance(bob, 100000);
    await setQuote("mrbeast", 40, 0.5);
    fill(await order(bob, "mrbeast", "BUY", 10)); // lot A: 10 @ 4050 = 40,500
    await setQuote("mrbeast", 42, 0.5);
    fill(await order(bob, "mrbeast", "BUY", 10)); // lot B: 10 @ 4250 = 42,500
  });

  it("shows the weighted-average basis while the lots keep their own prices", async () => {
    const position = await summary(bob, "mrbeast");
    // Independent calculation: (10 × 4050 + 10 × 4250) / 20.
    expect(position).toMatchObject({ direction: "HIGH", open_units: 20, cost_cents: 83000, avg_entry_cents: 4150, lots: 2 });
    // Marked at the Sell quote 41.50: value 20 × 4150 = 83,000, so unrealized is exactly zero here.
    expect(position).toMatchObject({ mark_price_cents: 4150, value_cents: 83000, unrealized_pnl_cents: 0, realized_pnl_cents: 0 });
    const lots = await openLots(bob, "mrbeast");
    expect(lots.map((lot) => lot.entry_price_cents)).toEqual(["4050", "4250"]);
  });

  it("Sell exceeding the position is refused with the most it could close", async () => {
    const tooMany = rejection(await order(bob, "mrbeast", "SELL", 21));
    expect(tooMany.code).toBe("exceeds_position");
    expect(tooMany.max_units).toBe(20);
    expect(tooMany.message).toContain("You hold 20 shares of MrBeast");
    expect(await openLots(bob, "mrbeast")).toHaveLength(2);
  });

  it("closes the oldest lot first, then part of the next, with exact FIFO P&L", async () => {
    await setQuote("mrbeast", 45, 0.5); // Sell 44.50 → 4450¢
    const before = await balance(bob);
    const result = fill(await order(bob, "mrbeast", "SELL", 15, 4450));
    // Lot A closes fully: 10 × (4450 − 4050) = 4,000. Lot B closes 5: 5 × (4450 − 4250) = 1,000.
    expect(result.order).toMatchObject({ closed_units: 15, opened_units: 0, realized_pnl_cents: 5000, proceeds_cents: 15 * 4450, fill_price_cents: 4450 });
    expect(result.order.fills.map((f) => [f.units, f.entry_price_cents, f.pnl_cents, f.proceeds_cents])).toEqual([
      [10, 4050, 4000, 44500],
      [5, 4250, 1000, 22250],
    ]);
    expect(await balance(bob)).toBe(before + 15 * 4450);

    const lots = await openLots(bob, "mrbeast");
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ entry_price_cents: "4250", units: "10", open_units: "5" });
    const closes = await database.rows<{ units: string; pnl: string; proceeds: string }>(
      "select units::text, pnl_cents::text as pnl, proceeds_cents::text as proceeds from public.position_closes where user_id = $1 order by closed_at, entry_price_cents",
      [bob],
    );
    expect(closes).toEqual([
      { units: "10", pnl: "4000", proceeds: "44500" },
      { units: "5", pnl: "1000", proceeds: "22250" },
    ]);
    const position = await summary(bob, "mrbeast");
    expect(position).toMatchObject({ open_units: 5, cost_cents: 21250, avg_entry_cents: 4250, realized_pnl_cents: 5000, mark_price_cents: 4450, value_cents: 22250, unrealized_pnl_cents: 1000 });
  });

  it("loses no cents across partial closes: the sum of the parts is the whole", async () => {
    // Close the remaining 5 in three orders and compare with the one-shot arithmetic.
    const before = await balance(bob);
    const parts = [fill(await order(bob, "mrbeast", "SELL", 2)), fill(await order(bob, "mrbeast", "SELL", 2)), fill(await order(bob, "mrbeast", "SELL", 1))];
    const pnl = parts.reduce((sum, part) => sum + Number(part.order.realized_pnl_cents), 0);
    const proceeds = parts.reduce((sum, part) => sum + Number(part.order.proceeds_cents), 0);
    expect(pnl).toBe(5 * (4450 - 4250));
    expect(proceeds).toBe(5 * 4450);
    expect(await balance(bob)).toBe(before + proceeds);
    expect(await openLots(bob, "mrbeast")).toEqual([]);
    // Whole history reconciles: balance = starting balance + every ledger row.
    expect(await balance(bob)).toBe(await ledgerNet(bob));
    expect(await balance(bob)).toBe(100000 - 40500 - 42500 + 20 * 4450);
    const position = await summary(bob, "mrbeast");
    expect(position).toMatchObject({ direction: null, open_units: 0, realized_pnl_cents: 6000 });
  });

  it("with nothing held, Sell says there is nothing to close", async () => {
    const nothing = rejection(await order(bob, "mrbeast", "SELL", 1));
    expect(nothing.code).toBe("exceeds_position");
    expect(nothing.max_units).toBe(0);
    expect(nothing.message).toBe("You hold no shares of MrBeast. There is nothing to close.");
  });
});

describe("the shorting gate, both states", () => {
  let cara: string;

  beforeAll(async () => {
    cara = await createUser("cara@example.com");
    await setQuote("elon-musk", 60, 1.0); // Buy 61.00 → 6100¢, Sell 59.00 → 5900¢
    fill(await order(cara, "elon-musk", "BUY", 5));
  });

  afterAll(async () => {
    await settings({ shorting_enabled: false });
  });

  it("gate down: a Sell may only close", async () => {
    const [state] = await database.rows<{ s: boolean }>("select public.shorting_enabled() as s");
    expect(state.s).toBe(false);
    const over = rejection(await order(cara, "elon-musk", "SELL", 8));
    expect(over.code).toBe("exceeds_position");
    expect(await openLots(cara, "elon-musk")).toHaveLength(1);
  });

  it("gate up: the same Sell closes the HIGH lot and opens LOW with the rest, no code change", async () => {
    await settings({ shorting_enabled: true });
    const flip = fill(await order(cara, "elon-musk", "SELL", 8));
    expect(flip.order).toMatchObject({ closed_units: 5, opened_units: 3, opened_direction: "LOW", fill_price_cents: 5900 });
    // Closing 5 HIGH bought at 6100 and sold at 5900: −1,000.
    expect(flip.order.realized_pnl_cents).toBe(-1000);
    const lots = await openLots(cara, "elon-musk");
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ direction: "LOW", open_units: "3", entry_price_cents: "5900" });
    const position = await summary(cara, "elon-musk");
    // A LOW marks at the Buy quote: cost 3 × 5900 = 17,700, value 3 × 6100 = 18,300, unrealized −600.
    expect(position).toMatchObject({ direction: "LOW", open_units: 3, cost_cents: 17700, mark_price_cents: 6100, unrealized_pnl_cents: -600 });
    const [net] = await database.rows<{ n: string }>("select public.net_position_units($1::uuid, $2::uuid)::text as n", [cara, people.get("elon-musk")]);
    expect(net.n).toBe("-3");
  });

  it("a Buy closes LOW first (at the Buy quote) and then opens HIGH", async () => {
    await setQuote("elon-musk", 58, 1.0); // Buy 59.00 → 5900¢: the LOW closes flat
    const back = fill(await order(cara, "elon-musk", "BUY", 5));
    expect(back.order).toMatchObject({ closed_units: 3, opened_units: 2, opened_direction: "HIGH", realized_pnl_cents: 0 });
    const lots = await openLots(cara, "elon-musk");
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ direction: "HIGH", open_units: "2", entry_price_cents: "5900" });
    expect(await balance(cara)).toBe(await ledgerNet(cara));
  });

  it("gate down again: the table trigger and the RPC both refuse a net short", async () => {
    await settings({ shorting_enabled: false });
    const over = rejection(await order(cara, "elon-musk", "SELL", 3));
    expect(over.code).toBe("exceeds_position");
    expect(over.max_units).toBe(2);
    // Whatever writes the table: a LOW lot larger than the 2 HIGH units held is a net short, and refused.
    await expect(
      database.rows(
        `insert into public.positions (user_id, person_id, direction, amount_cents, entry_score, units, open_units, entry_price_cents)
         values ($1, $2, 'LOW', 17700, 59, 3, 3, 5900)`,
        [cara, people.get("elon-musk")],
      ),
    ).rejects.toThrow(/shorting is disabled/);
    expect(await openLots(cara, "elon-musk")).toHaveLength(1);
  });
});

describe("risk levers reject at their boundaries", () => {
  let dan: string;
  let eve: string;

  beforeAll(async () => {
    dan = await createUser("dan@example.com");
    eve = await createUser("eve@example.com");
    await setQuote("kai-cenat", 40, 0.5); // Buy 40.50 → 4050¢, Sell 39.50 → 3950¢
    fill(await order(dan, "kai-cenat", "BUY", 10));
  });

  afterAll(async () => {
    await settings({ max_units_per_person: 100000, max_open_interest_share: 1.0, max_daily_close_cents: 100000000, close_cooldown_seconds: 0 });
  });

  it("ships permissive: none of the four binds a normal order", async () => {
    const [levers] = await database.rows<Record<string, string>>(
      "select price_tolerance_cents::text as t, max_units_per_person::text as u, max_open_interest_share::text as s, max_daily_close_cents::text as d from public.platform_settings where id",
    );
    expect(levers).toEqual({ t: "10", u: "100000", s: "1.0", d: "100000000" });
  });

  it("max units per user per person", async () => {
    await settings({ max_units_per_person: 12 });
    const over = rejection(await order(dan, "kai-cenat", "BUY", 3));
    expect(over.code).toBe("max_units");
    expect(over).toMatchObject({ limit_units: 12, held_units: 10 });
    fill(await order(dan, "kai-cenat", "BUY", 2));
    await settings({ max_units_per_person: 100000 });
  });

  it("max share of open interest on one person", async () => {
    await settings({ max_open_interest_share: 0.6 });
    // Dan holds all 12 open units. Eve buying 3 takes 3 of 15 (20%): fine.
    fill(await order(eve, "kai-cenat", "BUY", 3));
    // Dan buying 10 more would hold 22 of 25 (88%): refused.
    const over = rejection(await order(dan, "kai-cenat", "BUY", 10));
    expect(over.code).toBe("open_interest");
    expect(over.message).toContain("60%");
    await settings({ max_open_interest_share: 1.0 });
  });

  it("max close value per day", async () => {
    await settings({ max_daily_close_cents: 10000 }); // $100
    const over = rejection(await order(dan, "kai-cenat", "SELL", 3)); // 3 × 3950 = 11,850
    expect(over.code).toBe("daily_limit");
    expect(over).toMatchObject({ closed_today_cents: 0, limit_cents: 10000 });
    fill(await order(dan, "kai-cenat", "SELL", 2)); // 7,900 fits
    const next = rejection(await order(dan, "kai-cenat", "SELL", 1)); // 7,900 + 3,950 > 10,000
    expect(next.code).toBe("daily_limit");
    expect(next.closed_today_cents).toBe(7900);
    await settings({ max_daily_close_cents: 100000000 });
  });

  it("cooldown between opening and closing the same lot", async () => {
    await settings({ close_cooldown_seconds: 60 });
    fill(await order(eve, "kai-cenat", "BUY", 1)); // a fresh lot on top of the 3
    // Eve holds two lots: the older 3 (opened a moment ago too) and the new 1.
    const now = rejection(await order(eve, "kai-cenat", "SELL", 1));
    expect(now.code).toBe("cooldown");
    expect(Number(now.wait_seconds)).toBeGreaterThan(0);
    expect(Number(now.wait_seconds)).toBeLessThanOrEqual(60);
    // Age the older lot past the cooldown: closing 3 touches only it and is allowed…
    await database.rows("update public.positions set opened_at = now() - interval '2 minutes' where user_id = $1 and open_units = 3", [eve]);
    fill(await order(eve, "kai-cenat", "SELL", 3));
    // …but closing the young lot is still refused.
    const young = rejection(await order(eve, "kai-cenat", "SELL", 1));
    expect(young.code).toBe("cooldown");
    await settings({ close_cooldown_seconds: 0 });
    fill(await order(eve, "kai-cenat", "SELL", 1));
  });
});

describe("atomicity and reconciliation", () => {
  let fay: string;

  beforeAll(async () => {
    fay = await createUser("fay@example.com");
    await setQuote("jensen-huang", 70, 0.5); // Buy 70.50 → 7050¢
  });

  it("a failure after the writes begin leaves no partial state", async () => {
    await database.exec(`
      create function public.test_break_tape() returns trigger language plpgsql as $$
      begin raise exception 'tape unavailable'; end $$;
      create trigger test_break_tape before insert on public.trade_events for each row execute function public.test_break_tape();
    `);
    const before = await balance(fay);
    await database.actAs(fay);
    await expect(database.rows("select public.place_order($1::uuid, 'BUY', 3)", [people.get("jensen-huang")])).rejects.toThrow(/tape unavailable/);
    expect(await balance(fay)).toBe(before);
    expect(await openLots(fay, "jensen-huang")).toEqual([]);
    const [counts] = await database.rows<{ orders: string; ledger: string; closes: string }>(
      `select (select count(*) from public.trade_orders where user_id = $1)::text as orders,
              (select count(*) from public.transactions where user_id = $1 and type <> 'DEPOSIT')::text as ledger,
              (select count(*) from public.position_closes where user_id = $1)::text as closes`,
      [fay],
    );
    expect(counts).toEqual({ orders: "0", ledger: "0", closes: "0" });
    await database.exec("drop trigger test_break_tape on public.trade_events; drop function public.test_break_tape();");
    fill(await order(fay, "jensen-huang", "BUY", 3));
  });

  it("the ledger, the lots and the balance always agree", async () => {
    await setQuote("jensen-huang", 72.25, 0.75); // Sell 71.50 → 7150¢
    fill(await order(fay, "jensen-huang", "SELL", 1));
    const [state] = await database.rows<{ balance: string; ledger: string; open_cost: string }>(
      `select (select wallet_balance_cents from public.users where id = $1)::text as balance,
              (select coalesce(sum(case when type in ('DEPOSIT', 'REDEMPTION') then amount_cents else -amount_cents end), 0) from public.transactions where user_id = $1)::text as ledger,
              (select coalesce(sum(open_units * entry_price_cents), 0) from public.positions where user_id = $1 and is_open)::text as open_cost`,
      [fay],
    );
    expect(state.balance).toBe(state.ledger);
    // Starting balance + realized P&L = balance + capital still at work.
    const [pnl] = await database.rows<{ p: string }>("select coalesce(sum(pnl_cents), 0)::text as p from public.position_closes where user_id = $1", [fay]);
    expect(Number(state.balance) + Number(state.open_cost)).toBe(STARTING_BALANCE_CENTS + Number(pnl.p));
    expect(Number(pnl.p)).toBe(7150 - 7050);
  });

  it("reset_paper_balance is service-role only, refuses over open lots, and goes through the ledger", async () => {
    await database.actAs(fay);
    await expect(database.rows("select public.reset_paper_balance($1::uuid)", [fay])).rejects.toThrow(/open lot/);
    fill(await order(fay, "jensen-huang", "SELL", 2));
    const [result] = await database.rows<{ r: Record<string, unknown> }>("select public.reset_paper_balance($1::uuid) as r", [fay]);
    expect(result.r).toMatchObject({ balance_after_cents: STARTING_BALANCE_CENTS });
    expect(await balance(fay)).toBe(STARTING_BALANCE_CENTS);
    expect(await ledgerNet(fay)).toBe(STARTING_BALANCE_CENTS);
    const [grant] = await database.rows<{ ok: boolean }>("select has_function_privilege('authenticated', 'public.reset_paper_balance(uuid)', 'execute') as ok");
    expect(grant.ok).toBe(false);
    const [orders] = await database.rows<{ ok: boolean }>("select has_function_privilege('authenticated', 'public.place_order(uuid, text, bigint, bigint, text)', 'execute') as ok");
    expect(orders.ok).toBe(true);
  });
});
