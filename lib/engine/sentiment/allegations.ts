import type { Json } from "@/types/database";

import { REPUTABLE_TIER_MAX, sourceOf } from "./grave-claims";
import type { SentimentInput, SentimentResult } from "./types";

/**
 * THE ALLEGATION HOLD (2026-10-09). Display and narrative only: the Engine
 * keeps scoring coverage exactly as before.
 *
 * THE RULE (settled). An unverified allegation of a serious crime (sexual
 * abuse, violence, a crime against a minor) about a tracked person or their
 * family is held from display. The hold lifts only when a tier 1-2 PUBLISHER
 * reports the claim. Connector tiers (Twitch, YouTube, API-Sports) never
 * count: they measure weighting, not reporting, so a signal without a
 * publisher domain can never qualify. Several lower-tier outlets never lift
 * it (gossip outlets copy each other). A story reporting a denial still
 * repeats the claim and is held the same way. Once a tier 1-2 story on the
 * claim is admitted, earlier lower-tier cards stay held and only the
 * qualifying story and later tier 1-2 coverage display: a story displays
 * exactly when it is itself a tier 1-2 publisher's.
 *
 * DETECTION. The scoring call (version 2) labels every story with an
 * allegation category, or "none". The 59-term grave-claim list stays as
 * the backstop: the allegation terms of that list flag a headline the
 * model did not, so a story is never missed for want of a label. The two
 * methods are recorded on the signal (`method`), so the console can show
 * where they disagree.
 */

export const ALLEGATION_CATEGORIES = ["sexual_abuse", "violence", "minors"] as const;
export type AllegationCategory = (typeof ALLEGATION_CATEGORIES)[number];
export type AllegationLabel = AllegationCategory | "none";
export type AllegationMethod = "model" | "terms";

/** The allegation terms of the 59-term list, by category: the backstop when the model labels nothing. */
const TERMS: ReadonlyArray<{ category: AllegationCategory; pattern: RegExp }> = [
  { category: "minors", pattern: /\b(groom(?:ed|ing)|molest(?:ed|ing|ation)?|child (?:abuse|sexual abuse|exploitation|pornography)|minor(?:s)? (?:abuse|exploitation)|underage (?:girl|boy|victim|sex))\b/i },
  { category: "sexual_abuse", pattern: /\b(sexual (?:misconduct|harassment|assault|abuse|allegations?)|sexually (?:assaulted|harassed|abused)|misconduct allegations?|rape[ds]?|rapist|sex trafficking|abuse[ds]?|abusing|abuser)\b/i },
  { category: "violence", pattern: /\b(assault(?:ed|s|ing)?|domestic violence|battery charges?|beat(?:en|s)? (?:up|his|her)|strangl(?:ed|ing)|stabb(?:ed|ing)|shot (?:him|her|at)|attempted murder|murder(?:ed|ing)?)\b/i },
];

/** The term that flags a headline, by category; null when none does. Minors before sexual abuse, so "grooming" reads as the graver category. */
export function allegationTerm(text: string | null | undefined): { category: AllegationCategory; term: string } | null {
  if (!text) return null;
  for (const { category, pattern } of TERMS) {
    const match = pattern.exec(text);
    if (match) return { category, term: match[1].toLowerCase() };
  }
  return null;
}

export function isAllegationCategory(value: unknown): value is AllegationCategory {
  return typeof value === "string" && (ALLEGATION_CATEGORIES as readonly string[]).includes(value);
}

/** What the tick records on a signal: the category, which method flagged it, the publisher and whether the story displays. */
export interface AllegationFlag {
  category: AllegationCategory;
  method: AllegationMethod;
  /** The backstop term, when the terms flagged it. */
  term?: string;
  /** The publisher's domain, or null for a signal with none (a connector's, a feed item without a source element). */
  publisherDomain: string | null;
  /** The publisher's tier as the runner resolved it; the source's tier when the signal carries none. */
  publisherTier: number;
  /** A tier 1-2 PUBLISHER's story: it lifts the claim and displays. Never a connector's. */
  qualifying: boolean;
  /** The display decision: held from every surface. */
  held: boolean;
}

function payloadField(payload: Json | null, key: string): Json | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

/** A story a publisher wrote: an article with a publisher domain. A connector's event, a metric, a live moment has none. */
export function publisherOf(signal: Pick<SentimentInput, "rawPayload" | "sourceName" | "sourceTier">): { domain: string | null; tier: number } {
  const domain = payloadField(signal.rawPayload, "publisher_domain");
  const kind = payloadField(signal.rawPayload, "kind");
  const source = sourceOf(signal as SentimentInput);
  const isArticle = kind === "article" || kind === undefined;
  return { domain: isArticle && typeof domain === "string" && domain.trim() ? domain.trim().toLowerCase() : null, tier: source.tier };
}

/**
 * The classification of one scored signal: the model's label first, the
 * terms as the backstop; null when neither flags it. The hold decision is
 * the rule above: only a tier 1-2 publisher's story displays.
 */
export function classifyAllegation(signal: Pick<SentimentInput, "headline" | "rawPayload" | "sourceName" | "sourceTier">, sentiment: Pick<SentimentResult, "allegation"> | null | undefined): AllegationFlag | null {
  let category: AllegationCategory | null = null;
  let method: AllegationMethod = "model";
  let term: string | undefined;
  if (sentiment?.allegation && isAllegationCategory(sentiment.allegation)) {
    category = sentiment.allegation;
  } else {
    const flagged = allegationTerm(signal.headline);
    if (flagged) {
      category = flagged.category;
      method = "terms";
      term = flagged.term;
    }
  }
  if (!category) return null;
  const publisher = publisherOf(signal);
  const qualifying = publisher.domain !== null && publisher.tier <= REPUTABLE_TIER_MAX;
  return { category, method, ...(term ? { term } : {}), publisherDomain: publisher.domain, publisherTier: publisher.tier, qualifying, held: !qualifying };
}

/** The row the tick hands record_allegation_holds(). */
export interface AllegationHoldRecord {
  signalId: string;
  category: AllegationCategory;
  method: AllegationMethod;
  publisherDomain: string | null;
  publisherTier: number;
  qualifying: boolean;
}

export function allegationHoldRecord(signalId: string, flag: AllegationFlag): AllegationHoldRecord {
  return { signalId, category: flag.category, method: flag.method, publisherDomain: flag.publisherDomain, publisherTier: flag.publisherTier, qualifying: flag.qualifying };
}

export function allegationHoldsPayload(records: readonly AllegationHoldRecord[]): Json {
  return records.map((record) => ({
    signal_id: record.signalId,
    category: record.category,
    method: record.method,
    publisher_domain: record.publisherDomain,
    publisher_tier: record.publisherTier,
    qualifying: record.qualifying,
  })) as unknown as Json;
}
