import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * PHASE 22 on real Postgres: the trending chart is one source, every active
 * person reads it, and the seed carries the matching decisions the connector
 * relies on — a channel route only where a channel id was VERIFIED, no bare
 * surnames, and the disambiguation block inherited from the news doors.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

interface SourceRow {
  display_name: string;
  tier: number;
  poll_interval_minutes: number;
  is_active: boolean;
  config: { region?: string; max_results?: number; metrics?: unknown; observe_only?: unknown };
}

interface MappingRow {
  slug: string;
  display_name: string;
  identifier: string;
  is_active: boolean;
  config: { channel_ids?: string[]; handles?: string[]; match_terms?: string[]; disambiguation?: { exclude_terms: string[]; require_any: string[] } };
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

const source = async () => (await database.rows<SourceRow>("select display_name, tier, poll_interval_minutes, is_active, config from public.data_sources where name = 'youtube_trending'"))[0];
const mappings = () =>
  database.rows<MappingRow>(
    "select p.slug, p.display_name, m.external_identifier as identifier, m.is_active, m.config from public.person_data_sources m join public.people p on p.id = m.person_id join public.data_sources d on d.id = m.data_source_id where d.name = 'youtube_trending' order by p.slug",
  );

describe("the source row", () => {
  it("is YouTube's own chart at tier 2, active, one national chart, the top fifty", async () => {
    const row = await source();
    expect(row).toBeDefined();
    expect(row.display_name).toBe("YouTube Trending");
    expect(row.tier).toBe(2);
    expect(row.is_active).toBe(true);
    expect(row.config).toEqual({ region: "US", max_results: 50 });
  });

  it("declares NO metric: the rank is never a level to baseline", async () => {
    const row = await source();
    expect(row.config.metrics).toBeUndefined();
    expect(row.config.observe_only).toBeUndefined();
  });

  it("polls every 25 minutes: off the multiple of fifteen, off the top of the hour, and every second fire of the cron", async () => {
    const row = await source();
    expect(row.poll_interval_minutes).toBe(25);
    expect(row.poll_interval_minutes % 15).not.toBe(0);
    // 55 comes due exactly on the hour beside youtube, youtube_comments and
    // twitch; 25 comes due every second fifteen-minute fire, an effective
    // thirty minutes — the chart's own refresh cadence.
    expect(row.poll_interval_minutes).not.toBe(55);
    expect(Math.ceil(row.poll_interval_minutes / 15) * 15).toBe(30);
  });
});

describe("the mappings", () => {
  it("cover every active person, keyed by display name, all active", async () => {
    const rows = await mappings();
    const people = await database.rows<{ slug: string; display_name: string }>("select slug, display_name from public.people where is_active order by slug");
    expect(rows.map((r) => r.slug)).toEqual(people.map((p) => p.slug));
    expect(rows).toHaveLength(16);
    for (const row of rows) {
      expect(row.identifier, row.slug).toBe(row.display_name);
      expect(row.is_active, row.slug).toBe(true);
    }
  });

  it("pin exactly the channels that were resolved through the official API and judged to be the person's own", async () => {
    const rows = await mappings();
    const pinned = Object.fromEntries(rows.filter((r) => (r.config.channel_ids ?? []).length > 0).map((r) => [r.slug, r.config.channel_ids]));
    expect(pinned).toEqual({
      // Re-verified rather than assumed: @MrBeast resolved to the id the board
      // already held, which is what his handle rode along for.
      mrbeast: ["UCX6OQ3DkcsbYNE6H8uQQuVA"],
      // THE ONE THIS FOLLOW-UP EXISTS FOR: his titles do not name him.
      "kai-cenat": ["UCoEmptob-eEGKk18c2VplJg"],
      // Personal AND label: the set doing the job it was widened for.
      "kendrick-lamar": ["UC3lBXcrKFnFAFkfVk5WuKcQ", "UCoYfzC2zMlc9M-Odgaf6OSg"],
      // NOT A DEFECT, though it reads as one: this channel is titled "Adin
      // Live" and not "Adin Ross". Two independent confirmations of ownership
      // — it holds the handle @AdinRoss, and it lists kick.com/adinross among
      // its links — verified at 4.62M subscribers. Creators routinely name a
      // channel differently from themselves. Do not "correct" this.
      "adin-ross": ["UCey-eDTR5J6xU6pZ2f4guoA"],
      // Both channels that matter, which is what the set was widened for: the
      // active one (@DrakeOfficial, 33.1M, where releases go up) and the label
      // catalogue (@DrakeVEVO). @Drake itself was refused; see below.
      drake: ["UCByOQJjav0CUDwxCk-jVNRQ", "UCQznUf1SjfDqx65hX3zRDiA"],
    });
    // The singular key is gone (the connector reads a set) and every id is well formed.
    for (const row of rows) {
      expect(row.config, row.slug).not.toHaveProperty("channel_id");
      for (const id of row.config.channel_ids ?? []) expect(id, `${row.slug}: ${id}`).toMatch(CHANNEL_ID);
    }
  });

  it("leave no handle behind once its resolution has been judged: a pinned id costs nothing, a handle costs a unit a poll", async () => {
    for (const row of await mappings()) {
      expect(row.config.handles ?? [], row.slug).toEqual([]);
    }
  });

  it("NEVER pin the @Drake handle: it resolves to a 491-subscriber namesake, which is the error the note channel exists to catch", async () => {
    const drake = (await mappings()).find((r) => r.slug === "drake")!;
    // The namesake's id must appear nowhere: arming it would credit Aubrey
    // Graham with that person's uploads the first time one charted.
    expect(drake.config.channel_ids).not.toContain("UCNTQH0uJzryQB4rRLGlv-Ww");
    // His main channel IS pinned, but it arrived through @DrakeOfficial
    // resolving to it — not through the chart sighting that suggested it. The
    // sighting was evidence of a NAME; the resolution is evidence of OWNERSHIP.
    expect(drake.config.channel_ids).toEqual(["UCByOQJjav0CUDwxCk-jVNRQ", "UCQznUf1SjfDqx65hX3zRDiA"]);
  });

  it("maps NO executive to a channel: a corporate channel is the company's upload schedule, not the person's", async () => {
    const executives = await database.rows<{ slug: string }>("select slug from public.people where category = 'executive' and is_active order by slug");
    expect(executives.length).toBeGreaterThanOrEqual(9);
    const rows = await mappings();
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    for (const { slug } of executives) {
      expect(bySlug.get(slug)!.config.channel_ids ?? [], slug).toEqual([]);
      expect(bySlug.get(slug)!.config.handles ?? [], slug).toEqual([]);
    }
  });

  it("admit no bare surname: match_terms is empty on every row, so a title must name the person in full", async () => {
    for (const row of await mappings()) {
      expect(row.config.match_terms, row.slug).toEqual([]);
    }
  });

  it("inherit each person's disambiguation block from the publisher feed mapping rather than restating it", async () => {
    const rows = await mappings();
    const inherited = await database.rows<{ slug: string; disambiguation: { exclude_terms: string[]; require_any: string[] } | null }>(
      "select p.slug, m.config -> 'disambiguation' as disambiguation from public.person_data_sources m join public.people p on p.id = m.person_id join public.data_sources d on d.id = m.data_source_id where d.name = 'publisher_rss' order by p.slug",
    );
    const byslug = new Map(inherited.map((r) => [r.slug, r.disambiguation]));
    for (const row of rows) {
      const expected = byslug.get(row.slug) ?? { exclude_terms: [], require_any: [] };
      expect(row.config.disambiguation, row.slug).toBeDefined();
      expect(row.config.disambiguation!.require_any, row.slug).toEqual(expected.require_any);
      // Every inherited exclusion is present; Drake's list is a superset (below).
      for (const term of expected.exclude_terms) expect(row.config.disambiguation!.exclude_terms, `${row.slug}: ${term}`).toContain(term);
    }
  });

  it("refuse the sitcom for Drake, on top of the university, the quarterback and the rest", async () => {
    const drake = (await mappings()).find((r) => r.slug === "drake")!;
    const terms = drake.config.disambiguation!.exclude_terms;
    for (const term of ["drake university", "drake maye", "drake bell", "drake london", "drake & josh", "drake and josh"]) {
      expect(terms, term).toContain(term);
    }
  });

  it("is idempotent: re-running the seed and its follow-up, in order, changes nothing", async () => {
    const before = await mappings();
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // In order, as a fresh database applies them: the seed rewrites each row's
    // config wholesale, and the follow-up puts the ids and handles back.
    for (const file of [
      "20260920192009_phase22_youtube_trending.sql",
      "20260920213950_phase22_trending_channel_handles.sql",
      "20260920215500_phase22_trending_pin_channel_ids.sql",
      "20260920220000_phase22_drake_official_handle.sql",
      "20260920221800_phase22_pin_drake_official.sql",
    ]) {
      await database.exec(readFileSync(join(__dirname, "..", "..", "supabase", "migrations", file), "utf8"));
    }
    expect(await mappings()).toEqual(before);
    expect((await database.rows("select count(*)::int as n from public.data_sources where name = 'youtube_trending'"))[0]).toEqual({ n: 1 });
  });
});
