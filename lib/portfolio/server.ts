import "server-only";

import { cache } from "react";

import { getCurrentUser } from "@/lib/auth";
import { RANGES, emptySeries, type SeriesByRange } from "@/lib/person/profile-model";
import { createSupabaseServerClient } from "@/lib/supabase-server";

import {
  HISTORY_PAGE_SIZE,
  historyCursorAfter,
  toPortfolioSummary,
  toTradeHistoryEntry,
  toValuePoint,
  toValueSeries,
  type PortfolioSummary,
  type TradeHistoryCursor,
  type TradeHistoryPage,
  type TradeHistoryRow,
  type ValuePoint,
  type ValueSeriesRow,
} from "./model";

/**
 * The portfolio's server-side reads. Every one runs as the signed-in user
 * through their own RLS-scoped client, so the RPCs see auth.uid() and a user
 * only ever reads their own money. Signed out, everything here is empty.
 */

/** Most value points one live poll returns. */
const LIVE_POINTS_LIMIT = 500;

/** The signed-in user's portfolio summary, or null when signed out or unreadable. */
export const getMyPortfolio = cache(async (): Promise<PortfolioSummary | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_portfolio");
  if (error) {
    console.warn("[portfolio] my_portfolio failed:", error.message);
    return null;
  }
  return toPortfolioSummary(data);
});

/** Recorded value history for every chart range, each downsampled by the database. */
export const getMyValueSeries = cache(async (): Promise<SeriesByRange> => {
  const user = await getCurrentUser();
  const series = emptySeries();
  if (!user) return series;
  const supabase = await createSupabaseServerClient();
  const now = Date.now();

  const results = await Promise.all(
    RANGES.map((range) =>
      supabase.rpc("my_portfolio_value_series", {
        p_since: range.windowMs === null ? undefined : new Date(now - range.windowMs).toISOString(),
        p_points: range.points,
      }),
    ),
  );
  RANGES.forEach((range, index) => {
    const result = results[index];
    if (result.error) {
      // The chart is an enhancement: a failed range reads as empty, the page still renders.
      console.warn(`[portfolio] my_portfolio_value_series(${range.key}) failed:`, result.error.message);
      return;
    }
    series[range.key] = toValueSeries((result.data ?? []) as ValueSeriesRow[]);
  });
  return series;
});

/** One page of the signed-in user's trade history. Empty when signed out. */
export async function getMyTradeHistory(cursor: TradeHistoryCursor | null = null, limit = HISTORY_PAGE_SIZE): Promise<TradeHistoryPage> {
  const user = await getCurrentUser();
  if (!user) return { entries: [], nextCursor: null };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_trade_history", {
    p_before: cursor?.before ?? undefined,
    p_before_id: cursor?.beforeId ?? undefined,
    p_limit: limit,
  });
  if (error) throw new Error(`Could not load the trade history: ${error.message}`);
  const entries = ((data ?? []) as unknown as TradeHistoryRow[]).map(toTradeHistoryEntry).filter((entry) => entry !== null);
  return { entries, nextCursor: historyCursorAfter(entries, limit) };
}

/** The first page, memoised per request. */
export const getFirstTradeHistoryPage = cache(async (): Promise<TradeHistoryPage> => getMyTradeHistory(null));

/** Value points recorded after a moment, oldest first, for the live poll. Reads portfolio_history under RLS. */
export async function getMyValuePointsAfter(after: string | null): Promise<ValuePoint[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const supabase = await createSupabaseServerClient();
  let query = supabase.from("portfolio_history").select("recorded_at, total_value_cents").eq("user_id", user.id).order("recorded_at").order("id").limit(LIVE_POINTS_LIMIT);
  if (after) query = query.gt("recorded_at", after);
  const { data, error } = await query;
  if (error) {
    console.warn("[portfolio] value points read failed:", error.message);
    return [];
  }
  return (data ?? []).map((row) => toValuePoint({ at: row.recorded_at, value_cents: row.total_value_cents })).filter((point): point is ValuePoint => point !== null);
}
