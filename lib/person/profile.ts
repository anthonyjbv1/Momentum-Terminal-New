import "server-only";

import { cache } from "react";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import {
  FORCES_WINDOW_MINUTES,
  RANGES,
  convictionLevelFromConcentration,
  deriveState,
  emptyMarketReadings,
  emptySeries,
  isValidSlug,
  mergeSignals,
  readForces,
  readMarketReadings,
  toProfilePerson,
  toSeries,
  type ForceImpactRow,
  type NarrativeRow,
  type PersonProfile,
  type ProfilePerson,
  type ProfilePersonRow,
  type ProfileSignal,
  type ScoreEventRow,
  type SeriesByRange,
  type SeriesRow,
  type SignalRow,
  type TradeEventRow,
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
  "id, slug, display_name, category, avatar_url, current_score, revert_target, target_offset, spread, buy_price, sell_price, created_at, last_tick_at, forecast_paused, " +
  "premium_cents, market_price, market_inventory_units, tier, trading_mode, halted_until, halt_reason, max_allocation_cents, " +
  // The person's own market settings (Phase 29d): shown on the profile wherever they differ from the tier's.
  "depth_units_override, decay_half_life_ticks_override, premium_cap_cents_override, pricing_mode_override, shorting_override";

/** Most signal / narrative items the page lists. */
const SIGNAL_LIMIT = 30;

/** The request's render time; lives in lib/render-time.ts, re-exported for the profile routes. */
export { getRenderedAt } from "@/lib/render-time";

/**
 * The person behind a slug, or null when there is no active person by that
 * name. The row carries the market's STATE (inventory, premium, mode, halt);
 * the market's PARAMETERS (the depth the curve runs on, the premium cap) come
 * from trade_quote(), which resolves the tier's settings and any per-person
 * override exactly as place_order() does, so the book the sheet previews on
 * is the book the server prices on.
 */
export const getPersonBySlug = cache(async (slug: string): Promise<ProfilePerson | null> => {
  if (!isValidSlug(slug)) return null;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("people").select(PERSON_COLUMNS).eq("slug", slug).eq("is_active", true).maybeSingle();
  if (error) throw new Error(`Could not load person: ${error.message}`);
  if (!data) return null;

  const row = data as unknown as ProfilePersonRow & { id: string };
  const quote = await supabase.rpc("trade_quote", { p_person_id: row.id });
  if (quote.error) {
    // The parameters are an enhancement to the preview; the server enforces them regardless.
    console.warn("[person] trade_quote failed, previewing on a flat market:", quote.error.message);
    return toProfilePerson(row);
  }
  const params = (typeof quote.data === "object" && quote.data !== null ? quote.data : {}) as Record<string, unknown>;
  return toProfilePerson({
    ...row,
    depth_units: (params.depth_units as number | string | null | undefined) ?? null,
    premium_cap_cents: (params.premium_cap_cents as number | string | null | undefined) ?? null,
  });
});

/** Score and market-price history for every chart range, each downsampled by the database. */
async function getScoreSeries(personId: string): Promise<SeriesByRange> {
  const supabase = createSupabaseAdminClient();
  const now = Date.now();

  const results = await Promise.all(
    RANGES.map((range) =>
      supabase.rpc("person_market_series", {
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
      console.warn(`[person] person_market_series(${range.key}) failed:`, result.error.message);
      return;
    }
    series[range.key] = toSeries((result.data ?? []) as SeriesRow[]);
  });
  return series;
}

/**
 * Everything the profile page shows for a person except the signal list:
 * identity, the chart series, the STATE reading, the five forces, the market
 * readings behind the two market forces and the CONVICTION level. Null when
 * the slug matches nobody.
 */
export const getPersonProfile = cache(async (slug: string): Promise<PersonProfile | null> => {
  const person = await getPersonBySlug(slug);
  if (!person) return null;

  const supabase = createSupabaseAdminClient();
  const windowStart = new Date(Date.now() - FORCES_WINDOW_MINUTES * 60_000).toISOString();
  const [series, latestTickResult, windowResult, eventsResult, capitalResult, tradesResult] = await Promise.all([
    getScoreSeries(person.id),
    supabase
      .from("score_history")
      .select("tick_number, recorded_at")
      .eq("person_id", person.id)
      .order("recorded_at", { ascending: false })
      .order("tick_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Every force row of the last FORCES_WINDOW_MINUTES, which is what the
    // panel adds up. Two ticks a minute and at most four rows a tick bounds an
    // hour at 480; the limit is the ceiling, not a page. Force and impact
    // only — the working is read once, below, not 480 times.
    supabase
      .from("score_events")
      .select("force, impact")
      .eq("person_id", person.id)
      .gte("created_at", windowStart)
      .limit(1_000),
    // The latest tick's rows, for the working each force recorded there.
    supabase
      .from("score_events")
      .select("force, impact, tick_number, details")
      .eq("person_id", person.id)
      .order("tick_number", { ascending: false })
      .order("id")
      .limit(12),
    // THE MARKET READINGS (Phase 29). Conviction reads open paper capital on
    // the person — the same rows and the same column the Engine sums — and
    // Trading Activity reads the tape over the display window. Neither
    // touches the score; both move the market price, and the panel says so.
    supabase.from("positions").select("amount_cents").eq("person_id", person.id).eq("is_open", true).limit(5_000),
    supabase.from("trade_events").select("side, amount_cents").eq("person_id", person.id).gte("created_at", windowStart).limit(5_000),
  ]);

  if (latestTickResult.error) console.warn("[person] latest tick read failed:", latestTickResult.error.message);
  if (windowResult.error) console.warn("[person] score_events window read failed:", windowResult.error.message);
  if (eventsResult.error) console.warn("[person] score_events read failed:", eventsResult.error.message);
  if (capitalResult.error) console.warn("[person] positions read failed:", capitalResult.error.message);
  if (tradesResult.error) console.warn("[person] trade_events read failed:", tradesResult.error.message);

  const latestRow = latestTickResult.data;
  const latestTick = latestRow ? { tickNumber: Number(latestRow.tick_number), at: latestRow.recorded_at } : null;
  const forces = readForces((windowResult.data ?? []) as ForceImpactRow[], (eventsResult.data ?? []) as ScoreEventRow[], latestTick?.tickNumber ?? null);

  const openCapitalCents = (capitalResult.data ?? []).reduce((total, row) => total + Number(row.amount_cents), 0);
  const market =
    capitalResult.error && tradesResult.error
      ? emptyMarketReadings()
      : readMarketReadings(openCapitalCents, person.maxAllocationCents, (tradesResult.data ?? []) as TradeEventRow[]);

  return {
    person,
    series,
    state: deriveState(series["24h"]),
    forces,
    // Read from the concentration itself: the Conviction force no longer
    // writes score_events (it moves the market price, not the score), so the
    // level comes straight from the capital rather than from an audit row.
    conviction: latestTick === null ? null : convictionLevelFromConcentration(market.conviction.concentration ?? 0),
    market,
    latestTick,
  };
});

/**
 * The person's newest signals and Engine narratives, merged newest first.
 *
 * `personName` is what a metric signal's sentence is rendered WITH: the list
 * shows plain language built from the payload rather than the stored headline,
 * which is how a signal written before Phase 21+ reads without its sigma.
 */
export const getPersonSignals = cache(async (personId: string, personName: string): Promise<ProfileSignal[]> => {
  const supabase = createSupabaseAdminClient();

  const [signals, narratives] = await Promise.all([
    supabase
      .from("signals")
      .select("id, headline, occurred_at, impact_score, sentiment_label, sentiment_confidence, processed, raw_payload, data_sources(display_name)")
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
    personName,
  );
});
