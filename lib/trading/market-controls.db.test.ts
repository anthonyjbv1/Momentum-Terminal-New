import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * MARKET CONTROLS (migration 20261005090000), against a real Postgres with
 * every migration applied verbatim:
 *
 *   halts freeze the premium   apply_market_decay() skips a halted person:
 *                              no decay row, no premium change, no house-book
 *                              entry, across several ticks; decay resumes
 *                              after the halt lifts (and an expired halt does
 *                              not freeze)
 *   logged overrides only      a person's and a tier's market parameters
 *                              change only through the admin functions, which
 *                              write admin_audit_log (actor, reason, before
 *                              and after) in the same transaction; a direct
 *                              write is refused; a refused change leaves no
 *                              audit row
 *   resets                     refused while anyone holds a position on the
 *                              person, from the admin function and from the
 *                              flat-market reset in decay alike; when allowed
 *                              they go through one function, with a 'reset'
 *                              premium row and a 'reset' house-book row
 *   voids                      the columns and the audit row in one
 *                              transaction; a direct write is refused
 */

let database: TestDatabase;
const people = new Map<string, string>();
const SHARE = 1000;
const DEPTH = 300_000;

interface Result {
  ok: boolean;
  code?: string;
  message?: string;
}

async function createUser(email: string, balanceCents = 100_000_000): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  await database.rows("insert into public.transactions (user_id, type, amount_cents) values ($1, 'DEPOSIT', $2)", [row.id, balanceCents]);
  await database.rows("update public.users set wallet_balance_cents = wallet_balance_cents + $2, buying_power_cents = buying_power_cents + $2 where id = $1", [row.id, balanceCents]);
  return row.id;
}

async function createAdmin(email: string): Promise<string> {
  const id = await createUser(email);
  await database.rows("update public.users set is_admin = true where id = $1", [id]);
  return id;
}

async function order(userId: string, slug: string, side: "BUY" | "SELL", units: number): Promise<Result> {
  await database.actAs(userId);
  const [row] = await database.rows<{ r: Result }>("select public.place_order($1::uuid, $2, $3::bigint, null::bigint, 'test', null::bigint, 'milli') as r", [people.get(slug), side, units]);
  await database.actAs(null);
  if (!row.r.ok) throw new Error(`expected a fill on ${slug}, got ${row.r.code}: ${row.r.message}`);
  return row.r;
}

async function market(slug: string): Promise<{ inventory: number; premium: number; haltedUntil: string | null }> {
  const [row] = await database.rows<{ inventory: string; premium: string; halted: string | null }>(
    "select market_inventory_units::text as inventory, premium_cents::text as premium, halted_until::text as halted from public.people where slug = $1",
    [slug],
  );
  return { inventory: Number(row.inventory), premium: Number(row.premium), haltedUntil: row.halted };
}

/** The dealer's state as a decayed remnant would leave it: inventory and its derived premium, no positions behind it. */
async function setInventory(slug: string, units: number): Promise<void> {
  await database.rows("update public.people set market_inventory_units = $1, premium_cents = public.market_premium_cents($1, $2) where slug = $3", [units, DEPTH, slug]);
}

async function decay(fromTick: number, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await database.rows("select public.apply_market_decay(now(), $1)", [fromTick + i]);
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await database.rows<{ n: number }>(`select count(*)::int as n from ${sql}`, params);
  return row.n;
}

async function auditRows(action: string): Promise<Array<{ actor_id: string; target_person_id: string | null; note: string | null; details: Record<string, unknown> }>> {
  return database.rows("select actor_id, target_person_id, note, details from public.admin_audit_log where action = $1 order by id", [action]);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

async function ageLots(userId: string): Promise<void> {
  await database.rows("update public.positions set opened_at = opened_at - interval '2 days' where user_id = $1 and is_open", [userId]);
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  await database.rows("update public.platform_settings set close_cooldown_seconds = 0, updated_at = now() where id");
  // Fixtures, through the door the guards leave open to a deliberate operator transaction.
  await database.operator("update public.market_tier_settings set min_hold_seconds = 0, breaker_premium_cents = 1000000 where tier = 'public_figure'");
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("halts freeze the premium", () => {
  it("skips a halted person across several ticks (no premium change, no decay row, no decay_mark) and resumes when the halt lifts", async () => {
    const admin = await createAdmin("halt-admin@example.com");
    const holder = await createUser("holder@example.com");
    await order(holder, "drake", "BUY", 2 * SHARE);
    await setInventory("drake", 240_000); // premium 80¢: every step moves it, and a holder is marked on it
    const before = await market("drake");
    expect(before.premium).toBe(80);

    await database.actAs(admin);
    await database.rows("select public.admin_halt_person($1::uuid, 3600, 'manual review')", [people.get("drake")]);
    await database.actAs(null);
    expect((await market("drake")).haltedUntil).not.toBeNull();

    const historyBefore = await count("public.premium_history where person_id = $1", [people.get("drake")]);
    const ledgerBefore = await count("public.house_ledger where person_id = $1", [people.get("drake")]);
    await decay(100, 5);
    const during = await market("drake");
    expect([during.inventory, during.premium]).toEqual([before.inventory, before.premium]);
    expect(await count("public.premium_history where person_id = $1", [people.get("drake")])).toBe(historyBefore);
    expect(await count("public.house_ledger where person_id = $1", [people.get("drake")])).toBe(ledgerBefore);
    expect(await count("public.premium_history where tick_number between 100 and 104 and person_id = $1", [people.get("drake")])).toBe(0);

    await database.actAs(admin);
    await database.rows("select public.admin_lift_halt($1::uuid, 'done')", [people.get("drake")]);
    await database.actAs(null);
    await decay(105, 1);
    const after = await market("drake");
    expect(after.inventory).toBeLessThan(before.inventory);
    expect(after.premium).toBeLessThan(before.premium);
    const [step] = await database.rows<{ cause: string; before: string; after: string }>(
      "select cause, inventory_before_units::text as before, inventory_after_units::text as after from public.premium_history where person_id = $1 and tick_number = 105",
      [people.get("drake")],
    );
    // Resumes from where it stood: the step reads the frozen inventory, not a catch-up.
    expect([step.cause, Number(step.before), Number(step.after)]).toEqual(["decay", before.inventory, after.inventory]);
    const marks = await database.rows<{ category: string; tick: string }>("select category, tick_number::text as tick from public.house_ledger where person_id = $1 and tick_number >= 100", [people.get("drake")]);
    expect(marks).toEqual([{ category: "decay_mark", tick: "105" }]);

    await order(holder, "drake", "SELL", 2 * SHARE);
    await setInventory("drake", 0);
  });

  it("does not freeze on a halt that has lapsed", async () => {
    await setInventory("jeff-bezos", 120_000);
    await database.rows("update public.people set halted_until = now() - interval '1 minute', halt_reason = 'over' where slug = 'jeff-bezos'");
    await decay(200, 1);
    expect((await market("jeff-bezos")).inventory).toBeLessThan(120_000);
    await database.rows("update public.people set halted_until = null, halt_reason = null where slug = 'jeff-bezos'");
    await setInventory("jeff-bezos", 0);
  });
});

describe("logged overrides only", () => {
  it("refuses a direct write to a person's or a tier's market parameters, naming the function to use", async () => {
    expect(await refusal(database.rows("update public.people set depth_units_override = 120000 where slug = 'drake'"))).toMatch(/people\.depth_units_override is a market parameter: change it through admin_set_person_market_parameter\(\)/);
    expect(await refusal(database.rows("update public.people set pricing_mode_override = 'flat' where slug = 'drake'"))).toMatch(/pricing_mode_override/);
    expect(await refusal(database.rows("update public.people set tier = 'private_individual' where slug = 'drake'"))).toMatch(/people\.tier/);
    expect(await refusal(database.rows("update public.people set trading_mode = 'paused' where slug = 'drake'"))).toMatch(/trading_mode.*admin_set_trading_mode/);
    expect(await refusal(database.rows("update public.people set shorting_override = true where slug = 'drake'"))).toMatch(/shorting_override/);
    expect(await refusal(database.rows("update public.market_tier_settings set depth_units = 250000 where tier = 'public_figure'"))).toMatch(/market_tier_settings\.public_figure is a market parameter: change it through admin_set_tier_market_parameter\(\)/);
    // The Engine's own writes to the row are untouched.
    await database.rows("update public.people set current_score = 65.5, spread = 0.5 where slug = 'drake'");
    const [row] = await database.rows<{ depth: string | null; mode: string; tier: string }>("select depth_units_override::text as depth, trading_mode as mode, tier from public.people where slug = 'drake'");
    expect([row.depth, row.mode, row.tier]).toEqual([null, "tradeable", "public_figure"]);
  });

  it("changes a person's parameter through the admin function, audit-logged with the before and after, and clears it the same way", async () => {
    const admin = await createAdmin("param-admin@example.com");
    const mel = await createUser("mel@example.com");
    await database.actAs(mel);
    expect(await refusal(database.rows("select public.admin_set_person_market_parameter($1::uuid, 'depth_units_override', '120000'::jsonb, 'test')", [people.get("drake")]))).toMatch(/Not an admin/);
    await database.actAs(admin);
    expect(await refusal(database.rows("select public.admin_set_person_market_parameter($1::uuid, 'depth_units_override', '120000'::jsonb, '  ')", [people.get("drake")]))).toMatch(/reason is required/);
    expect(await refusal(database.rows("select public.admin_set_person_market_parameter($1::uuid, 'market_inventory_units', '0'::jsonb, 'no')", [people.get("drake")]))).toMatch(/p_parameter must be/);
    expect(await refusal(database.rows("select public.admin_set_person_market_parameter($1::uuid, 'tier', null, 'no')", [people.get("drake")]))).toMatch(/tier cannot be cleared/);

    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_set_person_market_parameter($1::uuid, 'depth_units_override', '120000'::jsonb, 'depth demo') as r", [people.get("drake")]);
    expect(r).toMatchObject({ ok: true, parameter: "depth_units_override", from: null, to: 120000 });
    const [resolved] = await database.rows<{ depth: string }>("select m.depth_units::text as depth from public.people p cross join lateral public.market_params_for(p.id) m where p.slug = 'drake'");
    expect(Number(resolved.depth)).toBe(120_000);

    await database.rows("select public.admin_set_person_market_parameter($1::uuid, 'pricing_mode_override', '\"flat\"'::jsonb, 'flat for one person')", [people.get("drake")]);
    await database.rows("select public.admin_set_person_market_parameter($1::uuid, 'shorting_override', 'false'::jsonb, 'no shorting')", [people.get("drake")]);
    await database.rows("select public.admin_set_person_market_parameter($1::uuid, 'depth_units_override', 'null'::jsonb, 'demo over')", [people.get("drake")]);
    await database.rows("select public.admin_set_person_market_parameter($1::uuid, 'pricing_mode_override', null, 'back on the curve')", [people.get("drake")]);
    await database.rows("select public.admin_set_person_market_parameter($1::uuid, 'shorting_override', null, 'tier decides')", [people.get("drake")]);
    await database.actAs(null);

    const log = await auditRows("set_market_parameter");
    expect(log.map((row) => [row.details.parameter, row.details.from, row.details.to, row.note])).toEqual([
      ["depth_units_override", null, 120000, "depth demo"],
      ["pricing_mode_override", null, "flat", "flat for one person"],
      ["shorting_override", null, false, "no shorting"],
      ["depth_units_override", 120000, null, "demo over"],
      ["pricing_mode_override", "flat", null, "back on the curve"],
      ["shorting_override", false, null, "tier decides"],
    ]);
    for (const row of log) expect([row.actor_id, row.target_person_id]).toEqual([admin, people.get("drake")]);
    const [row] = await database.rows<{ depth: string | null; mode: string | null; shorting: boolean | null }>("select depth_units_override::text as depth, pricing_mode_override as mode, shorting_override as shorting from public.people where slug = 'drake'");
    expect([row.depth, row.mode, row.shorting]).toEqual([null, null, null]);
  });

  it("writes the change and its audit row in one transaction: a value the column refuses leaves no row", async () => {
    const admin = await createAdmin("atomic-admin@example.com");
    const before = await count("public.admin_audit_log");
    await database.actAs(admin);
    expect(await refusal(database.rows("select public.admin_set_person_market_parameter($1::uuid, 'depth_units_override', '0'::jsonb, 'bad')", [people.get("drake")]))).toMatch(/people_depth_override_pos/);
    expect(await refusal(database.rows("select public.admin_set_person_market_parameter($1::uuid, 'pricing_mode_override', '\"sideways\"'::jsonb, 'bad')", [people.get("drake")]))).toMatch(/people_pricing_mode_override_check/);
    expect(await refusal(database.rows("select public.admin_set_tier_market_parameter('public_figure', 'depth_units', '0'::jsonb, 'bad')"))).toMatch(/market_tier_settings_depth_positive/);
    expect(await refusal(database.rows("select public.admin_set_tier_market_parameter('public_figure', 'depth_units', null, 'bad')"))).toMatch(/depth_units cannot be null/);
    expect(await refusal(database.rows("select public.admin_set_tier_market_parameter('public_figure', 'tier', '\"x\"'::jsonb, 'bad')"))).toMatch(/must be a market_tier_settings column/);
    await database.actAs(null);
    expect(await count("public.admin_audit_log")).toBe(before);
  });

  it("changes a tier's parameter through the admin function, audit-logged, and lets the total-price breaker be switched off with null", async () => {
    const admin = await createAdmin("tier-admin@example.com");
    await database.actAs(admin);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_set_tier_market_parameter('public_figure', 'decay_half_life_ticks', '240'::jsonb, 'faster decay') as r");
    expect(r).toMatchObject({ ok: true, tier: "public_figure", parameter: "decay_half_life_ticks", from: 480, to: 240 });
    await database.rows("select public.admin_set_tier_market_parameter('private_individual', 'breaker_price_cents', null, 'breaker off')");
    await database.rows("select public.admin_set_tier_market_parameter('private_individual', 'breaker_price_cents', '500'::jsonb, 'breaker on')");
    await database.rows("select public.admin_set_tier_market_parameter('public_figure', 'decay_half_life_ticks', '480'::jsonb, 'as shipped')");
    await database.rows("select public.admin_set_tier_market_parameter('public_figure', 'shorting_allowed', 'false'::jsonb, 'no shorting')");
    await database.rows("select public.admin_set_tier_market_parameter('public_figure', 'shorting_allowed', 'true'::jsonb, 'as shipped')");
    await database.actAs(null);
    const log = await auditRows("set_tier_parameter");
    expect(log.map((row) => [row.details.tier, row.details.parameter, row.details.from, row.details.to])).toEqual([
      ["public_figure", "decay_half_life_ticks", 480, 240],
      ["private_individual", "breaker_price_cents", 500, null],
      ["private_individual", "breaker_price_cents", null, 500],
      ["public_figure", "decay_half_life_ticks", 240, 480],
      ["public_figure", "shorting_allowed", true, false],
      ["public_figure", "shorting_allowed", false, true],
    ]);
    const [tier] = await database.rows<{ half: string; breaker: string | null }>("select t.decay_half_life_ticks::text as half, (select breaker_price_cents::text from public.market_tier_settings where tier = 'private_individual') as breaker from public.market_tier_settings t where t.tier = 'public_figure'");
    expect([tier.half, tier.breaker]).toEqual(["480", "500"]);
  });

  it("keeps the trading mode on its own audit-logged function, which still writes through the guard", async () => {
    const admin = await createAdmin("mode-admin@example.com");
    await database.actAs(admin);
    await database.rows("select public.admin_set_trading_mode($1::uuid, 'paused', 'subject request')", [people.get("michael-dell")]);
    await database.rows("select public.admin_set_trading_mode($1::uuid, 'tradeable', 'resolved')", [people.get("michael-dell")]);
    await database.actAs(null);
    const log = await auditRows("set_trading_mode");
    expect(log.slice(-2).map((row) => [row.details.from, row.details.to])).toEqual([
      ["tradeable", "paused"],
      ["paused", "tradeable"],
    ]);
  });
});

describe("resets", () => {
  it("is refused while anyone holds a position on the person, and leaves no row behind", async () => {
    const admin = await createAdmin("reset-admin@example.com");
    const holder = await createUser("reset-holder@example.com");
    await order(holder, "kai-cenat", "BUY", 3 * SHARE);
    const before = await market("kai-cenat");
    expect(before.inventory).toBe(3 * SHARE);
    const audits = await count("public.admin_audit_log");
    const history = await count("public.premium_history where person_id = $1", [people.get("kai-cenat")]);
    await database.actAs(admin);
    expect(await refusal(database.rows("select public.admin_reset_market($1::uuid, 'demo over')", [people.get("kai-cenat")]))).toMatch(/Cannot reset the market on kai-cenat: 1 open position\(s\)/);
    await database.actAs(null);
    expect(await market("kai-cenat")).toEqual(before);
    expect(await count("public.admin_audit_log")).toBe(audits);
    expect(await count("public.premium_history where person_id = $1", [people.get("kai-cenat")])).toBe(history);
    expect(await count("public.house_ledger where person_id = $1 and category = 'reset'", [people.get("kai-cenat")])).toBe(0);
    await ageLots(holder);
    await order(holder, "kai-cenat", "SELL", 3 * SHARE);
  });

  it("goes through the one function when nobody holds: inventory and premium to zero, a 'reset' premium row, a 'reset' house-book row and the audit row", async () => {
    const admin = await createAdmin("reset-admin-2@example.com");
    await setInventory("kai-cenat", 150_000); // a decayed remnant: premium 50¢, no position behind it
    await database.rows("insert into public.engine_ticks (tick_number, started_at, finished_at) values (7777, now(), now())");
    await database.actAs(admin);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_reset_market($1::uuid, 'demo over') as r", [people.get("kai-cenat")]);
    await database.actAs(null);
    expect(r).toMatchObject({ ok: true, changed: true, inventory_before_units: 150000, premium_before_cents: 50 });
    expect(await market("kai-cenat")).toMatchObject({ inventory: 0, premium: 0 });

    const [history] = await database.rows<{ cause: string; before: string; after: string; pb: string; pa: string; depth: string | null; tick: string }>(
      "select cause, inventory_before_units::text as before, inventory_after_units::text as after, premium_before_cents::text as pb, premium_after_cents::text as pa, depth_units::text as depth, tick_number::text as tick from public.premium_history where id = $1",
      [r.premium_history_id],
    );
    expect(history).toEqual({ cause: "reset", before: "150000", after: "0", pb: "50", pa: "0", depth: null, tick: "7777" });

    const [ledger] = await database.rows<{ category: string; amount: string; details: Record<string, unknown>; tick: string }>(
      "select category, amount_cents::text as amount, details, tick_number::text as tick from public.house_ledger where id = $1",
      [r.house_ledger_id],
    );
    expect(ledger.category).toBe("reset");
    // Nothing was held, so the mark of what is held moved by exactly nothing; the row records the write-off.
    expect(ledger.amount).toBe("0");
    expect(ledger.details).toMatchObject({ source: "admin_reset", actor_id: admin, reason: "demo over", inventory_before_units: 150000, premium_before_cents: 50, open_positions: 0, high_units: 0, low_units: 0 });
    expect(ledger.tick).toBe("7777");

    const log = await auditRows("reset_market");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: admin, target_person_id: people.get("kai-cenat"), note: "demo over" });
    expect(log[0].details).toMatchObject({ changed: true, inventory_before_units: 150000, premium_before_cents: 50, premium_history_id: r.premium_history_id, house_ledger_id: r.house_ledger_id });

    // A reset of a market already at zero changes nothing and writes no premium or house row; the call is still on the record.
    await database.actAs(admin);
    const [{ r: again }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_reset_market($1::uuid, 'belt and braces') as r", [people.get("kai-cenat")]);
    await database.actAs(null);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(await count("public.premium_history where person_id = $1 and cause = 'reset'", [people.get("kai-cenat")])).toBe(1);
    expect(await count("public.house_ledger where person_id = $1 and category = 'reset'", [people.get("kai-cenat")])).toBe(1);
    expect(await auditRows("reset_market")).toHaveLength(2);
  });

  it("refuses the flat-market reset in decay while a position is open, and resets through the same function once it closes", async () => {
    const admin = await createAdmin("flat-admin@example.com");
    const holder = await createUser("flat-holder@example.com");
    await order(holder, "warren-buffett", "BUY", 2 * SHARE);
    expect((await market("warren-buffett")).inventory).toBe(2 * SHARE);
    await database.actAs(admin);
    await database.rows("select public.admin_set_person_market_parameter($1::uuid, 'pricing_mode_override', '\"flat\"'::jsonb, 'flat for the demo')", [people.get("warren-buffett")]);
    await database.actAs(null);

    await decay(300, 3);
    expect((await market("warren-buffett")).inventory).toBe(2 * SHARE);
    expect(await count("public.premium_history where person_id = $1 and cause = 'reset'", [people.get("warren-buffett")])).toBe(0);

    await ageLots(holder);
    await order(holder, "warren-buffett", "SELL", 2 * SHARE); // a flat close: no inventory change, the remnant stays
    expect((await market("warren-buffett")).inventory).toBe(2 * SHARE);
    await decay(303, 1);
    expect(await market("warren-buffett")).toMatchObject({ inventory: 0, premium: 0 });
    const [history] = await database.rows<{ cause: string; tick: string }>("select cause, tick_number::text as tick from public.premium_history where person_id = $1 and cause = 'reset'", [people.get("warren-buffett")]);
    expect(history).toEqual({ cause: "reset", tick: "303" });
    const [ledger] = await database.rows<{ amount: string; details: Record<string, unknown> }>("select amount_cents::text as amount, details from public.house_ledger where person_id = $1 and category = 'reset'", [people.get("warren-buffett")]);
    expect(ledger.amount).toBe("0");
    expect(ledger.details).toMatchObject({ source: "flat_market", pricing_mode: "flat", inventory_before_units: 2 * SHARE, open_positions: 0 });
    // The automatic reset has no operator: no audit row, the premium and house rows are its record.
    expect(await count("public.admin_audit_log where action = 'reset_market' and target_person_id = $1", [people.get("warren-buffett")])).toBe(0);

    await database.actAs(admin);
    await database.rows("select public.admin_set_person_market_parameter($1::uuid, 'pricing_mode_override', null, 'demo over')", [people.get("warren-buffett")]);
    await database.actAs(null);
  });

  it("keeps the reset function away from the client roles", async () => {
    const [fn] = await database.rows<{ reset: boolean; admin: boolean; anon: boolean }>(
      `select has_function_privilege('authenticated', 'public.market_reset_inventory(uuid, timestamptz, bigint, jsonb)', 'execute') as reset,
              has_function_privilege('authenticated', 'public.admin_reset_market(uuid, text, uuid)', 'execute') as admin,
              has_function_privilege('anon', 'public.admin_reset_market(uuid, text, uuid)', 'execute') as anon`,
    );
    expect([fn.reset, fn.admin, fn.anon]).toEqual([false, true, false]);
  });
});

describe("voids", () => {
  it("refuses a direct write of the void columns, and voids a signal through the admin function with the audit row in the same transaction", async () => {
    const admin = await createAdmin("void-admin@example.com");
    const [{ id: sourceId }] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'rss'");
    const [{ id: signalId }] = await database.rows<{ id: string }>(
      "insert into public.signals (person_id, data_source_id, headline, raw_payload, dedupe_key, occurred_at) values ($1, $2, 'A namesake''s obituary', '{\"kind\": \"article\"}'::jsonb, 'void-test-1', now()) returning id",
      [people.get("larry-page"), sourceId],
    );
    expect(await refusal(database.rows("update public.signals set voided_at = now(), void_reason = 'by hand' where id = $1", [signalId]))).toMatch(/signals\.voided_at is set through admin_void_signal\(\)/);

    const audits = await count("public.admin_audit_log");
    expect(await refusal(database.rows("select public.admin_void_signal($1::uuid, 'obvious error')", [signalId]))).toMatch(/Not authenticated|Not an admin/);
    await database.actAs(admin);
    expect(await refusal(database.rows("select public.admin_void_signal($1::uuid, ' ')", [signalId]))).toMatch(/reason is required/);
    expect(await refusal(database.rows("select public.admin_void_signal('00000000-0000-0000-0000-000000000000'::uuid, 'obvious error')"))).toMatch(/Unknown signal/);
    expect(await count("public.admin_audit_log")).toBe(audits);

    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_void_signal($1::uuid, 'obvious error: a namesake') as r", [signalId]);
    expect(r).toMatchObject({ ok: true, signal_id: signalId, person_id: people.get("larry-page") });
    expect(await refusal(database.rows("select public.admin_void_signal($1::uuid, 'twice')", [signalId]))).toMatch(/already voided/);
    await database.actAs(null);

    const [signal] = await database.rows<{ voided: string | null; reason: string | null }>("select voided_at::text as voided, void_reason as reason from public.signals where id = $1", [signalId]);
    expect(signal.voided).not.toBeNull();
    expect(signal.reason).toBe("obvious error: a namesake");
    const log = await auditRows("void_signal");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: admin, target_person_id: people.get("larry-page"), note: "obvious error: a namesake" });
    expect(log[0].details).toMatchObject({ signal_id: signalId, headline: "A namesake's obituary" });
    expect(String(log[0].details.voided_at).slice(0, 19)).toBe(signal.voided!.replace(" ", "T").slice(0, 19));
  });

  it("voids a narrative the same way", async () => {
    const admin = await createAdmin("void-admin-2@example.com");
    await database.rows("insert into public.engine_ticks (tick_number, started_at, finished_at) values (8888, now(), now())");
    const [{ id: narrativeId }] = await database.rows<{ id: string }>(
      "insert into public.narratives (person_id, tick_number, text, score_before, score_after) values ($1, 8888, 'Larry Page has died.', 55, 54) returning id",
      [people.get("larry-page")],
    );
    expect(await refusal(database.rows("update public.narratives set voided_at = now(), void_reason = 'by hand' where id = $1", [narrativeId]))).toMatch(/narratives\.voided_at is set through admin_void_narrative\(\)/);
    await database.actAs(admin);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_void_narrative($1::uuid, 'asserts a death that did not happen') as r", [narrativeId]);
    expect(r).toMatchObject({ ok: true, narrative_id: narrativeId, person_id: people.get("larry-page") });
    expect(await refusal(database.rows("select public.admin_void_narrative($1::uuid, 'twice')", [narrativeId]))).toMatch(/already voided/);
    await database.actAs(null);
    const [row] = await database.rows<{ voided: string | null; reason: string | null }>("select voided_at::text as voided, void_reason as reason from public.narratives where id = $1", [narrativeId]);
    expect(row.voided).not.toBeNull();
    expect(row.reason).toBe("asserts a death that did not happen");
    const log = await auditRows("void_narrative");
    expect(log).toHaveLength(1);
    expect(log[0].details).toMatchObject({ narrative_id: narrativeId, text: "Larry Page has died." });
  });
});
