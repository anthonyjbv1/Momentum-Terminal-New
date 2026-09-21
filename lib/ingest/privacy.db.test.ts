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
  // Phase 16. The live ledger: raw viewer counts and what each sample produced.
  "live_sessions",
  "live_samples",
  // Phase 17. The view onto figures a source records and never scores. It is
  // the one place a raw level is deliberately readable, and it is readable by
  // the service role alone, on the same terms as the table underneath it.
  "observe_only_snapshots",
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
    // youtube_comments reads comment_volume and, since Phase 21, scores
    // nothing with it: the figure is a sum over a CHANGING BASKET of uploads,
    // so it is recorded as an observe-only snapshot and declared nowhere. A
    // key cannot be both, and the runner reads observe_only first.
    const comments = sources.find((s) => s.name === "youtube_comments")?.config as { metrics: Record<string, unknown>; observe_only: string[] };
    expect(comments.observe_only).toEqual(["comment_volume"]);
    expect(comments.metrics).not.toHaveProperty("comment_volume");
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
    // Phase 15: the twelve who had no source read the two news doors, and only those.
    // Phase 22: everyone reads the trending chart under their display name;
    // the chart is one fetch shared by all, and a person it never carries gets
    // nothing from it. Sorts last for every person ("youtube_trending").
    const trending = (slug: string, name: string) => [{ slug, source: "youtube_trending", identifier: name }];
    const news = (slug: string, name: string) => [
      { slug, source: "publisher_rss", identifier: name },
      { slug, source: "rss", identifier: expect.stringContaining(`news.google.com/rss/search?q=%22${name.replace(/ /g, "+")}%22`) },
      ...trending(slug, name),
    ];
    // Phase 17: an executive also reads the company they are identified with,
    // for its news VOLUME and their own Form 4s. Never for its share price,
    // which is recorded and scores nothing (finnhub.db.test.ts).
    const executive = (slug: string, name: string, symbol: string) => [{ slug, source: "finnhub", identifier: symbol }, ...news(slug, name)];
    expect(mappings).toEqual([
      ...news("adin-ross", "Adin Ross"),
      ...news("anthony-baptiste", "Anthony Baptiste"),
      // Phase 13: every subject also reads the publisher feed catalogue, under
      // their primary match term; the Google News search stays as the fallback.
      { slug: "drake", source: "publisher_rss", identifier: "Drake" },
      { slug: "drake", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22Drake%22") },
      { slug: "drake", source: "spotify", identifier: "3TVXtAsR1Inumwj472S9r4" },
      ...trending("drake", "Drake"),
      ...executive("elon-musk", "Elon Musk", "TSLA"),
      ...executive("jeff-bezos", "Jeff Bezos", "AMZN"),
      ...executive("jensen-huang", "Jensen Huang", "NVDA"),
      // Phase 10: a creator whose primary platform is Twitch, and an athlete on
      // a weekly schedule — two data shapes the first two subjects do not have.
      { slug: "kai-cenat", source: "publisher_rss", identifier: "Kai Cenat" },
      { slug: "kai-cenat", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22Kai+Cenat%22") },
      { slug: "kai-cenat", source: "twitch", identifier: "kaicenat" },
      ...trending("kai-cenat", "Kai Cenat"),
      ...news("kendrick-lamar", "Kendrick Lamar"),
      ...executive("larry-ellison", "Larry Ellison", "ORCL"),
      ...executive("larry-page", "Larry Page", "GOOGL"),
      ...executive("mark-zuckerberg", "Mark Zuckerberg", "META"),
      ...executive("michael-dell", "Michael Dell", "DELL"),
      { slug: "mrbeast", source: "publisher_rss", identifier: "MrBeast" },
      { slug: "mrbeast", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22MrBeast%22") },
      { slug: "mrbeast", source: "youtube", identifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" },
      { slug: "mrbeast", source: "youtube_comments", identifier: "UCX6OQ3DkcsbYNE6H8uQQuVA" },
      ...trending("mrbeast", "MrBeast"),
      { slug: "patrick-mahomes", source: "apisports", identifier: "1197" },
      { slug: "patrick-mahomes", source: "publisher_rss", identifier: "Patrick Mahomes" },
      { slug: "patrick-mahomes", source: "rss", identifier: expect.stringContaining("news.google.com/rss/search?q=%22Patrick+Mahomes%22") },
      ...trending("patrick-mahomes", "Patrick Mahomes"),
      ...executive("sergey-brin", "Sergey Brin", "GOOGL"),
      ...executive("warren-buffett", "Warren Buffett", "BRK.B"),
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
    // Phase 22: 25 comes due every second fire, an effective thirty minutes — the chart's own refresh.
    expect(byName).toMatchObject({ rss: 10, publisher_rss: 10, apisports: 40, youtube: 55, youtube_comments: 55, twitch: 55, youtube_trending: 25 });
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
    // The outlets that retired RSS were measured, not assumed: their discovery
    // rows exist, were fetched from production on 2026-09-17, and were then
    // switched off by the curation migration with what was found in the note.
    const retired = await database.rows<{ domain: string; is_active: boolean; note: string | null }>(
      "select domain, is_active, note from public.publisher_feeds where domain in ('reuters.com', 'apnews.com', 'bloomberg.com') order by domain",
    );
    expect(retired.map((feed) => [feed.domain, feed.is_active])).toEqual([["apnews.com", false], ["bloomberg.com", false], ["reuters.com", false]]);
    for (const feed of retired) expect(feed.note).toMatch(/2026-09-17/);
  });

  it("writes a run's feed health in one statement, touching health columns only, and only for the service role", async () => {
    const [{ id, url, mode }] = await database.rows<{ id: string; url: string; mode: string }>("select id, url, mode from public.publisher_feeds where domain = 'espn.com' order by url limit 1");
    const [{ written }] = await database.rows<{ written: number }>("select public.record_feed_health($1::jsonb) as written", [
      JSON.stringify([
        { id, fetched_at: "2026-09-17T15:15:29Z", status: "ok", http_status: 200, error: null, item_count: 24, dated_count: 24, described_count: 24, matched_count: 3, newest_published_at: "2026-09-17T15:12:00Z", discovered_url: null, etag: '"abc"', last_modified: null, consecutive_failures: 0 },
        { id: "00000000-0000-4000-8000-000000000000", fetched_at: "2026-09-17T15:15:29Z", status: "error", http_status: 503, error: "gone", item_count: null, dated_count: null, described_count: null, matched_count: 0, newest_published_at: null, discovered_url: null, etag: null, last_modified: null, consecutive_failures: 1 },
      ]),
    ]);
    expect(Number(written)).toBe(1);
    const [row] = await database.rows<Record<string, unknown>>("select url, mode, last_status, last_http_status, last_item_count, last_matched_count, etag, consecutive_failures, last_fetched_at::text as fetched from public.publisher_feeds where id = $1", [id]);
    expect(row).toMatchObject({ url, mode, last_status: "ok", last_http_status: 200, last_item_count: 24, last_matched_count: 3, etag: '"abc"', consecutive_failures: 0 });
    expect(String(row.fetched)).toContain("2026-09-17 15:15:29");
    for (const role of USER_ROLES) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select has_function_privilege($1, 'public.record_feed_health(jsonb)', 'execute') as ok", [role]);
      expect(ok, `${role} may execute record_feed_health`).toBe(false);
    }
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
      "apisports.game_interceptions",
      "apisports.game_passing_yards",
      "apisports.game_rating",
      "twitch.clips_per_stream_hour",
      "twitch.follower_count",
      "twitch.session_peak_viewers",
      "twitch.stream_days_7d",
      "twitch.stream_hours_7d",
    ]);

    // No instantaneous live reading is a metric: a concurrent-viewer count read
    // at an arbitrary minute has a distribution set by the polling schedule. The
    // one audience metric is the PEAK OF A WHOLE SESSION, recorded once per
    // session when it ends (Phase 16), and needs five sessions before it says anything.
    expect(Object.keys(metrics).filter((key) => /viewer/.test(key))).toEqual(["twitch.session_peak_viewers"]);
    expect(metrics["twitch.session_peak_viewers"]).toMatchObject({ delta: "level", polarity: 1, min_samples: 5, baseline_window_hours: 720 });
    expect(metrics["twitch.clips_per_stream_hour"]).toMatchObject({ delta: "level", polarity: 1, min_samples: 5, baseline_window_hours: 720 });

    // A weekly sport cannot reach the platform's usual 24 samples inside one
    // season, so every per-game metric declares the same reachable minimum:
    // the sample count is the number of games whichever figure is asked, and
    // what differs between the figures is noise, which is the sd floor's job.
    for (const key of ["game_passing_yards", "game_rating", "game_interceptions"]) {
      expect(metrics[`apisports.${key}`].min_samples, key).toBe(8);
      expect(Number(metrics[`apisports.${key}`].baseline_window_hours), key).toBeGreaterThanOrEqual(8 * 168);
    }
    // Interceptions count against him; the other two for him.
    expect(metrics["apisports.game_interceptions"].polarity).toBe(-1);
    expect(metrics["apisports.game_rating"].polarity).toBe(1);
    expect(metrics["apisports.game_passing_yards"].polarity).toBe(1);
    // Every declared per-game metric says where it lives in the per-game
    // response, and nothing points at a composite figure ("comp att", "sacks").
    const apisports = sources.find((source) => source.name === "apisports")!.config as { game_stats: Record<string, { group: string; name: string }> };
    expect(Object.keys(apisports.game_stats).sort()).toEqual(["game_interceptions", "game_passing_yards", "game_rating"]);
    expect(apisports.game_stats).toEqual({
      game_passing_yards: { group: "Passing", name: "yards" },
      game_rating: { group: "Passing", name: "rating" },
      game_interceptions: { group: "Passing", name: "interceptions" },
    });
    for (const lookup of Object.values(apisports.game_stats)) expect(lookup.name).not.toMatch(/comp att|sacks/);

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

  it("selects raw_payload from signals only where the Engine scores, the runner writes, or a METRIC is rendered", () => {
    // Phase 7 let no user-facing file touch raw_payload at all. Phase 21+ has
    // the consumer app render a metric signal's sentence and its counts FROM
    // the payload, which is what carries the headlines stored in sigma. So the
    // rule narrows rather than lifts: these two files may read it, and nothing
    // else may start to without this list being changed deliberately.
    //
    // What makes it safe is the layer beneath: signals_enforce_metric_privacy
    // allow-lists a metric payload's keys, so "the payload" is already the
    // safe subset, and the two tests below hold that shut.
    const root = join(__dirname, "..", "..");
    const allowed = ["lib/person/profile-model.ts", "lib/person/profile.ts"];
    const selectors = sourceFiles(root)
      .filter((file) => /^(app|components|lib\/(feed|person|home|portfolio))\//.test(relative(root, file)))
      .filter((file) => /raw_payload|rawPayload/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
      .sort();
    expect(selectors).toEqual(allowed);

    // And none of them names a raw statistic column: the payload is read, the
    // raw tables are not.
    for (const file of allowed) {
      const text = readFileSync(join(root, file), "utf8");
      for (const column of ["raw_source_snapshots", "raw_metric_observations", "sd_applied", "min_samples"]) {
        expect(text, `${file} names ${column}`).not.toContain(column);
      }
    }
  });
});

/**
 * THE GATE (Phase 21+). A metric may publish its observed count, and only if
 * its declaration says so. These hold the two ends of that shut: the database
 * refuses a malformed attempt, and the roster declares it on counts alone.
 */
describe("publish_observed", () => {
  it("refuses a published count without the pace it is read against", async () => {
    const [person] = await database.rows<{ id: string }>("select id from public.people limit 1");
    const [source] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'rss'");
    const insert = (payload: Record<string, unknown>) =>
      database.rows(
        `insert into public.signals (person_id, data_source_id, headline, raw_payload, occurred_at)
         values ($1, $2, 'A reading', $3::jsonb, now()) returning id`,
        [person.id, source.id, JSON.stringify(payload)],
      );
    const base = { kind: "metric", metric: "news_volume_24h", label: "news volume", sigma: 2.9, direction: 1, polarity: 1, window_hours: 336, source: "rss" };

    // Half a comparison is a bare level, not transparency.
    await expect(insert({ ...base, observed: 12 })).rejects.toThrow(/observed and baseline/);
    await expect(insert({ ...base, baseline: 4 })).rejects.toThrow(/observed and baseline/);
    // A count that is not a number is not a count.
    await expect(insert({ ...base, observed: "twelve", baseline: 4 })).rejects.toThrow(/observed and baseline/);
    // Anything outside the allow-list is still refused, gate or no gate.
    await expect(insert({ ...base, value: 12 })).rejects.toThrow(/is not allowed/);

    const [ok] = await database.rows<{ id: string }>(
      `insert into public.signals (person_id, data_source_id, headline, raw_payload, occurred_at)
       values ($1, $2, '12 stories today', $3::jsonb, now()) returning id`,
      [person.id, source.id, JSON.stringify({ ...base, observed: 12, baseline: 4 })],
    );
    expect(ok.id).toBeTruthy();
    await database.rows("delete from public.signals where id = $1", [ok.id]);
  });

  it("is declared on public counts alone, never on an audience level", async () => {
    const rows = await database.rows<{ metric: string; publishes: boolean; delta: string }>(`
      select m.key as metric,
             coalesce((m.value->>'publish_observed')::boolean, false) as publishes,
             m.value->>'delta' as delta
        from public.data_sources d, jsonb_each(coalesce(d.config->'metrics','{}'::jsonb)) m
       where d.is_active
    `);
    const publishing = rows.filter((row) => row.publishes).map((row) => row.metric).sort();
    expect(publishing).toEqual([
      "clips_per_stream_hour", "company_news_volume_24h", "news_volume_24h",
      "stream_days_7d", "stream_hours_7d", "viral_moment_rate",
    ]);

    // An audience metric cannot publish a total by ANY route: none of them
    // opts in, and each is a relative_rate anyway, so its observed quantity is
    // a growth rate rather than a level.
    for (const metric of ["subscriber_count", "view_count", "recent_video_views", "follower_count"]) {
      const row = rows.find((candidate) => candidate.metric === metric);
      expect(row, metric).toBeDefined();
      expect(row!.publishes, `${metric} publishes`).toBe(false);
      expect(row!.delta, `${metric} delta`).toBe("relative_rate");
    }
    // Peak concurrent viewers IS a level, and is kept out by the gate alone.
    const peak = rows.find((row) => row.metric === "session_peak_viewers");
    expect(peak?.delta).toBe("level");
    expect(peak?.publishes).toBe(false);
  });
});
