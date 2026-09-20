import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { readSearchResults, SEARCH_LIMIT, type SearchResult, type SearchRow } from "./search-model";

/**
 * Search's server-side read.
 *
 * One call to public.search_people(). The discoverability gate lives inside
 * that function, not here: this client holds the service role and bypasses
 * RLS, and the answer is still only the people who have been opted in. That
 * is the property worth stating out loud — the gate is not "the caller is
 * careful", it is "the query cannot see them".
 */
export async function searchPeople(query: string, limit: number = SEARCH_LIMIT): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("search_people", { p_query: trimmed, p_limit: limit });

  if (error) throw new Error(`Search failed: ${error.message}`);

  return readSearchResults((data ?? []) as SearchRow[]);
}
