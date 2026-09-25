import "server-only";

import { cache } from "react";

import { companyForTicker } from "@/lib/people/company";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { projectSignalDetail, type SignalDetail } from "./card-copy";

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
