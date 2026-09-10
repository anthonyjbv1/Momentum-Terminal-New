import "server-only";

import { cache } from "react";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { SHORTING_ENABLED_DEFAULT } from "./direction";

/**
 * Platform-wide switches, read from public.platform_settings (one row).
 *
 * The database is the authority for these: the RPC guard and the positions
 * trigger read the same row, so what the interface reflects and what the
 * write path enforces can never disagree. Flip a switch with the service
 * role, never from code:
 *
 *   update public.platform_settings set shorting_enabled = true, updated_at = now() where id;
 */
export interface PlatformSettings {
  /** False: long-only, a Sell may only close or reduce. True: net-short positions are allowed. */
  shortingEnabled: boolean;
  updatedAt: string | null;
}

export const getPlatformSettings = cache(async (): Promise<PlatformSettings> => {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("platform_settings").select("shorting_enabled, updated_at").eq("id", true).maybeSingle();

  // Fail closed: if the row cannot be read the interface assumes the launch
  // setting. The database enforces the real one regardless.
  if (error) {
    console.warn("[trading] platform_settings read failed, assuming long-only:", error.message);
    return { shortingEnabled: SHORTING_ENABLED_DEFAULT, updatedAt: null };
  }
  return { shortingEnabled: data?.shorting_enabled ?? SHORTING_ENABLED_DEFAULT, updatedAt: data?.updated_at ?? null };
});
