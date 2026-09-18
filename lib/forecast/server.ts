import "server-only";

import { cache } from "react";

import { getCurrentUser } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { createSupabaseServerClient } from "@/lib/supabase-server";

import { readCastResult, readForecastSummary, readOwnVote, type CastForecastResult, type ForecastDirection, type ForecastReason, type ForecastSummary, type OwnForecastVote } from "./model";

/**
 * The Forecast section's server-side reads and its one write (Phase 19).
 *
 * The aggregate is read through the service-role client like every other
 * profile read: forecast_summary() returns counts only, and below the
 * minimum not even a split, so nothing about an individual crosses here.
 * The viewer's OWN vote is read as the viewer, under the select-own policy,
 * which is the only way any vote row ever reaches a client. The write goes
 * through cast_forecast_vote() as the viewer: the actor is the session.
 */

export interface ForecastViewerState {
  signedIn: boolean;
  /** The viewer's active vote on this person, or null. Always null signed out. */
  ownVote: OwnForecastVote | null;
}

/** The crowd's forecast on a person, aggregates only; empty on any failure rather than a broken section. */
export const getForecastSummary = cache(async (personId: string): Promise<ForecastSummary> => {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("forecast_summary", { p_person_id: personId });
  if (error) {
    console.warn("[forecast] summary unavailable:", error.message);
    return readForecastSummary(null, personId);
  }
  return readForecastSummary(data, personId);
});

/** The viewer's own active vote on a person, read under RLS as the viewer. */
export const getForecastViewerState = cache(async (personId: string): Promise<ForecastViewerState> => {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return { signedIn: false, ownVote: null };
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.from("forecast_votes").select("*").eq("person_id", personId).is("superseded_at", null).maybeSingle();
    if (error) throw new Error(error.message);
    return { signedIn: true, ownVote: readOwnVote(data) };
  } catch (error) {
    console.warn("[forecast] own vote unavailable:", error instanceof Error ? error.message : error);
    return { signedIn: true, ownVote: null };
  }
});

export interface CastForecastInput {
  personId: string;
  direction: ForecastDirection;
  reason: ForecastReason;
}

/** Casts the signed-in user's forecast through the RPC. Refusals come back as values; only a missing session throws. */
export async function castForecastVoteAsUser(input: CastForecastInput): Promise<CastForecastResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("cast_forecast_vote", { p_person_id: input.personId, p_direction: input.direction, p_reason: input.reason });
  if (error) throw new Error(error.message);
  return readCastResult(data);
}
