import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * The Feed's SQL, run against a real Postgres with the migrations applied:
 * the narrative ↔ signal link the Engine records, the integrity rule on it,
 * feed_entries() reading evidence from that link and nothing else, and the
 * keyset cursor staying exact when many entries share one timestamp.
 */

/** A microsecond timestamp: the cursor has to survive the round trip whole. */
const TICK_AT = "2026-09-10 12:00:00.123456+00";
const BURST_AT = "2026-09-11 00:00:00.500000+00";

let database: TestDatabase;
const people = new Map<string, string>();
let youtube: { id: string; name: string };

interface FeedRow {
  kind: string;
  id: string;
  person_slug: string;
  text: string;
  occurred_at: string;
  sources: string[];
  evidence: Array<{ id: string; relation: string; person_name: string | null; impact: number | string | null; source: string | null }>;
}

async function feed(before: string | null = null, beforeId: string | null = null, limit = 24): Promise<FeedRow[]> {
  return database.rows<FeedRow>(
    `select kind, id, person_slug, text, occurred_at::text as occurred_at, sources, evidence
       from public.feed_entries($1::timestamptz, $2::uuid, $3::int)`,
    [before, beforeId, limit],
  );
}

async function signal(slug: string, headline: string, options: { at?: string; impact?: number | null; processed?: boolean } = {}): Promise<string> {
  const [row] = await database.rows<{ id: string }>(
    `insert into public.signals (person_id, data_source_id, headline, occurred_at, impact_score, processed, processed_at, sentiment_label, sentiment_confidence)
     values ($1, $2, $3, $4::timestamptz, $5, $6, case when $6 then $4::timestamptz end, case when $6 then 'positive' end, case when $6 then 0.8 end)
     returning id`,
    [people.get(slug), youtube.id, headline, options.at ?? TICK_AT, options.impact ?? null, options.processed ?? true],
  );
  return row.id;
}

interface NarrativeInput {
  slug: string;
  text: string;
  before?: number;
  after?: number;
  source?: string;
  signals?: Array<{ signal_id: string; relation?: string }>;
}

async function record(rows: NarrativeInput[]): Promise<number> {
  const payload = rows.map((row) => ({
    person_id: people.get(row.slug),
    tick_number: 1,
    text: row.text,
    score_before: row.before ?? 50,
    score_after: row.after ?? 51,
    source: row.source ?? "template",
    signals: row.signals ?? [],
  }));
  const [result] = await database.rows<{ n: number }>("select public.record_narratives($1::jsonb) as n", [JSON.stringify(payload)]);
  return Number(result.n);
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  [youtube] = await database.rows<{ id: string; name: string }>("select id, display_name as name from public.data_sources where name = 'youtube'");
  await database.exec(`insert into public.engine_ticks (tick_number, started_at, finished_at) values (1, '${TICK_AT}', '${TICK_AT}')`);
  // Narratives are stamped by the database; pin them to the tick so the order is known.
  await database.exec(`alter table public.narratives alter column created_at set default '${TICK_AT}'::timestamptz`);
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("record_narratives and narrative_signals", () => {
  let drakeAlbum: string;
  let drakeTour: string;
  let beastUpload: string;
  let loneProcessed: string;
  let unprocessed: string;

  beforeAll(async () => {
    drakeAlbum = await signal("drake", "Drake drops a surprise album", { impact: 1.2 });
    drakeTour = await signal("drake", "Drake adds tour dates", { impact: 0.4 });
    beastUpload = await signal("mrbeast", "MrBeast upload passes 40M views", { impact: 0.9 });
    // Processed in the same tick window as the narratives below, but linked to none of them.
    loneProcessed = await signal("elon-musk", "Tesla deliveries beat estimates", { impact: 0.3 });
    unprocessed = await signal("kai-cenat", "Kai Cenat announces a subathon", { processed: false });

    const written = await record([
      { slug: "drake", text: "Drake's momentum climbed on a surprise album and new tour dates.", source: "llm", after: 51.6, signals: [{ signal_id: drakeAlbum }, { signal_id: drakeTour }] },
      { slug: "mrbeast", text: 'MrBeast\'s momentum climbed on "MrBeast upload passes 40M views".', after: 50.9, signals: [{ signal_id: beastUpload }] },
      { slug: "elon-musk", text: "Elon Musk drifted up with a broadly positive market mood.", after: 50.6 },
      { slug: "kendrick-lamar", text: "Kendrick Lamar's momentum slipped as Drake's surge pulled the pair the other way.", after: 49.4, signals: [{ signal_id: drakeAlbum, relation: "inverse_pair" }] },
    ]);
    expect(written).toBe(4);
  });

  it("writes the sentence and its links together", async () => {
    const links = await database.rows<{ narrative_person: string; signal_id: string; relation: string }>(
      `select p.slug as narrative_person, ns.signal_id, ns.relation
         from public.narrative_signals ns
         join public.narratives n on n.id = ns.narrative_id
         join public.people p on p.id = n.person_id
        order by p.slug, ns.relation, ns.signal_id`,
    );
    expect(links).toEqual([
      { narrative_person: "drake", signal_id: [drakeAlbum, drakeTour].sort()[0], relation: "direct" },
      { narrative_person: "drake", signal_id: [drakeAlbum, drakeTour].sort()[1], relation: "direct" },
      { narrative_person: "kendrick-lamar", signal_id: drakeAlbum, relation: "inverse_pair" },
      { narrative_person: "mrbeast", signal_id: beastUpload, relation: "direct" },
    ]);
  });

  it("gives a narrative exactly its linked signals as evidence: several, one, none", async () => {
    const rows = await feed();
    const narrative = (slug: string) => rows.find((row) => row.kind === "narrative" && row.person_slug === slug)!;

    const drake = narrative("drake");
    expect(drake.evidence.map((item) => item.id)).toEqual([drakeAlbum, drakeTour]); // strongest first
    expect(drake.evidence.every((item) => item.relation === "direct")).toBe(true);
    expect(drake.sources).toEqual([youtube.name]);

    const beast = narrative("mrbeast");
    expect(beast.evidence.map((item) => item.id)).toEqual([beastUpload]);
    expect(beast.sources).toEqual([youtube.name]);

    const musk = narrative("elon-musk");
    expect(musk.evidence).toEqual([]);
    expect(musk.sources).toEqual([]);
  });

  it("marks the paired person's signal as inverse_pair evidence, with their name, and not as a source", async () => {
    const rows = await feed();
    const kendrick = rows.find((row) => row.kind === "narrative" && row.person_slug === "kendrick-lamar")!;
    expect(kendrick.evidence).toHaveLength(1);
    expect(kendrick.evidence[0]).toMatchObject({ id: drakeAlbum, relation: "inverse_pair", person_name: "Drake" });
    expect(kendrick.sources).toEqual([]);
  });

  it("does not infer evidence from the tick window: a processed but unlinked signal is its own entry", async () => {
    const rows = await feed();
    const signalIds = rows.filter((row) => row.kind === "signal").map((row) => row.id);
    expect(signalIds).toContain(loneProcessed);
    expect(signalIds).toContain(unprocessed);
    // Linked signals are explained, so they do not appear twice.
    expect(signalIds).not.toContain(drakeAlbum);
    expect(signalIds).not.toContain(drakeTour);
    expect(signalIds).not.toContain(beastUpload);
    // The Musk narrative and the Musk signal sit in the same tick window and stay unrelated.
    const musk = rows.find((row) => row.kind === "narrative" && row.person_slug === "elon-musk")!;
    expect(musk.evidence).toEqual([]);
  });

  it("refuses a link that disagrees with the people on both rows", async () => {
    const [drakeNarrative] = await database.rows<{ id: string }>("select n.id from public.narratives n join public.people p on p.id = n.person_id where p.slug = 'drake'");
    await expect(
      database.exec(`insert into public.narrative_signals (narrative_id, signal_id, relation) values ('${drakeNarrative.id}', '${beastUpload}', 'direct')`),
    ).rejects.toThrow(/direct link must point at a signal about the narrative's own person/);
    await expect(
      database.exec(`insert into public.narrative_signals (narrative_id, signal_id, relation) values ('${drakeNarrative.id}', '${beastUpload}', 'inverse_pair')`),
    ).rejects.toThrow(/paired with the narrative's person/);
    await expect(
      database.exec(`insert into public.narrative_signals (narrative_id, signal_id, relation) values ('${drakeNarrative.id}', '${drakeAlbum}', 'sideways')`),
    ).rejects.toThrow(/relation_check/);
  });
});

describe("feed_entries keyset pagination", () => {
  const PAGE = 24;

  beforeAll(async () => {
    // Forty entries — half narratives, half signals — at one identical instant,
    // so a page boundary falls inside the tie.
    await database.exec(`alter table public.narratives alter column created_at set default '${BURST_AT}'::timestamptz`);
    const slugs = [...people.keys()].sort();
    for (let index = 0; index < 20; index += 1) {
      await signal(slugs[index % slugs.length], `Burst signal ${index}`, { at: BURST_AT, impact: 0.1, processed: false });
    }
    await record(Array.from({ length: 20 }, (_, index) => ({ slug: slugs[index % slugs.length], text: `Burst narrative ${index}.`, after: 50.7 })));
  });

  async function allPages(): Promise<FeedRow[][]> {
    const pages: FeedRow[][] = [];
    let cursor: { before: string; beforeId: string } | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: FeedRow[] = await feed(cursor?.before ?? null, cursor?.beforeId ?? null, PAGE);
      pages.push(page);
      if (page.length < PAGE) break;
      const last = page[page.length - 1];
      cursor = { before: last.occurred_at, beforeId: last.id };
    }
    return pages;
  }

  it("neither skips nor repeats entries that share a timestamp across a page boundary", async () => {
    const everything = await feed(null, null, 100);
    expect(everything.length).toBeGreaterThan(PAGE);
    const burst = everything.filter((row) => row.occurred_at.startsWith("2026-09-11 00:00:00.5"));
    expect(burst).toHaveLength(40);

    const pages = await allPages();
    expect(pages.length).toBeGreaterThanOrEqual(2);
    // The boundary between the first two pages falls inside the tie.
    expect(pages[0][PAGE - 1].occurred_at).toBe(pages[1][0].occurred_at);

    const paged = pages.flat();
    expect(paged.map((row) => row.id)).toEqual(everything.map((row) => row.id));
    expect(new Set(paged.map((row) => row.id)).size).toBe(everything.length);
  });

  it("orders by (occurred_at desc, id desc) and returns the same order on every identical query", async () => {
    const runs = await Promise.all([allPages(), allPages(), allPages()]);
    const sequences = runs.map((pages) => pages.flat().map((row) => row.id));
    expect(sequences[1]).toEqual(sequences[0]);
    expect(sequences[2]).toEqual(sequences[0]);

    const rows = runs[0].flat();
    const sorted = [...rows].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id));
    expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
  });

  it("keeps microseconds through the cursor, so the boundary row is excluded and its same-instant neighbours are not", async () => {
    const everything = await feed(null, null, 100);
    const tick = everything.filter((row) => row.occurred_at.endsWith(".123456+00"));
    expect(tick).toHaveLength(6); // four narratives and two unexplained signals at TICK_AT
    const [head, ...rest] = tick;

    const next = (await feed(head.occurred_at, head.id, 100)).map((row) => row.id);
    expect(next).not.toContain(head.id);
    for (const row of rest) expect(next).toContain(row.id);

    // A cursor rounded to milliseconds would sit before every one of them and skip them all.
    const rounded = (await feed(head.occurred_at.replace(".123456", ".123"), head.id, 100)).map((row) => row.id);
    for (const row of rest) expect(rounded).not.toContain(row.id);
  });
});
