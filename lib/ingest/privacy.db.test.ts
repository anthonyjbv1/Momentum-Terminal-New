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
const INTERNAL_RELATIONS = [
  ...RAW_TABLES,
  "ingest_runs",
  "source_polls",
  "llm_model_prices",
  "source_health",
  "llm_cost_per_tick",
  "publisher_domains",
  // Phase 9. metric_baseline_progress counts rows in the raw tables, so it is
  // internal on exactly the same terms as source_health: service role only.
  "metric_baseline_progress",
  // Phase 13. The publisher feed catalogue and its health: configuration and
  // counts the runner writes; nothing a user-facing path reads.
  "publisher_feeds",
];
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

  it("carries a per-item tier inside 1..5, or none, in which case the source's tier applies", async () => {
    const withTier = (tier: number | null) =>
      database.rows<{ id: string }>("insert into public.signals (person_id, data_source_id, headline, raw_payload, dedupe_key, tier) values ($1, $2, $3, $4::jsonb, $5, $6) returning id", [
        personId,
        sourceId,
        "Tiered headline",
        JSON.stringify({ kind: "article" }),
        `tier:${Math.random()}`,
        tier,
      ]);
    expect(await withTier(1)).toHaveLength(1);
    expect(await withTier(5)).toHaveLength(1);
    expect(await withTier(null)).toHaveLength(1);
    await expect(withTier(0)).rejects.toThrow(/signals_tier_range/);
    await expect(withTier(6)).rejects.toThrow(/signals_tier_range/);
  });
});

describe("the publisher allowlist", () => {
  it("is seeded small: wires, papers of record and the two subjects' trade press, one blocked scraper, tiers 1 to 3 only", async () => {
    const rows = await database.rows<{ domain: string; status: string; tier: number | null; note: string | null }>("select domain, status, tier, note from public.publisher_domains order by domain");
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(rows.length).toBeLessThanOrEqual(90);
    expect(rows.filter((r) => r.status === "blocked").map((r) => r.domain)).toEqual(["defensorianna.gob.ar"]);
    for (const row of rows.filter((r) => r.status === "allowed")) expect([1, 2, 3, 4, 5], row.domain).toContain(row.tier);
    // Held at the floor by decision, not by omission: a subject's own promotional channel is not coverage of them.
    for (const domain of ["amgen.com", "blog.google"]) {
      const held = rows.find((r) => r.domain === domain);
      expect(held, domain).toMatchObject({ status: "allowed", tier: 5 });
      expect(held?.note ?? "", domain).toMatch(/^FLOOR BY DECISION:/);
    }
    // Promoted from what the first runs surfaced, at the tiers decided for them.
    expect(rows.find((r) => r.domain === "morningbrew.com")?.tier).toBe(2);
    expect(rows.find((r) => r.domain === "kctv5.com")?.tier).toBe(3);
    expect(rows.find((r) => r.domain === "police1.com")?.tier).toBe(4);
    for (const domain of ["billboard.com", "rollingstone.com", "theneedledrop.com", "complex.com", "theverge.com", "tubefilter.com", "marketingdive.com"]) {
      expect(rows.map((r) => r.domain), domain).toContain(domain);
    }
    expect(rows.find((r) => r.domain === "theneedledrop.com")?.tier).toBe(2);
    expect(rows.find((r) => r.domain === "billboard.com")?.tier).toBe(1);
  });

  it("is configuration with a normalised key: a row is a domain in canonical form, allowed rows carry a tier, and adding one is an insert", async () => {
    const add = (domain: string, status: string, tier: number | null) => database.rows("insert into public.publisher_domains (domain, status, tier) values ($1, $2, $3) returning domain", [domain, status, tier]);
    expect(await add("stereoboard.example", "allowed", 3)).toEqual([{ domain: "stereoboard.example" }]);
    await expect(add("WWW.Shouty.example", "allowed", 3)).rejects.toThrow(/publisher_domains_domain_normalised/);
    await expect(add("www.shouty.example", "allowed", 3)).rejects.toThrow(/publisher_domains_domain_normalised/);
    await expect(add("trailing.example.", "allowed", 3)).rejects.toThrow(/publisher_domains_domain_normalised/);
    await expect(add("nodot", "allowed", 3)).rejects.toThrow(/publisher_domains_domain_normalised/);
    await expect(add("https://scheme.example", "allowed", 3)).rejects.toThrow(/publisher_domains_domain_normalised/);
    await expect(add("untiered.example", "allowed", null)).rejects.toThrow(/publisher_domains_tier_when_allowed/);
    await expect(add("wrong.example", "allowed", 9)).rejects.toThrow(/publisher_domains_tier_range/);
    await expect(add("maybe.example", "unsure", null)).rejects.toThrow(/publisher_domains_status_check/);
    expect(await add("scraper.example", "blocked", null)).toEqual([{ domain: "scraper.example" }]);
  });
});

describe("the registry", () => {
  it("registers youtube, youtube_comments, rss and spotify with explicit metric declarations", async () => {
    const sources = await database.rows<{ name: string; tier: number; is_active: boolean; config: Record<string, unknown> | null }>(
      "select name, tier, is_active, config from public.data_sources where name in ('youtube', 'youtube_comments', 'rss', 'spotify') order by name",
    );
    // youtube_comments now declares a metric of its own (comment_volume), so it is no longer metric-free.
    expect((sources.find((s) => s.name === "youtube_comments")?.config as { metrics: Record<string, unknown> }).metrics).toHaveProperty("comment_volume");
    expect(sources.map((s) => [s.name, s.tier, s.is_active])).toEqual([
      ["rss", 3, true],
      ["spotify", 2, true],
      ["youtube", 2, true],
      ["youtube_comments", 4, true],
    ]);
    for (const source of sources) {
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
    // Exhaustive on purpose: a mapping that appears without being named here is
    // a person being polled that nobody decided to poll.
    expect(mappings).toEqual([
      // Phase 13: every subject also reads the publisher feed catalogue, under
      // their primary match term; the Google News search stays as the fallback.
      { slug: "drake", source: "publisher_rss", identifier: "Drake" },
      { slug: "drake", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22Drake%22") },
      { slug: "drake", source: "spotify", identifier: "3TVXtAsR1Inumwj472S9r4" },
      // Phase 10: a creator whose primary platform is Twitch, and an athlete on
      // a weekly schedule — two data shapes the first two subjects do not have.
      { slug: "kai-cenat", source: "publisher_rss", identifier: "Kai Cenat" },
      { slug: "kai-cenat", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22Kai+Cenat%22") },
      { slug: "kai-cenat", source: "twitch", identifier: "kaicenat" },
      { slug: "mrbeast", source: "publisher_rss", identifier: "MrBeast" },
      { slug: "mrbeast", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22MrBeast%22") },
      { slug: "mrbeast", source: "youtube", identifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" },
      { slug: "mrbeast", source: "youtube_comments", identifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" },
      { slug: "patrick-mahomes", source: "apisports", identifier: "1197" },
      { slug: "patrick-mahomes", source: "publisher_rss", identifier: "Patrick Mahomes" },
      { slug: "patrick-mahomes", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22Patrick+Mahomes%22") },
    ]);
  });

  it("keeps EVERY active source off the multiple of the cron period, so no fire ever skips one", async () => {
    // THE DEFECT THIS HOLDS SHUT. The runner skips a source when
    // `minutes since last poll < poll_interval_minutes`. The cron fires on the
    // period and the previous run's poll lands a few seconds after its own
    // fire, so a period later the check measures a fraction less than the
    // period. Any interval that is an exact multiple of the period loses that
    // race every time and the source polls half as often as its interval
    // claims — which is what rss, youtube and youtube_comments did at 60 on the
    // hourly schedule, undetectably: a sample count rising at half speed looks
    // exactly like a sample count rising.
    //
    // Phase 13 moved the schedule to every fifteen minutes. 10 polls on every
    // fire; 40 every third (45 min), deliberate for a weekly sport; 55 every
    // fourth (the hour), deliberate for the quota-bound YouTube reads and the
    // weekly Twitch aggregates. 15, 30, 45 or 60 would silently halve any of
    // them. Every ACTIVE source is covered, because the next source registered
    // at a tidy-looking 15 would reintroduce this in a form nothing on the
    // dashboard reports.
    const CRON_PERIOD_MINUTES = 15;
    const active = await database.rows<{ name: string; poll_interval_minutes: number }>(
      "select name, poll_interval_minutes from public.data_sources where is_active order by name",
    );
    expect(active.length).toBeGreaterThanOrEqual(6);
    for (const source of active) {
      expect(source.poll_interval_minutes % CRON_PERIOD_MINUTES, `${source.name} polls every ${source.poll_interval_minutes} min, an exact multiple of ${CRON_PERIOD_MINUTES}`).not.toBe(0);
    }
    const byName = Object.fromEntries(active.map((source) => [source.name, source.poll_interval_minutes]));
    expect(byName).toMatchObject({ rss: 10, publisher_rss: 10, apisports: 40, youtube: 55, youtube_comments: 55, twitch: 55 });
  });

  it("registers every publisher feed under an allowed publisher of tier 1 to 3, with a topic and a mode", async () => {
    const feeds = await database.rows<{ domain: string; url: string; mode: string; topics: string[]; tier: number | null; status: string | null }>(`
      select f.domain, f.url, f.mode, f.topics, d.tier, d.status
        from public.publisher_feeds f
        left join public.publisher_domains d on d.domain = f.domain
       where f.is_active
       order by f.domain, f.url
    `);
    expect(feeds.length).toBeGreaterThanOrEqual(60);
    for (const feed of feeds) {
      expect(feed.status, `${feed.url}: ${feed.domain} is not on the allowlist`).toBe("allowed");
      expect(feed.tier, `${feed.url}: ${feed.domain} tier`).toBeLessThanOrEqual(3);
      expect(feed.topics.length, `${feed.url}: no topic`).toBeGreaterThan(0);
      expect(["feed", "discover"], `${feed.url}: mode`).toContain(feed.mode);
      expect(feed.url).toMatch(/^https:\/\//);
    }
    // A discovery row is a page to search, and there are known ones: the outlets that retired RSS are measured, not assumed.
    expect(feeds.filter((feed) => feed.mode === "discover").map((feed) => feed.domain)).toEqual(expect.arrayContaining(["reuters.com", "apnews.com", "bloomberg.com"]));
  });

  it("declares Twitch and API-Sports as data, with every metric able to fill its baseline", async () => {
    const sources = await database.rows<{ name: string; tier: number; is_active: boolean; config: Record<string, unknown> }>(
      "select name, tier, is_active, config from public.data_sources where name in ('twitch', 'apisports') order by name",
    );
    expect(sources.map((source) => [source.name, source.tier, source.is_active])).toEqual([
      ["apisports", 2, true],
      ["twitch", 2, true],
    ]);

    const metrics = Object.fromEntries(
      sources.flatMap((source) =>
        Object.entries((source.config as { metrics: Record<string, Record<string, unknown>> }).metrics).map(([key, declaration]) => [`${source.name}.${key}`, declaration]),
      ),
    );
    expect(Object.keys(metrics).sort()).toEqual([
      "apisports.game_passing_yards",
      "twitch.follower_count",
      "twitch.stream_days_7d",
      "twitch.stream_hours_7d",
    ]);

    // No instantaneous live reading is a metric: a concurrent-viewer count read
    // at an arbitrary minute has a distribution set by the polling schedule.
    for (const key of Object.keys(metrics)) expect(key).not.toMatch(/viewer/);

    // A weekly sport cannot reach the platform's usual 24 samples inside one
    // season, so its single metric declares a reachable minimum instead.
    expect(metrics["apisports.game_passing_yards"].min_samples).toBe(8);
    expect(Number(metrics["apisports.game_passing_yards"].baseline_window_hours)).toBeGreaterThanOrEqual(8 * 168);

    for (const [key, declaration] of Object.entries(metrics)) {
      expect([1, -1], `${key} polarity`).toContain(declaration.polarity);
      expect(declaration, key).toMatchObject({
        baseline_window_hours: expect.any(Number),
        min_samples: expect.any(Number),
        sd_floor: expect.any(Number),
        scale: expect.any(Number),
      });
    }
  });
});

describe("observability", () => {
  it("source_health reads last poll, last success, last error and the trailing-day rates", async () => {
    const [{ id: runId }] = await database.rows<{ id: string }>("insert into public.ingest_runs (started_at, trigger) values (now(), 'manual') returning id");
    await database.exec(`
      insert into public.source_polls (run_id, data_source_id, person_id, status, reason, latency_ms, signals_created, blocked_dropped, duplicates_collapsed, started_at, finished_at) values
        ('${runId}', '${sourceId}', '${personId}', 'ok',    null,   120, 2, 1, 4, now() - interval '3 hours', now() - interval '3 hours'),
        ('${runId}', '${sourceId}', '${personId}', 'error', 'quota', 80, 0, 0, 0, now() - interval '2 hours', now() - interval '2 hours'),
        ('${runId}', '${sourceId}', '${personId}', 'ok',    null,   200, 1, 0, 2, now() - interval '1 hour',  now() - interval '1 hour'),
        ('${runId}', '${sourceId}', null,          'skipped', 'inactive: YOUTUBE_API_KEY is not set', null, 0, 0, 0, now(), now());
    `);
    const [health] = await database.rows<Record<string, unknown>>("select * from public.source_health where name = 'youtube'");
    expect(health).toMatchObject({ name: "youtube", last_error: "quota", last_skip_reason: "inactive: YOUTUBE_API_KEY is not set" });
    expect([health.people_mapped, health.polls_24h, health.errors_24h, health.signals_24h].map(Number)).toEqual([1, 3, 1, 3]);
    // The Phase 8 counters: what the trailing day dropped as blocked and collapsed as duplicates.
    expect([health.blocked_24h, health.collapsed_24h].map(Number)).toEqual([1, 6]);
    expect(Number(health.error_rate_24h)).toBeCloseTo(1 / 3, 4);
    expect(Number(health.avg_latency_ms_24h)).toBe(160);
    expect(health.last_success_at).not.toBeNull();
    expect(new Date(health.last_success_at as string).getTime()).toBeGreaterThan(new Date(health.last_error_at as string).getTime());
  });

  it("llm_model_prices carries the verified rates for the models in use, under the strings the API echoes, with no assumed row", async () => {
    const rows = await database.rows<{ model: string; input_per_mtok: string | number; output_per_mtok: string | number; cache_read_per_mtok: string | number; cache_write_per_mtok: string | number; note: string | null }>(
      "select model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, note from public.llm_model_prices where model in ('claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5') order by model",
    );
    expect(rows.map((r) => [r.model, Number(r.input_per_mtok), Number(r.output_per_mtok), Number(r.cache_read_per_mtok), Number(r.cache_write_per_mtok)])).toEqual([
      // Haiku 4.5's ID is dated and the adapter records the ID the API echoes, so the dated row is the one usage hits; the alias row prices the same.
      ["claude-haiku-4-5", 1, 5, 0.1, 1.25],
      ["claude-haiku-4-5-20251001", 1, 5, 0.1, 1.25],
      ["claude-opus-5", 5, 25, 0.5, 6.25],
      ["claude-sonnet-5", 2, 10, 0.2, 2.5],
    ]);
    const all = await database.rows<{ note: string | null }>("select note from public.llm_model_prices");
    for (const row of all) expect(row.note ?? "").not.toMatch(/ASSUMED/);
    for (const row of rows) expect(row.note).toMatch(/^Verified 2026-09-1[34] against Anthropic pricing/);
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
    // Haiku: 1M in × $1 + 100k out × $5 = $1.50; Opus: 200k × $5 + 10k × $25 + 100k × $0.50 = $1.30.
    expect([rows[0].calls, rows[0].sentiment_calls, rows[0].memory_calls, rows[0].unpriced_calls].map(Number)).toEqual([2, 1, 1, 0]);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(2.8, 6);
    expect([rows[1].calls, rows[1].unpriced_calls].map(Number)).toEqual([1, 1]);
    expect(rows[1].cost_usd).toBeNull();
  });

  it("llm_cost_per_tick matches a price row exactly: a longer model string is unpriced, never priced as its prefix", async () => {
    // claude-opus-5-1 begins with claude-opus-5 and must NOT be billed at Opus 5's rate; the dated Haiku ID
    // matches its own row, and an unknown dated string does not fall back to the alias row.
    await database.exec(`
      insert into public.llm_usage (provider, model, task_type, input_tokens, output_tokens, tick_number) values
        ('anthropic', 'claude-opus-5-1',           'sentiment', 1000000, 100000, 21),
        ('anthropic', 'claude-opus-5',             'sentiment', 1000000, 100000, 22),
        ('anthropic', 'claude-haiku-4-5-20251001', 'sentiment', 1000000, 100000, 23),
        ('anthropic', 'claude-haiku-4-5-2026',     'sentiment', 1000000, 100000, 24);
    `);
    const rows = await database.rows<{ tick_number: number | string; unpriced_calls: string | number; cost_usd: string | number | null }>(
      "select tick_number, unpriced_calls, cost_usd from public.llm_cost_per_tick where tick_number between 21 and 24 order by tick_number",
    );
    expect(rows.map((r) => [Number(r.tick_number), Number(r.unpriced_calls), r.cost_usd === null ? null : Number(r.cost_usd)])).toEqual([
      [21, 1, null], // claude-opus-5-1: no row, so unpriced rather than $7.50 at Opus 5's rate
      [22, 0, 7.5], // claude-opus-5: 1M × $5 + 100k × $25
      [23, 0, 1.5], // claude-haiku-4-5-20251001: 1M × $1 + 100k × $5
      [24, 1, null], // an unknown dated string does not fall back to the alias row
    ]);
    const [view] = await database.rows<{ def: string }>("select pg_get_viewdef('public.llm_cost_per_tick'::regclass) as def");
    expect(view.def).not.toMatch(/like/i);
    expect(view.def).toMatch(/p\.model = u\.model/);
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
