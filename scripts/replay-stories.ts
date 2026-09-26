/**
 * REPLAY: story confirmation over an export of scored article signals.
 *
 *   npx tsx scripts/replay-stories.ts <articles.json> [--share 0.2] [--cap 0.15] [--anchor 0.25] [--window 48]
 *
 * The export is an array of rows with at least:
 *   { id, slug, occurred_at, impact (number or string), headline }
 * (the shape `select id, p.slug, s.occurred_at, s.impact_score as impact,
 * s.headline from signals ...` returns). Rows are replayed per person in
 * occurred_at order, each row scored against the rows before it inside the
 * window, exactly as the tick would have seen them arrive one at a time
 * (the conservative case: every earlier copy is a "recent" story with its
 * impact already published, none shares a tick with a later one).
 *
 * Prints every cluster it found and, per person, the summed absolute and
 * signed impact before and after the bounded confirmations. Reads a file,
 * calls nothing, changes nothing.
 */
import { readFileSync } from "node:fs";

import { DEFAULT_ENGINE_CONFIG } from "../lib/engine/config";
import { confirmStories, storyOptions } from "../lib/engine/stories";
import type { RecentStory, ScoredSignal } from "../lib/engine/types";

interface ExportRow {
  id: string;
  slug: string;
  display_name?: string;
  occurred_at: string;
  impact: number | string;
  headline: string;
}

type Row = Omit<ExportRow, "impact"> & { impact: number };

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx scripts/replay-stories.ts <articles.json> [--share 0.2] [--cap 0.15] [--anchor 0.25] [--window 48]");
  process.exit(2);
}

const quality = {
  ...DEFAULT_ENGINE_CONFIG.signalQuality,
  enabled: true,
  storyConfirmationShare: arg("share", DEFAULT_ENGINE_CONFIG.signalQuality.storyConfirmationShare),
  storyConfirmationCap: arg("cap", DEFAULT_ENGINE_CONFIG.signalQuality.storyConfirmationCap),
  storyAnchorThreshold: arg("anchor", DEFAULT_ENGINE_CONFIG.signalQuality.storyAnchorThreshold),
  storyWindowHours: arg("window", DEFAULT_ENGINE_CONFIG.signalQuality.storyWindowHours),
};

const rows: Row[] = (JSON.parse(readFileSync(file, "utf8")) as ExportRow[]).map((row) => ({ ...row, impact: Number(row.impact) })).filter((row) => Number.isFinite(row.impact));
const bySlug = new Map<string, Row[]>();
for (const row of rows) bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row]);

/** A person's names from the slug: "larry-ellison" → ["Larry Ellison"]. Good enough to strip the name from headlines. */
function namesOf(slug: string): string[] {
  const words = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return [words.join(" ")];
}

function scored(row: Row): ScoredSignal {
  return {
    signal: { id: row.id, personId: row.slug, headline: row.headline, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 5, occurredAt: new Date(row.occurred_at), createdAt: new Date(row.occurred_at) },
    sentiment: { label: row.impact > 0 ? "positive" : row.impact < 0 ? "negative" : "neutral", confidence: 0.5, direction: row.impact > 0 ? 1 : row.impact < 0 ? -1 : 0 },
    impact: row.impact,
    ageHours: 0,
    freshness: 1,
    volumeWeight: 1,
  };
}

const totals: Array<{ slug: string; articles: number; clusters: number; confirmations: number; absBefore: number; absAfter: number; signedBefore: number; signedAfter: number }> = [];
const clusterLines: string[] = [];

for (const [slug, list] of [...bySlug.entries()].sort()) {
  const ordered = [...list].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime() || a.id.localeCompare(b.id));
  const options = storyOptions(quality, namesOf(slug));
  const recent: RecentStory[] = [];
  let absBefore = 0;
  let absAfter = 0;
  let signedBefore = 0;
  let signedAfter = 0;
  let confirmations = 0;
  const clusterIds = new Set<string>();
  for (const row of ordered) {
    const before = row.impact;
    absBefore += Math.abs(before);
    signedBefore += before;
    const window = recent.filter((story) => Math.abs(story.occurredAt.getTime() - new Date(row.occurred_at).getTime()) <= quality.storyWindowHours * 3_600_000);
    const result = confirmStories([scored(row)], window, options);
    const after = result.scored[0].impact;
    absAfter += Math.abs(after);
    signedAfter += after;
    if (result.scored[0].story) {
      confirmations += 1;
      const story = result.scored[0].story;
      clusterIds.add(story.leaderId);
      const leader = recent.find((s) => s.id === story.leaderId);
      clusterLines.push(
        `${slug}  ${new Date(row.occurred_at).toISOString().slice(5, 16)}  ${before >= 0 ? "+" : ""}${before.toFixed(2)} -> ${after >= 0 ? "+" : ""}${after.toFixed(2)}  dice ${story.similarity.toFixed(3)}${story.anchor ? ` anchor "${story.anchor}"` : ""}\n    ${row.headline}\n    = ${leader?.headline ?? story.leaderId}  (${(leader?.impact ?? 0) >= 0 ? "+" : ""}${(leader?.impact ?? 0).toFixed(2)})`,
      );
    }
    // What the tick publishes is what later copies are compared against. The
    // leader keeps its full impact; a confirmation enters the window too, so a
    // third copy can match either wording (single linkage).
    recent.push({ id: row.id, personId: slug, headline: row.headline, occurredAt: new Date(row.occurred_at), impact: before });
  }
  totals.push({ slug, articles: ordered.length, clusters: clusterIds.size, confirmations, absBefore, absAfter, signedBefore, signedAfter });
}

console.log(`story confirmation replay: share ${quality.storyConfirmationShare}, cap ${quality.storyConfirmationCap}, anchor threshold ${quality.storyAnchorThreshold}, window ${quality.storyWindowHours} h\n`);
console.log(clusterLines.join("\n\n"));
console.log("\nper person (articles with non-zero impact only count toward impact):");
console.log("slug                 articles  clusters  confirmations   |impact| before -> after   signed before -> after");
for (const t of totals) {
  console.log(
    `${t.slug.padEnd(20)} ${String(t.articles).padStart(8)}  ${String(t.clusters).padStart(8)}  ${String(t.confirmations).padStart(13)}   ${t.absBefore.toFixed(2).padStart(8)} -> ${t.absAfter.toFixed(2).padStart(6)}   ${(t.signedBefore >= 0 ? "+" : "") + t.signedBefore.toFixed(2)} -> ${(t.signedAfter >= 0 ? "+" : "") + t.signedAfter.toFixed(2)}`,
  );
}
const all = totals.reduce((acc, t) => ({ articles: acc.articles + t.articles, confirmations: acc.confirmations + t.confirmations, absBefore: acc.absBefore + t.absBefore, absAfter: acc.absAfter + t.absAfter }), { articles: 0, confirmations: 0, absBefore: 0, absAfter: 0 });
console.log(`\ntotal: ${all.articles} articles, ${all.confirmations} confirmations, |impact| ${all.absBefore.toFixed(2)} -> ${all.absAfter.toFixed(2)} (${((1 - all.absAfter / all.absBefore) * 100).toFixed(1)}% removed)`);
