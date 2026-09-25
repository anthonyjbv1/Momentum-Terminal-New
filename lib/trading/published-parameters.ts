import "server-only";

import { cache } from "react";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { LIVE_TICK_MS } from "@/lib/person/live-series";

import { DEFAULT_PLATFORM_SETTINGS } from "./settings";

/**
 * THE PUBLISHED PARAMETERS (Phase 29): the market's tier settings and the
 * platform-wide levers the public explainer prints, read from the same rows
 * place_order() enforces. Read-only, service role (the settings table has a
 * read policy for signed-in users; the explainer is public).
 */

export interface PublishedTierParameters {
  tier: "public_figure" | "private_individual";
  /** 'flat' is the explicit opt-in to a flat market (Phase 29b): no premium, no impact, no order-size limit from depth. */
  pricingMode: "curve" | "flat";
  /** Units per point of premium. Always a number; kept while the tier is flat. */
  depthUnits: number;
  /** The premium's half-life with no trading, in seconds (ticks × the cadence). */
  halfLifeSeconds: number;
  premiumCapCents: number;
  minHoldSeconds: number;
  maxOrderShareOfDepth: number;
  aggregateExposureCapUnits: number;
  breakerPremiumCents: number;
  breakerWindowSeconds: number;
  breakerHaltSeconds: number;
  breakerPriceCents: number | null;
  shortingAllowed: boolean;
}

export interface PublishedMarketParameters {
  tiers: { public_figure: PublishedTierParameters | null; private_individual: PublishedTierParameters | null };
  minOrderCents: number;
  priceToleranceCents: number;
  closeCooldownSeconds: number;
  shortingEnabled: boolean;
}

function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export const readPublishedMarketParameters = cache(async (): Promise<PublishedMarketParameters> => {
  const supabase = createSupabaseAdminClient();
  const [tiers, settings] = await Promise.all([
    supabase.from("market_tier_settings").select("*"),
    supabase.from("platform_settings").select("min_order_cents, price_tolerance_cents, close_cooldown_seconds, shorting_enabled").eq("id", true).maybeSingle(),
  ]);
  if (tiers.error) console.warn("[market] market_tier_settings read failed:", tiers.error.message);
  if (settings.error) console.warn("[market] platform_settings read failed:", settings.error.message);

  const byTier: PublishedMarketParameters["tiers"] = { public_figure: null, private_individual: null };
  for (const row of tiers.data ?? []) {
    if (row.tier !== "public_figure" && row.tier !== "private_individual") continue;
    byTier[row.tier] = {
      tier: row.tier,
      pricingMode: row.pricing_mode === "flat" ? "flat" : "curve",
      depthUnits: toInt(row.depth_units, 0),
      halfLifeSeconds: Math.round((toInt(row.decay_half_life_ticks, 0) * LIVE_TICK_MS) / 1000),
      premiumCapCents: toInt(row.premium_cap_cents, 0),
      minHoldSeconds: toInt(row.min_hold_seconds, 0),
      maxOrderShareOfDepth: Number(row.max_order_share_of_depth),
      aggregateExposureCapUnits: toInt(row.aggregate_exposure_cap_units, 0),
      breakerPremiumCents: toInt(row.breaker_premium_cents, 0),
      breakerWindowSeconds: toInt(row.breaker_window_seconds, 0),
      breakerHaltSeconds: toInt(row.breaker_halt_seconds, 0),
      breakerPriceCents: row.breaker_price_cents === null ? null : toInt(row.breaker_price_cents, 0),
      shortingAllowed: row.shorting_allowed === true,
    };
  }

  return {
    tiers: byTier,
    minOrderCents: toInt(settings.data?.min_order_cents, DEFAULT_PLATFORM_SETTINGS.minOrderCents),
    priceToleranceCents: toInt(settings.data?.price_tolerance_cents, DEFAULT_PLATFORM_SETTINGS.priceToleranceCents),
    closeCooldownSeconds: toInt(settings.data?.close_cooldown_seconds, DEFAULT_PLATFORM_SETTINGS.closeCooldownSeconds),
    shortingEnabled: settings.data?.shorting_enabled === true,
  };
});
