import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { toPortfolioSummary } from "@/lib/portfolio/model";

import { bookFromMarket, cents, flatBook, previewMarketOrder, toTradeBook, toTradeQuote, type TradeBook } from "./model";

/**
 * PHASE 29b, against a real Postgres with every migration applied.
 *
 *   depth resolution   every tradeable person resolves to a non-null depth
 *                      from their tier; a NULL override is the tier's value,
 *                      never a flat market; a stored depth cannot be NULL
 *   flat is named      only pricing_mode = 'flat' (tier, or the person's
 *                      override) gives a flat market, and 'curve' on a person
 *                      overrides a flat tier
 *   the portfolio book portfolio_summary_for() carries the book trade_quote()
 *                      gives the profile, so the portfolio's close sheet
 *                      walks the curve and quotes the average fill, and the
 *                      server fills it to the cent
 */

let database: TestDatabase;
const people = new Map<string, string>();
const SHARE = 1000;

interface Result {
  ok: boolean;
  code?: string;
  order?: Record<string, unknown>;
  quote?: Record<string, unknown>;
}

async function createUser(email: string, balanceCents = 100_000_000): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  await database.rows("insert into public.transactions (user_id, type, amount_cents) values ($1, 'DEPOSIT', $2)", [row.id, balanceCents]);
  await database.rows("update public.users set wallet_balance_cents = wallet_balance_cents + $2, buying_power_cents = buying_power_cents + $2 where id = $1", [row.id, balanceCents]);
  return row.id;
}

async function order(userId: string, slug: string, side: "BUY" | "SELL", units: number, quoted: number | null = null): Promise<Result> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: Result }>("select public.place_order($1::uuid, $2, $3::bigint, $4::bigint, 'test', null::bigint, 'milli') as r", [people.get(slug), side, units, quoted]);
  await database.actAs(null);
  return row.r;
}

async function tierPatch(tier: string, patch: Record<string, unknown>): Promise<void> {
  const sets = Object.keys(patch)
    .map((key, index) => `${key} = $${index + 2}`)
    .join(", ");
  await database.rows(`update public.market_tier_settings set ${sets}, updated_at = now() where tier = $1`, [tier, ...Object.values(patch)]);
}

async function personPatch(slug: string, patch: Record<string, unknown>): Promise<void> {
  const sets = Object.keys(patch)
    .map((key, index) => `${key} = $${index + 2}`)
    .join(", ");
  await database.rows(`update public.people set ${sets} where slug = $1`, [slug, ...Object.values(patch)]);
}

async function resolved(slug: string): Promise<{ depth: number | null; mode: string }> {
  const [row] = await database.rows<{ depth: string | null; mode: string }>(
    "select m.depth_units::text as depth, m.pricing_mode as mode from public.people p cross join lateral public.market_params_for(p.id) m where p.slug = $1",
    [slug],
  );
  return { depth: row.depth === null ? null : Number(row.depth), mode: row.mode };
}

async function quote(slug: string): Promise<Record<string, unknown>> {
  const [row] = await database.rows<{ q: Record<string, unknown> }>("select public.trade_quote($1::uuid) as q", [people.get(slug)]);
  return row.q;
}

async function sqlError(sql: string): Promise<string> {
  try {
    await database.exec(sql);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected "${sql}" to be refused`);
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  await database.rows("update public.platform_settings set close_cooldown_seconds = 0, updated_at = now() where id");
  await tierPatch("public_figure", { min_hold_seconds: 0 });
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("depth resolution", () => {
  it("resolves every tradeable person to a non-null depth from their tier, and the quote carries it", async () => {
    const rows = await database.rows<{ slug: string; override: string | null; resolved: string | null; tier_depth: string; mode: string }>(
      `select p.slug, p.depth_units_override::text as override, m.depth_units::text as resolved, t.depth_units::text as tier_depth, m.pricing_mode as mode
         from public.people p
         join public.market_tier_settings t on t.tier = p.tier
        cross join lateral public.market_params_for(p.id) m
        where p.is_active and p.trading_mode = 'tradeable'
        order by p.slug`,
    );
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(`${row.slug}: ${row.override} ${row.mode} ${row.resolved}`).toBe(`${row.slug}: null curve ${row.tier_depth}`);
      expect(row.resolved).not.toBeNull();
      const q = await quote(row.slug);
      expect([q.depth_units, q.pricing_mode]).toEqual([Number(row.tier_depth), "curve"]);
    }
  });

  it("reads a NULL override as the tier's value: the tier's depth moves the person, an override replaces it, and clearing it restores the tier's", async () => {
    await tierPatch("public_figure", { depth_units: 250_000 });
    expect(await resolved("drake")).toEqual({ depth: 250_000, mode: "curve" });
    await personPatch("drake", { depth_units_override: 120_000 });
    expect(await resolved("drake")).toEqual({ depth: 120_000, mode: "curve" });
    await personPatch("drake", { depth_units_override: null });
    expect(await resolved("drake")).toEqual({ depth: 250_000, mode: "curve" });
    await tierPatch("public_figure", { depth_units: 300_000 });
    expect(await resolved("drake")).toEqual({ depth: 300_000, mode: "curve" });
  });

  it("refuses a NULL or non-positive stored depth, and any mode but 'curve' or 'flat'", async () => {
    expect(await sqlError("update public.market_tier_settings set depth_units = null where tier = 'public_figure'")).toMatch(/null value in column "depth_units"/);
    expect(await sqlError("update public.market_tier_settings set depth_units = 0 where tier = 'public_figure'")).toMatch(/market_tier_settings_depth_positive/);
    expect(await sqlError("update public.market_tier_settings set pricing_mode = 'off' where tier = 'public_figure'")).toMatch(/market_tier_settings_pricing_mode/);
    expect(await sqlError("update public.people set pricing_mode_override = 'none' where slug = 'drake'")).toMatch(/people_pricing_mode_override_check/);
    expect(await sqlError("update public.people set depth_units_override = 0 where slug = 'drake'")).toMatch(/people_depth_override_pos/);
    expect(await resolved("drake")).toEqual({ depth: 300_000, mode: "curve" });
  });
});

describe("flat is a named mode", () => {
  it("the tier's 'flat' puts every person of the tier on a flat market that fills at the quote; a person's 'curve' overrides it", async () => {
    await tierPatch("public_figure", { pricing_mode: "flat" });
    expect(await resolved("drake")).toEqual({ depth: null, mode: "flat" });
    expect(await resolved("kai-cenat")).toEqual({ depth: null, mode: "flat" });
    const q = await quote("drake");
    expect([q.depth_units, q.pricing_mode]).toEqual([null, "flat"]);
    // The stored depth is kept for the switch back.
    const [{ depth }] = await database.rows<{ depth: string }>("select depth_units::text as depth from public.market_tier_settings where tier = 'public_figure'");
    expect(depth).toBe("300000");

    const user = await createUser("flat@example.com");
    const buyCents = Number(q.buy_cents);
    const fill = await order(user, "drake", "BUY", 10 * SHARE, buyCents);
    expect(fill.ok).toBe(true);
    expect(fill.order).toMatchObject({ fill_price_cents: buyCents, worst_fill_cents: buyCents, gross_cents: 10 * buyCents, depth_units: null, inventory_after_units: 0, premium_after_cents: 0 });

    await personPatch("kai-cenat", { pricing_mode_override: "curve" });
    expect(await resolved("kai-cenat")).toEqual({ depth: 300_000, mode: "curve" });
    expect(await resolved("drake")).toEqual({ depth: null, mode: "flat" });
    await personPatch("kai-cenat", { pricing_mode_override: null });
    await tierPatch("public_figure", { pricing_mode: "curve" });
    expect(await resolved("drake")).toEqual({ depth: 300_000, mode: "curve" });
  });

  it("a person's 'flat' leaves the rest of the tier on the curve, and the next decay returns their inventory to zero with a reset row", async () => {
    const user = await createUser("reset@example.com");
    const first = await order(user, "kendrick-lamar", "BUY", 30 * SHARE);
    expect(first.ok).toBe(true);
    const [before] = await database.rows<{ inv: string; premium: string }>("select market_inventory_units::text as inv, premium_cents::text as premium from public.people where slug = 'kendrick-lamar'");
    expect([before.inv, before.premium]).toEqual(["30000", "10"]);

    await personPatch("kendrick-lamar", { pricing_mode_override: "flat" });
    expect(await resolved("kendrick-lamar")).toEqual({ depth: null, mode: "flat" });
    expect(await resolved("drake")).toEqual({ depth: 300_000, mode: "curve" });

    await database.rows("select public.apply_market_decay(now(), 7001)");
    const [after] = await database.rows<{ inv: string; premium: string }>("select market_inventory_units::text as inv, premium_cents::text as premium from public.people where slug = 'kendrick-lamar'");
    expect([after.inv, after.premium]).toEqual(["0", "0"]);
    const [reset] = await database.rows<{ cause: string; before: string; after: string; depth: string | null }>(
      "select cause, inventory_before_units::text as before, inventory_after_units::text as after, depth_units::text as depth from public.premium_history where person_id = $1 order by recorded_at desc, id desc limit 1",
      [people.get("kendrick-lamar")],
    );
    expect(reset).toEqual({ cause: "reset", before: "30000", after: "0", depth: null });

    await personPatch("kendrick-lamar", { pricing_mode_override: null });
    expect(await resolved("kendrick-lamar")).toEqual({ depth: 300_000, mode: "curve" });
  });
});

describe("the portfolio's close sheet walks the curve", () => {
  const SLUG = "mrbeast";
  let user: string;

  async function portfolioBook(): Promise<TradeBook> {
    const [row] = await database.rows<{ s: unknown }>("select public.portfolio_summary_for($1::uuid) as s", [user]);
    const summary = toPortfolioSummary(row.s);
    const position = summary?.positions.find((entry) => entry.person.slug === SLUG);
    if (!position) throw new Error("no position");
    return position.book;
  }

  /** The profile's book: the people row the page holds live, with depth and cap from trade_quote(). */
  async function profileBook(): Promise<TradeBook> {
    const [row] = await database.rows<{ score: string; spread: string; premium: string; inventory: string }>(
      "select current_score::text as score, spread::text as spread, premium_cents::text as premium, market_inventory_units::text as inventory from public.people where slug = $1",
      [SLUG],
    );
    const q = await quote(SLUG);
    return bookFromMarket({
      score: Number(row.score),
      spread: Number(row.spread),
      premiumCents: Number(row.premium),
      inventoryUnits: Number(row.inventory),
      depthUnits: q.depth_units === null ? null : Number(q.depth_units),
      premiumCapCents: Number(q.premium_cap_cents),
    });
  }

  beforeAll(async () => {
    await database.rows("update public.people set current_score = 68.4, spread = 0.5 where slug = $1", [SLUG]);
    // Orders up to half the depth, so one close can move the price well past the tolerance.
    await tierPatch("public_figure", { max_order_share_of_depth: 0.5 });
    user = await createUser("closer@example.com");
    for (let i = 0; i < 2; i += 1) expect((await order(user, SLUG, "BUY", 150 * SHARE)).ok).toBe(true);
  });

  it("carries the same book trade_quote() gives the profile", async () => {
    const fromPortfolio = await portfolioBook();
    const fromQuote = toTradeBook(await quote(SLUG));
    expect(fromPortfolio.depthUnits).toBe(300_000);
    expect(fromPortfolio.inventoryUnits).toBe(300 * SHARE);
    expect(fromPortfolio.premiumCents).toBe(100);
    expect(fromPortfolio).toEqual(fromQuote);
    expect(fromPortfolio).toEqual(await profileBook());
    expect(toTradeQuote(await quote(SLUG), people.get(SLUG)!)).toMatchObject(fromPortfolio);
  });

  it("a 60-share sell moves the price 20¢, and the preview's average, worst fill and gross are the server's when the average is quoted", async () => {
    const book = await portfolioBook();
    const preview = previewMarketOrder("SELL", 60, book, cents(0));
    expect(preview.premiumAfterCents - book.premiumCents).toBe(-20);
    expect(book.sellCents - preview.worstCents).toBeGreaterThan(10);
    // The average sits inside the walk, the worst fill at its end.
    expect(preview.priceCents).toBeLessThan(preview.quoteCents);
    expect(preview.worstCents).toBeLessThan(preview.priceCents);

    const result = await order(user, SLUG, "SELL", preview.units, preview.priceCents);
    expect(result.ok).toBe(true);
    expect(result.order).toMatchObject({
      fill_price_cents: preview.priceCents,
      worst_fill_cents: preview.worstCents,
      gross_cents: preview.grossCents,
      premium_after_cents: preview.premiumAfterCents,
      inventory_after_units: 240 * SHARE,
    });
  });

  it("a 150-share sell: the flat quote is refused as price_moved, the curve's average fills", async () => {
    const book = await portfolioBook();
    const curve = previewMarketOrder("SELL", 150, book, cents(0));
    const flat = previewMarketOrder("SELL", 150, flatBook(book.buyCents, book.sellCents, book.premiumCents), cents(0));
    // What the portfolio sheet sent before 29b: the quote itself, 25¢ from the average.
    expect(flat.priceCents).toBe(book.sellCents);
    expect(flat.priceCents - curve.priceCents).toBe(25);

    const refused = await order(user, SLUG, "SELL", curve.units, flat.priceCents);
    expect(refused).toMatchObject({ ok: false, code: "price_moved" });

    const filled = await order(user, SLUG, "SELL", curve.units, curve.priceCents);
    expect(filled.ok).toBe(true);
    expect(filled.order).toMatchObject({ fill_price_cents: curve.priceCents, worst_fill_cents: curve.worstCents, gross_cents: curve.grossCents });
  });
});
