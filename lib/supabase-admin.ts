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
/**
 * Branded so that functions which must only ever run with the service role
 * (e.g. lib/behavioral/queries.ts) can refuse an RLS-scoped client at the
 * type level.
 */
export type SupabaseAdminClient = TypedSupabaseClient & { readonly __role: "service_role" };

export function createSupabaseAdminClient(): SupabaseAdminClient {
  return createClient<Database>(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }) as SupabaseAdminClient;
}
