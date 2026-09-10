import type { EngineConfig } from "@/lib/engine/config";
import type { ForceName, PersonSummary, TickSummary } from "@/lib/engine/types";
import type { TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

/**
 * Narratives: the Engine explaining, in one or two sentences, why a person's
 * score moved meaningfully this tick.
 *
 * Cost control: a narrative is written only for |change| >= minAbsChange, at
 * most maxPerTick per tick. When the move was signal-driven, the sentence the
 * LLM scorer already produced during signal reasoning is reused (no extra
 * call). Moves driven by other forces get a deterministic sentence from the
 * force breakdown.
 *
 * Every narrative records the signals that produced it (`signals`), decided
 * here, at generation time, where they are known — never inferred later from
 * timing. The Feed's evidence is exactly this list.
 */

export type NarrativeLinkRelation = "direct" | "inverse_pair";

/** One signal behind a narrative. */
export interface NarrativeSignalLink {
  signalId: string;
  /** direct: a signal about the narrative's own person. inverse_pair: the paired person's signal, whose move this one reacts to. */
  relation: NarrativeLinkRelation;
}

export interface NarrativeRow {
  personId: string;
  tickNumber: number;
  text: string;
  scoreBefore: number;
  scoreAfter: number;
  source: "llm" | "template";
  /** The signals that produced the sentence. Empty when other forces carried the move. */
  signals: NarrativeSignalLink[];
}

export interface NarrativeStore {
  insert(rows: NarrativeRow[]): Promise<number>;
}

type SummarySignal = TickSummary["signals"][number];

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

function signalsFor(summary: TickSummary, slug: string): SummarySignal[] {
  return summary.signals.filter((signal) => signal.personSlug === slug);
}

/** The strongest non-zero signal on a person this tick, or undefined. */
function strongestSignal(summary: TickSummary, slug: string): SummarySignal | undefined {
  return signalsFor(summary, slug)
    .filter((signal) => signal.impact !== 0)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact) || a.id.localeCompare(b.id))[0];
}

/**
 * The paired person whose Signals force pulled this one the other way: the
 * one with the largest opposite-signed Signals impact this tick.
 */
function pairedPartner(person: PersonSummary, summary: TickSummary, inverseImpact: number): PersonSummary | undefined {
  return summary.people
    .filter((p) => p.slug !== person.slug && (p.forces.signals ?? 0) !== 0 && Math.sign(p.forces.signals ?? 0) === -Math.sign(inverseImpact))
    .sort((a, b) => Math.abs(b.forces.signals ?? 0) - Math.abs(a.forces.signals ?? 0) || a.id.localeCompare(b.id))[0];
}

export function templateNarrative(person: PersonSummary, summary: TickSummary): string {
  const up = person.change > 0;
  const name = person.displayName;
  const dominant = dominantForce(person);
  const verb = up ? "climbed" : "slipped";

  if (!dominant) return `${possessive(name)} momentum ${verb} this tick.`;

  switch (dominant.force) {
    case "signals": {
      const top = strongestSignal(summary, person.slug);
      return top
        ? `${possessive(name)} momentum ${verb} on "${top.headline}".`
        : `${possessive(name)} momentum ${verb} on fresh signals.`;
    }
    case "inverse_pair": {
      const partner = pairedPartner(person, summary, dominant.impact);
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

/**
 * The signals that produced a narrative, by how the Engine wrote it:
 *
 *   - an LLM sentence came from one batch of the person's signals in this
 *     tick: every signal that carries that same sentence produced it;
 *   - a template sentence for a Signals-driven move came from the person's
 *     non-zero signals this tick (the strongest one is the one quoted);
 *   - an inverse-pair sentence came from the paired person's non-zero
 *     signals, recorded as `inverse_pair` so the Feed can say whose they are;
 *   - a move carried by Gravity, Market Mood, Conviction or Trading Activity
 *     was produced by no signal at all, and links to none.
 */
export function producingSignals(person: PersonSummary, summary: TickSummary, llmNarrative: string | null): NarrativeSignalLink[] {
  const direct = (signal: SummarySignal): NarrativeSignalLink => ({ signalId: signal.id, relation: "direct" });

  if (llmNarrative) {
    return signalsFor(summary, person.slug)
      .filter((signal) => signal.scorer === "llm" && signal.narrative === llmNarrative)
      .map(direct);
  }

  const dominant = dominantForce(person);
  if (!dominant) return [];

  if (dominant.force === "signals") {
    return signalsFor(summary, person.slug)
      .filter((signal) => signal.impact !== 0)
      .map(direct);
  }

  if (dominant.force === "inverse_pair") {
    const partner = pairedPartner(person, summary, dominant.impact);
    if (!partner) return [];
    return signalsFor(summary, partner.slug)
      .filter((signal) => signal.impact !== 0)
      .map((signal) => ({ signalId: signal.id, relation: "inverse_pair" as const }));
  }

  return [];
}

export function buildNarratives(summary: TickSummary, config: EngineConfig["narratives"]): NarrativeRow[] {
  const candidates = summary.people
    .filter((person) => Math.abs(person.change) >= config.minAbsChange)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.id.localeCompare(b.id))
    .slice(0, config.maxPerTick);

  return candidates.map((person) => {
    const llmNarrative = signalsFor(summary, person.slug).find((s) => s.scorer === "llm" && s.narrative)?.narrative ?? null;
    const useLlm = Boolean(llmNarrative) && (person.forces.signals ?? 0) !== 0;
    return {
      personId: person.id,
      tickNumber: summary.tickNumber,
      text: useLlm ? (llmNarrative as string) : templateNarrative(person, summary),
      scoreBefore: person.previousScore,
      scoreAfter: person.newScore,
      source: useLlm ? "llm" : "template",
      signals: producingSignals(person, summary, useLlm ? llmNarrative : null),
    };
  });
}

/**
 * Writes narratives and their signal links through record_narratives(), one
 * transaction per tick, so a sentence and its evidence land together or not
 * at all.
 */
export function createSupabaseNarrativeStore(client: TypedSupabaseClient): NarrativeStore {
  return {
    async insert(rows) {
      if (rows.length === 0) return 0;
      const payload = rows.map((row) => ({
        person_id: row.personId,
        tick_number: row.tickNumber,
        text: row.text,
        score_before: row.scoreBefore,
        score_after: row.scoreAfter,
        source: row.source,
        signals: row.signals.map((link) => ({ signal_id: link.signalId, relation: link.relation })),
      }));
      const { data, error } = await client.rpc("record_narratives", { p_narratives: payload as unknown as Json });
      if (error) throw new Error(`Failed to record narratives: ${error.message}`);
      return Number(data ?? 0);
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
