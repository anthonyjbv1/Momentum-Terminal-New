import "server-only";

import { cache } from "react";

import { companyForTicker } from "@/lib/people/company";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { projectSignalDetail, type SignalDetail } from "./card-copy";
import type { SparkPoint } from "./story-card";

/**
 * WHAT THE SERVER ADDS TO A CARD (Phase 30).
 *
 * `feed_entries()` passes a signal's payload only for metrics, so the outlet,
 * the article link and a comment digest's shape never reached the Feed. They
 * are read here, through the service-role client, for exactly the signals on
 * the page — and projected (`projectSignalDetail`) to a handful of fields
 * before anything leaves the server. A comment digest's payload holds the
 * sampled comment texts; the projection never reads them, so they never
 * reach a browser.
 *
 * The company behind a company-news signal comes from the person's Finnhub
 * mapping (the ticker) through `lib/people/company.ts`. Both reads are
 * memoised per request.
 */

type DetailRow = { id: string; raw_payload: unknown };

/** The projections for a set of signal ids, keyed by id. Ids the database does not return are simply absent. */
export async function loadSignalDetails(ids: readonly string[]): Promise<Map<string, SignalDetail>> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const out = new Map<string, SignalDetail>();
  if (unique.length === 0) return out;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("signals").select("id, raw_payload").in("id", unique);
  if (error) {
    // The detail is an enhancement: a card without it still renders, with the source noun in place of the outlet.
    console.warn("[feed] signal detail read failed:", error.message);
    return out;
  }
  for (const row of (data ?? []) as DetailRow[]) out.set(row.id, projectSignalDetail(row.raw_payload));
  return out;
}

/** Roughly one point per this many minutes across the page's span; the RPC caps a read at 1,000 points. */
const SERIES_MINUTES_PER_POINT = 5;
const SERIES_MAX_POINTS = 1000;

/**
 * Each person's score series from `since` to now (Phase 34), through
 * `person_score_series`, one bounded read per person on the page. The card
 * takes the hours around its own move out of it. A person the read fails
 * for simply has no sparkline; the card renders without one.
 */
export async function loadScoreSeries(personIds: readonly string[], since: Date): Promise<Map<string, SparkPoint[]>> {
  const unique = [...new Set(personIds.filter((id) => typeof id === "string" && id.length > 0))];
  const out = new Map<string, SparkPoint[]>();
  if (unique.length === 0) return out;

  const spanMinutes = Math.max(1, (Date.now() - since.getTime()) / 60_000);
  const points = Math.min(SERIES_MAX_POINTS, Math.max(2, Math.ceil(spanMinutes / SERIES_MINUTES_PER_POINT)));
  const supabase = createSupabaseAdminClient();
  await Promise.all(
    unique.map(async (personId) => {
      const { data, error } = await supabase.rpc("person_score_series", { p_person_id: personId, p_since: since.toISOString(), p_points: points });
      if (error) {
        console.warn("[feed] score series read failed:", error.message);
        return;
      }
      const series: SparkPoint[] = [];
      for (const row of (data ?? []) as Array<{ bucket_at: string; score: number | string }>) {
        const score = typeof row.score === "number" ? row.score : Number(row.score);
        if (row.bucket_at && Number.isFinite(score)) series.push({ at: row.bucket_at, score });
      }
      out.set(personId, series);
    }),
  );
  return out;
}

type MappingRow = { person_id: string; external_identifier: string | null; data_sources: { name: string } | null };

/**
 * The company for every person with an active Finnhub mapping, by person id.
 * One read per request, shared by the Feed, the profile and the rail.
 */
export const loadCompaniesByPerson = cache(async (): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("person_data_sources")
    .select("person_id, external_identifier, data_sources!inner(name)")
    .eq("is_active", true)
    .eq("data_sources.name", "finnhub");
  if (error) {
    console.warn("[feed] company read failed:", error.message);
    return out;
  }
  for (const row of (data ?? []) as unknown as MappingRow[]) {
    const company = companyForTicker(row.external_identifier);
    if (company) out.set(row.person_id, company);
  }
  return out;
});
