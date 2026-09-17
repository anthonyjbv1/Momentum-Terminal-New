import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { readDisambiguation } from "@/lib/ingest/disambiguation";

/**
 * PHASE 15 on real Postgres: every subject on both news doors, with sensible
 * topics and the disambiguation the shared names need, and the volume
 * baseline the Engine reads.
 */

const TOPICS = ["general", "entertainment", "music", "tech", "creator", "business", "sports", "nfl", "gaming", "streaming"];
/** Names shared with somebody the feeds also write about, and so seeded with exclusions. */
const AMBIGUOUS = ["elon-musk", "jeff-bezos", "mark-zuckerberg", "warren-buffett", "kendrick-lamar", "drake"];
/** Names unique as a phrase: nothing invented for them. */
const UNIQUE = ["jensen-huang", "larry-ellison", "larry-page", "sergey-brin", "michael-dell", "adin-ross", "kai-cenat", "mrbeast", "patrick-mahomes"];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

interface MappingRow {
  slug: string;
  category: string;
  source: string;
  external_identifier: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
}

async function mappings(): Promise<MappingRow[]> {
  return database.rows<MappingRow>(
    "select p.slug, p.category, d.name as source, m.external_identifier, m.is_active, m.config from public.person_data_sources m join public.people p on p.id = m.person_id join public.data_sources d on d.id = m.data_source_id where d.name in ('publisher_rss', 'rss') order by p.slug, d.name",
  );
}

describe("the sixteen subjects on the two news doors", () => {
  it("every active person has an active publisher_rss and rss mapping", async () => {
    const people = await database.rows<{ slug: string }>("select slug from public.people where is_active order by slug");
    expect(people).toHaveLength(16);
    const rows = await mappings();
    for (const { slug } of people) {
      for (const source of ["publisher_rss", "rss"]) {
        const row = rows.find((r) => r.slug === slug && r.source === source);
        expect(row, `${slug} on ${source}`).toBeDefined();
        expect(row!.is_active, `${slug} on ${source} active`).toBe(true);
      }
    }
  });

  it("selects feeds by topic: executives read business, tech and general; musicians music; creators the creator and streaming desks; nobody reads the NFL who is not in it", async () => {
    const rows = (await mappings()).filter((r) => r.source === "publisher_rss");
    for (const row of rows) {
      const topics = (row.config?.topics ?? []) as string[];
      expect(topics.length, `${row.slug} topics`).toBeGreaterThan(0);
      for (const topic of topics) expect(TOPICS, `${row.slug} topic ${topic}`).toContain(topic);
      expect(topics, `${row.slug} general`).toContain("general");
      if (row.category === "executive") expect(topics).toEqual(["business", "tech", "general"]);
      if (row.category === "musician") expect(topics).toContain("music");
      if (row.category === "creator") expect(topics).toContain("creator");
      if (row.slug !== "patrick-mahomes") expect(topics).not.toContain("nfl");
    }
    expect(rows.find((r) => r.slug === "patrick-mahomes")!.config!.topics).toContain("nfl");
  });

  it("names are matched as the row's identifier plus safe aliases only: no bare Page, Dell, Ellison, Lamar or Huang", async () => {
    const rows = (await mappings()).filter((r) => r.source === "publisher_rss");
    const terms = (slug: string) => [rows.find((r) => r.slug === slug)!.external_identifier, ...((rows.find((r) => r.slug === slug)!.config?.match_terms ?? []) as string[])];
    expect(terms("elon-musk")).toEqual(["Elon Musk", "Musk"]);
    expect(terms("mark-zuckerberg")).toEqual(["Mark Zuckerberg", "Zuckerberg", "Zuck"]);
    expect(terms("warren-buffett")).toEqual(["Warren Buffett", "Buffett"]);
    expect(terms("jeff-bezos")).toEqual(["Jeff Bezos", "Bezos"]);
    expect(terms("kendrick-lamar")).toEqual(["Kendrick Lamar", "Kendrick"]);
    for (const slug of ["larry-page", "michael-dell", "larry-ellison", "jensen-huang", "sergey-brin", "adin-ross", "anthony-baptiste"]) {
      expect(terms(slug), slug).toHaveLength(1);
    }
    for (const row of rows) {
      for (const term of terms(row.slug)) expect(["Page", "Dell", "Ellison", "Lamar", "Huang", "Ross", "Brin"], `${row.slug} bare ${term}`).not.toContain(term);
    }
  });

  it("seeds exclusions where the name is shared, nothing where it is unique, and a required context for the one name with no coverage", async () => {
    const rows = await mappings();
    for (const row of rows) {
      const rules = readDisambiguation(row.config as Record<string, never> | null);
      if (AMBIGUOUS.includes(row.slug)) expect(rules.exclude_terms.length, `${row.slug} on ${row.source}`).toBeGreaterThan(0);
      if (UNIQUE.includes(row.slug)) expect(rules.exclude_terms, `${row.slug} on ${row.source}`).toEqual([]);
      if (row.slug === "anthony-baptiste") expect(rules.require_any).toEqual(["momentum terminal", "baptiste facility"]);
      else expect(rules.require_any, `${row.slug} requires nothing`).toEqual([]);
    }
    // The other entities, by name and by discourse.
    const musk = readDisambiguation(rows.find((r) => r.slug === "elon-musk" && r.source === "publisher_rss")!.config as Record<string, never>);
    expect(musk.exclude_terms).toEqual(expect.arrayContaining(["kimbal musk", "musk ox", "musk deer"]));
    const zuck = readDisambiguation(rows.find((r) => r.slug === "mark-zuckerberg" && r.source === "rss")!.config as Record<string, never>);
    expect(zuck.exclude_terms).toEqual(expect.arrayContaining(["indiana lawyer", "randi zuckerberg"]));
    const buffett = readDisambiguation(rows.find((r) => r.slug === "warren-buffett" && r.source === "rss")!.config as Record<string, never>);
    expect(buffett.exclude_terms).toEqual(expect.arrayContaining(["jimmy buffett", "margaritaville", "howard buffett"]));
    const kendrick = readDisambiguation(rows.find((r) => r.slug === "kendrick-lamar" && r.source === "publisher_rss")!.config as Record<string, never>);
    expect(kendrick.exclude_terms).toEqual(expect.arrayContaining(["kendrick perkins", "anna kendrick", "lamar jackson"]));
    // Both doors carry the same block for a shared name.
    for (const slug of AMBIGUOUS) {
      const [a, b] = rows.filter((r) => r.slug === slug).map((r) => readDisambiguation(r.config as Record<string, never> | null));
      if (slug === "drake") continue; // Drake's publisher block was widened in Phase 13 and the two differ on purpose
      expect(a, slug).toEqual(b);
    }
  });

  it("points every Google News row at a quoted-name search on the US edition", async () => {
    const rows = (await mappings()).filter((r) => r.source === "rss");
    for (const row of rows) {
      const url = new URL(row.external_identifier);
      expect(url.origin + url.pathname, row.slug).toBe("https://news.google.com/rss/search");
      expect(url.searchParams.get("q"), row.slug).toMatch(/^"[^"]+"/);
      expect(url.searchParams.get("ceid")).toBe("US:en");
    }
  });

  it("polls the two news doors four people at a time; nothing else declares a concurrency", async () => {
    const rows = await database.rows<{ name: string; concurrency: number | null }>("select name, (config ->> 'poll_concurrency')::int as concurrency from public.data_sources order by name");
    expect(rows.filter((r) => r.concurrency !== null).map((r) => [r.name, r.concurrency])).toEqual([
      ["publisher_rss", 4],
      ["rss", 4],
    ]);
  });
});

describe("person_signal_volume()", () => {
  it("returns one row per active person with the regime start, the trailing day and the complete days since; service role only", async () => {
    const rows = await database.rows<{ person_id: string; tracked_since: string; current_24h: string; daily: number[] | string }>("select * from public.person_signal_volume(14) order by person_id");
    expect(rows).toHaveLength(16);
    for (const row of rows) {
      expect(row.tracked_since).not.toBeNull();
      expect(Number(row.current_24h)).toBe(0);
      // Mapped today: no complete day yet, so nothing to build a baseline from.
      expect(Array.isArray(row.daily) ? row.daily : JSON.parse(String(row.daily).replace("{", "[").replace("}", "]"))).toEqual([]);
    }
    for (const role of ["anon", "authenticated"]) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select has_function_privilege($1, 'public.person_signal_volume(integer)', 'execute') as ok", [role]);
      expect(ok, `${role} may execute person_signal_volume`).toBe(false);
    }
  });

  it("counts event signals per complete UTC day since the newest mapping, metric signals excluded, days without signals as zero", async () => {
    const [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'mrbeast'");
    const [{ id: sourceId }] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'rss'");
    // Tracked since ten days ago at noon: nine complete days before today.
    await database.rows("update public.person_data_sources set created_at = (now() at time zone 'utc')::date - 10 + interval '12 hours' where person_id = $1", [personId]);
    const insert = (daysAgo: number, index: number, kind: string) =>
      database.rows(
        "insert into public.signals (person_id, data_source_id, headline, raw_payload, dedupe_key, occurred_at) values ($1, $2, $3, $4::jsonb, $5, ((now() at time zone 'utc')::date - $6::int + interval '6 hours') at time zone 'utc')",
        [
          personId,
          sourceId,
          `story ${daysAgo}-${index}`,
          // A metric row must satisfy the privacy trigger: an explicit polarity and a numeric sigma, nothing raw.
          JSON.stringify(kind === "metric" ? { kind, metric: "news_volume_24h", polarity: 1, sigma: 2.1, direction: 1 } : { kind }),
          `vol-${daysAgo}-${index}-${kind}`,
          daysAgo,
        ],
      );
    // Three articles nine days ago (the first complete day), one eight days ago, two metric rows seven days ago (not volume), five yesterday, two today.
    for (let i = 0; i < 3; i += 1) await insert(9, i, "article");
    await insert(8, 0, "article");
    await insert(7, 0, "metric");
    await insert(7, 1, "metric");
    for (let i = 0; i < 5; i += 1) await insert(1, i, "article");
    await insert(0, 0, "article");
    await insert(0, 1, "comment_digest");
    // Before the regime started: not evidence.
    await insert(12, 0, "article");

    const [row] = await database.rows<{ current_24h: string; daily: string }>("select current_24h, daily::text as daily from public.person_signal_volume(14) where person_id = $1", [personId]);
    expect(row.daily).toBe("{3,1,0,0,0,0,0,0,5}");
    // Today's two are in the trailing 24 hours (they occurred at 06:00 UTC today), and so may be some of yesterday's depending on the clock.
    expect(Number(row.current_24h)).toBeGreaterThanOrEqual(2);
    expect(Number(row.current_24h)).toBeLessThanOrEqual(7);
    // The window bounds the series: four days asks for the last four complete days only.
    const [short] = await database.rows<{ daily: string }>("select daily::text as daily from public.person_signal_volume(4) where person_id = $1", [personId]);
    expect(short.daily).toBe("{0,0,0,5}");
  });
});
