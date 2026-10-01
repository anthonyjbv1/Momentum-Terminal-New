import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * The story record (Feed upgrade, Part B), run against a real Postgres with
 * the migrations applied: record_story_clusters() writing stories and their
 * members idempotently, and feed_entries() showing a story at its last
 * update with its members as evidence and its members gone from the signal
 * branch.
 */

let database: TestDatabase;
const people = new Map<string, string>();
let source: { id: string; name: string };

const DAY1 = "2026-09-26 12:00:00+00";
const DAY2 = "2026-09-27 09:00:00+00";
const DAY3 = "2026-09-28 15:30:00+00";

interface FeedRow {
  kind: string;
  id: string;
  person_slug: string;
  text: string;
  impact: number | string;
  occurred_at: string;
  sources: string[];
  evidence: Array<{ id: string; relation: string; impact: number | string | null }>;
  story_first_at: string | null;
  story_signals: number | null;
}

async function feed(limit = 24): Promise<FeedRow[]> {
  return database.rows<FeedRow>(
    `select kind, id, person_slug, text, impact, occurred_at::text as occurred_at, sources, evidence, story_first_at::text as story_first_at, story_signals
       from public.feed_entries(null, null, $1::int)`,
    [limit],
  );
}

async function signal(slug: string, headline: string, at: string, impact: number, payload: Record<string, unknown> = { kind: "article" }): Promise<string> {
  const [row] = await database.rows<{ id: string }>(
    `insert into public.signals (person_id, data_source_id, headline, occurred_at, impact_score, processed, processed_at, sentiment_label, sentiment_confidence, raw_payload)
     values ($1, $2, $3, $4::timestamptz, $5, true, $4::timestamptz, 'positive', 0.8, $6::jsonb)
     returning id`,
    [people.get(slug), source.id, headline, at, impact, JSON.stringify(payload)],
  );
  return row.id;
}

async function record(clusters: Array<{ person_id: string | undefined; leader_id: string; headline: string; members: Array<{ id: string; similarity: number; anchor: string | null }> }>): Promise<number> {
  const [row] = await database.rows<{ n: number }>("select public.record_story_clusters($1::jsonb) as n", [JSON.stringify(clusters)]);
  return Number(row.n);
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  [source] = await database.rows<{ id: string; name: string }>("select id, display_name as name from public.data_sources where name = 'rss'");
});

afterAll(async () => {
  await database.close();
});

describe("record_story_clusters", () => {
  it("creates a story from a leader and its members, then grows it on the next tick without repeating anyone", async () => {
    const zuck = "mark-zuckerberg";
    const leader = await signal(zuck, "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears", DAY1, -1.11);
    const copy = await signal(zuck, "Mark Zuckerberg Loses $9 Billion In A Day As Goldman Sachs Pours Cold Water On Meta Stock Rally", DAY2, -0.15);
    expect(await record([{ person_id: people.get(zuck), leader_id: leader, headline: "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears", members: [{ id: copy, similarity: 0.353, anchor: "9 billion" }] }])).toBe(1);

    const [story] = await database.rows<{ id: string; signal_count: number; impact_total: string; first_at: string; last_at: string }>(
      "select id, signal_count, impact_total::text as impact_total, first_at::text as first_at, last_at::text as last_at from public.stories",
    );
    expect(story.signal_count).toBe(2);
    expect(Number(story.impact_total)).toBeCloseTo(-1.26, 5);
    expect(story.first_at).toBe(DAY1);
    expect(story.last_at).toBe(DAY2);

    // The same cluster again: nothing new. A later tick with a third copy: the same story, now three.
    expect(await record([{ person_id: people.get(zuck), leader_id: leader, headline: "x", members: [{ id: copy, similarity: 0.353, anchor: "9 billion" }] }])).toBe(1);
    const third = await signal(zuck, "Zuckerberg's $9 billion loss explained", DAY3, -0.1);
    await record([{ person_id: people.get(zuck), leader_id: leader, headline: "x", members: [{ id: third, similarity: 0.3, anchor: "9 billion" }] }]);
    const stories = await database.rows<{ id: string; signal_count: number; headline: string; last_at: string }>("select id, signal_count, headline, last_at::text as last_at from public.stories");
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ id: story.id, signal_count: 3, headline: "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears", last_at: DAY3 });
    const members = await database.rows<{ role: string; anchor: string | null }>("select role, anchor from public.story_signals where story_id = $1 order by joined_at", [story.id]);
    expect(members).toEqual([
      { role: "leader", anchor: null },
      { role: "member", anchor: "9 billion" },
      { role: "member", anchor: "9 billion" },
    ]);
  });

  it("refuses a leader that is not the person's own signal, and a member already in another story stays there", async () => {
    const drake = "drake";
    const musk = "elon-musk";
    const drakeLeader = await signal(drake, "Drake drops surprise album", DAY1, 0.6);
    const drakeCopy = await signal(drake, "Drake's surprise album lands", DAY2, 0.1);
    expect(await record([{ person_id: people.get(musk), leader_id: drakeLeader, headline: "x", members: [{ id: drakeCopy, similarity: 0.5, anchor: null }] }])).toBe(0);
    expect(await record([{ person_id: people.get(drake), leader_id: drakeLeader, headline: "Drake drops surprise album", members: [{ id: drakeCopy, similarity: 0.5, anchor: null }] }])).toBe(1);
    // A second cluster claiming the copy as its member gets a story of its own with only its leader: the copy is spoken for.
    const other = await signal(drake, "Drake tour dates announced", DAY2, 0.2);
    await record([{ person_id: people.get(drake), leader_id: other, headline: "Drake tour dates announced", members: [{ id: drakeCopy, similarity: 0.45, anchor: null }] }]);
    const counts = await database.rows<{ headline: string; signal_count: number }>("select headline, signal_count from public.stories where person_id = $1 order by headline", [people.get(drake)]);
    expect(counts).toEqual([
      { headline: "Drake drops surprise album", signal_count: 2 },
      { headline: "Drake tour dates announced", signal_count: 1 },
    ]);
  });
});

describe("feed_entries with stories", () => {
  it("shows a story once, at its last update, with its members as evidence, and no member as a signal of its own", async () => {
    const rows = await feed(100);
    const stories = rows.filter((row) => row.kind === "story");
    expect(stories.map((row) => [row.person_slug, row.story_signals, row.occurred_at])).toEqual([
      ["mark-zuckerberg", 3, DAY3],
      ["drake", 2, DAY2],
    ]);
    const zuck = stories[0];
    expect(zuck.text).toBe("Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears");
    expect(Number(zuck.impact)).toBeCloseTo(-1.36, 5);
    expect(zuck.story_first_at).toBe(DAY1);
    expect(zuck.evidence).toHaveLength(3);
    expect(zuck.evidence.every((item) => item.relation === "direct")).toBe(true);
    expect(zuck.sources).toEqual([source.name]);

    const memberIds = new Set(stories.flatMap((row) => row.evidence.map((item) => item.id)));
    const signals = rows.filter((row) => row.kind === "signal");
    expect(signals.some((row) => memberIds.has(row.id))).toBe(false);
    // A one-signal story is not a story on the Feed: its signal is its own entry.
    expect(signals.map((row) => row.text)).toContain("Drake tour dates announced");
    for (const row of rows.filter((entry) => entry.kind !== "story")) expect([row.story_first_at, row.story_signals]).toEqual([null, null]);
  });
});
