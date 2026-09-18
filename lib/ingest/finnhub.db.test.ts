import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { COMPANY_NEWS_VOLUME_METRIC, DAILY_CLOSE_METRIC, PRICE_DERIVED_METRICS } from "@/lib/connectors/finnhub";

/**
 * PHASE 17 on real Postgres: the executives are on Finnhub, and NO PRICE
 * REACHES A SCORE.
 *
 * That last one is the reason the phase exists, so it is asserted against the
 * shipped schema rather than against the connector's intentions: every key the
 * connector can derive from a security price must be on the source row's
 * observe_only list, none of them may be declared as a metric, and the view the
 * operator console reads must be unable to show anything that scores.
 */

/** Ticker per executive, and the SEC's spelling of their name on a Form 4. */
const EXECUTIVES: Array<[slug: string, symbol: string, insider: string]> = [
  ["elon-musk", "TSLA", "Musk Elon"],
  ["jeff-bezos", "AMZN", "Bezos Jeffrey"],
  ["jensen-huang", "NVDA", "Huang Jen Hsun"],
  ["larry-ellison", "ORCL", "Ellison Lawrence"],
  ["larry-page", "GOOGL", "Page Larry"],
  ["mark-zuckerberg", "META", "Zuckerberg Mark"],
  ["michael-dell", "DELL", "Dell Michael"],
  ["sergey-brin", "GOOGL", "Brin Sergey"],
  ["warren-buffett", "BRK.B", "Buffett Warren"],
];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

interface SourceRow {
  is_active: boolean;
  tier: number;
  poll_interval_minutes: number;
  config: { observe_only?: string[]; metrics?: Record<string, Record<string, unknown>>; insider_codes?: string[]; poll_concurrency?: number };
}

async function finnhub(): Promise<SourceRow> {
  const [row] = await database.rows<SourceRow>("select is_active, tier, poll_interval_minutes, config from public.data_sources where name = 'finnhub'");
  return row;
}

describe("the executives on Finnhub", () => {
  it("maps every executive to their company, with the name their Form 4 files under", async () => {
    const rows = await database.rows<{ slug: string; identifier: string; is_active: boolean; config: { insider_names?: string[] } }>(
      "select p.slug, m.external_identifier as identifier, m.is_active, m.config from public.person_data_sources m join public.people p on p.id = m.person_id join public.data_sources d on d.id = m.data_source_id where d.name = 'finnhub' order by p.slug",
    );
    expect(rows.map((row) => [row.slug, row.identifier])).toEqual(EXECUTIVES.map(([slug, symbol]) => [slug, symbol]));
    for (const [slug, , insider] of EXECUTIVES) {
      const row = rows.find((candidate) => candidate.slug === slug)!;
      expect(row.is_active, `${slug} active`).toBe(true);
      expect(row.config.insider_names, `${slug} insider names`).toContain(insider);
    }
    // Every executive the platform tracks, and nobody who is not one.
    const executives = await database.rows<{ slug: string }>("select slug from public.people where is_active and category = 'executive' order by slug");
    expect(executives.map((row) => row.slug)).toEqual(EXECUTIVES.map(([slug]) => slug));
  });

  it("puts Page and Brin on the same company, which is a fact about Alphabet and not a mistake", async () => {
    const rows = await database.rows<{ slug: string; identifier: string }>(
      "select p.slug, m.external_identifier as identifier from public.person_data_sources m join public.people p on p.id = m.person_id join public.data_sources d on d.id = m.data_source_id where d.name = 'finnhub' and m.external_identifier = 'GOOGL' order by p.slug",
    );
    expect(rows.map((row) => row.slug)).toEqual(["larry-page", "sergey-brin"]);
    // Their company news is one series; their filings are told apart by name.
    const names = await database.rows<{ slug: string; names: string[] }>(
      "select p.slug, m.config -> 'insider_names' as names from public.person_data_sources m join public.people p on p.id = m.person_id join public.data_sources d on d.id = m.data_source_id where d.name = 'finnhub' and m.external_identifier = 'GOOGL' order by p.slug",
    );
    expect(names[0].names).not.toEqual(names[1].names);
  });

  it("is active on an interval that is neither a multiple of fifteen nor the top of the hour", async () => {
    const row = await finnhub();
    expect(row.is_active).toBe(true);
    expect(row.poll_interval_minutes).toBe(35);
    expect(row.poll_interval_minutes % 15).not.toBe(0);
    // 55 comes due at exactly :00 on a fifteen-minute cron, which is why five
    // sources already land together there. 35 comes due every 45 minutes and
    // cycles, so it shares the top of the hour one poll in four.
    expect(row.poll_interval_minutes).not.toBe(55);
    expect(row.config.poll_concurrency).toBe(4);
  });
});

describe("no price reaches a score", () => {
  it("declares exactly one metric, a COUNT, and no price-derived key among them", async () => {
    const row = await finnhub();
    expect(Object.keys(row.config.metrics ?? {})).toEqual([COMPANY_NEWS_VOLUME_METRIC]);
    for (const key of PRICE_DERIVED_METRICS) {
      expect(Object.keys(row.config.metrics ?? {}), `${key} is declared as a metric`).not.toContain(key);
    }
    // A windowed count, like news_volume_24h: the window is the measurement.
    expect(row.config.metrics?.[COMPANY_NEWS_VOLUME_METRIC]).toMatchObject({ delta: "level", polarity: 1, baseline_window_hours: 336, min_samples: 24 });
  });

  it("lists EVERY price-derived key the connector can produce on observe_only", async () => {
    const row = await finnhub();
    // The invariant: a price metric added to the connector without the matching
    // row change fails here rather than reaching a score.
    expect(row.config.observe_only ?? []).toEqual([...PRICE_DERIVED_METRICS]);
    expect(row.config.observe_only).toContain(DAILY_CLOSE_METRIC);
  });

  it("scores only decisions an insider took, never compensation mechanics", async () => {
    const row = await finnhub();
    expect(row.config.insider_codes).toEqual(["P", "S"]);
    // An award, an option exercise, tax withholding and a gift say nothing
    // about conviction; scoring an award would mean the board paying the CEO
    // moved the CEO's score.
    for (const code of ["A", "M", "F", "G"]) expect(row.config.insider_codes, `code ${code}`).not.toContain(code);
  });
});

describe("observe_only_snapshots", () => {
  it("shows an observe-only reading and CANNOT show one that scores", async () => {
    const [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'elon-musk'");
    const [{ id: sourceId }] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'finnhub'");
    const record = (metricKey: string, value: number) =>
      database.rows("insert into public.raw_source_snapshots (person_id, data_source_id, metric_key, value, recorded_at) values ($1, $2, $3, $4, now())", [personId, sourceId, metricKey, value]);
    await record(DAILY_CLOSE_METRIC, 425.5);
    await record(COMPANY_NEWS_VOLUME_METRIC, 37);

    const rows = await database.rows<{ person_slug: string; source: string; identifier: string; metric_key: string; value: string }>("select * from public.observe_only_snapshots order by metric_key");
    // The close is visible, with the value, which is the point: it can be watched.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_slug: "elon-musk", source: "finnhub", identifier: "TSLA", metric_key: DAILY_CLOSE_METRIC });
    expect(Number(rows[0].value)).toBe(425.5);
    // The metric that scores is not in the view, so the operator console cannot
    // show a level that moved a score even by accident.
    expect(rows.map((row) => row.metric_key)).not.toContain(COMPANY_NEWS_VOLUME_METRIC);
  });

  it("is bounded by the list, so the edit that lets a key count is the edit that hides it here", async () => {
    // Turning the close on: drop it from observe_only, declare it as a metric.
    await database.rows(
      "update public.data_sources set config = jsonb_set(jsonb_set(config, '{observe_only}', '[]'::jsonb), '{metrics,daily_close}', '{\"label\":\"daily close\",\"delta\":\"level\",\"polarity\":1,\"baseline_window_hours\":720,\"min_samples\":20,\"sd_floor\":1,\"scale\":1}'::jsonb) where name = 'finnhub'",
    );
    expect(await database.rows("select 1 from public.observe_only_snapshots")).toEqual([]);
    // And back: one row update, no deploy, in either direction.
    await database.rows("update public.data_sources set config = jsonb_set(config #- '{metrics,daily_close}', '{observe_only}', '[\"daily_close\"]'::jsonb) where name = 'finnhub'");
    expect(await database.rows("select 1 from public.observe_only_snapshots")).toHaveLength(1);
  });

  it("is service role only, like the table underneath it", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [{ ok }] = await database.rows<{ ok: boolean }>("select has_table_privilege($1, 'public.observe_only_snapshots', 'select') as ok", [role]);
      expect(ok, `${role} may read observe_only_snapshots`).toBe(false);
    }
  });
});
