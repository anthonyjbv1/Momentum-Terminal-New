import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * THE PRIVACY RULE, checked against real Postgres.
 *
 * Raw metric levels live in raw_source_snapshots and raw_metric_observations
 * and nowhere else. No user-facing path can reach them: not through a grant,
 * not through a policy, not through a function or view the authenticated or
 * anonymous roles can execute, and not through the application's own reads.
 * A metric signal stores direction and normalised magnitude only, and the
 * database refuses one that tries to carry more.
 */

const RAW_TABLES = ["raw_source_snapshots", "raw_metric_observations"];
const INTERNAL_RELATIONS = [...RAW_TABLES, "ingest_runs", "source_polls", "llm_model_prices", "source_health", "llm_cost_per_tick"];
const USER_ROLES = ["anon", "authenticated"];

let database: TestDatabase;
let personId: string;
let sourceId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'mrbeast'");
  [{ id: sourceId }] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'youtube'");
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe("the raw tables", () => {
  it("are named for what they are, and the old name is gone", async () => {
    const tables = await database.rows<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_name like '%snapshot%' or table_name like 'raw_%'");
    const names = tables.map((t) => t.table_name).sort();
    expect(names).toContain("raw_source_snapshots");
    expect(names).toContain("raw_metric_observations");
    expect(names).not.toContain("source_snapshots");
  });

  it("grant nothing to the user roles and carry no policy, with row level security on", async () => {
    for (const relation of INTERNAL_RELATIONS) {
      for (const role of USER_ROLES) {
        for (const privilege of ["select", "insert", "update", "delete"]) {
          const [{ ok }] = await database.rows<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, `public.${relation}`, privilege]);
          expect(ok, `${role} ${privilege} on ${relation}`).toBe(false);
        }
      }
    }
    for (const table of RAW_TABLES) {
      const [{ rls }] = await database.rows<{ rls: boolean }>("select relrowsecurity as rls from pg_class where oid = $1::regclass", [`public.${table}`]);
      expect(rls, `${table} rls`).toBe(true);
      const policies = await database.rows("select policyname from pg_policies where schemaname = 'public' and tablename = $1", [table]);
      expect(policies, `${table} policies`).toEqual([]);
    }
  });

  it("are not referenced by any function or view the user roles can execute or read", async () => {
    const functions = await database.rows<{ name: string; definition: string; anon: boolean; authenticated: boolean }>(`
      select p.proname as name,
             pg_get_functiondef(p.oid) as definition,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
    `);
    const reachable = functions.filter((f) => f.anon || f.authenticated);
    expect(reachable.length).toBeGreaterThan(0);
    for (const fn of reachable) {
      for (const table of RAW_TABLES) {
        expect(fn.definition, `${fn.name} references ${table}`).not.toContain(table);
      }
    }
    const views = await database.rows<{ name: string; definition: string; anon: boolean; authenticated: boolean }>(`
      select c.relname as name,
             pg_get_viewdef(c.oid) as definition,
             has_table_privilege('anon', c.oid, 'select') as anon,
             has_table_privilege('authenticated', c.oid, 'select') as authenticated
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'
    `);
    for (const view of views.filter((v) => v.anon || v.authenticated)) {
      for (const table of RAW_TABLES) {
        expect(view.definition, `${view.name} references ${table}`).not.toContain(table);
      }
    }
  });
});

describe("the signals table", () => {
  const insert = (headline: string, payload: unknown) =>
    database.rows("insert into public.signals (person_id, data_source_id, headline, raw_payload, dedupe_key) values ($1, $2, $3, $4::jsonb, $5) returning id", [
      personId,
      sourceId,
      headline,
      JSON.stringify(payload),
      `test:${Math.random()}`,
    ]);

  const metric = {
    kind: "metric",
    metric: "subscriber_count",
    label: "YouTube subscriber growth",
    sigma: 1.42,
    direction: 1,
    polarity: 1,
    samples: 48,
    min_samples: 24,
    window_hours: 168,
    delta_kind: "relative_rate",
    threshold_std_devs: 1,
    scale: 1,
    source: "youtube",
  };

  it("accepts a metric signal that carries direction and normalised magnitude only", async () => {
    const rows = await insert("MrBeast's YouTube subscriber growth is running +1.4σ above their own trailing week", metric);
    expect(rows).toHaveLength(1);
  });

  it("refuses a metric signal carrying a level, a delta, or anything outside the allow-list", async () => {
    await expect(insert("MrBeast's YouTube subscriber growth is running +1.4σ above their own trailing week", { ...metric, value: 516000000 })).rejects.toThrow(/"value" is not allowed/);
    await expect(insert("x", { ...metric, previous: 515900000 })).rejects.toThrow(/"previous" is not allowed/);
    await expect(insert("x", { ...metric, delta: 100000 })).rejects.toThrow(/"delta" is not allowed/);
    await expect(insert("x", { ...metric, mean: 0.00001 })).rejects.toThrow(/"mean" is not allowed/);
    await expect(insert("x", { ...metric, followers: 1 })).rejects.toThrow(/"followers" is not allowed/);
  });

  it("refuses a metric signal without an explicit polarity or a numeric sigma", async () => {
    const { polarity: _polarity, ...noPolarity } = metric;
    void _polarity;
    await expect(insert("x", noPolarity)).rejects.toThrow(/polarity 1 or -1/);
    await expect(insert("x", { ...metric, polarity: 0 })).rejects.toThrow(/polarity 1 or -1/);
    await expect(insert("x", { ...metric, polarity: "up" })).rejects.toThrow(/polarity 1 or -1/);
    await expect(insert("x", { ...metric, sigma: "1.4" })).rejects.toThrow(/numeric sigma/);
  });

  it("refuses a metric signal whose headline carries a raw level", async () => {
    await expect(insert("MrBeast crosses 516M subscribers on YouTube", metric)).rejects.toThrow(/raw level/);
    await expect(insert("MrBeast gains 850,000 subscribers", metric)).rejects.toThrow(/raw level/);
    await expect(insert("MrBeast stands at 516000000 subscribers", metric)).rejects.toThrow(/raw level/);
    await expect(insert("Drake's Spotify popularity is running 2.3B above", metric)).rejects.toThrow(/raw level/);
    // Sigma with one decimal, and small counts, are fine.
    expect(await insert("Drake's Spotify popularity is running +12.3σ above their own trailing month", metric)).toHaveLength(1);
  });

  it("leaves news signals alone: an article headline may carry any number", async () => {
    expect(await insert("MrBeast signs a $1,000,000,000 deal with 516M fans watching", { kind: "article", source: "rss", outlet: "Example" })).toHaveLength(1);
    expect(await insert("Plain headline", null)).toHaveLength(1);
  });
});

describe("the registry", () => {
  it("registers youtube, youtube_comments, rss and spotify with explicit metric declarations", async () => {
    const sources = await database.rows<{ name: string; tier: number; is_active: boolean; config: Record<string, unknown> | null }>(
      "select name, tier, is_active, config from public.data_sources where name in ('youtube', 'youtube_comments', 'rss', 'spotify') order by name",
    );
    expect(sources.map((s) => [s.name, s.tier, s.is_active])).toEqual([
      ["rss", 3, true],
      ["spotify", 2, true],
      ["youtube", 2, true],
      ["youtube_comments", 4, true],
    ]);
    for (const source of sources) {
      if (source.name === "youtube_comments") continue;
      const metrics = (source.config as { metrics: Record<string, Record<string, unknown>> }).metrics;
      for (const [key, declaration] of Object.entries(metrics)) {
        expect([1, -1], `${source.name}.${key} polarity`).toContain(declaration.polarity);
        expect(declaration, `${source.name}.${key}`).toMatchObject({ baseline_window_hours: expect.any(Number), min_samples: expect.any(Number), sd_floor: expect.any(Number), scale: expect.any(Number) });
      }
    }
  });

  it("maps MrBeast and Drake to their sources", async () => {
    const mappings = await database.rows<{ slug: string; source: string; identifier: string }>(`
      select p.slug, d.name as source, pds.external_identifier as identifier
        from public.person_data_sources pds
        join public.people p on p.id = pds.person_id
        join public.data_sources d on d.id = pds.data_source_id
       where pds.is_active
       order by p.slug, d.name
    `);
    expect(mappings).toEqual([
      { slug: "drake", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22Drake%22") },
      { slug: "drake", source: "spotify", identifier: "3TVXtAsR1Inumwj472S9r4" },
      { slug: "mrbeast", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22MrBeast%22") },
      { slug: "mrbeast", source: "youtube", identifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" },
      { slug: "mrbeast", source: "youtube_comments", identifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" },
    ]);
  });
});

describe("observability", () => {
  it("source_health reads last poll, last success, last error and the trailing-day rates", async () => {
    const [{ id: runId }] = await database.rows<{ id: string }>("insert into public.ingest_runs (started_at, trigger) values (now(), 'manual') returning id");
    await database.exec(`
      insert into public.source_polls (run_id, data_source_id, person_id, status, reason, latency_ms, signals_created, started_at, finished_at) values
        ('${runId}', '${sourceId}', '${personId}', 'ok',    null,   120, 2, now() - interval '3 hours', now() - interval '3 hours'),
        ('${runId}', '${sourceId}', '${personId}', 'error', 'quota', 80, 0, now() - interval '2 hours', now() - interval '2 hours'),
        ('${runId}', '${sourceId}', '${personId}', 'ok',    null,   200, 1, now() - interval '1 hour',  now() - interval '1 hour'),
        ('${runId}', '${sourceId}', null,          'skipped', 'inactive: YOUTUBE_API_KEY is not set', null, 0, now(), now());
    `);
    const [health] = await database.rows<Record<string, unknown>>("select * from public.source_health where name = 'youtube'");
    expect(health).toMatchObject({ name: "youtube", last_error: "quota", last_skip_reason: "inactive: YOUTUBE_API_KEY is not set" });
    expect([health.people_mapped, health.polls_24h, health.errors_24h, health.signals_24h].map(Number)).toEqual([1, 3, 1, 3]);
    expect(Number(health.error_rate_24h)).toBeCloseTo(1 / 3, 4);
    expect(Number(health.avg_latency_ms_24h)).toBe(160);
    expect(health.last_success_at).not.toBeNull();
    expect(new Date(health.last_success_at as string).getTime()).toBeGreaterThan(new Date(health.last_error_at as string).getTime());
  });

  it("llm_cost_per_tick prices usage per tick and says when a model has no price", async () => {
    await database.exec(`
      insert into public.llm_usage (provider, model, task_type, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, latency_ms, tick_number) values
        ('anthropic', 'claude-haiku-4-5-20251001', 'sentiment', 1000000, 100000, 0, 0, 900, 7),
        ('anthropic', 'claude-opus-5',             'memory',    200000,  10000,  100000, 0, 1500, 7),
        ('anthropic', 'mystery-model',             'sentiment', 5000,    500,    0, 0, 300, 8);
    `);
    const rows = await database.rows<Record<string, unknown>>("select * from public.llm_cost_per_tick where tick_number in (7, 8) order by tick_number");
    expect(rows).toHaveLength(2);
    // Haiku: 1M in × $1 + 100k out × $5 = $1.50; Opus (assumed price): 200k × $5 + 10k × $25 + 100k × $0.50 = $1.30.
    expect([rows[0].calls, rows[0].sentiment_calls, rows[0].memory_calls, rows[0].unpriced_calls].map(Number)).toEqual([2, 1, 1, 0]);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(2.8, 6);
    expect([rows[1].calls, rows[1].unpriced_calls].map(Number)).toEqual([1, 1]);
    expect(rows[1].cost_usd).toBeNull();
  });
});

/** Every source file under the app, excluding dependencies, build output, tests and the generated type declarations (which name every table without reading any). */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", "supabase", "public", "types"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry) && !full.includes("__tests__")) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("the application", () => {
  it("reads the raw tables from the ingestion store alone, never from a page, a component or a user-facing read", () => {
    const root = join(__dirname, "..", "..");
    const readers = sourceFiles(root)
      .filter((file) => RAW_TABLES.some((table) => readFileSync(file, "utf8").includes(table)))
      .map((file) => relative(root, file))
      .sort();
    expect(readers).toEqual(["lib/ingest/store.ts"]);
  });

  it("selects raw_payload from signals only where the Engine scores and the runner writes", () => {
    const root = join(__dirname, "..", "..");
    const selectors = sourceFiles(root)
      .filter((file) => /^(app|components|lib\/(feed|person|home|portfolio))\//.test(relative(root, file)))
      .filter((file) => /raw_payload|rawPayload/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(selectors).toEqual([]);
  });
});
