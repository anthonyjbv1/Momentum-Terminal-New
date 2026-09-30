import "server-only";

import { cache } from "react";

import { getCurrentProfile } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { createSupabaseServerClient } from "@/lib/supabase-server";

import { pickTourPerson, type RosterEntry } from "./model";

/**
 * What the onboarding screens and the profile read about following (Phase
 * 32). The roster is public (the service role, like Home); a person's
 * follows are theirs alone, read and written as them under RLS.
 */

export type { RosterEntry };

export const getFollowRoster = cache(async (): Promise<RosterEntry[]> => {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("people")
    .select("id, slug, display_name, category, avatar_url, current_score")
    .eq("is_active", true)
    .eq("is_discoverable", true)
    .order("current_score", { ascending: false })
    .order("id");
  if (error) throw new Error(`Could not load people: ${error.message}`);
  return (data ?? []).map((row) => ({ id: row.id, slug: row.slug, name: row.display_name, category: row.category, avatarUrl: row.avatar_url }));
});

/** The person the tour runs on (Phase 32b): MrBeast when tradeable, else the top tradeable person; null when nobody is. */
export const getTourPersonSlug = cache(async (): Promise<string | null> => {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("people")
    .select("slug, trading_mode")
    .eq("is_active", true)
    .eq("is_discoverable", true)
    .order("current_score", { ascending: false })
    .order("id");
  if (error) {
    console.warn("[tour] could not read people:", error.message);
    return null;
  }
  return pickTourPerson((data ?? []).map((row) => ({ slug: row.slug, tradingMode: row.trading_mode ?? null })));
});

/** The signed-in person's follows, as person ids. Empty when signed out or on any failure. */
export const getMyFollowIds = cache(async (): Promise<string[]> => {
  const profile = await getCurrentProfile().catch(() => null);
  if (!profile) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("follows").select("person_id").eq("user_id", profile.id);
  if (error) {
    console.warn("[follows] read failed:", error.message);
    return [];
  }
  return (data ?? []).map((row) => row.person_id);
});

/**
 * Replaces the signed-in person's follows with exactly this set, as them.
 * Returns the ids added and removed, for the follow events.
 */
export async function setMyFollows(personIds: string[]): Promise<{ added: string[]; removed: string[] }> {
  const profile = await getCurrentProfile();
  if (!profile) throw new Error("Not signed in");
  const roster = new Set((await getFollowRoster()).map((person) => person.id));
  const wanted = new Set(personIds.filter((id) => roster.has(id)));
  const supabase = await createSupabaseServerClient();
  const { data: current, error } = await supabase.from("follows").select("person_id").eq("user_id", profile.id);
  if (error) throw new Error(error.message);
  const have = new Set((current ?? []).map((row) => row.person_id));
  const added = [...wanted].filter((id) => !have.has(id));
  const removed = [...have].filter((id) => !wanted.has(id));
  if (added.length > 0) {
    const { error: insertError } = await supabase.from("follows").insert(added.map((person_id) => ({ user_id: profile.id, person_id })));
    if (insertError) throw new Error(insertError.message);
  }
  if (removed.length > 0) {
    const { error: deleteError } = await supabase.from("follows").delete().eq("user_id", profile.id).in("person_id", removed);
    if (deleteError) throw new Error(deleteError.message);
  }
  return { added, removed };
}

export async function markOnboarded(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("mark_onboarded");
  if (error) console.warn("[onboarding] mark failed:", error.message);
}
