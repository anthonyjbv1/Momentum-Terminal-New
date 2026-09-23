import "server-only";

import { getPersonBySlug, getPersonSignals } from "@/lib/person/profile";
import { FORCES_WINDOW_MINUTES, RANGES, readForces, toSeries, type ForceImpactRow, type ScoreEventRow, type SeriesRow } from "@/lib/person/profile-model";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { FEATURED_SIGNAL_LIMIT, FEATURED_SLUG, HISTORY_POINTS, HISTORY_WINDOW_MS, changeOver, tickSlot, type FeaturedPayload } from "./model";

/**
 * THE ONE READ BEHIND THE PUBLIC PAGE, and the only place the featured
 * person is looked up.
 *
 * It reads through the service role for the same reason every profile does
 * (anon has no policies) and returns a FeaturedPayload and nothing beyond it:
 * no id, no slug, no user, no trade. The slug is FEATURED_SLUG and no caller
 * can substitute another.
 *
 * SERVER-CACHED FOR ONE TICK. The result is memoised under the 30-second
 * slot it was read in, so however many visitors and however many polls
 * arrive inside a slot, this instance reads the database once for it — and
 * a poll that lands just after the boundary (which is when the page polls)
 * always reads fresh. A failed read is not kept: the next caller tries again.
 */

let memo: { slot: number; payload: Promise<FeaturedPayload | null> } | null = null;

export async function readFeatured(now: number = Date.now()): Promise<FeaturedPayload | null> {
  const slot = tickSlot(now);
  if (memo && memo.slot === slot) return memo.payload;
  const payload = readFeaturedUncached(now).catch((error) => {
    // Forget a failed read so the next request retries rather than serving
    // the failure for the rest of the slot.
    if (memo?.payload === payload) memo = null;
    throw error;
  });
  memo = { slot, payload };
  return payload;
}

/** For tests and the kill-switch check: forget the memo. */
export function forgetFeatured(): void {
  memo = null;
}

async function readFeaturedUncached(now: number): Promise<FeaturedPayload | null> {
  const person = await getPersonBySlug(FEATURED_SLUG);
  if (!person) return null;

  const supabase = createSupabaseAdminClient();
  const range = (key: "1h" | "7d") => RANGES.find((definition) => definition.key === key)!;
  const series = (sinceMs: number, points: number) =>
    supabase.rpc("person_score_series", { p_person_id: person.id, p_since: new Date(now - sinceMs).toISOString(), p_points: points });
  const windowStart = new Date(now - FORCES_WINDOW_MINUTES * 60_000).toISOString();

  const [h1, h24, d7, latestTick, forceWindow, latestEvents, signals] = await Promise.all([
    series(range("1h").windowMs!, range("1h").points),
    series(HISTORY_WINDOW_MS, HISTORY_POINTS),
    series(range("7d").windowMs!, range("7d").points),
    supabase.from("score_history").select("tick_number, recorded_at").eq("person_id", person.id).order("recorded_at", { ascending: false }).order("tick_number", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("score_events").select("force, impact").eq("person_id", person.id).gte("created_at", windowStart).limit(1_000),
    supabase.from("score_events").select("force, impact, tick_number, details").eq("person_id", person.id).order("tick_number", { ascending: false }).order("id").limit(12),
    getPersonSignals(person.id, person.displayName),
  ]);

  for (const [label, result] of Object.entries({ h1, h24, d7, latestTick, forceWindow, latestEvents })) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  const history = toSeries((h24.data ?? []) as SeriesRow[]);
  const latest = latestTick.data ? { tickNumber: Number(latestTick.data.tick_number), at: latestTick.data.recorded_at } : null;
  const forces = readForces((forceWindow.data ?? []) as ForceImpactRow[], (latestEvents.data ?? []) as ScoreEventRow[], latest?.tickNumber ?? null);

  return {
    score: person.score,
    tickNumber: latest?.tickNumber ?? null,
    lastTickAt: latest?.at ?? person.lastTickAt,
    change: {
      h1: changeOver(toSeries((h1.data ?? []) as SeriesRow[])),
      h24: changeOver(history),
      d7: changeOver(toSeries((d7.data ?? []) as SeriesRow[])),
    },
    history: history.map((point) => ({ at: point.at, score: point.score })),
    forces: forces.map((force) => ({ key: force.key, impact: force.impact })),
    windowMinutes: FORCES_WINDOW_MINUTES,
    // The profile's plain-language items, trimmed to what a stranger needs:
    // no ids, no sentiment working, no detail lines.
    signals: signals.slice(0, FEATURED_SIGNAL_LIMIT).map((item) => ({ source: item.source, headline: item.headline, occurredAt: item.occurredAt, impact: item.impact })),
    generatedAt: new Date(now).toISOString(),
  };
}
