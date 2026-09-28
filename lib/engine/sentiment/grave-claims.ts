import type { Json } from "@/types/database";

import type { SentimentInput } from "./types";

/**
 * THE NARRATIVE SAFETY RULE (hotfix, 2026-09-28).
 *
 * On 2026-09-28 at 17:46 UTC the Engine wrote "Larry Page has died. This ends
 * his momentum profile as an active market figure." from one item headlined
 * "Larry Page" on wgrv.com, a Greeneville, Tennessee radio station, at the
 * unknown-publisher tier, three hours after a Legacy.com obituary for a
 * namesake in the same town had been scored and had entered his memory. Larry
 * Page is alive.
 *
 * So: the narrative writer never asserts a death, an arrest, a criminal
 * charge, a serious illness or a similar grave claim unless the batch that
 * produced it carries a REPUTABLE source (publisher tier 1 or 2) or TWO
 * INDEPENDENT outlets. Otherwise it writes nothing about it: the sentence is
 * withheld, the tick falls back to the template narrative (which quotes the
 * headline and claims nothing), and the withholding is logged with the term
 * and the sources. The signals' own scores are not touched here; this rule
 * is about what the platform SAYS.
 *
 * The vocabulary is deliberately wide and the cost of a false match is small
 * (a template sentence instead of the model's), so "killed it on stage" and
 * "death threat" are accepted losses. It is a guard after generation, not a
 * prompt instruction: a model can be told, and still write it.
 */
export const GRAVE_CLAIM =
  /\b(died|dies|dead|death|deceased|passed away|passes away|killed|obituary|funeral|arrested|arrest|detained|in custody|charged with|indicted|indictment|convicted|pleaded guilty|pleads guilty|sentenced to|hospitali[sz]ed|diagnosed with|cancer|stroke|heart attack|critical condition|life support|overdose|coma|terminally ill|seriously ill|gravely ill|serious illness)\b/i;

/** Publisher tiers 1 and 2 are reputable enough to carry a grave claim on their own. */
export const REPUTABLE_TIER_MAX = 2;

/** Where a signal came from, as the rule judges it: the publisher's tier and its outlet. */
export interface NarrativeSource {
  tier: number;
  outlet: string | null;
}

function payloadField(payload: Json | null, key: string): Json | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

/**
 * A news item's tier is the PUBLISHER's, resolved per item by the runner into
 * the payload (`publisher_tier`), not the connector's: the RSS source is tier
 * 3 as a whole while the wgrv.com item inside it resolved to 5. Absent, the
 * source tier stands. The outlet is the publisher's domain, else the outlet
 * name, else the source.
 */
export function sourceOf(signal: SentimentInput): NarrativeSource {
  const publisherTier = payloadField(signal.rawPayload, "publisher_tier");
  const tier = typeof publisherTier === "number" && Number.isFinite(publisherTier) ? publisherTier : signal.sourceTier;
  const domain = payloadField(signal.rawPayload, "publisher_domain");
  const outlet = payloadField(signal.rawPayload, "outlet");
  const name = typeof domain === "string" && domain.trim() ? domain : typeof outlet === "string" && outlet.trim() ? outlet : signal.sourceName;
  return { tier, outlet: name ? name.trim().toLowerCase() : null };
}

/** The grave term the text asserts, or null when it asserts none. */
export function graveClaimTerm(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = GRAVE_CLAIM.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** A reputable source, or two independent outlets: enough to carry a grave claim. */
export function graveClaimSupported(sources: readonly NarrativeSource[]): boolean {
  if (sources.some((source) => source.tier <= REPUTABLE_TIER_MAX)) return true;
  const outlets = new Set(sources.map((source) => source.outlet).filter((outlet): outlet is string => outlet !== null));
  return outlets.size >= 2;
}

/**
 * THE COMPANION SCORING RULE (decision 4, 2026-09-28). A signal whose
 * ASSESSED content, the model's rationale for it, is a grave claim scores
 * zero unless the batch carries a reputable publisher or two independent
 * outlets. The rationale rather than the headline, because the rationale is
 * the assessment: "Sued to Death" and "Killed Its Solar Roof" are headlines,
 * and the model's reading of them says nothing grave. Returns the term when
 * the signal is to be zeroed, null when it stands.
 */
export function zeroedGraveClaim(rationale: string | null | undefined, sources: readonly NarrativeSource[]): string | null {
  const term = graveClaimTerm(rationale);
  if (!term) return null;
  return graveClaimSupported(sources) ? null : term;
}

export interface GuardedNarrative {
  narrative: string | undefined;
  /** Why the sentence was withheld; null when it stands. */
  withheld: { term: string; sources: NarrativeSource[] } | null;
}

/**
 * The guard. A narrative with no grave term stands as written. One with a
 * grave term stands only when the batch behind it supports it; otherwise the
 * sentence is withheld and the reason returned for the log.
 */
export function guardNarrative(narrative: string | undefined, signals: readonly SentimentInput[]): GuardedNarrative {
  const term = graveClaimTerm(narrative);
  if (!term) return { narrative, withheld: null };
  const sources = signals.map(sourceOf);
  if (graveClaimSupported(sources)) return { narrative, withheld: null };
  return { narrative: undefined, withheld: { term, sources } };
}
