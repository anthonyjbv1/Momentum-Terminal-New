import "server-only";

import { cache } from "react";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import {
  RANGES,
  convictionLevel,
  deriveState,
  emptySeries,
  isValidSlug,
  mergeSignals,
  readForces,
  toProfilePerson,
  toSeries,
  type NarrativeRow,
  type PersonProfile,
  type ProfilePerson,
  type ProfilePersonRow,
  type ProfileSignal,
  type ScoreEventRow,
  type SeriesByRange,
  type SeriesRow,
  type SignalRow,
} from "./profile-model";

/**
 * The profile page's server-side reads.
 *
 * Like Home, these go through the service-role client: the profile is a
 * public page, and anon has no RLS policies anywhere, so a signed-out visitor
 * reading with the publishable key would see nothing. Everything here is
 * per-person, bounded, and read-only; only the rendered fields reach the
 * browser.
 *
 * Every export is wrapped in React cache(), so the page, its metadata and the
 * desktop rail (a parallel route rendered in the same request) share one set
 * of queries.
 */

const PERSON_COLUMNS =
  "id, slug, display_name, category, avatar_url, current_score, revert_target, spread, buy_price, sell_price, created_at, last_tick_at";

/** Most signal / narrative items the page lists. */
const SIGNAL_LIMIT = 30;

/** The request's render time; lives in lib/render-time.ts, re-exported for the profile routes. */
export { getRenderedAt } from "@/lib/render-time";

/** The person behind a slug, or null when there is no active person by that name. */
export const getPersonBySlug = cache(async (slug: string): Promise<ProfilePerson | null> => {
  if (!isValidSlug(slug)) return null;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("people").select(PERSON_COLUMNS).eq("slug", slug).eq("is_active", true).maybeSingle();
  if (error) throw new Error(`Could not load person: ${error.message}`);

  return data ? toProfilePerson(data as ProfilePersonRow) : null;
});

/** Score history for every chart range, each downsampled by the database. */
async function getScoreSeries(personId: string): Promise<SeriesByRange> {
  const supabase = createSupabaseAdminClient();
  const now = Date.now();

  const results = await Promise.all(
    RANGES.map((range) =>
      supabase.rpc("person_score_series", {
        p_person_id: personId,
        p_since: range.windowMs === null ? undefined : new Date(now - range.windowMs).toISOString(),
        p_points: range.points,
      }),
    ),
  );

  const series = emptySeries();
  RANGES.forEach((range, index) => {
    const result = results[index];
    if (result.error) {
      // The chart is an enhancement: a failed range reads as empty, the page still renders.
      console.warn(`[person] person_score_series(${range.key}) failed:`, result.error.message);
      return;
    }
    series[range.key] = toSeries((result.data ?? []) as SeriesRow[]);
  });
  return series;
}

/**
 * Everything the profile page shows for a person except the signal list:
 * identity, the chart series, the STATE reading, the five forces and the
 * CONVICTION level. Null when the slug matches nobody.
 */
export const getPersonProfile = cache(async (slug: string): Promise<PersonProfile | null> => {
  const person = await getPersonBySlug(slug);
  if (!person) return null;

  const supabase = createSupabaseAdminClient();
  const [series, latestTickResult, eventsResult] = await Promise.all([
    getScoreSeries(person.id),
    supabase
      .from("score_history")
      .select("tick_number, recorded_at")
      .eq("person_id", person.id)
      .order("recorded_at", { ascending: false })
      .order("tick_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // The forces of the latest tick. Six rows at most per tick (five forces
    // plus inverse_pair), so twelve covers the latest tick with room to spare.
    supabase
      .from("score_events")
      .select("force, impact, tick_number, details")
      .eq("person_id", person.id)
      .order("tick_number", { ascending: false })
      .order("id")
      .limit(12),
  ]);

  if (latestTickResult.error) console.warn("[person] latest tick read failed:", latestTickResult.error.message);
  if (eventsResult.error) console.warn("[person] score_events read failed:", eventsResult.error.message);

  const latestRow = latestTickResult.data;
  const latestTick = latestRow ? { tickNumber: Number(latestRow.tick_number), at: latestRow.recorded_at } : null;
  const forces = readForces((eventsResult.data ?? []) as ScoreEventRow[], latestTick?.tickNumber ?? null);

  return {
    person,
    series,
    state: deriveState(series["24h"]),
    forces,
    conviction: convictionLevel(forces.find((force) => force.key === "conviction")),
    latestTick,
  };
});

/** The person's newest signals and Engine narratives, merged newest first. */
export const getPersonSignals = cache(async (personId: string): Promise<ProfileSignal[]> => {
  const supabase = createSupabaseAdminClient();

  const [signals, narratives] = await Promise.all([
    supabase
      .from("signals")
      .select("id, headline, occurred_at, impact_score, sentiment_label, sentiment_confidence, processed, data_sources(display_name)")
      .eq("person_id", personId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SIGNAL_LIMIT),
    supabase
      .from("narratives")
      .select("id, text, created_at, score_before, score_after")
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SIGNAL_LIMIT),
  ]);

  if (signals.error) console.warn("[person] signals read failed:", signals.error.message);
  if (narratives.error) console.warn("[person] narratives read failed:", narratives.error.message);

  return mergeSignals(
    (signals.data ?? []) as unknown as SignalRow[],
    (narratives.data ?? []) as unknown as NarrativeRow[],
    SIGNAL_LIMIT,
  );
});
