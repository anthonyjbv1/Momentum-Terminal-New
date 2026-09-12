import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { CLOSE_COOLDOWN_MIN_SECONDS, RISK_LEVER_DEFAULTS, STARTING_BALANCE_CENTS, pointsToCents } from "@/lib/trading/model";

/**
 * The portfolio's SQL against a real Postgres with every migration applied:
 * the Part 0 figures, the paper-credit top-up, the summary reconciling to
 * the cent across several people with partial and full closes, realized
 * P&L read from the 6e close records, the weighted-average basis and the
 * rounding rule, value history recorded at ticks and orders, and the trade
 * history's keyset cursor holding across a page boundary of identical
 * timestamps.
 */

let database: TestDatabase;
const people = new Map<string, string>();
let initialCooldown: number;

interface Fill {
  ok: true;
  order: Record<string, unknown> & { id: string; created_at: string };
  balance_cents: number;
}
interface Rejection {
  ok: false;
  code: string;
}

interface PositionRow {
  person_id: string;
  slug: string;
  display_name: string;
  direction: string;
  open_units: number;
  cost_cents: number;
  avg_entry_cents: number;
  lots: number;
  mark_side: string;
  mark_price_cents: number;
  sell_cents: number;
  buy_cents: number;
  value_cents: number;
  unrealized_pnl_cents: number;
  unrealized_pct: number | null;
  realized_pnl_cents: number;
}

interface Summary {
  cash_cents: number;
  positions_value_cents: number;
  total_value_cents: number;
  open_cost_cents: number;
  unrealized_pnl_cents: number;
  realized_pnl_cents: number;
  paper_credit_cents: number;
  total_return_cents: number;
  total_return_pct: number | null;
  position_count: number;
  orders: number;
  closes: number;
  people_traded: number;
  history_points: number;
  positions: PositionRow[];
}

interface HistoryRow {
  id: string;
  created_at: string;
  side: string;
  units: number;
  fill_price_cents: number;
  cost_cents: number;
  proceeds_cents: number;
  realized_pnl_cents: number;
  person_slug: string;
}

async function createUser(email: string): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return row.id;
}

async function setQuote(slug: string, score: number, spread = 0.5): Promise<void> {
  await database.rows("update public.people set current_score = $1, spread = $2 where slug = $3", [score, spread, slug]);
}

async function order(userId: string, slug: string, side: "BUY" | "SELL", units: number): Promise<Fill> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: Fill | Rejection }>("select public.place_order($1::uuid, $2, $3::bigint, null, 'test') as r", [people.get(slug), side, units]);
  if (!row.r.ok) throw new Error(`expected a fill, got ${row.r.code}`);
  return row.r;
}

/** An Engine tick through the real write path: new scores and spreads, and the snapshot step. */
async function tick(moves: Array<{ slug: string; score: number; spread?: number }>): Promise<{ tick_number: number; portfolio_snapshots: number }> {
  const at = new Date().toISOString();
  const payload = {
    started_at: at,
    finished_at: at,
    mood: 0,
    people: moves.map((move) => ({ id: people.get(move.slug), score: move.score, spread: move.spread ?? 0.5 })),
    events: [],
    signals: [],
  };
  const [row] = await database.rows<{ r: { tick_number: number; portfolio_snapshots: number } }>("select public.apply_engine_tick($1::jsonb) as r", [JSON.stringify(payload)]);
  return row.r;
}

async function summary(userId: string): Promise<Summary> {
  const [row] = await database.rows<{ s: Summary }>("select public.portfolio_summary_for($1::uuid) as s", [userId]);
  return row.s;
}

async function history(userId: string, before: string | null = null, beforeId: string | null = null, limit = 20): Promise<HistoryRow[]> {
  return database.rows<HistoryRow>(
    `select id, created_at::text as created_at, side, units::int as units, fill_price_cents::int as fill_price_cents, cost_cents::int as cost_cents,
            proceeds_cents::int as proceeds_cents, realized_pnl_cents::int as realized_pnl_cents, person_slug
       from public.trade_history_for($1::uuid, $2::timestamptz, $3::uuid, $4::int)`,
    [userId, before, beforeId, limit],
  );
}

/**
 * The reconciliation, computed independently of the summary function: raw
 * rows out of the tables, the point-to-cent conversion done by the
 * TypeScript mirror, the sums done here.
 */
async function independent(userId: string): Promise<{ cash: number; marked: number; cost: number; realized: number; credit: number }> {
  const [wallet] = await database.rows<{ b: string }>("select wallet_balance_cents::text as b from public.users where id = $1", [userId]);
  const lots = await database.rows<{ open_units: string; entry: string; direction: string; sell: string; buy: string }>(
    `select l.open_units::text as open_units, l.entry_price_cents::text as entry, l.direction, p.sell_price::text as sell, p.buy_price::text as buy
       from public.positions l join public.people p on p.id = l.person_id
      where l.user_id = $1 and l.is_open`,
    [userId],
  );
  let marked = 0;
  let cost = 0;
  for (const lot of lots) {
    const mark = lot.direction === "HIGH" ? pointsToCents(Number(lot.sell)) : pointsToCents(Number(lot.buy));
    marked += Number(lot.open_units) * mark;
    cost += Number(lot.open_units) * Number(lot.entry);
  }
  const [closes] = await database.rows<{ p: string }>("select coalesce(sum(pnl_cents), 0)::text as p from public.position_closes where user_id = $1", [userId]);
  const [credit] = await database.rows<{ c: string }>(
    "select coalesce(sum(case when type = 'DEPOSIT' then amount_cents when type = 'WITHDRAWAL' then -amount_cents else 0 end), 0)::text as c from public.transactions where user_id = $1",
    [userId],
  );
  return { cash: Number(wallet.b), marked, cost, realized: Number(closes.p), credit: Number(credit.c) };
}

/** Asserts every identity the page relies on, to the cent. */
async function expectReconciled(userId: string): Promise<Summary> {
  const [s, raw] = await Promise.all([summary(userId), independent(userId)]);
  expect(s.cash_cents).toBe(raw.cash);
  expect(s.positions_value_cents).toBe(raw.marked);
  expect(s.total_value_cents).toBe(raw.cash + raw.marked);
  expect(s.open_cost_cents).toBe(raw.cost);
  expect(s.unrealized_pnl_cents).toBe(raw.marked - raw.cost);
  expect(s.realized_pnl_cents).toBe(raw.realized);
  expect(s.paper_credit_cents).toBe(raw.credit);
  expect(s.total_return_cents).toBe(s.total_value_cents - s.paper_credit_cents);
  // total value = paper credit + realized + unrealized (long-only).
  expect(s.total_value_cents).toBe(raw.credit + raw.realized + (raw.marked - raw.cost));
  // The rows sum to the totals.
  expect(s.positions.reduce((sum, p) => sum + p.value_cents, 0)).toBe(s.positions_value_cents);
  expect(s.positions.reduce((sum, p) => sum + p.unrealized_pnl_cents, 0)).toBe(s.unrealized_pnl_cents);
  for (const p of s.positions) {
    expect(p.value_cents).toBe(p.open_units * p.mark_price_cents);
    expect(p.unrealized_pnl_cents).toBe(p.direction === "HIGH" ? p.value_cents - p.cost_cents : p.cost_cents - p.value_cents);
    expect(p.mark_price_cents).toBe(p.direction === "HIGH" ? p.sell_cents : p.buy_cents);
    expect(p.mark_side).toBe(p.direction === "HIGH" ? "SELL" : "BUY");
  }
  return s;
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  const [row] = await database.rows<{ c: number }>("select close_cooldown_seconds as c from public.platform_settings where id");
  initialCooldown = Number(row.c);
  // The cooldown is inert for these tests: closes follow opens within seconds.
  await database.rows("update public.platform_settings set close_cooldown_seconds = 0, updated_at = now() where id");
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("Part 0: the carried figures", () => {
  it("ships the close cooldown at 60 s, at least one full tick, in the database and in the code", async () => {
    expect(initialCooldown).toBe(60);
    const [column] = await database.rows<{ d: string }>(
      "select column_default as d from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name = 'close_cooldown_seconds'",
    );
    expect(column.d).toBe("60");
    expect(RISK_LEVER_DEFAULTS.closeCooldownSeconds).toBe(60);
    expect(CLOSE_COOLDOWN_MIN_SECONDS).toBe(30);
    expect(RISK_LEVER_DEFAULTS.closeCooldownSeconds).toBeGreaterThanOrEqual(CLOSE_COOLDOWN_MIN_SECONDS);
  });

  it("starts every new account at $10,000, through the ledger", async () => {
    const [row] = await database.rows<{ s: string }>("select public.starting_balance_cents()::text as s");
    expect(Number(row.s)).toBe(1_000_000);
    expect(STARTING_BALANCE_CENTS).toBe(1_000_000);
    const userId = await createUser("fresh@example.com");
    const raw = await independent(userId);
    expect(raw).toEqual({ cash: 1_000_000, marked: 0, cost: 0, realized: 0, credit: 1_000_000 });
  });

  it("tops up an existing account with credit_paper_balance(): a DEPOSIT row and the balance together, service role only", async () => {
    const userId = await createUser("beta@example.com");
    await database.rows("update public.users set wallet_balance_cents = 100000, buying_power_cents = 100000 where id = $1", [userId]);
    const [result] = await database.rows<{ r: Record<string, unknown> }>("select public.credit_paper_balance($1::uuid, 900000) as r", [userId]);
    expect(result.r).toMatchObject({ credited_cents: 900000, balance_before_cents: 100000, balance_after_cents: 1_000_000 });
    const [state] = await database.rows<{ balance: string; power: string; deposits: string }>(
      `select (select wallet_balance_cents from public.users where id = $1)::text as balance,
              (select buying_power_cents from public.users where id = $1)::text as power,
              (select sum(amount_cents) from public.transactions where user_id = $1 and type = 'DEPOSIT')::text as deposits`,
      [userId],
    );
    expect(state).toEqual({ balance: "1000000", power: "1000000", deposits: "1900000" });
    await expect(database.rows("select public.credit_paper_balance($1::uuid, 0)", [userId])).rejects.toThrow(/positive integer/);
    const [grant] = await database.rows<{ ok: boolean }>("select has_function_privilege('authenticated', 'public.credit_paper_balance(uuid, bigint)', 'execute') as ok");
    expect(grant.ok).toBe(false);
  });
});

describe("the summary reconciles to the cent", () => {
  let ana: string;

  beforeAll(async () => {
    ana = await createUser("ana@example.com");
    await setQuote("drake", 50, 0.5); // Buy 50.50 → 5050¢
    await setQuote("mrbeast", 60, 0.5); // Buy 60.50 → 6050¢
  });

  it("starts as cash alone: no positions, no P&L, the credit as the return base", async () => {
    const s = await expectReconciled(ana);
    expect(s).toMatchObject({ cash_cents: 1_000_000, total_value_cents: 1_000_000, position_count: 0, orders: 0, closes: 0, paper_credit_cents: 1_000_000, total_return_cents: 0, total_return_pct: 0, history_points: 0 });
    expect(s.positions).toEqual([]);
  });

  it("marks every open position at the quote it would close at: the Sell quote for a HIGH", async () => {
    await order(ana, "drake", "BUY", 10); // 50,500
    await order(ana, "mrbeast", "BUY", 5); // 30,250
    const s = await expectReconciled(ana);
    expect(s.cash_cents).toBe(1_000_000 - 50500 - 30250);
    // Marked at Sell 49.50 / 59.50 straight away: the spread is the immediate, honest loss.
    expect(s.positions.map((p) => [p.slug, p.open_units, p.mark_side, p.mark_price_cents, p.value_cents, p.unrealized_pnl_cents])).toEqual([
      ["drake", 10, "SELL", 4950, 49500, -1000],
      ["mrbeast", 5, "SELL", 5950, 29750, -500],
    ]);
    expect(s.unrealized_pnl_cents).toBe(-1500);
    expect(s.total_value_cents).toBe(1_000_000 - 1500);
    expect(s).toMatchObject({ position_count: 2, orders: 2, people_traded: 2, history_points: 2 });
  });

  it("follows the ticks: values move with the Sell quotes, cost does not", async () => {
    await tick([
      { slug: "drake", score: 52 }, // Sell 51.50
      { slug: "mrbeast", score: 58 }, // Sell 57.50
    ]);
    const s = await expectReconciled(ana);
    expect(s.positions.map((p) => [p.slug, p.value_cents, p.cost_cents, p.unrealized_pnl_cents, p.unrealized_pct])).toEqual([
      ["drake", 51500, 50500, 1000, 1.98],
      ["mrbeast", 28750, 30250, -1500, -4.96],
    ]);
    expect(s.unrealized_pnl_cents).toBe(-500);
    expect(s.total_value_cents).toBe(1_000_000 - 500);
  });

  it("a partial close realizes FIFO P&L that the summary reads from the close records", async () => {
    const fill = await order(ana, "drake", "SELL", 4); // 4 × (5150 − 5050) = +400
    expect(fill.order).toMatchObject({ closed_units: 4, realized_pnl_cents: 400, proceeds_cents: 4 * 5150 });
    const s = await expectReconciled(ana);
    expect(s.realized_pnl_cents).toBe(400);
    const drake = s.positions.find((p) => p.slug === "drake")!;
    expect(drake).toMatchObject({ open_units: 6, cost_cents: 30300, value_cents: 30900, unrealized_pnl_cents: 600, realized_pnl_cents: 400, lots: 1 });
    // Closing at the mark moves nothing: total value is unchanged by the close itself.
    expect(s.total_value_cents).toBe(1_000_000 - 500);
    expect(s.unrealized_pnl_cents).toBe(600 - 1500);
    expect(s.closes).toBe(1);
  });

  it("a full close leaves the person out of the positions and in realized P&L", async () => {
    const fill = await order(ana, "mrbeast", "SELL", 5); // 5 × (5750 − 6050) = −1,500
    expect(fill.order).toMatchObject({ closed_units: 5, realized_pnl_cents: -1500 });
    const s = await expectReconciled(ana);
    expect(s.positions.map((p) => p.slug)).toEqual(["drake"]);
    expect(s.realized_pnl_cents).toBe(400 - 1500);
    expect(s.unrealized_pnl_cents).toBe(600);
    expect(s.total_value_cents).toBe(1_000_000 - 500);
    expect(s.total_return_cents).toBe(-500);
    expect(s.total_return_pct).toBe(-0.05);
    expect(s).toMatchObject({ position_count: 1, orders: 4, closes: 2, people_traded: 2 });
  });

  it("weighted-average entry is a display figure, rounded half up; the P&L is exact", async () => {
    // One more lot at a different price: 1 @ 5250 on top of 6 @ 5050.
    await tick([{ slug: "drake", score: 52 }]); // Buy 52.50 → 5250
    await order(ana, "drake", "BUY", 1);
    const s = await expectReconciled(ana);
    const drake = s.positions.find((p) => p.slug === "drake")!;
    // cost 6 × 5050 + 1 × 5250 = 35,550 over 7 units = 5,078.57…: shown as 5,079.
    expect(drake).toMatchObject({ open_units: 7, cost_cents: 35550, avg_entry_cents: 5079, lots: 2, mark_price_cents: 5150, value_cents: 36050 });
    // Exact: value − cost = 500. The rounded average would have said (5150 − 5079) × 7 = 497.
    expect(drake.unrealized_pnl_cents).toBe(500);
    expect((5150 - 5079) * 7).toBe(497);
    // And the rule itself: half up.
    const [halves] = await database.rows<{ a: string; b: string }>("select round(15550::numeric / 3)::text as a, round(10101::numeric / 2)::text as b");
    expect(halves).toEqual({ a: "5183", b: "5051" });
  });

  it("orders the positions by value, then name, then id, every time", async () => {
    await order(ana, "mrbeast", "BUY", 3); // 3 × 5850 = 17,550, worth less than the 7 Drake shares
    await order(ana, "kai-cenat", "BUY", 3); // 3 × 5050 = 15,150 at the seeded 50.0
    const first = await expectReconciled(ana);
    const second = await summary(ana);
    expect(first.positions.map((p) => p.slug)).toEqual(["drake", "mrbeast", "kai-cenat"]);
    expect(second.positions.map((p) => p.slug)).toEqual(first.positions.map((p) => p.slug));
    const values = first.positions.map((p) => p.value_cents);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});

describe("value history is recorded, never synthesised", () => {
  let ben: string;
  const expected: number[] = [];

  async function value(userId: string): Promise<number> {
    const raw = await independent(userId);
    return raw.cash + raw.marked;
  }

  async function rows(userId: string) {
    return database.rows<{ total: string; order_id: string | null; tick_number: string | null; recorded_at: string }>(
      "select total_value_cents::text as total, order_id, tick_number::text as tick_number, recorded_at::text as recorded_at from public.portfolio_history where user_id = $1 order by recorded_at, id",
      [userId],
    );
  }

  beforeAll(async () => {
    ben = await createUser("ben@example.com");
    await setQuote("jensen-huang", 70, 0.5);
  });

  it("has no points before the first order: nothing to draw, and the series says so", async () => {
    expect(await rows(ben)).toEqual([]);
    expect(await database.rows("select * from public.portfolio_value_series_for($1::uuid, null, 120)", [ben])).toEqual([]);
    expect((await summary(ben)).history_points).toBe(0);
  });

  it("records one point after each order, at the order's own instant and value", async () => {
    const fill = await order(ben, "jensen-huang", "BUY", 4); // 4 × 7050 = 28,200; marked at 6950 → 27,800
    expected.push(await value(ben));
    const history = await rows(ben);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ order_id: fill.order.id, tick_number: null });
    expect(Number(history[0].total)).toBe(1_000_000 - 4 * 100);
    expect(Number(history[0].total)).toBe(expected[0]);
    const [orderRow] = await database.rows<{ at: string }>("select created_at::text as at from public.trade_orders where id = $1", [fill.order.id]);
    expect(history[0].recorded_at).toBe(orderRow.at);
  });

  it("records one point per tick for every user holding a position, at that tick's quotes", async () => {
    const holders = await database.rows<{ n: string }>("select count(*)::text as n from public.users u where exists (select 1 from public.positions l where l.user_id = u.id and l.is_open)");
    const result = await tick([{ slug: "jensen-huang", score: 73, spread: 1.0 }]); // Sell 72.00 → 7200
    expect(result.portfolio_snapshots).toBe(Number(holders[0].n));
    expected.push(await value(ben));
    const history = await rows(ben);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ order_id: null, tick_number: String(result.tick_number) });
    expect(Number(history[1].total)).toBe(1_000_000 - 28200 + 4 * 7200);
    expect(Number(history[1].total)).toBe(expected[1]);
    // A user holding nothing gets no tick point: their value is flat at their last order.
    const idle = await createUser("idle@example.com");
    await tick([{ slug: "jensen-huang", score: 73, spread: 1.0 }]);
    expect(await rows(idle)).toEqual([]);
    expected.push(await value(ben));
  });

  it("every recorded point equals the independently computed value at that moment", async () => {
    await tick([{ slug: "jensen-huang", score: 71, spread: 0.5 }]);
    expected.push(await value(ben));
    await order(ben, "jensen-huang", "SELL", 4);
    expected.push(await value(ben));
    // Holding nothing now: this tick adds no point for Ben.
    await tick([{ slug: "jensen-huang", score: 75, spread: 0.5 }]);
    const history = await rows(ben);
    expect(history.map((row) => Number(row.total))).toEqual(expected);
    expect(history).toHaveLength(5);
  });

  it("downsamples by time with open and close per slice, honours p_since, and is empty when signed out", async () => {
    const history = await rows(ben);
    const series = await database.rows<{ bucket_at: string; value_cents: string; open_cents: string; samples: number }>(
      "select bucket_at::text as bucket_at, value_cents::text as value_cents, open_cents::text as open_cents, samples from public.portfolio_value_series_for($1::uuid, null, 1000)",
      [ben],
    );
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series.reduce((sum, slice) => sum + Number(slice.samples), 0)).toBe(history.length);
    expect(Number(series[0].open_cents)).toBe(Number(history[0].total));
    expect(Number(series[series.length - 1].value_cents)).toBe(Number(history[history.length - 1].total));
    for (let index = 1; index < series.length; index += 1) expect(series[index].bucket_at > series[index - 1].bucket_at).toBe(true);
    // Since the third point: at most three points survive.
    const since = history[2].recorded_at;
    const later = await database.rows<{ samples: number }>("select samples from public.portfolio_value_series_for($1::uuid, $2::timestamptz, 1000)", [ben, since]);
    expect(later.reduce((sum, slice) => sum + Number(slice.samples), 0)).toBe(history.length - 2);

    await database.actAs(ben);
    const mine = await database.rows<{ samples: number }>("select samples from public.my_portfolio_value_series(null, 1000)");
    expect(mine.reduce((sum, slice) => sum + Number(slice.samples), 0)).toBe(history.length);
    const [portfolio] = await database.rows<{ p: Summary }>("select public.my_portfolio() as p");
    expect(portfolio.p.history_points).toBe(history.length);
    await database.actAs(null);
    expect(await database.rows("select * from public.my_portfolio_value_series(null, 1000)")).toEqual([]);
    const [signedOut] = await database.rows<{ p: Summary | null }>("select public.my_portfolio() as p");
    expect(signedOut.p).toBeNull();
  });
});

describe("trade history", () => {
  let cy: string;
  let dee: string;

  beforeAll(async () => {
    cy = await createUser("cy@example.com");
    dee = await createUser("dee@example.com");
    await setQuote("kendrick-lamar", 40, 0.5); // Buy 4050, Sell 3950
  });

  it("lists every order newest first with the executed price as recorded, the cost of what it opened and the proceeds and P&L of what it closed", async () => {
    const buy = await order(cy, "kendrick-lamar", "BUY", 6);
    await setQuote("kendrick-lamar", 44, 0.5); // Sell 43.50 → 4350
    const sell = await order(cy, "kendrick-lamar", "SELL", 2);
    await order(dee, "kendrick-lamar", "BUY", 1); // someone else's order, never in Cy's history
    const rows = await history(cy);
    expect(rows.map((row) => row.id)).toEqual([sell.order.id, buy.order.id]);
    expect(rows[1]).toMatchObject({ side: "BUY", units: 6, fill_price_cents: 4050, cost_cents: 24300, proceeds_cents: 0, realized_pnl_cents: 0, person_slug: "kendrick-lamar" });
    expect(rows[0]).toMatchObject({ side: "SELL", units: 2, fill_price_cents: 4350, cost_cents: 0, proceeds_cents: 2 * 4350, realized_pnl_cents: 2 * (4350 - 4050) });
    // The quote has moved since; the stored price is the snapshot, not today's.
    await setQuote("kendrick-lamar", 48, 0.5);
    expect((await history(cy))[1].fill_price_cents).toBe(4050);

    await database.actAs(cy);
    const mine = await database.rows<{ id: string }>("select id from public.my_trade_history(null, null, 20)");
    expect(mine.map((row) => row.id)).toEqual([sell.order.id, buy.order.id]);
    await database.actAs(null);
    expect(await database.rows("select id from public.my_trade_history(null, null, 20)")).toEqual([]);
  });

  describe("keyset pagination across identical timestamps", () => {
    const PAGE = 12;

    beforeAll(async () => {
      // Thirty orders inside one transaction share one now(): one instant, thirty rows.
      const personId = people.get("kendrick-lamar");
      const statements = Array.from({ length: 30 }, () => `select public.place_order('${personId}'::uuid, 'BUY', 1, null, 'burst');`).join("\n");
      await database.exec(`begin;\nselect set_config('request.jwt.claim.sub', '${cy}', true);\n${statements}\ncommit;`);
      const [tie] = await database.rows<{ n: string }>(
        "select count(*)::text as n from public.trade_orders where user_id = $1 and created_at = (select max(created_at) from public.trade_orders where user_id = $1)",
        [cy],
      );
      expect(Number(tie.n)).toBe(30);
    });

    async function allPages(): Promise<HistoryRow[][]> {
      const pages: HistoryRow[][] = [];
      let cursor: { before: string; beforeId: string } | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: HistoryRow[] = await history(cy, cursor?.before ?? null, cursor?.beforeId ?? null, PAGE);
        pages.push(page);
        if (page.length < PAGE) break;
        const last = page[page.length - 1];
        cursor = { before: last.created_at, beforeId: last.id };
      }
      return pages;
    }

    it("neither skips nor repeats orders that share a timestamp across a page boundary", async () => {
      const everything = await history(cy, null, null, 100);
      expect(everything).toHaveLength(32);
      const pages = await allPages();
      expect(pages.length).toBe(3);
      // The first boundary falls inside the tie.
      expect(pages[0][PAGE - 1].created_at).toBe(pages[1][0].created_at);
      const paged = pages.flat();
      expect(paged.map((row) => row.id)).toEqual(everything.map((row) => row.id));
      expect(new Set(paged.map((row) => row.id)).size).toBe(everything.length);
    });

    it("orders by (created_at desc, id desc) and returns the same order on every identical query", async () => {
      const runs = await Promise.all([allPages(), allPages(), allPages()]);
      const sequences = runs.map((pages) => pages.flat().map((row) => row.id));
      expect(sequences[1]).toEqual(sequences[0]);
      expect(sequences[2]).toEqual(sequences[0]);
      const rows = runs[0].flat();
      const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
    });

    it("the burst left one value point per order, all at one instant, each at the value after its own order", async () => {
      const points = await database.rows<{ total: string; instants: string }>(
        `select h.total_value_cents::text as total, (select count(distinct h2.recorded_at) from public.portfolio_history h2 where h2.user_id = $1 and h2.order_id = any(select id from public.trade_orders where user_id = $1 and surface = 'burst'))::text as instants
           from public.portfolio_history h
          where h.user_id = $1 and h.order_id in (select id from public.trade_orders where user_id = $1 and surface = 'burst')
          order by h.total_value_cents desc`,
        [cy],
      );
      expect(points).toHaveLength(30);
      expect(points[0].instants).toBe("1");
      // Each Buy of one share at 48.50 is marked at 47.50 straight away, so
      // successive orders leave values one dollar apart; the smallest is the
      // value after the last of them, which is the value now. (Within one
      // instant a uuid is no tiebreaker for insertion order, which is why the
      // set is checked rather than "the last row".)
      const totals = points.map((row) => Number(row.total));
      for (let index = 1; index < totals.length; index += 1) expect(totals[index - 1] - totals[index]).toBe(100);
      const raw = await independent(cy);
      expect(totals[totals.length - 1]).toBe(raw.cash + raw.marked);
    });
  });
});
