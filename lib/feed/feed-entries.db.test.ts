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

describe("a voided signal (2026-09-28)", () => {
  it("is neither a card nor evidence, and a voided narrative is no card; the void needs its reason", async () => {
    const struck = await signal("larry-page", "Larry Page", { impact: -0.9 });
    const kept = await signal("larry-page", "Alphabet co-founder backs a flying-car venture", { impact: 0.3 });
    await record([{ slug: "larry-page", text: "Larry Page has died.", source: "llm", after: 49.1, signals: [{ signal_id: struck }, { signal_id: kept }] }]);
    const [{ id: narrativeId }] = await database.rows<{ id: string }>("select id from public.narratives where text = 'Larry Page has died.'");

    await expect(database.operator("update public.signals set voided_at = now() where id = $1", [struck])).rejects.toThrow(/signals_void_reason_with_time/);
    await database.operator("update public.signals set voided_at = now(), void_reason = 'obvious error: a namesake' where id = $1", [struck]);

    const before = await feed(null, null, 100);
    const narrative = before.find((row) => row.id === narrativeId)!;
    expect(narrative.evidence.map((e: { id: string }) => e.id)).toEqual([kept]);
    expect(before.some((row) => row.id === struck)).toBe(false);

    await database.operator("update public.narratives set voided_at = now(), void_reason = 'asserts a death that did not happen' where id = $1", [narrativeId]);
    const after = await feed(null, null, 100);
    expect(after.some((row) => row.id === narrativeId)).toBe(false);
    // The kept signal is still linked directly to a narrative, voided or not, so it is not a card of its own either.
    expect(after.some((row) => row.id === kept)).toBe(false);
  });
});

describe("the allegation hold and the display-only hide (2026-10-09)", () => {
  async function createAdmin(email: string): Promise<string> {
    const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
    await database.rows("update public.users set is_admin = true where id = $1", [row.id]);
    return row.id;
  }
  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected a refusal");
  }
  const snapshot = async (slug: string) =>
    database.rows(
      `select p.current_score::text as score,
              (select count(*)::int from public.signals s where s.person_id = p.id) as signals,
              (select coalesce(sum(s.impact_score), 0)::text from public.signals s where s.person_id = p.id) as impact,
              (select count(*)::int from public.score_history h where h.person_id = p.id) as history,
              (select current_24h::text from public.person_signal_volume(14) v where v.person_id = p.id) as volume_24h
         from public.people p where p.slug = $1`,
      [slug],
    );

  it("holds a lower-tier allegation story from the cards and from evidence, lifts the claim on a tier 1-2 publisher's story, and keeps lower-tier coverage held after the lift", async () => {
    const now = new Date().toISOString();
    const azcentral = await signal("kai-cenat", "Twitch streamer Reggie Travers accuses brother of sexual abuse in tearful video", { at: now, impact: -0.34 });
    const usaToday = await signal("kai-cenat", "Popular streamer Kai Cenat responds to abuse allegations: 'I'm suing you, bro!'", { at: now, impact: -0.47 });
    const tmz = await signal("kai-cenat", "Kai Cenat Calls Out Former Friend Over Grooming Allegations", { at: now, impact: -0.44 });
    const plain = await signal("kai-cenat", "Kai Cenat's Mafiathon 3 breaks the Twitch subscriber record", { at: now, impact: 0.9 });
    const before = await snapshot("kai-cenat");

    // The tick's record: the first two in one tick, TMZ in the next.
    const [{ r: first }] = await database.operator<{ r: Record<string, unknown> }>(
      "select public.record_allegation_holds($1::jsonb) as r",
      [JSON.stringify([
        { signal_id: azcentral, category: "sexual_abuse", method: "model", publisher_domain: "azcentral.com", publisher_tier: 5, qualifying: false },
        { signal_id: usaToday, category: "sexual_abuse", method: "model", publisher_domain: "usatoday.com", publisher_tier: 2, qualifying: true },
      ])],
    );
    expect(first).toEqual({ recorded: 2, held: 1, lifted: 1 });
    const [{ r: second }] = await database.operator<{ r: Record<string, unknown> }>(
      "select public.record_allegation_holds($1::jsonb) as r",
      [JSON.stringify([{ signal_id: tmz, category: "sexual_abuse", method: "terms", publisher_domain: "tmz.com", publisher_tier: 3, qualifying: false }])],
    );
    expect(second).toEqual({ recorded: 1, held: 1, lifted: 0 });

    const claims = await database.rows<{ status: string; lifted_by_signal_id: string }>("select status, lifted_by_signal_id from public.allegation_claims where category = 'sexual_abuse'");
    expect(claims).toEqual([{ status: "lifted", lifted_by_signal_id: usaToday }]);
    const rows = await database.rows<{ id: string; held: boolean; claim_status: string }>("select id, allegation_held as held, allegation ->> 'claim_status' as claim_status from public.signals where id = any($1::uuid[]) order by occurred_at, id", [[azcentral, usaToday, tmz]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.held]))).toEqual({ [azcentral]: true, [usaToday]: false, [tmz]: true });

    // The Feed: only the qualifying story and the plain one are cards.
    const cards = (await feed(null, null, 100)).filter((row) => [azcentral, usaToday, tmz, plain].includes(row.id)).map((row) => row.id);
    expect(cards.sort()).toEqual([usaToday, plain].sort());
    // As evidence under a narrative, the held signal drops out and the qualifying one stays.
    await record([{ slug: "kai-cenat", text: "Kai Cenat's momentum slipped on fresh signals.", source: "template", after: 59.3, signals: [{ signal_id: azcentral }, { signal_id: usaToday }] }]);
    const [{ id: narrativeId }] = await database.rows<{ id: string }>("select id from public.narratives where text = 'Kai Cenat''s momentum slipped on fresh signals.' order by created_at desc limit 1");
    const narrative = (await feed(null, null, 100)).find((row) => row.id === narrativeId)!;
    expect(narrative.evidence.map((e: { id: string }) => e.id)).toEqual([usaToday]);

    // Nothing about the score, the signals, their impact, the history or the volume count moved.
    expect(await snapshot("kai-cenat")).toEqual(before);
    // The review list sees all three, with the tier each outlet resolved at.
    const review = await database.rows<{ signal_id: string; tier: number; held: boolean; qualifying: boolean; claim_status: string }>("select signal_id, tier, held, qualifying, claim_status from public.allegation_review where signal_id = any($1::uuid[]) order by tier", [[azcentral, usaToday, tmz]]);
    expect(review.map((r) => [r.tier, r.held, r.qualifying, r.claim_status])).toEqual([[2, false, true, "lifted"], [3, true, false, "lifted"], [5, true, false, "lifted"]]);
  });

  it("hides a card from every surface through the logged admin function only, leaving the score, the signal and its volume count byte-identical", async () => {
    const admin = await createAdmin("hide-admin@example.com");
    const now = new Date().toISOString();
    const post = await signal("kai-cenat", "Reggie Accuses Kai Cenat of Grooming in Streaming Feud", { at: now, impact: -0.12 });
    const before = await snapshot("kai-cenat");
    expect((await feed(null, null, 100)).some((row) => row.id === post)).toBe(true);

    // A direct edit is refused, like a void; the columns move together.
    expect(await refusal(database.rows("update public.signals set hidden_at = now(), hide_reason = 'by hand' where id = $1", [post]))).toMatch(/admin_hide_signal/);
    expect(await refusal(database.rows("update public.signals set allegation_held = true where id = $1", [post]))).toMatch(/record_allegation_holds|allegation/);
    expect(await refusal(database.rows("select public.admin_hide_signal($1::uuid, 'unverified allegation, not a publisher')", [post]))).toMatch(/Not authenticated|Not an admin/);

    await database.actAs(admin);
    expect(await refusal(database.rows("select public.admin_hide_signal($1::uuid, ' ')", [post]))).toMatch(/reason is required/);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_hide_signal($1::uuid, 'unverified allegation, not a publisher') as r", [post]);
    expect(r).toMatchObject({ ok: true, signal_id: post });
    expect(await refusal(database.rows("select public.admin_hide_signal($1::uuid, 'twice')", [post]))).toMatch(/already hidden/);
    await database.actAs(null);

    expect((await feed(null, null, 100)).some((row) => row.id === post)).toBe(false);
    expect(await snapshot("kai-cenat")).toEqual(before);
    const [log] = await database.rows<{ actor_id: string; note: string; details: Record<string, unknown> }>("select actor_id, note, details from public.admin_audit_log where action = 'hide_signal' order by id desc limit 1");
    expect(log).toMatchObject({ actor_id: admin, note: "unverified allegation, not a publisher" });
    expect(log.details).toMatchObject({ signal_id: post, headline: "Reggie Accuses Kai Cenat of Grooming in Streaming Feud" });

    // Unhide, logged the same way, and the card is back.
    await database.actAs(admin);
    await database.rows("select public.admin_unhide_signal($1::uuid, 'reviewed: a publisher reported it')", [post]);
    await database.actAs(null);
    expect((await feed(null, null, 100)).some((row) => row.id === post)).toBe(true);
    expect(await database.rows("select count(*)::int as n from public.admin_audit_log where action = 'unhide_signal'")).toEqual([{ n: 1 }]);
  });

  it("lets the operator lift one held card, logged, and refuses a lift on a card that is not held", async () => {
    const admin = await createAdmin("lift-admin@example.com");
    const now = new Date().toISOString();
    const held = await signal("kai-cenat", "'I pay Reggie's debt so he would not get hurt': Kai Cenat claims he saved Reggie from being killed", { at: now, impact: 0 });
    await database.operator("select public.record_allegation_holds($1::jsonb)", [JSON.stringify([{ signal_id: held, category: "violence", method: "model", publisher_domain: "timesofindia.indiatimes.com", publisher_tier: 3, qualifying: false }])]);
    expect((await feed(null, null, 100)).some((row) => row.id === held)).toBe(false);
    await database.actAs(admin);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.admin_lift_allegation_hold($1::uuid, 'verified against the police report') as r", [held]);
    expect(r).toMatchObject({ ok: true, signal_id: held });
    expect(await refusal(database.rows("select public.admin_lift_allegation_hold($1::uuid, 'again')", [held]))).toMatch(/not held/);
    await database.actAs(null);
    expect((await feed(null, null, 100)).some((row) => row.id === held)).toBe(true);
    expect(await database.rows("select status from public.allegation_claims where category = 'violence'")).toEqual([{ status: "lifted" }]);
    expect(await database.rows("select count(*)::int as n from public.admin_audit_log where action = 'lift_allegation_hold'")).toEqual([{ n: 1 }]);
  });
});
