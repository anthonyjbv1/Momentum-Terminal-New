import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { CREATOR_CATEGORIES, METRIC_VOICE } from "@/lib/signals/metric-language";

import { COMPANY_BY_TICKER, companyForTicker } from "./company";

/**
 * Phase 30, rules 3 and 5, held against the SEEDED database rather than a
 * fixture: every executive's company resolves from the mapping the connector
 * actually polls, and every creator-platform metric is declared only on
 * creator and musician mappings, so its nouns can never be said of anyone
 * else.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

describe("the company behind a company-news signal", () => {
  it("resolves for every active Finnhub mapping on the board", async () => {
    const rows = await database.rows<{ slug: string; ticker: string }>(
      `select p.slug, pds.external_identifier as ticker
         from public.person_data_sources pds
         join public.people p on p.id = pds.person_id
         join public.data_sources d on d.id = pds.data_source_id
        where d.name = 'finnhub' and pds.is_active and p.is_active
        order by p.slug`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const row of rows) expect(companyForTicker(row.ticker), `${row.slug} (${row.ticker})`).toBeTruthy();
  });

  it("forgives case and space, and knows nothing it was not told", () => {
    expect(companyForTicker(" tsla ")).toBe("Tesla");
    expect(companyForTicker("BRK.B")).toBe("Berkshire Hathaway");
    expect(companyForTicker("GOOGL")).toBe("Alphabet");
    expect(companyForTicker("XYZ")).toBeNull();
    expect(companyForTicker(null)).toBeNull();
    for (const name of Object.values(COMPANY_BY_TICKER)) expect(name).not.toMatch(/company|'s\b/i);
  });
});

describe("creator-platform metrics reach creators only", () => {
  it("every metric whose voice is for creators is declared on creator and musician mappings alone", async () => {
    const creatorMetrics = Object.entries(METRIC_VOICE)
      .filter(([, voice]) => voice.audience === "creator")
      .map(([metric]) => metric);
    expect(creatorMetrics.length).toBeGreaterThan(0);

    // Every metric a source declares, and the categories of the people mapped to it.
    const rows = await database.rows<{ source: string; metric: string; category: string }>(
      `select d.name as source, m.key as metric, p.category
         from public.data_sources d
         cross join lateral jsonb_object_keys(coalesce(d.config->'metrics', '{}'::jsonb)) as m(key)
         join public.person_data_sources pds on pds.data_source_id = d.id and pds.is_active
         join public.people p on p.id = pds.person_id and p.is_active
        order by 1, 2, 3`,
    );
    const offenders = rows.filter((row) => creatorMetrics.includes(row.metric) && !CREATOR_CATEGORIES.includes(row.category));
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
  });
});
