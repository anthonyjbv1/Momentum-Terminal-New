import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * The profile route's SQL (2026-10-02): person_market_series() rewritten to
 * join the premium history once, and person_profile_header(), the slug
 * lookup in one call. Both run here on the migrations as production has
 * them.
 */

let database: TestDatabase;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const [row] = await database.rows<{ id: string }>("select id from public.people where slug = 'kendrick-lamar'");
  person = row.id;
});

afterAll(async () => {
  await database.close();
});

/** A premium_history row as the trade path writes one (the derived-premium check holds). */
async function premiumChange(at: string, beforeUnits: number, afterUnits: number, depth = 300_000, cause: "trade" | "decay" = "trade") {
  await database.rows(
    `insert into public.premium_history (person_id, recorded_at, cause, inventory_before_units, inventory_after_units, premium_before_cents, premium_after_cents, depth_units, score)
     values ($1, ${at}, $2, $3::bigint, $4::bigint, ($3::bigint * 100) / $5::bigint, ($4::bigint * 100) / $5::bigint, $5::bigint, 50)`,
    [person, cause, beforeUnits, afterUnits, depth],
  );
}

describe("person_market_series(): the premium joined once", () => {
  it("returns, bucket for bucket, what the per-bucket premium lookup returned, with a premium that moves inside the span and before it", async () => {
    // Ticks every 30 seconds over the last two hours.
    await database.rows(
      `insert into public.score_history (person_id, score, tick_number, recorded_at)
       select $1, 50 + (g % 7) * 0.25, g, now() - interval '2 hours' + g * interval '30 seconds' from generate_series(1, 240) g`,
      [person],
    );
    // The premium: on before the span, up twice inside it, decays, and two changes in one instant (the later one wins).
    await premiumChange("now() - interval '3 hours'", 0, 60_000);
    await premiumChange("now() - interval '90 minutes'", 60_000, 150_000);
    await premiumChange("now() - interval '70 minutes'", 150_000, 240_000);
    await premiumChange("now() - interval '70 minutes'", 240_000, 210_000);
    await premiumChange("now() - interval '40 minutes'", 210_000, 90_000, 300_000, "decay");

    // The Phase 29 function, inlined: the per-bucket premium lookup the rewrite replaced.
    const old = (since: string, points: number) => `
      with params as (select least(greatest(${points}, 2), 1000) as points),
      span as (select coalesce(${since}, (select min(sh.recorded_at) from public.score_history sh where sh.person_id = $1)) as from_at, now() as to_at),
      ranked as (
        select sh.score, sh.recorded_at,
               width_bucket(extract(epoch from sh.recorded_at), extract(epoch from s.from_at), extract(epoch from s.to_at) + 0.001, (select points from params)) as bucket
          from public.score_history sh cross join span s
         where sh.person_id = $1 and s.from_at is not null and sh.recorded_at >= s.from_at and sh.recorded_at <= s.to_at),
      buckets as (
        select max(r.recorded_at) as bucket_at, min(r.recorded_at) as opened_at,
               (array_agg(r.score order by r.recorded_at desc))[1] as score, (array_agg(r.score order by r.recorded_at asc))[1] as open, count(*)::int as samples
          from ranked r group by r.bucket)
      select b.bucket_at, b.score, b.open,
             b.score + public.premium_cents_at($1, b.bucket_at) * 0.01 as market,
             b.open  + public.premium_cents_at($1, b.opened_at) * 0.01 as market_open,
             b.samples
        from buckets b`;

    for (const [since, points] of [
      ["now() - interval '1 hour'", 120],
      ["now() - interval '100 minutes'", 50],
      ["now() - interval '24 hours'", 144],
      ["null::timestamptz", 160],
    ] as const) {
      const [diff] = await database.rows<{ rows_total: number; only_new: number; only_old: number; differing: number; premium_gaps: number }>(
        `select count(*)::int as rows_total,
                count(*) filter (where o.samples is null)::int as only_new,
                count(*) filter (where n.samples is null)::int as only_old,
                count(*) filter (where o.samples is not null and n.samples is not null
                                   and (o.score is distinct from n.score or o.open is distinct from n.open or o.market is distinct from n.market
                                        or o.market_open is distinct from n.market_open or o.samples is distinct from n.samples))::int as differing,
                count(distinct (n.market - n.score))::int as premium_gaps
           from (${old(since, points)}) o
           full outer join public.person_market_series($1, ${since}, ${points}) n using (bucket_at)`,
        [person],
      );
      expect(diff.rows_total).toBeGreaterThan(1);
      expect(diff.only_new).toBe(0);
      expect(diff.only_old).toBe(0);
      expect(diff.differing).toBe(0);
      // The premium really moves inside the span: the buckets do not all read the same gap.
      if (since !== "now() - interval '1 hour'") expect(diff.premium_gaps).toBeGreaterThan(1);
    }
  });

  it("plots recorded ticks only: every score and open is a score_history value at that bucket's own edge", async () => {
    const rows = await database.rows<{ ok: boolean }>(
      `select bool_and(
                exists (select 1 from public.score_history sh where sh.person_id = $1 and sh.recorded_at = s.bucket_at and sh.score = s.score)
              ) as ok
         from public.person_market_series($1, now() - interval '24 hours', 144) s`,
      [person],
    );
    expect(rows[0].ok).toBe(true);
  });

  it("falls back to the person's current premium when they have no premium history", async () => {
    const [other] = await database.rows<{ id: string }>("select id from public.people where slug = 'drake'");
    await database.rows(
      `insert into public.score_history (person_id, score, tick_number, recorded_at)
       select $1, 60, g, now() - interval '1 hour' + g * interval '30 seconds' from generate_series(1, 60) g`,
      [other.id],
    );
    await database.rows("update public.people set premium_cents = 250 where id = $1", [other.id]);
    const rows = await database.rows<{ market: string; score: string }>("select market::text, score::text from public.person_market_series($1, now() - interval '1 hour', 10)", [other.id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Number(row.market) - Number(row.score)).toBeCloseTo(2.5, 9);
    await database.rows("update public.people set premium_cents = 0 where id = $1", [other.id]);
  });
});

describe("person_profile_header(): the slug lookup in one call", () => {
  it("returns the person, their avatar blocks, the quote trade_quote() gives and the newest tick", async () => {
    const [{ header }] = await database.rows<{ header: Record<string, unknown> }>("select public.person_profile_header('kendrick-lamar') as header");
    const personRow = header.person as Record<string, unknown>;
    expect(personRow.id).toBe(person);
    expect(personRow.slug).toBe("kendrick-lamar");
    expect(typeof personRow.current_score).toBe("number");
    expect(header.avatar_configs).toEqual([]);
    const [{ quote }] = await database.rows<{ quote: Record<string, unknown> }>("select public.trade_quote($1) as quote", [person]);
    expect({ ...(header.quote as Record<string, unknown>), as_of: null }).toEqual({ ...quote, as_of: null });
    const tick = header.latest_tick as { tick_number: number; recorded_at: string };
    expect(tick.tick_number).toBe(240);
  });

  it("is null for an unknown or inactive slug, and reads only the active mappings' avatar blocks", async () => {
    const [{ missing }] = await database.rows<{ missing: unknown }>("select public.person_profile_header('nobody-here') as missing");
    expect(missing).toBeNull();
    await database.rows(
      `insert into public.person_data_sources (person_id, data_source_id, external_identifier, is_active, config)
       select $1, d.id, 'UCtest', true, '{"avatar": {"source": "youtube", "url": "https://yt3.googleusercontent.com/x=s800-c-k-c0x00ffffff-no-rj", "channel": "Kendrick", "refreshed_at": "2026-10-01T00:00:00Z"}}'::jsonb
         from public.data_sources d where d.name = 'youtube' limit 1`,
      [person],
    );
    const [{ header }] = await database.rows<{ header: Record<string, unknown> }>("select public.person_profile_header('kendrick-lamar') as header");
    expect(header.avatar_configs).toHaveLength(1);
    await database.rows("delete from public.person_data_sources where person_id = $1 and external_identifier = 'UCtest'", [person]);
  });

  it("is not callable by the browser roles", async () => {
    const [{ anon, authenticated, service }] = await database.rows<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.person_profile_header(text)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.person_profile_header(text)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.person_profile_header(text)', 'execute') as service`,
    );
    expect(anon).toBe(false);
    expect(authenticated).toBe(false);
    expect(service).toBe(true);
  });
});
