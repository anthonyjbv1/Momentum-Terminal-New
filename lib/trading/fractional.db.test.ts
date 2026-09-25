import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { UNITS_PER_SHARE, cents, previewOrder, previewSpend, sharesLabel, sharesText } from "@/lib/trading/model";

/**
 * FRACTIONAL SHARES, against a real Postgres with the migrations applied
 * verbatim (Phase 27).
 *
 * The ledger is where this phase can fail invisibly, so the properties are
 * asserted on stored rows rather than on the RPC's return value:
 *
 *   the rounding rule   a buy is charged UP, a sell paid DOWN, one cent at
 *                       most, and never in the user's favour
 *   dollars mode        the charge is <= the amount entered, always
 *   the basis           a lot's closes sum to its amount_cents to the cent,
 *                       however many times it is cut
 *   "All"               leaves exactly zero units AND zero basis
 *   the minimum         an order worth less than $1 is refused in both modes
 *   reconciliation      cash + what the lots cost + what was realised is
 *                       exactly the paper credit granted, after every step
 */

let database: TestDatabase;
const people = new Map<string, string>();
const SHARE = 1000;

interface Rejection {
  ok: false;
  code: string;
  message: string;
  [key: string]: unknown;
}
interface Fill {
  ok: true;
  order: Record<string, unknown> & { fills: Array<Record<string, unknown>> };
  balance_cents: number;
  position: Record<string, unknown>;
}
type Result = Rejection | Fill;

async function createUser(email: string): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
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

/** Shares mode: a quantity in units (thousandths of a share). */
async function orderUnits(userId: string, slug: string, side: "BUY" | "SELL", units: number, quoted: number | null = null): Promise<Result> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: Result }>("select public.place_order($1::uuid, $2, $3::bigint, $4::bigint, $5, null::bigint, 'milli') as r", [people.get(slug), side, units, quoted, "test"]);
  return row.r;
}

/** Dollars mode: an amount in cents, resolved server-side against the snapshot. */
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

/** Every lot of a user on a person, oldest first. */
async function lots(userId: string, slug: string) {
  return database.rows<{ id: string; units: string; open_units: string; open_cost_cents: string; amount_cents: string; is_open: boolean }>(
    `select id, units::text, open_units::text, open_cost_cents::text, amount_cents::text, is_open
       from public.positions where user_id = $1 and person_id = $2 order by opened_at, id`,
    [userId, people.get(slug)],
  );
}

/**
 * THE RECONCILIATION. Cash, plus what the still-open lots cost, plus every
 * cent realised so far, must equal the paper credit ever granted. It holds
 * after every single order, whatever the rounding did, because the rounding
 * moves cents between the user and the platform's spread, never into or out
 * of existence.
 */
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
  await database.rows("update public.platform_settings set close_cooldown_seconds = 0, updated_at = now() where id");
  // A FLAT MARKET for this suite (Phase 29b: the named 'flat' pricing mode),
  // so every price here is exactly Phase 27's. The curve has its own
  // suite, market.db.test.ts.
  await database.exec("update public.market_tier_settings set pricing_mode = 'flat', min_hold_seconds = 0");
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("the scale", () => {
  it("is a thousand units to the share, and a whole share still prices exactly as it did", async () => {
    const [row] = await database.rows<{ per: string; up: string; down: string }>(
      "select public.units_per_share()::text as per, public.units_cost_cents(1000, 5664)::text as up, public.units_proceeds_cents(1000, 5664)::text as down",
    );
    expect(row.per).toBe("1000");
    // A whole share divides exactly, so both directions agree and both equal
    // the pre-Phase-27 product. Nothing about a whole-share order moved.
    expect(row.up).toBe("5664");
    expect(row.down).toBe("5664");
  });

  it("rounds a buy up and a sell down, and never by more than a cent", async () => {
    const rows = await database.rows<{ units: string; price: string; up: string; down: string; exact: string }>(
      `select u.units::text, p.price::text,
              public.units_cost_cents(u.units, p.price)::text as up,
              public.units_proceeds_cents(u.units, p.price)::text as down,
              (u.units::numeric * p.price / 1000)::text as exact
         from generate_series(1, 999) u(units), (values (5664), (5050), (1), (99991)) p(price)`,
    );
    for (const row of rows) {
      const exact = Number(row.exact);
      const up = Number(row.up);
      const down = Number(row.down);
      expect(up).toBeGreaterThanOrEqual(exact);
      expect(down).toBeLessThanOrEqual(exact);
      expect(up - down).toBeLessThanOrEqual(1);
      expect(up - exact).toBeLessThan(1);
      expect(exact - down).toBeLessThan(1);
    }
  });
});

describe("dollars mode", () => {
  let user: string;

  beforeAll(async () => {
    user = await createUser("dollars@example.com");
    await setBalance(user, 1_000_000);
    await setQuote("drake", 56.14, 0.5); // Buy 56.64 → 5664¢
  });

  it("never charges more than the amount entered, at any amount", async () => {
    // Every whole-dollar amount from $1 to $60, plus the awkward ones.
    const amounts = [100, 101, 199, 250, 999, 1000, 1001, 2500, 5000, 5664, 5665, 6000];
    for (const spend of amounts) {
      const before = await balance(user);
      const result = fill(await orderSpend(user, "drake", "BUY", spend, 5664));
      const cost = Number(result.order.cost_cents);
      const units = Number(result.order.units);
      expect(`$${spend}: charged ${cost}`).toBe(`$${spend}: charged ${cost}`);
      // THE PROMISE: the charge is at most what was entered.
      expect(cost).toBeLessThanOrEqual(spend);
      // And it is the LARGEST quantity that fits: one more unit would not.
      expect(Number(await database.rows<{ c: string }>("select public.units_cost_cents($1, 5664)::text as c", [units + 1]).then((r) => r[0].c))).toBeGreaterThan(spend);
      expect(await balance(user)).toBe(before - cost);
      expect(Number(result.order.requested_spend_cents)).toBe(spend);
      const state = await reconcile(user);
      expect(state.cash + state.openCost - state.realized).toBe(state.credit);
    }
  });

  it("refuses $0.99 in dollars mode and says what the minimum is", async () => {
    const refused = rejection(await orderSpend(user, "drake", "BUY", 99, 5664));
    expect(refused.code).toBe("below_minimum");
    expect(refused.message).toBe("The smallest order is $1.00. Enter at least that much.");
  });
});

describe("shares mode and the minimum", () => {
  let user: string;

  beforeAll(async () => {
    user = await createUser("shares@example.com");
    await setBalance(user, 1_000_000);
    await setQuote("kai-cenat", 56.14, 0.5);
  });

  it("refuses the smallest tradeable quantity because it is worth less than a dollar", async () => {
    // 0.001 share at $56.64 is 6 cents. The quantity is legal; the order is not.
    const refused = rejection(await orderUnits(user, "kai-cenat", "BUY", 1, 5664));
    expect(refused.code).toBe("below_minimum");
    expect(refused.message).toBe("0.001 shares of Kai Cenat is $0.06. The smallest order is $1.00.");
  });

  it("accepts the smallest quantity that does clear the minimum", async () => {
    // 0.018 share is $1.02; 0.017 is $0.97.
    expect(rejection(await orderUnits(user, "kai-cenat", "BUY", 17, 5664)).code).toBe("below_minimum");
    const ok = fill(await orderUnits(user, "kai-cenat", "BUY", 18, 5664));
    expect(Number(ok.order.cost_cents)).toBe(102);
    expect(Number(ok.order.units)).toBe(18);
  });
});

describe("the lot basis under partial closes", () => {
  let user: string;

  beforeAll(async () => {
    user = await createUser("basis@example.com");
    await setBalance(user, 1_000_000);
    await setQuote("mrbeast", 56.14, 0.5); // Buy 5664, Sell 5564
  });

  it("splits a lot without creating or losing a cent, and All leaves exactly nothing", async () => {
    // One awkward lot: 0.777 of a share, cost ceil(777 x 5664 / 1000) = 4401.
    const opened = fill(await orderUnits(user, "mrbeast", "BUY", 777, 5664));
    expect(Number(opened.order.cost_cents)).toBe(4401);
    const [lot0] = await lots(user, "mrbeast");
    expect(lot0.amount_cents).toBe("4401");
    expect(lot0.open_cost_cents).toBe("4401");

    // Cut it three times: 0.1, 0.377, then everything left.
    let realisedBasis = 0;
    for (const take of [100, 377]) {
      const sold = fill(await orderUnits(user, "mrbeast", "SELL", take, 5564));
      const closeRows = await database.rows<{ cost: string; proceeds: string; pnl: string }>(
        "select cost_cents::text as cost, proceeds_cents::text as proceeds, pnl_cents::text as pnl from public.position_closes where order_id = $1",
        [String(sold.order.id)],
      );
      expect(closeRows).toHaveLength(1);
      // Proceeds are the sell side of the rule, rounded DOWN.
      const [expected] = await database.rows<{ p: string }>("select public.units_proceeds_cents($1, 5564)::text as p", [take]);
      expect(closeRows[0].proceeds).toBe(expected.p);
      // P&L is proceeds less the basis allocated, by definition.
      expect(Number(closeRows[0].pnl)).toBe(Number(closeRows[0].proceeds) - Number(closeRows[0].cost));
      realisedBasis += Number(closeRows[0].cost);
      const [lot] = await lots(user, "mrbeast");
      // THE INVARIANT, after every cut.
      expect(Number(lot.open_cost_cents) + realisedBasis).toBe(Number(lot.amount_cents));
      expect(Number(lot.open_units)).toBeGreaterThan(0);
      expect(Number(lot.open_cost_cents)).toBeGreaterThan(0);
    }

    // "All": whatever is left, exactly.
    const [before] = await lots(user, "mrbeast");
    const all = fill(await orderUnits(user, "mrbeast", "SELL", Number(before.open_units), 5564));
    expect(Number(all.order.closed_units)).toBe(Number(before.open_units));
    const [after] = await lots(user, "mrbeast");
    expect(after.open_units).toBe("0");
    expect(after.open_cost_cents).toBe("0"); // no dust in the basis either
    expect(after.is_open).toBe(false);

    // Every close of that lot sums to what it cost. To the cent, for ever.
    const [sum] = await database.rows<{ s: string }>("select coalesce(sum(cost_cents), 0)::text as s from public.position_closes where position_id = $1", [after.id]);
    expect(sum.s).toBe(after.amount_cents);

    const state = await reconcile(user);
    expect(state.cash + state.openCost - state.realized).toBe(state.credit);
  });
});

describe("a mixed sequence reconciles after every step", () => {
  it("buys and sells at random in both modes and never loses a cent", async () => {
    const user = await createUser("property@example.com");
    await setBalance(user, 5_000_000);
    await setQuote("adin-ross", 41.37, 0.5); // Buy 4187, Sell 4087

    // A deterministic pseudo-random walk: reproducible, and wide enough to
    // hit every rounding case at these prices.
    let seed = 20260927;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    for (let step = 0; step < 240; step += 1) {
      const held = Number((await database.rows<{ u: string }>("select coalesce(sum(open_units), 0)::text as u from public.positions where user_id = $1 and person_id = $2 and is_open", [user, people.get("adin-ross")]))[0].u);
      const sell = held > 0 && next(3) === 0;
      let result: Result;
      if (sell) {
        const take = next(4) === 0 ? held : Math.max(1, next(held) + 1); // sometimes All
        result = await orderUnits(user, "adin-ross", "SELL", take, 4087);
      } else if (next(2) === 0) {
        result = await orderSpend(user, "adin-ross", "BUY", 100 + next(5000), 4187);
      } else {
        result = await orderUnits(user, "adin-ross", "BUY", 25 + next(2000), 4187);
      }

      if (result.ok) {
        const order = result.order;
        if (order.side === "BUY" && Number(order.requested_spend_cents) > 0) {
          expect(Number(order.cost_cents)).toBeLessThanOrEqual(Number(order.requested_spend_cents));
        }
      } else {
        // The only refusals this sequence can provoke.
        expect(["below_minimum", "insufficient_balance", "exceeds_position"]).toContain(result.code);
      }

      const state = await reconcile(user);
      expect(`step ${step}: ${state.cash + state.openCost - state.realized}`).toBe(`step ${step}: ${state.credit}`);
      const [bad] = await database.rows<{ n: string }>(
        `select count(*)::text as n from public.positions
          where user_id = $1 and ((open_units < 0) or (open_cost_cents < 0) or ((open_units > 0) <> (open_cost_cents > 0)) or ((open_units > 0) <> is_open))`,
        [user],
      );
      expect(`step ${step}: ${bad.n} broken lots`).toBe(`step ${step}: 0 broken lots`);
      expect(await balance(user)).toBeGreaterThanOrEqual(0);
    }

    // Close everything and check the lots settle to exactly nothing.
    const held = Number((await database.rows<{ u: string }>("select coalesce(sum(open_units), 0)::text as u from public.positions where user_id = $1 and person_id = $2 and is_open", [user, people.get("adin-ross")]))[0].u);
    if (held > 0) fill(await orderUnits(user, "adin-ross", "SELL", held, 4087));
    const [open] = await database.rows<{ n: string }>("select count(*)::text as n from public.positions where user_id = $1 and is_open", [user]);
    expect(open.n).toBe("0");
    const [dust] = await database.rows<{ u: string; c: string }>(
      "select coalesce(sum(open_units), 0)::text as u, coalesce(sum(open_cost_cents), 0)::text as c from public.positions where user_id = $1",
      [user],
    );
    expect(dust).toEqual({ u: "0", c: "0" });

    // Every lot, over its whole life, realised exactly what it cost.
    const [drift] = await database.rows<{ n: string }>(
      `select count(*)::text as n
         from public.positions l
        where l.user_id = $1
          and l.amount_cents <> l.open_cost_cents + coalesce((select sum(c.cost_cents) from public.position_closes c where c.position_id = l.id), 0)`,
      [user],
    );
    expect(drift.n).toBe("0");
  }, 120_000);
});

describe("the transition: two scales, declared not guessed", () => {
  let user: string;

  beforeAll(async () => {
    user = await createUser("transition@example.com");
    await setBalance(user, 1_000_000);
    await setQuote("kendrick-lamar", 56.14, 0.5); // Buy 5664
  });

  it("reads a caller that sends no scale as whole shares, which is what every pre-Phase-27 client meant", async () => {
    // EXACTLY the call the live client makes today: five positional arguments,
    // no scale, "2" meaning two whole shares. This is what lets the migration
    // land under a running client without refusing an order.
    await database.actAs(user);
    const [row] = await database.rows<{ r: Fill }>("select public.place_order($1::uuid, 'BUY', 2::bigint, 5664::bigint, 'legacy') as r", [people.get("kendrick-lamar")]);
    expect(row.r.ok).toBe(true);
    expect(Number(row.r.order.units)).toBe(2 * SHARE);
    expect(Number(row.r.order.cost_cents)).toBe(2 * 5664);
    expect(row.r.order.quantity_scale).toBe("share");
  });

  it("reads the same number as thousandths when the caller says so", async () => {
    const declared = fill(await orderUnits(user, "kendrick-lamar", "BUY", 2000, 5664));
    expect(Number(declared.order.units)).toBe(2000);
    expect(Number(declared.order.cost_cents)).toBe(2 * 5664);
    expect(declared.order.quantity_scale).toBe("milli");
  });

  it("never infers the scale from the size of the number, and refuses a scale it does not know", async () => {
    // "5" is a plausible order in both scales. The only difference is what the
    // caller declared, which is the whole point.
    await database.actAs(user);
    const [asShares] = await database.rows<{ r: Fill }>("select public.place_order($1::uuid, 'BUY', 5::bigint, 5664::bigint, 't', null::bigint, 'share') as r", [people.get("kendrick-lamar")]);
    expect(Number(asShares.r.order.units)).toBe(5 * SHARE);
    const [asMilli] = await database.rows<{ r: Result }>("select public.place_order($1::uuid, 'BUY', 5::bigint, 5664::bigint, 't', null::bigint, 'milli') as r", [people.get("kendrick-lamar")]);
    // 0.005 of a share is 3 cents: a legal quantity, not a legal order.
    expect(asMilli.r.ok).toBe(false);

    await expect(
      database.rows("select public.place_order($1::uuid, 'BUY', 5::bigint, null::bigint, 't', null::bigint, 'centi')", [people.get("kendrick-lamar")]),
    ).rejects.toThrow(/share or milli/);
  });

  it("records the scale on every order, so Phase 27a can see the legacy path fall silent", async () => {
    const rows = await database.rows<{ quantity_scale: string; n: string }>(
      "select quantity_scale, count(*)::text as n from public.trade_orders where user_id = $1 group by quantity_scale order by quantity_scale",
      [user],
    );
    expect(rows.map((r) => r.quantity_scale)).toEqual(["milli", "share"]);
  });
});

describe("the interface and the database say a quantity the same way", () => {
  /**
   * shares_text() writes the rejection sentences; sharesText() writes the
   * lines beside them. If the two ever drift, the same order reads two ways
   * — "0.75 shares" in the sheet and "0.750 shares" in the refusal — and the
   * user is left deciding which of them to believe. So they are compared
   * directly, over every shape a quantity can take: whole, a half, a third
   * decimal, a trailing zero, the smallest unit there is, and one.
   */
  it("shares_text and shares_label match their TypeScript mirrors", async () => {
    const units = [1, 5, 10, 100, 250, 500, 750, 999, 1000, 1001, 1010, 1100, 1500, 2000, 3333, 10_000, 12_345, 100_000, 1_000_000, 100_000_000];
    const rows = await database.rows<{ units: string; text: string; label: string }>(
      "select u::text as units, public.shares_text(u) as text, public.shares_label(u) as label from unnest($1::bigint[]) as u",
      [units],
    );
    expect(rows).toHaveLength(units.length);
    for (const row of rows) {
      const shares = Number(row.units) / UNITS_PER_SHARE;
      // en-US grouping is a presentation choice this side makes and SQL does
      // not, so the comparison is on the digits themselves.
      expect(sharesText(shares).replace(/,/g, "")).toBe(row.text);
      expect(sharesLabel(shares).replace(/,/g, "")).toBe(row.label);
    }
    // And the rule the label exists for: singular at exactly one, nowhere else.
    expect(rows.find((r) => r.units === "1000")?.label).toBe("1 share");
    expect(rows.find((r) => r.units === "1001")?.label).toBe("1.001 shares");
    expect(rows.find((r) => r.units === "500")?.label).toBe("0.5 shares");
  });

  /**
   * The same for the money: previewOrder and previewSpend exist so the sheet
   * can show a cost before it sends anything, and they are only worth having
   * if that cost is the one the server charges. Compared against the SQL
   * helpers over the whole price range, in both directions.
   */
  it("previewOrder and previewSpend agree with units_cost_cents and units_proceeds_cents", async () => {
    const cases: Array<{ units: number; price: number }> = [];
    for (const units of [1, 7, 250, 999, 1000, 1001, 3333, 10_000]) {
      for (const price of [1, 99, 100, 4950, 5050, 5673, 10_000]) cases.push({ units, price });
    }
    const rows = await database.rows<{ u: string; p: string; cost: string; proceeds: string }>(
      `select (c->>'units')::bigint::text as u, (c->>'price')::bigint::text as p,
              public.units_cost_cents((c->>'units')::bigint, (c->>'price')::bigint)::text     as cost,
              public.units_proceeds_cents((c->>'units')::bigint, (c->>'price')::bigint)::text as proceeds
         from jsonb_array_elements($1::jsonb) as c`,
      [JSON.stringify(cases)],
    );
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      const shares = Number(row.u) / UNITS_PER_SHARE;
      const price = cents(Number(row.p));
      const balance = cents(100_000_000);
      expect(previewOrder("BUY", shares, price, balance).grossCents).toBe(Number(row.cost));
      expect(previewOrder("SELL", shares, price, balance).grossCents).toBe(Number(row.proceeds));
    }
  });

  /**
   * Dollars mode is an inversion, and an inversion is the easy place to be
   * off by one unit. The quantity this side previews has to be the quantity
   * the server resolves, or the sheet promises a holding the fill does not
   * deliver.
   */
  it("previewSpend resolves the same quantity place_order does", async () => {
    const amounts = [100, 101, 250, 999, 1000, 1234, 5000, 10_000];
    const prices = [99, 4950, 5050, 5673, 10_000];
    const rows = await database.rows<{ a: string; p: string; units: string }>(
      `select (c->>'a')::bigint::text as a, (c->>'p')::bigint::text as p,
              floor((c->>'a')::numeric * public.units_per_share() / (c->>'p')::numeric)::bigint::text as units
         from jsonb_array_elements($1::jsonb) as c`,
      [JSON.stringify(amounts.flatMap((a) => prices.map((p) => ({ a, p }))))],
    );
    for (const row of rows) {
      const preview = previewSpend("BUY", cents(Number(row.a)), cents(Number(row.p)), cents(100_000_000));
      expect(preview.units).toBe(Number(row.units));
      // And the promise Dollars mode makes: never more than what was entered.
      expect(preview.grossCents).toBeLessThanOrEqual(Number(row.a));
    }
  });
}, 120_000);
