import "server-only";

import { cache } from "react";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { FEED_PAGE_SIZE, cursorAfter, feedCategoryOptions, toFeedEntry, type FeedCursor, type FeedPage, type FeedRow } from "./feed-model";

/**
 * The Feed's server-side reads.
 *
 * Like Home and the profile, these go through the service-role client: the
 * Feed is a public page and anon has no RLS policies. Every read is bounded
 * (one page of entries, the people roster) and read-only.
 */

export async function getFeedPage(cursor: FeedCursor | null = null, limit = FEED_PAGE_SIZE): Promise<FeedPage> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("feed_entries", {
    p_before: cursor?.before ?? undefined,
    p_before_id: cursor?.beforeId ?? undefined,
    p_limit: limit,
  });
  if (error) throw new Error(`Could not load the feed: ${error.message}`);

  const entries = ((data ?? []) as unknown as FeedRow[]).map(toFeedEntry).filter((entry) => entry !== null);
  return { entries, nextCursor: cursorAfter(entries, limit) };
}

/** The first page, memoised per request. */
export const getFirstFeedPage = cache(async (): Promise<FeedPage> => getFeedPage(null));

export interface RosterPerson {
  id: string;
  slug: string;
  name: string;
  category: string;
  avatarUrl: string | null;
}

/** Everyone the Engine tracks, for the category filter and the empty state's roster. */
export const getFeedRoster = cache(async (): Promise<RosterPerson[]> => {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("people")
    .select("id, slug, display_name, category, avatar_url")
    .eq("is_active", true)
    .order("display_name");
  if (error) throw new Error(`Could not load people: ${error.message}`);
  return (data ?? []).map((row) => ({ id: row.id, slug: row.slug, name: row.display_name, category: row.category, avatarUrl: row.avatar_url }));
});

export async function getFeedCategories() {
  return feedCategoryOptions(await getFeedRoster());
}
