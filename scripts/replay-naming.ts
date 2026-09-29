/**
 * The name requirement, replayed over stored articles (2026-09-29).
 *
 *   pnpm tsx scripts/replay-naming.ts <articles.json>
 *
 * The export is one row per article signal: slug, headline, outlet, domain,
 * status (known | unknown to the allowlist), tier, impact. Each row is judged
 * twice, on its headline (stored rows carry no first paragraph, so this is
 * the headline half of the rule and the drop counts are an upper bound):
 *
 *   old   the Phase 31 rule as designed, WITH the proposed tiers on: the
 *         name-conditional exclusions for everyone, the name requirement for
 *         unknown publishers only, and a proposed domain counted as listed
 *         (which is what took its unnamed items out of the requirement)
 *   new   the rule as decided: the name requirement for every tier
 *
 * Impact is the stored impact, and beside it the RELISTED impact: a proposed
 * domain's item was stored at the tier-5 multiplier (0.3) and would have
 * carried its proposed tier's (1: 1.5, 2: 1.0, 3: 0.5, 4: 0.3) once listed.
 *
 * and the report says what the change refuses, in items and impact, per
 * person and for the proposed-allowlist domains in particular (the "64").
 */
import { readFileSync } from "node:fs";

import { PROPOSED_TIERS } from "@/lib/ingest/publishers-proposed";
import { EMPTY_DISAMBIGUATION, exclusionSubject, excludeReason, namesSubject, readDisambiguation, subjectNames, type Disambiguation } from "@/lib/ingest/disambiguation";
import { stripOutletSuffix } from "@/lib/ingest/stories";

interface Row {
  slug: string;
  id: string;
  headline: string;
  outlet: string | null;
  domain: string | null;
  status: string | null;
  tier: number | null;
  impact: number | null;
  processed: boolean;
}

/** The people, as production names them, with the Phase 31 rules the shipping plan sets for them. */
const PEOPLE: Record<string, { display_name: string; full_name: string | null; rules?: Record<string, unknown> }> = {
  "adin-ross": { display_name: "Adin Ross", full_name: "Adin David Ross", rules: { surname_alone: false } },
  drake: { display_name: "Drake", full_name: "Aubrey Drake Graham" },
  "elon-musk": { display_name: "Elon Musk", full_name: "Elon Reeve Musk", rules: { surname_alone: true } },
  "jeff-bezos": { display_name: "Jeff Bezos", full_name: "Jeffrey Preston Bezos", rules: { surname_alone: true, exclude_unless_named: ["Mark Bezos", "HighPost"] } },
  "jensen-huang": { display_name: "Jensen Huang", full_name: "Jen-Hsun Huang", rules: { surname_alone: false, aliases: ["Nvidia CEO", "Nvidia's CEO", "Nvidia's Huang", "CEO Huang"] } },
  "kai-cenat": { display_name: "Kai Cenat", full_name: "Kai Carlo Cenat III", rules: { surname_alone: true } },
  "kendrick-lamar": { display_name: "Kendrick Lamar", full_name: "Kendrick Lamar Duckworth", rules: { surname_alone: false } },
  "larry-ellison": { display_name: "Larry Ellison", full_name: "Lawrence Joseph Ellison", rules: { surname_alone: false, exclude_unless_named: ["David Ellison", "Skydance", "Paramount"], aliases: ["Larry", "Oracle founder", "Oracle co-founder", "Oracle's Ellison", "Oracle chairman"] } },
  "larry-page": { display_name: "Larry Page", full_name: "Lawrence Edward Page", rules: { surname_alone: false, exclude_unless_named: ["Page Auto"], aliases: ["Google co-founder Page"] } },
  "mark-zuckerberg": { display_name: "Mark Zuckerberg", full_name: "Mark Elliot Zuckerberg", rules: { surname_alone: true } },
  "michael-dell": { display_name: "Michael Dell", full_name: "Michael Saul Dell", rules: { surname_alone: false, aliases: ["Dell founder", "Dell's founder", "Dell CEO", "Dell Family Office"] } },
  mrbeast: { display_name: "MrBeast", full_name: "James Stephen Donaldson" },
  "patrick-mahomes": { display_name: "Patrick Mahomes", full_name: "Patrick Lavon Mahomes II", rules: { surname_alone: true, exclude_unless_named: ["Brittany Mahomes"] } },
  "sergey-brin": { display_name: "Sergey Brin", full_name: "Sergey Mikhailovich Brin", rules: { surname_alone: true } },
  "warren-buffett": { display_name: "Warren Buffett", full_name: "Warren Edward Buffett", rules: { surname_alone: true } },
};

function rulesFor(slug: string): Disambiguation {
  const person = PEOPLE[slug];
  return person?.rules ? readDisambiguation({ disambiguation: person.rules } as unknown as Parameters<typeof readDisambiguation>[0]) : EMPTY_DISAMBIGUATION;
}

const TIER_MULTIPLIER: Record<number, number> = { 1: 1.5, 2: 1.0, 3: 0.5, 4: 0.3, 5: 0.3 };

function proposedTierOf(row: Row): number | null {
  const domain = row.domain?.toLowerCase().replace(/^www\./, "") ?? "";
  return PROPOSED_TIERS[domain]?.tier ?? null;
}

/** The impact the item would carry with the proposed tiers on: stored impact rescaled from the floor's multiplier to the proposed tier's. */
function relistedImpact(row: Row): number {
  const impact = row.impact ?? 0;
  const tier = proposedTierOf(row);
  return tier !== null && row.status === "unknown" ? (impact * TIER_MULTIPLIER[tier]) / TIER_MULTIPLIER[5] : impact;
}

/** The rule as designed, with the proposed tiers on: the requirement for unknown publishers only, and a proposed domain is listed. */
function oldVerdict(row: Row, headline: string, rules: Disambiguation): string | null {
  const person = PEOPLE[row.slug];
  const names = subjectNames(person, rules);
  const named = namesSubject(headline, names);
  if (named) return null;
  for (const term of rules.exclude_unless_named) if (headline.toLowerCase().includes(term)) return "excluded_unless_named";
  const listed = row.status === "known" || proposedTierOf(row) !== null;
  return listed ? null : "namesake_unnamed";
}

/** The rule of 549ba2c: the surname names everyone, and the settings' aliases and exclusions are not yet there. */
function surnameForAllVerdict(row: Row, headline: string): string | null {
  const person = PEOPLE[row.slug];
  const base = readDisambiguation({ disambiguation: { exclude_unless_named: (person.rules?.exclude_unless_named as string[] | undefined)?.filter((t) => ["David Ellison", "Skydance", "Paramount", "Page Auto"].includes(t)) ?? [], aliases: person.rules?.aliases && row.slug === "jensen-huang" ? ["Nvidia CEO"] : [], surname_alone: true } } as unknown as Parameters<typeof readDisambiguation>[0]);
  return excludeReason(headline, base, exclusionSubject(person, base))?.reason ?? null;
}

function newVerdict(row: Row, headline: string, rules: Disambiguation): string | null {
  return excludeReason(headline, rules, exclusionSubject(PEOPLE[row.slug], rules))?.reason ?? null;
}

function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: replay-naming <articles.json>");
  const rows = (JSON.parse(readFileSync(file, "utf8")) as Row[]).filter((row) => PEOPLE[row.slug]);
  const proposed = new Set(Object.keys(PROPOSED_TIERS));

  type Tally = { items: number; abs: number; signed: number; relisted: number; relistedAbs: number };
  const tally = (): Tally => ({ items: 0, abs: 0, signed: 0, relisted: 0, relistedAbs: 0 });
  const add = (t: Tally, row: Row) => {
    t.items += 1;
    t.abs += Math.abs(row.impact ?? 0);
    t.signed += row.impact ?? 0;
    t.relisted += relistedImpact(row);
    t.relistedAbs += Math.abs(relistedImpact(row));
  };

  const perPerson = new Map<string, { all: Tally; oldRefused: Tally; newRefused: Tally; dropped: Tally; droppedListed: Tally; droppedProposed: Tally; samples: string[] }>();
  const totals = { all: tally(), oldRefused: tally(), newRefused: tally(), dropped: tally(), droppedListed: tally(), droppedProposed: tally(), proposedItems: 0, proposedUnnamed: tally() };
  const byTier = new Map<string, Tally>();

  for (const row of rows) {
    const rules = rulesFor(row.slug);
    const headline = stripOutletSuffix(row.headline, row.outlet);
    const before = oldVerdict(row, headline, rules);
    const after = newVerdict(row, headline, rules);
    const p = perPerson.get(row.slug) ?? { all: tally(), oldRefused: tally(), newRefused: tally(), dropped: tally(), droppedListed: tally(), droppedProposed: tally(), samples: [] };
    perPerson.set(row.slug, p);
    add(p.all, row);
    add(totals.all, row);
    if (before) {
      add(p.oldRefused, row);
      add(totals.oldRefused, row);
    }
    if (after) {
      add(p.newRefused, row);
      add(totals.newRefused, row);
    }
    const isProposed = row.domain !== null && proposed.has(row.domain.toLowerCase().replace(/^www\./, ""));
    if (isProposed) {
      totals.proposedItems += 1;
      if (after === "namesake_unnamed") add(totals.proposedUnnamed, row);
    }
    if (!before && after) {
      add(p.dropped, row);
      add(totals.dropped, row);
      const key = `${row.status ?? "?"}/${row.tier ?? "?"}`;
      const t = byTier.get(key) ?? tally();
      byTier.set(key, t);
      add(t, row);
      if (row.status === "known") {
        add(p.droppedListed, row);
        add(totals.droppedListed, row);
      }
      if (isProposed) {
        add(p.droppedProposed, row);
        add(totals.droppedProposed, row);
      }
      if (p.samples.length < 5 || (isProposed && p.samples.length < 8)) p.samples.push(`${headline.slice(0, 90)} [${row.outlet ?? row.domain} t${row.tier}${isProposed ? `→${proposedTierOf(row)}` : ""} ${(row.impact ?? 0).toFixed(2)}${isProposed ? ` → ${relistedImpact(row).toFixed(2)}` : ""}]`);
    }
  }

  console.log("\nTHE SURNAME SETTINGS (2026-09-29) against the surname-for-everyone rule: what additionally drops out, and what the settings admit that it refused");
  const extraOut = new Map<string, Row[]>();
  const extraIn = new Map<string, Row[]>();
  for (const row of rows) {
    const rules = rulesFor(row.slug);
    const headline = stripOutletSuffix(row.headline, row.outlet);
    const before = surnameForAllVerdict(row, headline);
    const after = newVerdict(row, headline, rules);
    if (!before && after) extraOut.set(row.slug, [...(extraOut.get(row.slug) ?? []), row]);
    if (before && !after) extraIn.set(row.slug, [...(extraIn.get(row.slug) ?? []), row]);
  }
  for (const [label, map] of [["additionally refused", extraOut], ["newly admitted", extraIn]] as const) {
    let n = 0;
    let abs = 0;
    for (const list of map.values()) for (const row of list) { n += 1; abs += Math.abs(row.impact ?? 0); }
    console.log(`${label}: ${n} items, |${abs.toFixed(2)}|`);
    for (const [slug, list] of [...map].sort()) {
      console.log(`  ${slug}: ${list.length} items, |${list.reduce((sum, row) => sum + Math.abs(row.impact ?? 0), 0).toFixed(2)}|`);
      for (const row of list) console.log(`      - ${stripOutletSuffix(row.headline, row.outlet).slice(0, 110)} [${row.outlet ?? row.domain} t${row.tier} ${(row.impact ?? 0).toFixed(2)}]`);
    }
  }

  const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
  const fmt = (t: Tally) => `${t.items} items, stored |${t.abs.toFixed(2)}| ${sign(t.signed)}, relisted |${t.relistedAbs.toFixed(2)}| ${sign(t.relisted)}`;
  console.log(`rows: ${rows.length}`);
  console.log(`refused as designed (unknown publishers only): ${fmt(totals.oldRefused)}`);
  console.log(`refused as decided (every tier):               ${fmt(totals.newRefused)}`);
  console.log(`newly refused by the change:                   ${fmt(totals.dropped)}`);
  console.log(`  of them from listed domains (tier 1-4):      ${fmt(totals.droppedListed)}`);
  console.log(`  of them from the proposed domains:           ${fmt(totals.droppedProposed)} (of ${totals.proposedItems} proposed-domain items; ${totals.proposedUnnamed.items} unnamed among them)`);
  console.log("by status/tier:");
  for (const [key, t] of [...byTier].sort()) console.log(`  ${key}: ${fmt(t)}`);
  console.log("per person (newly refused; then their week's total):");
  for (const [slug, p] of [...perPerson].sort((a, b) => b[1].dropped.abs - a[1].dropped.abs)) {
    console.log(`  ${slug}: ${fmt(p.dropped)}  | listed ${fmt(p.droppedListed)} | proposed ${fmt(p.droppedProposed)} | week ${fmt(p.all)}`);
    for (const sample of p.samples) console.log(`      - ${sample}`);
  }
}

main();
