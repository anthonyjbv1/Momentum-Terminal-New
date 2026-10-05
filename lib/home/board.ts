import "server-only";

import { loadCompaniesByPerson } from "@/lib/feed/enrich";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { buildBoard, type HomeBoard, type MomentumRow, type PersonRow } from "./board-model";
import { buildFeedPreview, type FeedPreviewItem, type FeedPreviewNarrativeRow, type FeedPreviewSignalRow } from "./feed-preview-model";

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

export type { FeedPreviewItem } from "./feed-preview-model";

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
  // prints as zero, and the ones a narrative carries (rule 8), are not cards
  // and fall out in the merge. The payloads are NOT read here (the
  // tab-switch lag fix, 2026-10-04): thirty-two of them, comment digests
  // included, were most of the rail's bytes, for eight cards. Which rows
  // become cards does not depend on a payload (the move, the processed flag,
  // the void column and the narrative links decide), so the merge runs
  // first and the payloads are read for the cards alone, below.
  const [narratives, signals, companies] = await Promise.all([
    supabase
      .from("narratives")
      .select("id, text, created_at, score_before, score_after, people(id, slug, display_name, category), narrative_signals(relation, signals(id, headline, occurred_at, impact_score, voided_at, data_sources(display_name), people(display_name)))")
      .is("voided_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
    supabase
      .from("signals")
      .select("id, headline, occurred_at, impact_score, processed, sentiment_label, voided_at, people(id, slug, display_name, category), data_sources(display_name), narrative_signals(relation)")
      .is("voided_at", null)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit * 4),
    loadCompaniesByPerson(),
  ]);

  if (narratives.error) console.warn("[home] narratives preview failed:", narratives.error.message);
  if (signals.error) console.warn("[home] signals preview failed:", signals.error.message);

  const narrativeRows = ((narratives.data ?? []) as unknown as Array<Omit<FeedPreviewNarrativeRow, "narrative_signals"> & { narrative_signals: FeedPreviewNarrativeRow["narrative_signals"] }>).map((row) => ({
    ...row,
    narrative_signals: (row.narrative_signals ?? []).map((link) => ({ ...link, signals: link.signals ? { ...link.signals, raw_payload: null } : null })),
  })) as FeedPreviewNarrativeRow[];
  const signalRows = ((signals.data ?? []) as unknown as Array<Omit<FeedPreviewSignalRow, "raw_payload">>).map((row) => ({ ...row, raw_payload: null })) as FeedPreviewSignalRow[];

  // The merge, for the selection: which narratives and signals are the cards.
  const chosen = new Set(buildFeedPreview(narrativeRows, signalRows, companies, limit).map((item) => item.id));
  const cardNarratives = narrativeRows.filter((row) => chosen.has(`narrative:${row.id}`));
  const cardSignals = signalRows.filter((row) => chosen.has(`signal:${row.id}`));

  // The payloads of the cards' signals and of the evidence under the cards' narratives, then the merge again with them in place.
  const payloadIds = [...new Set([...cardSignals.map((row) => row.id), ...cardNarratives.flatMap((row) => (row.narrative_signals ?? []).flatMap((link) => (link.signals ? [link.signals.id] : [])))])];
  const payloads = new Map<string, unknown>();
  if (payloadIds.length > 0) {
    const { data, error } = await supabase.from("signals").select("id, raw_payload").in("id", payloadIds);
    if (error) console.warn("[home] preview payload read failed:", error.message);
    for (const row of data ?? []) payloads.set(row.id, row.raw_payload);
  }
  const withPayloads = {
    narratives: cardNarratives.map((row) => ({
      ...row,
      narrative_signals: (row.narrative_signals ?? []).map((link) => ({ ...link, signals: link.signals ? { ...link.signals, raw_payload: payloads.get(link.signals.id) ?? null } : null })),
    })),
    signals: cardSignals.map((row) => ({ ...row, raw_payload: payloads.get(row.id) ?? null })),
  };
  return buildFeedPreview(withPayloads.narratives, withPayloads.signals, companies, limit);
}
