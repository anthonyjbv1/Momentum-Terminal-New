import "server-only";

import { narrativeCard, projectSignalDetail, showsAsCard, signalCard, type CardEvidenceInput, type CardSubject } from "@/lib/feed/card-copy";
import { loadCompaniesByPerson } from "@/lib/feed/enrich";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { buildBoard, type HomeBoard, type MomentumRow, type PersonRow } from "./board-model";

/**
 * Home's server-side reads.
 *
 * These go through the service-role client. `people`, `score_history`,
 * `signals` and `narratives` are readable by signed-in users under RLS and
 * carry no per-user data, but Home is a public page — a signed-out visitor
 * reading with the publishable key would see nothing, because anon has no
 * policies anywhere. Reading them here, in trusted server code, keeps the
 * board public without granting anon a blanket read on the schema. Nothing
 * reaches the browser except the fields rendered below.
 */

/** How far back the momentum change and sparkline look. */
const MOMENTUM_WINDOW = "1 hour";
const SPARKLINE_POINTS = 24;

const PERSON_COLUMNS =
  "id, slug, display_name, category, avatar_url, current_score, revert_target, target_offset, spread, buy_price, sell_price, last_tick_at";

export async function getHomeBoard(): Promise<HomeBoard> {
  const supabase = createSupabaseAdminClient();

  const [peopleResult, momentumResult] = await Promise.all([
    supabase.from("people").select(PERSON_COLUMNS).eq("is_active", true),
    supabase.rpc("home_momentum", { p_window: MOMENTUM_WINDOW, p_points: SPARKLINE_POINTS }),
  ]);

  if (peopleResult.error) throw new Error(`Could not load people: ${peopleResult.error.message}`);

  // Momentum is an enhancement, not a requirement: if the aggregate fails the
  // board still renders, just without change readings.
  if (momentumResult.error) {
    console.warn("[home] home_momentum failed, rendering without movement:", momentumResult.error.message);
  }

  return buildBoard((peopleResult.data ?? []) as PersonRow[], (momentumResult.data ?? []) as MomentumRow[]);
}

// ---------------------------------------------------------------------------
// Feed preview (desktop rail)
// ---------------------------------------------------------------------------

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

interface PersonJoin {
  id: string;
  slug: string;
  display_name: string;
  category: string;
}

interface NarrativeJoin {
  id: string;
  text: string;
  created_at: string;
  score_before: number | string;
  score_after: number | string;
  people: PersonJoin | null;
  narrative_signals: Array<{
    relation: string | null;
    signals: { id: string; headline: string; occurred_at: string; impact_score: number | string | null; raw_payload: unknown; data_sources: { display_name: string } | null; people: { display_name: string } | null } | null;
  }> | null;
}

interface SignalJoin {
  id: string;
  headline: string;
  occurred_at: string;
  impact_score: number | string | null;
  processed: boolean | null;
  sentiment_label: string | null;
  raw_payload: unknown;
  people: PersonJoin | null;
  data_sources: { display_name: string } | null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest Engine narratives and signals, merged newest first, rendered
 * through the shared card copy (Phase 30) so the rail reads exactly as the
 * Feed does: a metric from its payload rather than the stored headline (a
 * sigma headline never reaches the rail), an article by its title and outlet,
 * a template narrative un-nested, and no card whose move prints as zero.
 * Read-only preview for the desktop rail.
 */
export async function getFeedPreview(limit = 8): Promise<FeedPreviewItem[]> {
  const supabase = createSupabaseAdminClient();

  // Signals are read deeper than the rail shows, because the ones whose move
  // prints as zero are not cards and fall out below.
  const [narratives, signals, companies] = await Promise.all([
    supabase
      .from("narratives")
      .select("id, text, created_at, score_before, score_after, people(id, slug, display_name, category), narrative_signals(relation, signals(id, headline, occurred_at, impact_score, raw_payload, data_sources(display_name), people(display_name)))")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
    supabase
      .from("signals")
      .select("id, headline, occurred_at, impact_score, processed, sentiment_label, raw_payload, people(id, slug, display_name, category), data_sources(display_name)")
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit * 4),
    loadCompaniesByPerson(),
  ]);

  if (narratives.error) console.warn("[home] narratives preview failed:", narratives.error.message);
  if (signals.error) console.warn("[home] signals preview failed:", signals.error.message);

  const subjectOf = (person: PersonJoin | null): CardSubject => ({
    name: person?.display_name ?? "Unknown",
    category: person?.category ?? null,
    company: person ? (companies.get(person.id) ?? null) : null,
  });

  const items: FeedPreviewItem[] = [
    ...((narratives.data ?? []) as unknown as NarrativeJoin[]).map((row) => {
      const impact = Math.round((Number(row.score_after) - Number(row.score_before)) * 1000) / 1000;
      const evidence: CardEvidenceInput[] = (row.narrative_signals ?? []).flatMap((link) => {
        const signal = link.signals;
        if (!signal) return [];
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
    ...((signals.data ?? []) as unknown as SignalJoin[])
      .filter((row) => showsAsCard(numberOrNull(row.impact_score), row.processed ?? null))
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
