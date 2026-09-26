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
  // and fall out in the merge.
  const [narratives, signals, companies] = await Promise.all([
    supabase
      .from("narratives")
      .select("id, text, created_at, score_before, score_after, people(id, slug, display_name, category), narrative_signals(relation, signals(id, headline, occurred_at, impact_score, raw_payload, data_sources(display_name), people(display_name)))")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
    supabase
      .from("signals")
      .select("id, headline, occurred_at, impact_score, processed, sentiment_label, raw_payload, people(id, slug, display_name, category), data_sources(display_name), narrative_signals(relation)")
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit * 4),
    loadCompaniesByPerson(),
  ]);

  if (narratives.error) console.warn("[home] narratives preview failed:", narratives.error.message);
  if (signals.error) console.warn("[home] signals preview failed:", signals.error.message);

  return buildFeedPreview(
    (narratives.data ?? []) as unknown as FeedPreviewNarrativeRow[],
    (signals.data ?? []) as unknown as FeedPreviewSignalRow[],
    companies,
    limit,
  );
}
