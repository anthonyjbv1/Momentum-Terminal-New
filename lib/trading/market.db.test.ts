import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

import {
  averageCents,
  buyCostCents,
  capInventoryUnits,
  decayDivisor,
  decayStep,
  largestUnitsWithin,
  marginalCents,
  premiumCents,
  sellProceedsCents,
  walkCents,
  type MarketState,
} from "./market";

/**
 * THE MARKET PRICE (Phase 29), against a real Postgres with the migrations
 * applied verbatim. The properties the phase promised, asserted on stored
 * rows:
 *
 *   deploy invariance   premium 0 everywhere, so every quote is exactly what
 *                       it was
 *   the curve           a buy is the up-walk rounded up, a sell the down-walk
 *                       rounded down, and every stored order and lot satisfies
 *                       its exact CHECK
 *   round trips         against an unchanged book cost exactly the spread —
 *                       the impact paid going in comes back going out — and
 *                       the inventory returns to exactly zero
 *   path independence   many small orders and one large order leave the same
 *                       inventory, and differ in money only by the rounding
 *                       cent each order is allowed
 *   decay               reaches EXACTLY zero, symmetrically, one history row
 *                       per step
 *   reproducibility     the recorded premium_history replays from the orders
 *                       and the parameters, row for row
 *   the guards          order size, premium cap, aggregate exposure, the two
 *                       breakers, minimum hold, and every mode and account
 *                       refusal, each with its own code
 *   dollars mode        the charge is at most the amount and the quantity is
 *                       the largest that fits, on a curved book too
 *   the house book      the three realised categories sum to −pnl per close
 *   the mirror          the SQL and the TypeScript agree over thousands of
 *                       random inputs
 */

let database: TestDatabase;
const people = new Map<string, string>();
const SHARE = 1000;
const DEPTH = 300_000; // public_figure default: 300 shares per point
const PRIVATE_DEPTH = 100_000;

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
type Result = Rejection | Fill;

async function createUser(email: string, balanceCents = 100_000_000): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  await setBalance(row.id, balanceCents);
  return row.id;
}

async function balance(userId: string): Promise<number> {
  const [row] = await database.rows<{ b: string }>("select wallet_balance_cents::text as b from public.users where id = $1", [userId]);
  return Number(row.b);
}

async function setBalance(userId: string, target: number): Promise<void> {
  const current = await balance(userId);
  if (current === target) return;
  await database.rows("insert into public.transactions (user_id, type, amount_cents) values ($1, $2, $3)", [userId, current > target ? "WITHDRAWAL" : "DEPOSIT", Math.abs(current - target)]);
  await database.rows("update public.users set wallet_balance_cents = $2, buying_power_cents = $2 where id = $1", [userId, target]);
}

async function setQuote(slug: string, score: number, spread = 0.5): Promise<void> {
  await database.rows("update public.people set current_score = $1, spread = $2 where slug = $3", [score, spread, slug]);
}

async function tier(tierName: string, patch: Record<string, unknown>): Promise<void> {
  const sets = Object.keys(patch)
    .map((key, index) => `${key} = $${index + 2}`)
    .join(", ");
  await database.rows(`update public.market_tier_settings set ${sets}, updated_at = now() where tier = $1`, [tierName, ...Object.values(patch)]);
}

async function settings(patch: Record<string, unknown>): Promise<void> {
  const sets = Object.keys(patch)
    .map((key, index) => `${key} = $${index + 1}`)
    .join(", ");
  await database.rows(`update public.platform_settings set ${sets}, updated_at = now() where id`, Object.values(patch));
}

async function orderUnits(userId: string, slug: string, side: "BUY" | "SELL", units: number, quoted: number | null = null, fingerprint: string | null = null): Promise<Result> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: Result }>("select public.place_order($1::uuid, $2, $3::bigint, $4::bigint, $5, null::bigint, 'milli', $6) as r", [
    people.get(slug),
    side,
    units,
    quoted,
    "test",
    fingerprint,
  ]);
  return row.r;
}

async function orderSpend(userId: string, slug: string, side: "BUY" | "SELL", spendCents: number, quoted: number | null = null): Promise<Result> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: Result }>("select public.place_order($1::uuid, $2, null::bigint, $3::bigint, $4, $5::bigint, 'milli') as r", [people.get(slug), side, quoted, "test", spendCents]);
  return row.r;
}

function fill(result: Result): Fill {
  if (!result.ok) throw new Error(`expected a fill, got ${result.code}: ${result.message}`);
  return result;
}
function rejection(result: Result): Rejection {
  if (result.ok) throw new Error("expected a rejection, got a fill");
  return result;
}

async function market(slug: string): Promise<{ inventory: number; premium: number; buyCents: number; sellCents: number; marketPrice: string; haltedUntil: string | null }> {
  const [row] = await database.rows<{ inventory: string; premium: string; buy: string; sell: string; market: string; halted: string | null }>(
    `select market_inventory_units::text as inventory, premium_cents::text as premium,
            public.points_to_cents(buy_price)::text as buy, public.points_to_cents(sell_price)::text as sell,
            market_price::text as market, halted_until::text as halted
       from public.people where slug = $1`,
    [slug],
  );
  return { inventory: Number(row.inventory), premium: Number(row.premium), buyCents: Number(row.buy), sellCents: Number(row.sell), marketPrice: row.market, haltedUntil: row.halted };
}

async function setInventory(slug: string, units: number, depth = DEPTH): Promise<void> {
  await database.rows("update public.people set market_inventory_units = $1, premium_cents = public.market_premium_cents($1, $2) where slug = $3", [units, depth, slug]);
}

/** Ages every open lot of a user so the minimum hold no longer binds. */
async function ageLots(userId: string, seconds = 100_000): Promise<void> {
  await database.rows("update public.positions set opened_at = opened_at - make_interval(secs => $2) where user_id = $1 and is_open", [userId, seconds]);
}

async function decay(ticks: number, slug?: string): Promise<void> {
  void slug;
  for (let i = 0; i < ticks; i += 1) {
    await database.rows("select public.apply_market_decay(now(), $1)", [1000 + i]);
  }
}

async function reconcile(userId: string): Promise<{ cash: number; openCost: number; realized: number; credit: number }> {
  const [row] = await database.rows<{ cash: string; open_cost: string; realized: string; credit: string }>(
    `select u.wallet_balance_cents::text as cash,
            coalesce((select sum(l.open_cost_cents) from public.positions l where l.user_id = u.id and l.is_open), 0)::text as open_cost,
            coalesce((select sum(c.pnl_cents) from public.position_closes c where c.user_id = u.id), 0)::text as realized,
            coalesce((select sum(case when t.type = 'DEPOSIT' then t.amount_cents when t.type = 'WITHDRAWAL' then -t.amount_cents else 0 end)
                        from public.transactions t where t.user_id = u.id), 0)::text as credit
       from public.users u where u.id = $1`,
    [userId],
  );
  return { cash: Number(row.cash), openCost: Number(row.open_cost), realized: Number(row.realized), credit: Number(row.credit) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  await settings({ close_cooldown_seconds: 0 });
  // The minimum hold is exercised by its own case; everywhere else it is inert.
  await tier("public_figure", { min_hold_seconds: 0 });
  await tier("private_individual", { min_hold_seconds: 0 });
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("deploy invariance", () => {
  it("starts every person at premium 0, so every quote is exactly score ± spread", async () => {
    const rows = await database.rows<{ slug: string; ok: boolean; premium: string; inventory: string; tier: string; mode: string }>(
      `select slug, market_inventory_units::text as inventory, premium_cents::text as premium, tier, trading_mode as mode,
              (buy_price = current_score + spread and sell_price = current_score - spread and market_price = current_score) as ok
         from public.people order by slug`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(`${row.slug}: ${row.ok} ${row.premium} ${row.inventory}`).toBe(`${row.slug}: true 0 0`);
    }
    // The founder is a private individual, display-only; everyone else a public figure.
    expect(rows.find((row) => row.slug === "anthony-baptiste")).toMatchObject({ tier: "private_individual", mode: "display_only" });
    expect(rows.filter((row) => row.slug !== "anthony-baptiste").every((row) => row.tier === "public_figure" && row.mode === "tradeable")).toBe(true);
  });

  it("ships the parameters the report states, and the two decay divisors", async () => {
    const rows = await database.rows<Record<string, string>>(
      `select tier, depth_units::text, decay_half_life_ticks::text, premium_cap_cents::text, max_order_share_of_depth::text, aggregate_exposure_cap_units::text,
              breaker_premium_cents::text, breaker_window_seconds::text, breaker_halt_seconds::text, breaker_price_cents::text, shorting_allowed::text, alert_on_halt::text
         from public.market_tier_settings order by tier`,
    );
    expect(rows.map((row) => row.tier)).toEqual(["private_individual", "public_figure"]);
    const pub = rows[1];
    const priv = rows[0];
    expect([pub.depth_units, pub.decay_half_life_ticks, pub.premium_cap_cents, pub.max_order_share_of_depth, pub.aggregate_exposure_cap_units]).toEqual(["300000", "480", "800", "0.20", "3000000"]);
    expect([pub.breaker_premium_cents, pub.breaker_window_seconds, pub.breaker_halt_seconds, pub.breaker_price_cents, pub.shorting_allowed, pub.alert_on_halt]).toEqual(["300", "600", "1800", null, "true", "false"]);
    expect([priv.depth_units, priv.decay_half_life_ticks, priv.premium_cap_cents, priv.max_order_share_of_depth, priv.aggregate_exposure_cap_units]).toEqual(["100000", "240", "300", "0.10", "400000"]);
    expect([priv.breaker_premium_cents, priv.breaker_window_seconds, priv.breaker_halt_seconds, priv.breaker_price_cents, priv.shorting_allowed, priv.alert_on_halt]).toEqual(["150", "600", "3600", "500", "false", "true"]);
    // The exposure cap sits above the inventory the premium cap allows (2,400 / 300 shares), so the premium cap binds first.
    expect(Number(pub.aggregate_exposure_cap_units)).toBeGreaterThan(capInventoryUnits(800, 300_000));
    expect(Number(priv.aggregate_exposure_cap_units)).toBeGreaterThan(capInventoryUnits(300, 100_000));
    const [k] = await database.rows<{ pub: string; priv: string }>("select public.market_decay_divisor(480)::text as pub, public.market_decay_divisor(240)::text as priv");
    expect([Number(k.pub), Number(k.priv)]).toEqual([692, 346]);
    expect([decayDivisor(480), decayDivisor(240)]).toEqual([692, 346]);
  });
});

describe("the curve", () => {
  let ann: string;

  beforeAll(async () => {
    ann = await createUser("ann@example.com");
    await setQuote("drake", 50, 0.5); // base Buy 5050, base Sell 4950
  });

  it("charges the up-walk rounded up and records every input its CHECK needs", async () => {
    const result = fill(await orderUnits(ann, "drake", "BUY", 10 * SHARE));
    // ceil(10000·5050/1000 + 10000·10000/(20·300000)) = ceil(50500 + 16.667) = 50517
    expect(result.order).toMatchObject({
      gross_cents: 50517,
      cost_cents: 50517,
      base_price_cents: 5050,
      inventory_before_units: 0,
      inventory_after_units: 10_000,
      premium_before_cents: 0,
      premium_after_cents: 3, // trunc(10000·100/300000)
      depth_units: DEPTH,
      fill_price_cents: 5052, // round(5050 + 100·10000/600000)
      worst_fill_cents: 5054, // ceil(5050 + 100·10000/300000)
    });
    expect(Number(result.order.impact_cents)).toBeCloseTo(16.666666667, 9);
    expect(buyCostCents(10_000, { baseCents: 5050, inventoryUnits: 0, depthUnits: DEPTH })).toBe(50517);

    const state = await market("drake");
    expect(state).toMatchObject({ inventory: 10_000, premium: 3, buyCents: 5053, sellCents: 4953 });
    expect(Number(state.marketPrice)).toBe(50.03);

    const [lot] = await database.rows<{ amount: string; base: string; inv: string; depth: string; premium: string; index: string; entry: string; points: string }>(
      `select amount_cents::text as amount, entry_base_cents::text as base, entry_inventory_units::text as inv, entry_depth_units::text as depth,
              entry_premium_cents::text as premium, entry_index_cents::text as index, entry_price_cents::text as entry, entry_price_points::text as points
         from public.positions where user_id = $1 and is_open`,
      [ann],
    );
    expect(lot).toEqual({ amount: "50517", base: "5050", inv: "0", depth: String(DEPTH), premium: "0", index: "5000", entry: "5052", points: "50.52" });

    const [history] = await database.rows<{ cause: string; before: string; after: string; pb: string; pa: string; score: string }>(
      "select cause, inventory_before_units::text as before, inventory_after_units::text as after, premium_before_cents::text as pb, premium_after_cents::text as pa, score::text as score from public.premium_history where person_id = $1 order by id desc limit 1",
      [people.get("drake")],
    );
    expect(history).toEqual({ cause: "trade", before: "0", after: "10000", pb: "0", pa: "3", score: "50" });
  });

  it("a round trip against an unchanged book costs exactly the spread, and returns the inventory to zero", async () => {
    const sold = fill(await orderUnits(ann, "drake", "SELL", 10 * SHARE));
    // floor(10000·4950/1000 + 10000·(2·10000 − 10000)/(20·300000)) = floor(49500 + 16.667) = 49516
    expect(sold.order).toMatchObject({ gross_cents: 49516, proceeds_cents: 49516, inventory_before_units: 10_000, inventory_after_units: 0, premium_after_cents: 0 });
    expect(sellProceedsCents(10_000, { baseCents: 4950, inventoryUnits: 10_000, depthUnits: DEPTH })).toBe(49516);
    // 50517 − 49516 = 1001: ten shares of the $1.00 spread, plus the one cent the two roundings are allowed.
    expect(Number(sold.order.realized_pnl_cents)).toBe(-1001);
    expect(await market("drake")).toMatchObject({ inventory: 0, premium: 0, buyCents: 5050, sellCents: 4950 });
    const state = await reconcile(ann);
    expect(state.cash + state.openCost - state.realized).toBe(state.credit);
  });

  it("the stored rows satisfy the exact identities, and a wrong gross is refused by the table", async () => {
    const [counts] = await database.rows<{ orders: string; lots: string; bad: string }>(
      `select (select count(*) from public.trade_orders)::text as orders,
              (select count(*) from public.positions)::text as lots,
              (select count(*) from public.trade_orders o
                where o.gross_cents <> public.market_order_gross_cents(o.side, o.units, o.closed_units, o.opened_units, o.base_price_cents, o.inventory_before_units, o.depth_units))::text as bad`,
    );
    expect(Number(counts.orders)).toBeGreaterThan(0);
    expect(counts.bad).toBe("0");
    await expect(database.rows("update public.trade_orders set gross_cents = gross_cents + 1 where id = (select id from public.trade_orders limit 1)")).rejects.toThrow(/trade_orders_gross_is_curve/);
    await expect(database.rows("update public.positions set amount_cents = amount_cents + 1 where id = (select id from public.positions limit 1)")).rejects.toThrow(/positions_amount_is_curve/);
  });

  it("is path independent: ten small buys and one large buy leave the same inventory and differ only by rounding", async () => {
    const bob = await createUser("bob@example.com");
    await setQuote("kendrick-lamar", 60, 0.5);
    let small = 0;
    for (let i = 0; i < 10; i += 1) small += Number(fill(await orderUnits(bob, "kendrick-lamar", "BUY", 3 * SHARE)).order.gross_cents);
    const afterSmall = await market("kendrick-lamar");
    // Reset the book and buy the same thirty shares at once.
    await database.rows("delete from public.positions where user_id = $1", [bob]);
    await setInventory("kendrick-lamar", 0);
    const large = Number(fill(await orderUnits(bob, "kendrick-lamar", "BUY", 30 * SHARE)).order.gross_cents);
    const afterLarge = await market("kendrick-lamar");
    expect(afterLarge.inventory).toBe(afterSmall.inventory);
    expect(afterLarge.premium).toBe(afterSmall.premium);
    // Each order may round up by less than a cent, so ten orders cost at most nine cents more than one.
    expect(small - large).toBeGreaterThanOrEqual(0);
    expect(small - large).toBeLessThan(10);
    await database.rows("delete from public.positions where user_id = $1", [bob]);
    await setInventory("kendrick-lamar", 0);
  });

  it("property: over thousands of random splits, the parts never cost less than the whole and never more than a cent an order", async () => {
    const rows = await database.rows<{ whole: string; parts: string; n: string; direction: string }>(
      `with cases as (
         select g as seed,
                (50 + (g * 7919) % 5000)::bigint            as base,   -- 50¢ .. $50.49
                (((g * 104729) % 4000001) - 2000000)::bigint as inv,   -- −2,000,000 .. 2,000,000 units
                (1 + (g * 15485863) % 600000)::bigint         as units, -- 1 .. 600,000 units
                (2 + (g * 31) % 9)::integer                   as n,     -- 2 .. 10 parts
                case when g % 2 = 0 then 'up' else 'down' end as direction
           from generate_series(1::bigint, 1500::bigint) g
       ),
       parts as (
         select c.seed, c.direction,
                public.market_walk_cents(c.units, c.base, c.inv, ${DEPTH}, c.direction, case when c.direction = 'up' then 'ceil' else 'floor' end) as whole,
                (select sum(public.market_walk_cents(
                          case when p = c.n then c.units - (c.units / c.n) * (c.n - 1) else c.units / c.n end,
                          c.base,
                          c.inv + case when c.direction = 'up' then 1 else -1 end * (c.units / c.n) * (p - 1),
                          ${DEPTH}, c.direction, case when c.direction = 'up' then 'ceil' else 'floor' end))
                   from generate_series(1, c.n) p) as parts,
                c.n
           from cases c
          where c.units >= c.n
       )
       select whole::text, parts::text, n::text, direction from parts`,
    );
    expect(rows.length).toBeGreaterThan(1000);
    for (const row of rows) {
      const diff = Number(row.parts) - Number(row.whole);
      if (row.direction === "up") {
        expect(diff).toBeGreaterThanOrEqual(0);
        expect(diff).toBeLessThan(Number(row.n));
      } else {
        expect(diff).toBeLessThanOrEqual(0);
        expect(diff).toBeGreaterThan(-Number(row.n));
      }
    }
  });
});

describe("the mirror: SQL and TypeScript agree", () => {
  it("over thousands of random walks, marginals, averages, premiums and decay steps", async () => {
    const rows = await database.rows<Record<string, string>>(
      `select g::text as g,
              (1 + (g * 7919) % 9000)::text                    as base,
              (((g * 104729) % 4800001) - 2400000)::text        as inv,
              (1 + (g * 15485863) % 2500000)::text              as units,
              (case when g % 7 = 0 then null else (1000 + (g * 6007) % 900000) end)::text as depth,
              (1 + (g * 13) % 2000)::text                        as k,
              public.market_walk_cents(1 + (g * 15485863) % 2500000, 1 + (g * 7919) % 9000, ((g * 104729) % 4800001) - 2400000,
                                       case when g % 7 = 0 then null else (1000 + (g * 6007) % 900000) end, 'up', 'ceil')::text   as up_ceil,
              public.market_walk_cents(1 + (g * 15485863) % 2500000, 1 + (g * 7919) % 9000, ((g * 104729) % 4800001) - 2400000,
                                       case when g % 7 = 0 then null else (1000 + (g * 6007) % 900000) end, 'down', 'floor')::text as down_floor,
              public.market_marginal_cents(1 + (g * 7919) % 9000, ((g * 104729) % 4800001) - 2400000,
                                       case when g % 7 = 0 then null else (1000 + (g * 6007) % 900000) end, 'ceil')::text          as marginal_ceil,
              public.market_marginal_cents(1 + (g * 7919) % 9000, ((g * 104729) % 4800001) - 2400000,
                                       case when g % 7 = 0 then null else (1000 + (g * 6007) % 900000) end, 'floor')::text         as marginal_floor,
              public.market_average_cents(1 + (g * 15485863) % 2500000, 1 + (g * 7919) % 9000, ((g * 104729) % 4800001) - 2400000,
                                       case when g % 7 = 0 then null else (1000 + (g * 6007) % 900000) end, 'up')::text            as avg_up,
              public.market_average_cents(1 + (g * 15485863) % 2500000, 1 + (g * 7919) % 9000, ((g * 104729) % 4800001) - 2400000,
                                       case when g % 7 = 0 then null else (1000 + (g * 6007) % 900000) end, 'down')::text          as avg_down,
              case when g % 7 = 0 then '0' else public.market_premium_cents(((g * 104729) % 4800001) - 2400000, 1000 + (g * 6007) % 900000)::text end as premium,
              public.market_decay_step(((g * 104729) % 4800001) - 2400000, 1 + (g * 13) % 2000)::text as step,
              public.market_decay_divisor((1 + (g * 13) % 2000)::integer)::text as divisor
         from generate_series(1::bigint, 3000::bigint) g`,
    );
    expect(rows).toHaveLength(3000);
    for (const row of rows) {
      const state: MarketState = { baseCents: Number(row.base), inventoryUnits: Number(row.inv), depthUnits: row.depth === null ? null : Number(row.depth) };
      const units = Number(row.units);
      const label = `case ${row.g}`;
      expect(`${label} up`).toBe(`${label} up`);
      expect(walkCents(units, state, "up", "ceil")).toBe(Number(row.up_ceil));
      expect(walkCents(units, state, "down", "floor")).toBe(Number(row.down_floor));
      expect(marginalCents(state, "ceil")).toBe(Number(row.marginal_ceil));
      expect(marginalCents(state, "floor")).toBe(Number(row.marginal_floor));
      expect(averageCents(units, state, "up")).toBe(Number(row.avg_up));
      expect(averageCents(units, state, "down")).toBe(Number(row.avg_down));
      expect(premiumCents(state.inventoryUnits, state.depthUnits)).toBe(Number(row.premium));
      expect(decayStep(state.inventoryUnits, Number(row.k))).toBe(Number(row.step));
      expect(decayDivisor(Number(row.k))).toBe(Number(row.divisor));
    }
  });
});

describe("decay", () => {
  it("returns a positive and a negative inventory to exactly zero, symmetrically, one history row a step", async () => {
    await setQuote("mrbeast", 70, 0.5);
    await setQuote("kai-cenat", 70, 0.5);
    const start = 250_000;
    await setInventory("mrbeast", start);
    await setInventory("kai-cenat", -start);
    const pathUp: number[] = [];
    const pathDown: number[] = [];
    let ticks = 0;
    while (ticks < 20_000) {
      await database.rows("select public.apply_market_decay(now(), $1)", [ticks + 1]);
      ticks += 1;
      const up = await market("mrbeast");
      const down = await market("kai-cenat");
      pathUp.push(up.inventory);
      pathDown.push(down.inventory);
      expect(String(down.inventory)).toBe(String(-up.inventory));
      expect(String(down.premium)).toBe(String(-up.premium));
      if (up.inventory === 0) break;
    }
    expect(pathUp[pathUp.length - 1]).toBe(0);
    expect(pathDown[pathDown.length - 1]).toBe(0);
    // Every step is the published rule, and the path is strictly monotone.
    let expected = start;
    for (const value of pathUp) {
      expected = decayStep(expected, 692);
      expect(value).toBe(expected);
    }
    for (let i = 1; i < pathUp.length; i += 1) expect(pathUp[i]).toBeLessThan(pathUp[i - 1]);
    // Once at zero the decay writes nothing more.
    await database.rows("select public.apply_market_decay(now(), $1)", [ticks + 1]);
    const [rows] = await database.rows<{ n: string; zero_steps: string }>(
      `select count(*)::text as n,
              count(*) filter (where inventory_before_units = inventory_after_units)::text as zero_steps
         from public.premium_history where person_id = $1 and cause = 'decay'`,
      [people.get("mrbeast")],
    );
    expect(Number(rows.n)).toBe(pathUp.length);
    expect(rows.zero_steps).toBe("0");
    // 250,000 units at half-life 480: about 480 ticks to halve, and roughly K·ln(start/K) + K to reach zero.
    expect(pathUp[479]).toBeLessThanOrEqual(125_000);
    expect(pathUp[479]).toBeGreaterThan(120_000);
  }, 120_000);

  it("writes the house book's decay mark from the holders' units, and the mark returns toward the data while they hold", async () => {
    const cid = await createUser("cid@example.com");
    await setQuote("drake", 50, 0.5);
    await setInventory("drake", 0);
    fill(await orderUnits(cid, "drake", "BUY", 60 * SHARE)); // inventory 60,000 → premium 20 cents
    const before = await market("drake");
    expect(before.premium).toBe(20);
    await database.rows("select public.apply_market_decay(now(), 5000)");
    const after = await market("drake");
    expect(after.inventory).toBe(decayStep(60_000, 692));
    expect(after.premium).toBeLessThanOrEqual(before.premium);
    const marks = await database.rows<{ amount: string; details: Record<string, unknown> }>(
      "select amount_cents::text as amount, details from public.house_ledger where person_id = $1 and category = 'decay_mark' order by id desc limit 1",
      [people.get("drake")],
    );
    if (after.premium !== before.premium) {
      expect(marks).toHaveLength(1);
      // HIGH holders marked at the Sell side: their value fell by the premium's move, the house gained it.
      const expected = -(Math.floor((60_000 * (4950 + after.premium)) / 1000) - Math.floor((60_000 * (4950 + before.premium)) / 1000));
      expect(Number(marks[0].amount)).toBe(expected);
      expect(marks[0].details).toMatchObject({ high_units: 60_000, low_units: 0, premium_before_cents: before.premium, premium_after_cents: after.premium });
    }
    // Clean up: sell out and flatten.
    fill(await orderUnits(cid, "drake", "SELL", 60 * SHARE));
    await setInventory("drake", 0);
  });
});

describe("dollars mode on a curved book", () => {
  it("charges at most the amount, and the quantity is the largest that fits, from a non-zero inventory", async () => {
    const dee = await createUser("dee@example.com");
    await setQuote("elon-musk", 56.14, 0.5); // base Buy 5664
    await setInventory("elon-musk", 90_000); // premium 30 cents: the first unit costs about $56.94
    for (const spend of [100, 101, 999, 1000, 2500, 5694, 5695, 10_000, 123_456]) {
      const state = await market("elon-musk");
      const result = fill(await orderSpend(dee, "elon-musk", "BUY", spend));
      const cost = Number(result.order.cost_cents);
      const units = Number(result.order.units);
      expect(cost).toBeLessThanOrEqual(spend);
      const book: MarketState = { baseCents: 5664, inventoryUnits: state.inventory, depthUnits: DEPTH };
      expect(units).toBe(largestUnitsWithin(spend, book, "up", "ceil"));
      expect(buyCostCents(units + 1, book)).toBeGreaterThan(spend);
      expect(cost).toBe(buyCostCents(units, book));
    }
    await database.rows("delete from public.positions where user_id = $1", [dee]);
    await setInventory("elon-musk", 0);
  });
});

describe("the tolerance band is on the average fill", () => {
  it("fills when the reviewed average is within tolerance and re-quotes with the average when it is not", async () => {
    const eve = await createUser("eve@example.com");
    await setQuote("jensen-huang", 62, 0.5); // base Buy 6250
    await setInventory("jensen-huang", 150_000); // premium 50 cents
    // The average of a 30-share buy from 150,000: 6250 + 100·(300000 + 30000)/600000 = 6305
    const ok = fill(await orderUnits(eve, "jensen-huang", "BUY", 30 * SHARE, 6305));
    expect(ok.order.fill_price_cents).toBe(6305);
    const stale = rejection(await orderUnits(eve, "jensen-huang", "BUY", 30 * SHARE, 6250));
    expect(stale.code).toBe("price_moved");
    // From 180,000 now: 6250 + 100·(360000 + 30000)/600000 = 6315
    expect(stale.fill_price_cents).toBe(6315);
    expect(stale.message).toContain("average of $63.15");
    await database.rows("delete from public.positions where user_id = $1", [eve]);
    await setInventory("jensen-huang", 0);
  });
});

describe("the guards", () => {
  let fay: string;

  beforeAll(async () => {
    fay = await createUser("fay@example.com", 1_000_000_000);
    await setQuote("larry-page", 55, 0.5);
    await setInventory("larry-page", 0);
  });

  it("refuses a single order larger than the tier's share of depth", async () => {
    const over = rejection(await orderUnits(fay, "larry-page", "BUY", 60_001));
    expect(over.code).toBe("order_too_large");
    expect(over.max_units).toBe(60_000);
    expect(over.message).toBe("The largest single order in Larry Page is 60 shares. Size it down or split it up.");
  });

  /** Walks the book in orders of at most one depth (the largest a 1.0 share allows). */
  async function walk(userId: string, slug: string, side: "BUY" | "SELL", units: number, chunk = DEPTH): Promise<void> {
    let left = units;
    while (left > 0) {
      const take = Math.min(chunk, left);
      fill(await orderUnits(userId, slug, side, take));
      left -= take;
    }
  }

  it("refuses past the premium cap in both directions, naming what fits, and the cap is exact", async () => {
    await tier("public_figure", { max_order_share_of_depth: 1.0, breaker_premium_cents: 1_000_000 });
    const capUnits = capInventoryUnits(800, DEPTH); // 2,402,999
    expect(capUnits).toBe(2_402_999);
    const [sql] = await database.rows<{ c: string }>("select public.market_cap_inventory_units(800, 300000)::text as c");
    expect(Number(sql.c)).toBe(capUnits);
    await walk(fay, "larry-page", "BUY", capUnits);
    expect(await market("larry-page")).toMatchObject({ inventory: capUnits, premium: 800 });
    const over = rejection(await orderUnits(fay, "larry-page", "BUY", 1 * SHARE));
    expect(over.code).toBe("premium_cap");
    expect(over.max_units).toBe(0);
    expect(over.message).toContain("more than 8.00 points above the data");
    // Back down through zero to the floor on the other side.
    await walk(fay, "larry-page", "SELL", capUnits);
    expect(await market("larry-page")).toMatchObject({ inventory: 0, premium: 0 });
    await tier("public_figure", { max_order_share_of_depth: 0.2, breaker_premium_cents: 300 });
  });

  it("refuses past the platform's aggregate exposure cap", async () => {
    await tier("public_figure", { aggregate_exposure_cap_units: 5 * SHARE });
    fill(await orderUnits(fay, "larry-page", "BUY", 5 * SHARE));
    const over = rejection(await orderUnits(fay, "larry-page", "BUY", 1 * SHARE));
    expect(over.code).toBe("exposure_cap");
    expect(over.max_units).toBe(0);
    fill(await orderUnits(fay, "larry-page", "SELL", 5 * SHARE));
    await tier("public_figure", { aggregate_exposure_cap_units: 3_000_000 });
    await setInventory("larry-page", 0);
  });

  it("the premium breaker halts the person before the order fills, and the halt refuses every order until it lifts", async () => {
    await setQuote("michael-dell", 52, 0.5);
    await setInventory("michael-dell", 0);
    await tier("public_figure", { max_order_share_of_depth: 1.0 });
    // 3.00 points of premium in ten minutes is the limit: 900,000 units lands exactly on it (allowed), 900,001 crosses.
    await walk(fay, "michael-dell", "BUY", 900_000);
    expect((await market("michael-dell")).premium).toBe(300);
    const tripped = rejection(await orderUnits(fay, "michael-dell", "BUY", 3_000));
    expect(tripped.code).toBe("halted");
    expect(tripped.message).toContain("Trading is halted for 30 minutes");
    const state = await market("michael-dell");
    expect(state.haltedUntil).not.toBeNull();
    expect(state.inventory).toBe(900_000); // the tripping order did not fill
    const again = rejection(await orderUnits(fay, "michael-dell", "SELL", 1_000));
    expect(again.code).toBe("halted");
    expect(again.halted_until).toBeTruthy();
    // A public figure's halt is an event, not an alert.
    const [counts] = await database.rows<{ events: string; alerts: string }>(
      "select (select count(*) from public.surveillance_events where person_id = $1 and detector = 'premium_breaker')::text as events, (select count(*) from public.alerts where person_id = $1)::text as alerts",
      [people.get("michael-dell")],
    );
    expect(counts).toEqual({ events: "1", alerts: "0" });
    await database.rows("update public.people set halted_until = null, halt_reason = null where slug = 'michael-dell'");
    await walk(fay, "michael-dell", "SELL", 900_000);
    await setInventory("michael-dell", 0);
    await tier("public_figure", { max_order_share_of_depth: 0.2 });
  });

  it("a private individual's halt raises an admin alert, and the total-price breaker reads score moves too", async () => {
    // Make Warren Buffett a private individual for this case.
    await database.rows("update public.people set tier = 'private_individual' where slug = 'warren-buffett'");
    await setQuote("warren-buffett", 60, 0.5);
    await setInventory("warren-buffett", 0);
    await tier("private_individual", { max_order_share_of_depth: 1.0 });
    // 1.50 points of premium is the private limit: 151,000 units at depth 100,000 crosses it (1.51).
    fill(await orderUnits(fay, "warren-buffett", "BUY", 100_000));
    const tripped = rejection(await orderUnits(fay, "warren-buffett", "BUY", 51_000));
    expect(tripped.code).toBe("halted");
    expect(tripped.message).toContain("halted for 1 hour");
    const [alert] = await database.rows<{ type: string; severity: string; status: string }>("select type, severity, status from public.alerts where person_id = $1 order by created_at desc limit 1", [people.get("warren-buffett")]);
    expect(alert).toEqual({ type: "premium_breaker", severity: "high", status: "open" });
    await database.rows("update public.people set halted_until = null, halt_reason = null where slug = 'warren-buffett'");

    // The total-price breaker, in the tick: a 6-point score move inside the window on a private individual.
    await database.rows("insert into public.score_history (person_id, score, tick_number, recorded_at) values ($1, 60, 1, now() - interval '5 minutes')", [people.get("warren-buffett")]);
    await database.rows("update public.people set current_score = 66.5 where slug = 'warren-buffett'");
    const [halts] = await database.rows<{ n: string }>("select public.evaluate_price_breakers(now(), 2)::text as n");
    expect(halts.n).toBe("1");
    expect((await market("warren-buffett")).haltedUntil).not.toBeNull();
    const [priceAlert] = await database.rows<{ type: string }>("select type from public.alerts where person_id = $1 order by created_at desc limit 1", [people.get("warren-buffett")]);
    expect(priceAlert.type).toBe("price_breaker");
    // Public figures have no total-price breaker: the same move on one halts nobody.
    await database.rows("insert into public.score_history (person_id, score, tick_number, recorded_at) values ($1, 50, 1, now() - interval '5 minutes')", [people.get("sergey-brin")]);
    await database.rows("update public.people set current_score = 58 where slug = 'sergey-brin'");
    const [none] = await database.rows<{ n: string }>("select public.evaluate_price_breakers(now(), 3)::text as n");
    expect(none.n).toBe("0");

    await database.rows("update public.people set tier = 'public_figure', halted_until = null, halt_reason = null where slug = 'warren-buffett'");
    await database.rows("delete from public.positions where user_id = $1 and person_id = $2", [fay, people.get("warren-buffett")]);
    await setInventory("warren-buffett", 0);
    await tier("private_individual", { max_order_share_of_depth: 0.1 });
  });

  it("the minimum hold extends the cooldown, per tier, and names the wait in words", async () => {
    await tier("public_figure", { min_hold_seconds: 600 });
    await setQuote("adin-ross", 50, 0.5);
    fill(await orderUnits(fay, "adin-ross", "BUY", 2 * SHARE));
    const held = rejection(await orderUnits(fay, "adin-ross", "SELL", 1 * SHARE));
    expect(held.code).toBe("cooldown");
    expect(held.message).toBe("Positions in Adin Ross must be held for 10 minutes. Wait 10 minutes more before closing this one.");
    expect(held.hold_seconds).toBe(600);
    await ageLots(fay);
    fill(await orderUnits(fay, "adin-ross", "SELL", 2 * SHARE));
    await tier("public_figure", { min_hold_seconds: 0 });
    await setInventory("adin-ross", 0);
  });
});

describe("modes and accounts", () => {
  let gus: string;

  beforeAll(async () => {
    gus = await createUser("gus@example.com");
    await setQuote("anthony-baptiste", 60, 0.5);
  });

  it("the display-only founder: new positions refused, an existing one can be closed", async () => {
    const refused = rejection(await orderUnits(gus, "anthony-baptiste", "BUY", 1 * SHARE));
    expect(refused.code).toBe("display_only");
    expect(refused.message).toContain("display-only");
    expect(refused.quote).toMatchObject({ trading_mode: "display_only", tier: "private_individual" });
    // A holding from before the mode was set.
    await database.rows("update public.people set trading_mode = 'tradeable' where slug = 'anthony-baptiste'");
    fill(await orderUnits(gus, "anthony-baptiste", "BUY", 1 * SHARE));
    await database.rows("update public.people set trading_mode = 'display_only' where slug = 'anthony-baptiste'");
    const closed = fill(await orderUnits(gus, "anthony-baptiste", "SELL", 1 * SHARE));
    expect(closed.order.closed_units).toBe(1 * SHARE);
    const nothing = rejection(await orderUnits(gus, "anthony-baptiste", "SELL", 1 * SHARE));
    expect(nothing.code).toBe("exceeds_position");
    await setInventory("anthony-baptiste", 0, PRIVATE_DEPTH);
  });

  it("paused refuses everything; frozen, excluded and identity-required refuse before pricing", async () => {
    await database.rows("update public.people set trading_mode = 'paused' where slug = 'jeff-bezos'");
    expect(rejection(await orderUnits(gus, "jeff-bezos", "BUY", 1 * SHARE)).code).toBe("paused");
    await database.rows("update public.people set trading_mode = 'tradeable' where slug = 'jeff-bezos'");

    await database.rows("update public.users set frozen_at = now(), frozen_reason = 'review' where id = $1", [gus]);
    const frozen = rejection(await orderUnits(gus, "jeff-bezos", "BUY", 1 * SHARE));
    expect(frozen.code).toBe("frozen");
    expect(frozen.quote).toBeNull();
    await database.rows("update public.users set frozen_at = null, frozen_reason = null where id = $1", [gus]);

    await database.rows("insert into public.excluded_parties (user_id, person_id, reason) values ($1, $2, 'subject''s staff')", [gus, people.get("jeff-bezos")]);
    expect(rejection(await orderUnits(gus, "jeff-bezos", "BUY", 1 * SHARE)).code).toBe("excluded");
    // Scoped to one market: another person is still open to the account.
    fill(await orderUnits(gus, "mark-zuckerberg", "BUY", 1 * SHARE));
    await database.rows("update public.excluded_parties set removed_at = now() where user_id = $1", [gus]);
    fill(await orderUnits(gus, "jeff-bezos", "BUY", 1 * SHARE));

    await settings({ require_verified_identity: true });
    expect(rejection(await orderUnits(gus, "jeff-bezos", "BUY", 1 * SHARE)).code).toBe("identity_required");
    await database.rows("update public.users set verified_identity_key = 'idk_test_gus', identity_verified_at = now() where id = $1", [gus]);
    fill(await orderUnits(gus, "jeff-bezos", "BUY", 1 * SHARE));
    await settings({ require_verified_identity: false });
    // One person, one account: a second account cannot carry the same identity key.
    const other = await createUser("gus2@example.com");
    await expect(database.rows("update public.users set verified_identity_key = 'idk_test_gus' where id = $1", [other])).rejects.toThrow(/users_verified_identity_key_uidx/);
  });

  it("shorting is never on for a private individual without an explicit override, even with the platform flag up", async () => {
    await settings({ shorting_enabled: true });
    await database.rows("update public.people set tier = 'private_individual' where slug = 'larry-ellison'");
    await setQuote("larry-ellison", 58, 0.5);
    const refused = rejection(await orderUnits(gus, "larry-ellison", "SELL", 1 * SHARE));
    expect(refused.code).toBe("exceeds_position");
    await database.rows("update public.people set shorting_override = true where slug = 'larry-ellison'");
    const opened = fill(await orderUnits(gus, "larry-ellison", "SELL", 1 * SHARE));
    expect(opened.order.opened_direction).toBe("LOW");
    fill(await orderUnits(gus, "larry-ellison", "BUY", 1 * SHARE));
    await database.rows("update public.people set tier = 'public_figure', shorting_override = null where slug = 'larry-ellison'");
    await settings({ shorting_enabled: false });
    await setInventory("larry-ellison", 0);
  });
});

describe("the house book", () => {
  it("decomposes every close into three categories that sum exactly to −pnl, across score and premium moves", async () => {
    const hal = await createUser("hal@example.com");
    const ivy = await createUser("ivy@example.com");
    await setQuote("patrick-mahomes", 61, 0.5);
    await setInventory("patrick-mahomes", 0);
    fill(await orderUnits(hal, "patrick-mahomes", "BUY", 20 * SHARE));
    fill(await orderUnits(ivy, "patrick-mahomes", "BUY", 45 * SHARE)); // moves the premium under Hal
    await setQuote("patrick-mahomes", 63.4, 0.5); // the index moves
    fill(await orderUnits(hal, "patrick-mahomes", "SELL", 12 * SHARE));
    await setQuote("patrick-mahomes", 60.2, 0.5);
    fill(await orderUnits(hal, "patrick-mahomes", "SELL", 8 * SHARE));
    fill(await orderUnits(ivy, "patrick-mahomes", "SELL", 45 * SHARE));

    const rows = await database.rows<{ close_id: string; pnl: string; house: string; categories: string; score_move: string; premium_change: string }>(
      `select c.id as close_id, c.pnl_cents::text as pnl,
              (select sum(h.amount_cents) from public.house_ledger h where h.close_id = c.id)::text as house,
              (select count(distinct h.category) from public.house_ledger h where h.close_id = c.id)::text as categories,
              (select h.amount_cents from public.house_ledger h where h.close_id = c.id and h.category = 'score_move')::text as score_move,
              (select h.amount_cents from public.house_ledger h where h.close_id = c.id and h.category = 'premium_change')::text as premium_change
         from public.position_closes c where c.person_id = $1 order by c.closed_at, c.id`,
      [people.get("patrick-mahomes")],
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(Number(row.house)).toBe(-Number(row.pnl));
      expect(row.categories).toBe("3");
    }
    // Hal's first close: 12 shares bought at index 6100, sold at index 6340 → the house lost 12 × 2.40 = 28.80 on the move.
    expect(Number(rows[0].score_move)).toBe(-Math.round((12_000 * (6340 - 6100)) / 1000));
    const [totals] = await database.rows<{ pnl: string; house: string }>(
      `select (select coalesce(sum(pnl_cents), 0) from public.position_closes where person_id = $1)::text as pnl,
              (select coalesce(sum(amount_cents), 0) from public.house_ledger where person_id = $1 and category <> 'decay_mark')::text as house`,
      [people.get("patrick-mahomes")],
    );
    expect(Number(totals.house)).toBe(-Number(totals.pnl));
    await setInventory("patrick-mahomes", 0);
  });
});

describe("reproducibility", () => {
  it("replays the recorded premium_history from the orders, the decay steps and the published parameters, row for row", async () => {
    const jan = await createUser("jan@example.com");
    const kim = await createUser("kim@example.com");
    const person = people.get("kendrick-lamar")!;
    await setQuote("kendrick-lamar", 63, 0.5);
    await setInventory("kendrick-lamar", 0);
    await database.rows("delete from public.premium_history where person_id = $1", [person]);
    const script: Array<["BUY" | "SELL", string, number] | ["DECAY", number]> = [
      ["BUY", jan, 7 * SHARE], ["DECAY", 3], ["BUY", kim, 12_345], ["DECAY", 1], ["SELL", jan, 2_500], ["DECAY", 10],
      ["BUY", jan, 30 * SHARE], ["DECAY", 700], ["SELL", kim, 12_345], ["SELL", jan, 34_500], ["DECAY", 5],
    ];
    for (const step of script) {
      if (step[0] === "DECAY") await decay(step[1]);
      else fill(await orderUnits(step[1], "kendrick-lamar", step[0], step[2]));
    }
    const history = await database.rows<{ cause: string; order_id: string | null; before: string; after: string; pb: string; pa: string; depth: string }>(
      "select cause, order_id, inventory_before_units::text as before, inventory_after_units::text as after, premium_before_cents::text as pb, premium_after_cents::text as pa, depth_units::text as depth from public.premium_history where person_id = $1 order by id",
      [person],
    );
    const orders = new Map(
      (await database.rows<{ id: string; side: string; units: string; gross: string; base: string; before: string }>("select id, side, units::text, gross_cents::text as gross, base_price_cents::text as base, inventory_before_units::text as before from public.trade_orders where person_id = $1", [person])).map((row) => [
        row.id,
        row,
      ]),
    );
    expect(history.length).toBe(script.reduce((n, step) => n + (step[0] === "DECAY" ? step[1] : 1), 0));
    let inventory = 0;
    for (const row of history) {
      expect(Number(row.before)).toBe(inventory);
      if (row.cause === "trade") {
        const order = orders.get(row.order_id!)!;
        const signed = order.side === "BUY" ? Number(order.units) : -Number(order.units);
        inventory += signed;
        // And the money of that order is the walk from the recorded state.
        const state: MarketState = { baseCents: Number(order.base), inventoryUnits: Number(order.before), depthUnits: DEPTH };
        expect(Number(order.gross)).toBe(order.side === "BUY" ? buyCostCents(Number(order.units), state) : sellProceedsCents(Number(order.units), state));
      } else {
        expect(row.cause).toBe("decay");
        inventory = decayStep(inventory, decayDivisor(480));
      }
      expect(Number(row.after)).toBe(inventory);
      expect(Number(row.pa)).toBe(premiumCents(inventory, DEPTH));
      expect(Number(row.pb)).toBe(premiumCents(Number(row.before), DEPTH));
      expect(Number(row.depth)).toBe(DEPTH);
    }
    expect(await market("kendrick-lamar")).toMatchObject({ inventory, premium: premiumCents(inventory, DEPTH) });
    // The market series carries score + the premium as it stood.
    await database.rows("insert into public.score_history (person_id, score, tick_number, recorded_at) values ($1, 63, 9001, now())", [person]);
    const [series] = await database.rows<{ score: string; market: string }>("select score::text, market::text from public.person_market_series($1, now() - interval '1 hour', 10) order by bucket_at desc limit 1", [person]);
    expect(Number(series.market)).toBeCloseTo(63 + premiumCents(inventory, DEPTH) / 100, 6);
    await database.rows("delete from public.positions where user_id in ($1, $2)", [jan, kim]);
    await setInventory("kendrick-lamar", 0);
  });
});

describe("the pump", () => {
  it("one account buying hard, holding through the minimum hold and selling out loses money, whatever it does in between", async () => {
    const lou = await createUser("lou@example.com", 1_000_000_000);
    await setQuote("kai-cenat", 60, 0.5);
    await setInventory("kai-cenat", 0);
    await tier("public_figure", { breaker_premium_cents: 1_000_000, min_hold_seconds: 600 });
    const before = await balance(lou);
    // Twelve orders at the largest size the depth allows: 720 shares, the premium to 2.40 points.
    for (let i = 0; i < 12; i += 1) fill(await orderUnits(lou, "kai-cenat", "BUY", 60 * SHARE));
    const peak = await market("kai-cenat");
    expect(peak).toMatchObject({ inventory: 720_000, premium: 240 });
    // Held for the minimum: twenty ticks of decay.
    await decay(20);
    await ageLots(lou, 601);
    const decayed = await market("kai-cenat");
    expect(decayed.inventory).toBeLessThan(peak.inventory);
    // Sold out, at the largest size again.
    let held = 720_000;
    while (held > 0) {
      const take = Math.min(60 * SHARE, held);
      fill(await orderUnits(lou, "kai-cenat", "SELL", take));
      held -= take;
    }
    const after = await balance(lou);
    const loss = before - after;
    // At least the spread on 720 shares ($720) plus the premium the decay took while held.
    expect(loss).toBeGreaterThan(72_000);
    const [pnl] = await database.rows<{ p: string }>("select sum(pnl_cents)::text as p from public.position_closes where user_id = $1", [lou]);
    expect(Number(pnl.p)).toBe(-loss);
    // The book is left short of where it started by the decayed units, below the data.
    const end = await market("kai-cenat");
    expect(end.inventory).toBeLessThan(0);
    expect(end.premium).toBeLessThanOrEqual(0);
    await tier("public_figure", { breaker_premium_cents: 300, min_hold_seconds: 0 });
    await setInventory("kai-cenat", 0);
  }, 60_000);

  it("ten coordinated new accounts trip the clustered-buying and new-account alerts, then the breaker", async () => {
    await setQuote("sergey-brin", 54, 0.5);
    await setInventory("sergey-brin", 0);
    await database.rows("delete from public.alerts where person_id = $1", [people.get("sergey-brin")]);
    const ring = await Promise.all(Array.from({ length: 10 }, (_, i) => createUser(`ring${i}@example.com`, 100_000_000)));
    let halted = false;
    let filled = 0;
    for (let round = 0; round < 3 && !halted; round += 1) {
      for (const member of ring) {
        const result = await orderUnits(member, "sergey-brin", "BUY", 60 * SHARE, null, "fp_shared_ring");
        if (!result.ok) {
          expect(result.code).toBe("halted");
          halted = true;
          break;
        }
        filled += 1;
      }
    }
    expect(halted).toBe(true);
    // 3.00 points is 900,000 units: fifteen orders of 60 shares land on it, the sixteenth trips.
    expect(filled).toBe(15);
    const alerts = await database.rows<{ type: string; severity: string; accounts: number }>(
      "select type, severity, coalesce(array_length(user_ids, 1), 0) as accounts from public.alerts where person_id = $1 order by type",
      [people.get("sergey-brin")],
    );
    const types = alerts.map((alert) => alert.type);
    expect(types).toContain("clustered_buying");
    expect(types).toContain("new_account_burst");
    expect(types).toContain("shared_infrastructure");
    expect(alerts.find((alert) => alert.type === "clustered_buying")!.accounts).toBeGreaterThanOrEqual(4);
    expect(alerts.find((alert) => alert.type === "shared_infrastructure")!.accounts).toBeGreaterThanOrEqual(2);
    // One alert per type per window, refreshed rather than repeated.
    expect(types.filter((type) => type === "clustered_buying")).toHaveLength(1);
    const [events] = await database.rows<{ n: string }>("select count(*)::text as n from public.surveillance_events where person_id = $1", [people.get("sergey-brin")]);
    expect(Number(events.n)).toBeGreaterThan(15);
    // Evidence never carries the fingerprint itself.
    const [evidence] = await database.rows<{ raw: string }>("select evidence::text as raw from public.alerts where person_id = $1 and type = 'shared_infrastructure'", [people.get("sergey-brin")]);
    expect(evidence.raw).not.toContain("fp_shared_ring");
    expect(evidence.raw).toContain("fp_shared_ri"); // the twelve-character prefix
    await database.rows("update public.people set halted_until = null, halt_reason = null where slug = 'sergey-brin'");
    await database.rows("delete from public.positions where user_id = any($1::uuid[])", [ring]);
    await setInventory("sergey-brin", 0);
  }, 60_000);
});

describe("the admin review queue", () => {
  it("refuses non-admins, audit-logs every action, and the log cannot be changed", async () => {
    const admin = await createUser("admin@example.com");
    const mel = await createUser("mel@example.com");
    await database.actAs(mel);
    await expect(database.rows("select public.admin_freeze_account($1::uuid, 'test')", [mel])).rejects.toThrow(/Not an admin/);
    await database.rows("update public.users set is_admin = true where id = $1", [admin]);
    await database.actAs(admin);
    await database.rows("select public.admin_freeze_account($1::uuid, 'suspected ring')", [mel]);
    expect(rejection(await orderUnits(mel, "drake", "BUY", 1 * SHARE)).code).toBe("frozen");
    await database.actAs(admin);
    await database.rows("select public.admin_unfreeze_account($1::uuid, 'cleared')", [mel]);
    await database.rows("select public.admin_halt_person($1::uuid, 900, 'manual review')", [people.get("drake")]);
    expect(rejection(await orderUnits(mel, "drake", "BUY", 1 * SHARE)).code).toBe("halted");
    await database.actAs(admin);
    await database.rows("select public.admin_lift_halt($1::uuid, 'done')", [people.get("drake")]);
    await database.rows("select public.admin_set_trading_mode($1::uuid, 'paused', 'subject request')", [people.get("drake")]);
    expect(rejection(await orderUnits(mel, "drake", "BUY", 1 * SHARE)).code).toBe("paused");
    await database.actAs(admin);
    await database.rows("select public.admin_set_trading_mode($1::uuid, 'tradeable', 'resolved')", [people.get("drake")]);
    const [{ r }] = await database.rows<{ r: { excluded_party_id: string } }>("select public.admin_add_excluded_party($1::uuid, null, 'employee') as r", [mel]);
    expect(rejection(await orderUnits(mel, "drake", "BUY", 1 * SHARE)).code).toBe("excluded");
    await database.actAs(admin);
    await database.rows("select public.admin_remove_excluded_party($1::uuid, 'left the company')", [r.excluded_party_id]);
    fill(await orderUnits(mel, "drake", "BUY", 1 * SHARE));
    await database.actAs(admin);
    const [alert] = await database.rows<{ id: string }>("insert into public.alerts (type, severity) values ('manual', 'low') returning id");
    await expect(database.rows("select public.admin_resolve_alert($1::uuid, 'resolved', '')", [alert.id])).rejects.toThrow(/note is required/);
    await database.rows("select public.admin_resolve_alert($1::uuid, 'resolved', 'looked into it')", [alert.id]);
    const log = await database.rows<{ action: string }>("select action from public.admin_audit_log where actor_id = $1 order by id", [admin]);
    expect(log.map((row) => row.action)).toEqual([
      "freeze_account",
      "unfreeze_account",
      "halt_person",
      "lift_halt",
      "set_trading_mode",
      "set_trading_mode",
      "add_excluded_party",
      "remove_excluded_party",
      "resolve_alert",
    ]);
    await expect(database.rows("update public.admin_audit_log set note = 'x' where actor_id = $1", [admin])).rejects.toThrow(/append-only/);
    await expect(database.rows("delete from public.admin_audit_log where actor_id = $1", [admin])).rejects.toThrow(/append-only/);
    await database.rows("delete from public.positions where user_id = $1", [mel]);
    await setInventory("drake", 0);
  });

  it("keeps the queue, the stream, the house book and the parties away from every client role", async () => {
    const rows = await database.rows<{ t: string; auth: boolean; anon: boolean }>(
      `select t, has_table_privilege('authenticated', 'public.' || t, 'select') as auth, has_table_privilege('anon', 'public.' || t, 'select') as anon
         from unnest(array['alerts', 'surveillance_events', 'admin_audit_log', 'house_ledger', 'excluded_parties']) t`,
    );
    for (const row of rows) expect(`${row.t}: ${row.auth} ${row.anon}`).toBe(`${row.t}: false false`);
    const [fn] = await database.rows<{ decay: boolean; halt: boolean; admin: boolean }>(
      `select has_function_privilege('authenticated', 'public.apply_market_decay(timestamptz, bigint)', 'execute') as decay,
              has_function_privilege('authenticated', 'public.halt_person(uuid, integer, text, timestamptz, text, jsonb, boolean)', 'execute') as halt,
              has_function_privilege('authenticated', 'public.admin_freeze_account(uuid, text, uuid)', 'execute') as admin`,
    );
    expect(fn).toEqual({ decay: false, halt: false, admin: true });
  });
});
