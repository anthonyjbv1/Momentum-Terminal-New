import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/lib/env";
import type { Database } from "@/types/database";
import type { TypedSupabaseClient } from "@/types";

/**
 * Service-role Supabase client. BYPASSES ROW LEVEL SECURITY.
 *
 * Use only from trusted server code: API routes, cron jobs, the scoring
 * Engine, admin tooling. Never pass its results to a client without
 * re-checking authorization yourself.
 *
 * The "server-only" import turns any accidental import from a Client
 * Component into a build error.
 */
export function createSupabaseAdminClient(): TypedSupabaseClient {
  return createClient<Database>(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
