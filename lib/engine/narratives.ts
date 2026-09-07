import type { EngineConfig } from "@/lib/engine/config";
import type { ForceName, PersonSummary, TickSummary } from "@/lib/engine/types";
import type { TypedSupabaseClient } from "@/types";

/**
 * Narratives: the Engine explaining, in one or two sentences, why a person's
 * score moved meaningfully this tick.
 *
 * Cost control: a narrative is written only for |change| >= minAbsChange, at
 * most maxPerTick per tick. When the move was signal-driven, the sentence the
 * LLM scorer already produced during signal reasoning is reused (no extra
 * call). Moves driven by other forces get a deterministic sentence from the
 * force breakdown.
 */

export interface NarrativeRow {
  personId: string;
  tickNumber: number;
  text: string;
  scoreBefore: number;
  scoreAfter: number;
  source: "llm" | "template";
}

export interface NarrativeStore {
  insert(rows: NarrativeRow[]): Promise<number>;
}

function dominantForce(person: PersonSummary): { force: ForceName; impact: number } | null {
  let best: { force: ForceName; impact: number } | null = null;
  for (const [force, impact] of Object.entries(person.forces) as Array<[ForceName, number]>) {
    if (impact === undefined) continue;
    if (!best || Math.abs(impact) > Math.abs(best.impact)) best = { force, impact };
  }
  return best;
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

export function templateNarrative(person: PersonSummary, summary: TickSummary): string {
  const up = person.change > 0;
  const name = person.displayName;
  const dominant = dominantForce(person);
  const verb = up ? "climbed" : "slipped";

  if (!dominant) return `${possessive(name)} momentum ${verb} this tick.`;

  switch (dominant.force) {
    case "signals": {
      const top = summary.signals
        .filter((s) => s.personSlug === person.slug && s.impact !== 0)
        .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))[0];
      return top
        ? `${possessive(name)} momentum ${verb} on "${top.headline}".`
        : `${possessive(name)} momentum ${verb} on fresh signals.`;
    }
    case "inverse_pair": {
      const partner = summary.people
        .filter((p) => p.slug !== person.slug && (p.forces.signals ?? 0) !== 0 && Math.sign(p.forces.signals ?? 0) === -Math.sign(dominant.impact))
        .sort((a, b) => Math.abs(b.forces.signals ?? 0) - Math.abs(a.forces.signals ?? 0))[0];
      return partner
        ? `${possessive(name)} momentum ${verb} as ${possessive(partner.displayName)} ${(partner.forces.signals ?? 0) > 0 ? "surge" : "slide"} pulled the pair the other way.`
        : `${possessive(name)} momentum ${verb} in reaction to a paired rival's move.`;
    }
    case "market_mood":
      return `${name} drifted ${up ? "up" : "down"} with a broadly ${summary.mood >= 0 ? "positive" : "negative"} market mood.`;
    case "gravity":
      return `${possessive(name)} momentum settled ${up ? "up" : "back"} toward its baseline of ${person.revertTarget.toFixed(0)}.`;
    case "conviction":
      return `${dominant.impact > 0 ? "Growing" : "Over-extended"} capital concentration ${dominant.impact > 0 ? "lifted" : "weighed on"} ${possessive(name)} momentum.`;
    case "trading_activity":
      return `A burst of ${dominant.impact > 0 ? "buying" : "selling"} ${dominant.impact > 0 ? "lifted" : "pushed down"} ${possessive(name)} momentum.`;
  }
}

export function buildNarratives(summary: TickSummary, config: EngineConfig["narratives"]): NarrativeRow[] {
  const candidates = summary.people
    .filter((person) => Math.abs(person.change) >= config.minAbsChange)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, config.maxPerTick);

  return candidates.map((person) => {
    const llmNarrative = summary.signals.find((s) => s.personSlug === person.slug && s.scorer === "llm" && s.narrative)?.narrative;
    const useLlm = Boolean(llmNarrative) && (person.forces.signals ?? 0) !== 0;
    return {
      personId: person.id,
      tickNumber: summary.tickNumber,
      text: useLlm ? (llmNarrative as string) : templateNarrative(person, summary),
      scoreBefore: person.previousScore,
      scoreAfter: person.newScore,
      source: useLlm ? "llm" : "template",
    };
  });
}

export function createSupabaseNarrativeStore(client: TypedSupabaseClient): NarrativeStore {
  return {
    async insert(rows) {
      if (rows.length === 0) return 0;
      const { data, error } = await client
        .from("narratives")
        .insert(
          rows.map((row) => ({
            person_id: row.personId,
            tick_number: row.tickNumber,
            text: row.text,
            score_before: row.scoreBefore,
            score_after: row.scoreAfter,
            source: row.source,
          })),
        )
        .select("id");
      if (error) throw new Error(`Failed to insert narratives: ${error.message}`);
      return data.length;
    },
  };
}

export function createMemoryNarrativeStore(): NarrativeStore & { rows: NarrativeRow[] } {
  const rows: NarrativeRow[] = [];
  return {
    rows,
    async insert(newRows) {
      rows.push(...newRows);
      return newRows.length;
    },
  };
}
