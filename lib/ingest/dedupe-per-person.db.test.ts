import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

import { createMemoryIngestStore } from "./store";

/**
 * A DEDUPE KEY IS UNIQUE PER SOURCE AND PERSON (Phase 29d).
 *
 * Larry Page and Sergey Brin are both on Finnhub as GOOGL, and the metric
 * signal's key — metric:finnhub:GOOGL:company_news_volume_24h:<time> — names
 * the item, not the person. Under the old rule, unique per data source alone,
 * the store's ON CONFLICT DO NOTHING refused whichever of the two arrived
 * second, silently, on every poll: Brin had never had a Finnhub signal. The
 * same held for any item two people share (an article in two people's feeds,
 * a game two tracked players played in). The rule now includes the person, on
 * the real schema and in the in-memory store the ingestion tests run on.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

const KEY = "metric:finnhub:GOOGL:company_news_volume_24h:2026-09-25T16:00:00.000Z";

async function ids(): Promise<{ page: string; brin: string; finnhub: string }> {
  const [row] = await database.rows<{ page: string; brin: string; finnhub: string }>(
    `select (select id from public.people where slug = 'larry-page') as page,
            (select id from public.people where slug = 'sergey-brin') as brin,
            (select id from public.data_sources where name = 'finnhub') as finnhub`,
  );
  return row;
}

/** Exactly the store's insert: ON CONFLICT on the per-person rule, DO NOTHING. */
async function insert(personId: string, dataSourceId: string, key: string | null): Promise<number> {
  const rows = await database.rows<{ id: string }>(
    `insert into public.signals (person_id, data_source_id, headline, raw_payload, occurred_at, dedupe_key, processed)
     values ($1, $2, 'Alphabet in the news', '{"kind":"article"}'::jsonb, now(), $3, false)
     on conflict (data_source_id, person_id, dedupe_key) do nothing
     returning id`,
    [personId, dataSourceId, key],
  );
  return rows.length;
}

describe("the signals table", () => {
  it("keeps the same item for each person it belongs to", async () => {
    const { page, brin, finnhub } = await ids();
    expect(await insert(page, finnhub, KEY)).toBe(1);
    expect(await insert(brin, finnhub, KEY)).toBe(1);
  });

  it("still refuses the same item twice for the same person", async () => {
    const { page, finnhub } = await ids();
    expect(await insert(page, finnhub, KEY)).toBe(0);
    const [count] = await database.rows<{ n: string }>("select count(*)::text as n from public.signals where dedupe_key = $1", [KEY]);
    expect(count.n).toBe("2");
  });

  it("never conflicts on a NULL key", async () => {
    const { page, finnhub } = await ids();
    expect(await insert(page, finnhub, null)).toBe(1);
    expect(await insert(page, finnhub, null)).toBe(1);
  });

  it("carries the per-person rule and no longer the source-only one", async () => {
    const constraints = await database.rows<{ name: string; definition: string }>(
      "select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'public.signals'::regclass and contype = 'u' order by 1",
    );
    expect(constraints).toEqual([{ name: "signals_source_person_dedupe_key_unique", definition: "UNIQUE (data_source_id, person_id, dedupe_key)" }]);
  });
});

describe("the in-memory store the ingestion tests run on", () => {
  it("follows the same rule", async () => {
    const store = createMemoryIngestStore();
    const row = (personId: string, dedupeKey: string | undefined) => ({ personId, dataSourceId: "finnhub", headline: "h", rawPayload: {}, occurredAt: new Date(), dedupeKey, tier: null });
    expect(await store.insertSignals([row("page", KEY), row("brin", KEY)])).toHaveLength(2);
    expect(await store.insertSignals([row("page", KEY)])).toHaveLength(0);
    expect(await store.insertSignals([row("page", undefined), row("page", undefined)])).toHaveLength(2);
  });
});
