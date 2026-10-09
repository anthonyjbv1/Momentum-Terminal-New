import { isNarrativeEvidence, narrativeCard, projectSignalDetail, showsAsCard, signalCard, type CardEvidenceInput, type CardSubject } from "@/lib/feed/card-copy";
import { isDisplayable } from "@/lib/signals/display";

/**
 * The desktop rail's preview of the Feed, as pure logic: the rows
 * `getFeedPreview` reads in, the items it renders out. No I/O here, so the
 * merge is testable on its own (Phase 31 moved it out of lib/home/board.ts).
 */

export interface FeedPreviewItem {
  id: string;
  kind: "narrative" | "signal";
  /** The card's headline (Phase 30): the Engine's sentence, a metric's plain-language sentence, or an article's title. */
  text: string;
  /** The outlet, above an article's title; null for the Engine's own sentences. */
  label: string | null;
  /** The article, when the headline is its title. */
  link: string | null;
  personSlug: string;
  personName: string;
  /** Where it came from, as a card says it: the outlet, the source noun, or "The Engine" and its sources. */
  source: string | null;
  occurredAt: string;
}

export interface FeedPreviewPerson {
  id: string;
  slug: string;
  display_name: string;
  category: string;
}

/** A narrative as the rail's select returns it, with the signals the Engine linked. */
export interface FeedPreviewNarrativeRow {
  id: string;
  text: string;
  created_at: string;
  score_before: number | string;
  score_after: number | string;
  people: FeedPreviewPerson | null;
  narrative_signals: Array<{
    relation: string | null;
    signals: { id: string; headline: string; occurred_at: string; impact_score: number | string | null; raw_payload: unknown; data_sources: { display_name: string } | null; people: { display_name: string } | null } | null;
  }> | null;
}

/** A signal as the rail's select returns it. */
export interface FeedPreviewSignalRow {
  id: string;
  headline: string;
  occurred_at: string;
  impact_score: number | string | null;
  processed: boolean | null;
  sentiment_label: string | null;
  raw_payload: unknown;
  people: FeedPreviewPerson | null;
  data_sources: { display_name: string } | null;
  /** The narratives that link this signal, by relation (rule 8). */
  narrative_signals?: Array<{ relation: string | null }> | null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest narratives and signals, merged newest first, rendered through the
 * shared card copy so the rail reads exactly as the Feed does. A signal is a
 * card only when its move prints (rule 6) and no narrative carries it as
 * direct evidence (rule 8): on 09-26 Kai Cenat's surge was on the rail twice,
 * once as the Engine's narrative and once as the surge beneath it.
 */
export function buildFeedPreview(
  narratives: FeedPreviewNarrativeRow[],
  signals: FeedPreviewSignalRow[],
  companies: ReadonlyMap<string, string>,
  limit: number,
): FeedPreviewItem[] {
  const subjectOf = (person: FeedPreviewPerson | null): CardSubject => ({
    name: person?.display_name ?? "Unknown",
    category: person?.category ?? null,
    company: person ? (companies.get(person.id) ?? null) : null,
  });

  const items: FeedPreviewItem[] = [
    ...narratives.map((row) => {
      const impact = Math.round((Number(row.score_after) - Number(row.score_before)) * 1000) / 1000;
      const evidence: CardEvidenceInput[] = (row.narrative_signals ?? []).flatMap((link) => {
        const signal = link.signals;
        if (!signal || !isDisplayable(signal)) return [];
        const relation = link.relation === "inverse_pair" ? ("inverse_pair" as const) : ("direct" as const);
        return [
          {
            id: signal.id,
            headline: signal.headline,
            sourceName: signal.data_sources?.display_name ?? null,
            impact: numberOrNull(signal.impact_score),
            occurredAt: signal.occurred_at,
            payload: signal.raw_payload ?? null,
            detail: projectSignalDetail(signal.raw_payload),
            relation,
            personName: relation === "inverse_pair" ? (signal.people?.display_name ?? null) : null,
          },
        ];
      });
      const copy = narrativeCard({ subject: subjectOf(row.people), text: row.text, impact: Number.isFinite(impact) ? impact : null, evidence });
      return {
        id: `narrative:${row.id}`,
        kind: "narrative" as const,
        text: copy.headline,
        label: copy.label,
        link: copy.link,
        personSlug: row.people?.slug ?? "",
        personName: row.people?.display_name ?? "Unknown",
        source: copy.attribution,
        occurredAt: row.created_at,
      };
    }),
    ...signals
      // Rule 8: a signal a narrative carries as direct evidence is that narrative's card, not its own.
      .filter((row) => isDisplayable(row) && showsAsCard(numberOrNull(row.impact_score), row.processed ?? null) && !isNarrativeEvidence(row.narrative_signals))
      .map((row) => {
        const copy = signalCard({
          subject: subjectOf(row.people),
          headline: row.headline,
          sourceName: row.data_sources?.display_name ?? null,
          impact: numberOrNull(row.impact_score),
          processed: row.processed ?? null,
          sentiment: row.sentiment_label,
          occurredAt: row.occurred_at,
          payload: row.raw_payload ?? null,
          detail: projectSignalDetail(row.raw_payload),
        });
        return {
          id: `signal:${row.id}`,
          kind: "signal" as const,
          text: copy.headline,
          label: copy.label,
          link: copy.link,
          personSlug: row.people?.slug ?? "",
          personName: row.people?.display_name ?? "Unknown",
          source: copy.attribution,
          occurredAt: row.occurred_at,
        };
      }),
  ];

  // Newest first, then id, so two items at the same instant keep one order on every load.
  return items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)).slice(0, limit);
}
