import "server-only";

import { cache } from "react";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { SHORTING_ENABLED_DEFAULT } from "./direction";
import { PRICE_TOLERANCE_CENTS_DEFAULT, RISK_LEVER_DEFAULTS, cents, type Cents } from "./model";

/**
 * Platform-wide switches and tunables, read from public.platform_settings
 * (one row).
 *
 * The database is the authority for these: place_order(), the RPC guard and
 * the positions trigger read the same row, so what the interface reflects
 * and what the write path enforces can never disagree. Change a value with
 * the service role, never from code:
 *
 *   update public.platform_settings set shorting_enabled = true, updated_at = now() where id;
 */
export interface PlatformSettings {
  /** False: long-only, a Sell may only close or reduce. True: net-short positions are allowed. */
  shortingEnabled: boolean;
  /** PRICE_TOLERANCE_CENTS: how far a displayed price may sit from the server's quote and still fill. */
  priceToleranceCents: Cents;
  /** RISK LEVER 1: most open units one user may hold on one person. */
  maxUnitsPerPerson: number;
  /** RISK LEVER 2: largest share (0–1) of a person's open units one user may hold. */
  maxOpenInterestShare: number;
  /** RISK LEVER 3: most close value one user may realise in a trailing day. */
  maxDailyCloseCents: Cents;
  /** RISK LEVER 4: seconds a lot must be open before it can be closed. */
  closeCooldownSeconds: number;
  updatedAt: string | null;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  shortingEnabled: SHORTING_ENABLED_DEFAULT,
  priceToleranceCents: PRICE_TOLERANCE_CENTS_DEFAULT,
  maxUnitsPerPerson: RISK_LEVER_DEFAULTS.maxUnitsPerPerson,
  maxOpenInterestShare: RISK_LEVER_DEFAULTS.maxOpenInterestShare,
  maxDailyCloseCents: RISK_LEVER_DEFAULTS.maxDailyCloseCents,
  closeCooldownSeconds: RISK_LEVER_DEFAULTS.closeCooldownSeconds,
  updatedAt: null,
};

function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export const getPlatformSettings = cache(async (): Promise<PlatformSettings> => {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("platform_settings")
    .select("shorting_enabled, price_tolerance_cents, max_units_per_person, max_open_interest_share, max_daily_close_cents, close_cooldown_seconds, updated_at")
    .eq("id", true)
    .maybeSingle();

  // Fail closed: if the row cannot be read the interface assumes the launch
  // settings. The database enforces the real ones regardless.
  if (error || !data) {
    if (error) console.warn("[trading] platform_settings read failed, assuming launch settings:", error.message);
    return DEFAULT_PLATFORM_SETTINGS;
  }
  const share = Number(data.max_open_interest_share);
  return {
    shortingEnabled: data.shorting_enabled ?? SHORTING_ENABLED_DEFAULT,
    priceToleranceCents: cents(toInt(data.price_tolerance_cents, PRICE_TOLERANCE_CENTS_DEFAULT)),
    maxUnitsPerPerson: toInt(data.max_units_per_person, RISK_LEVER_DEFAULTS.maxUnitsPerPerson),
    maxOpenInterestShare: Number.isFinite(share) ? share : RISK_LEVER_DEFAULTS.maxOpenInterestShare,
    maxDailyCloseCents: cents(toInt(data.max_daily_close_cents, RISK_LEVER_DEFAULTS.maxDailyCloseCents)),
    closeCooldownSeconds: toInt(data.close_cooldown_seconds, RISK_LEVER_DEFAULTS.closeCooldownSeconds),
    updatedAt: data.updated_at ?? null,
  };
});
