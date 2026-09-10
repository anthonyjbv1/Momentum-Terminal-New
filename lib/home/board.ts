import "server-only";

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
  "id, slug, display_name, category, avatar_url, current_score, revert_target, spread, buy_price, sell_price, last_tick_at";

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
  /** The Engine's sentence for a narrative; the headline for a signal. */
  text: string;
  personSlug: string;
  personName: string;
  /** Source display name for signals; null for narratives. */
  source: string | null;
  occurredAt: string;
}

interface NarrativeJoin {
  id: string;
  text: string;
  created_at: string;
  people: { slug: string; display_name: string } | null;
}

interface SignalJoin {
  id: string;
  headline: string;
  occurred_at: string;
  people: { slug: string; display_name: string } | null;
  data_sources: { display_name: string } | null;
}

/**
 * The newest Engine narratives and raw signals, merged newest first. Read-only
 * preview for the desktop rail; the full Feed page is a later phase.
 */
export async function getFeedPreview(limit = 8): Promise<FeedPreviewItem[]> {
  const supabase = createSupabaseAdminClient();

  const [narratives, signals] = await Promise.all([
    supabase
      .from("narratives")
      .select("id, text, created_at, people(slug, display_name)")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
    supabase
      .from("signals")
      .select("id, headline, occurred_at, people(slug, display_name), data_sources(display_name)")
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
  ]);

  if (narratives.error) console.warn("[home] narratives preview failed:", narratives.error.message);
  if (signals.error) console.warn("[home] signals preview failed:", signals.error.message);

  const items: FeedPreviewItem[] = [
    ...((narratives.data ?? []) as unknown as NarrativeJoin[]).map((row) => ({
      id: `narrative:${row.id}`,
      kind: "narrative" as const,
      text: row.text,
      personSlug: row.people?.slug ?? "",
      personName: row.people?.display_name ?? "Unknown",
      source: null,
      occurredAt: row.created_at,
    })),
    ...((signals.data ?? []) as unknown as SignalJoin[]).map((row) => ({
      id: `signal:${row.id}`,
      kind: "signal" as const,
      text: row.headline,
      personSlug: row.people?.slug ?? "",
      personName: row.people?.display_name ?? "Unknown",
      source: row.data_sources?.display_name ?? null,
      occurredAt: row.occurred_at,
    })),
  ];

  // Newest first, then id, so two items at the same instant keep one order on every load.
  return items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)).slice(0, limit);
}
