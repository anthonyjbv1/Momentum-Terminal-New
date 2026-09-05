import { createBrowserClient } from "@supabase/ssr";

import { getSupabasePublishableKey, getSupabaseUrl } from "@/lib/env";
import type { Database } from "@/types/database";
import type { TypedSupabaseClient } from "@/types";

/**
 * Typed Supabase client for Client Components and other browser code.
 *
 * Uses the publishable key, so every query runs as the signed-in user (or as
 * anon) and is subject to Row Level Security. The auth session is shared with
 * the server through cookies managed by @supabase/ssr.
 *
 * @supabase/ssr caches a single browser instance, so calling this repeatedly
 * is cheap.
 */
export function createSupabaseBrowserClient(): TypedSupabaseClient {
  return createBrowserClient<Database>(getSupabaseUrl(), getSupabasePublishableKey());
}
