import "server-only";

import { cache } from "react";

import { getCurrentProfile, getCurrentUser } from "@/lib/auth";
import { absoluteUrl } from "@/lib/env";
import type { RosterEntry } from "@/lib/onboarding/model";
import { getFollowRoster, getMyFollowIds } from "@/lib/onboarding/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

import { avatarSource } from "./model";

/**
 * What the member profile shows (Phase 32), read as the member under RLS:
 * their row, three counts, who they follow, and their referral link. Every
 * count is theirs alone; nothing here reads another member's data.
 */

export interface ProfileView {
  id: string;
  email: string;
  username: string;
  displayName: string;
  joinedAt: string;
  avatarSrc: string | null;
  hasUploadedPhoto: boolean;
  emailUpdates: boolean;
  referralLink: string | null;
  isOperator: boolean;
  activity: { openPositions: number; trades: number; forecasts: number };
  following: RosterEntry[];
}

export const getMyProfileView = cache(async (): Promise<ProfileView | null> => {
  const [user, profile] = await Promise.all([getCurrentUser(), getCurrentProfile()]);
  if (!user || !profile) return null;
  const supabase = await createSupabaseServerClient();

  const [open, trades, forecasts, roster, followIds] = await Promise.all([
    supabase.from("positions").select("person_id").eq("user_id", profile.id).eq("is_open", true),
    supabase.from("trade_orders").select("id", { count: "exact", head: true }).eq("user_id", profile.id),
    supabase.from("forecast_votes").select("id", { count: "exact", head: true }).eq("user_id", profile.id).is("superseded_at", null),
    getFollowRoster(),
    getMyFollowIds(),
  ]);
  for (const result of [open, trades, forecasts]) if (result.error) console.warn("[profile] count failed:", result.error.message);

  const followed = new Set(followIds);
  return {
    id: profile.id,
    email: user.email ?? profile.email,
    username: profile.username,
    displayName: profile.display_name,
    joinedAt: profile.created_at,
    avatarSrc: avatarSource(profile),
    hasUploadedPhoto: Boolean(profile.avatar_path),
    emailUpdates: Boolean(profile.email_updates),
    referralLink: profile.referral_code ? absoluteUrl(`/?ref=${profile.referral_code}`) : null,
    isOperator: Boolean(profile.is_admin),
    activity: {
      openPositions: new Set((open.data ?? []).map((row) => row.person_id)).size,
      trades: trades.count ?? 0,
      forecasts: forecasts.count ?? 0,
    },
    following: roster.filter((person) => followed.has(person.id)),
  };
});
