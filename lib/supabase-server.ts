import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabasePublishableKey, getSupabaseUrl } from "@/lib/env";
import type { Database } from "@/types/database";
import type { TypedSupabaseClient } from "@/types";

/**
 * Typed Supabase client for Server Components, Server Actions and Route
 * Handlers.
 *
 * Reads and writes the auth session from the request cookies, so it acts as
 * the signed-in user and every query is subject to Row Level Security.
 * Create a fresh instance per request — never cache it in a module variable.
 */
export async function createSupabaseServerClient(): Promise<TypedSupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient<Database>(getSupabaseUrl(), getSupabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll is called from a Server Component, where cookies are
          // read-only. That is fine: proxy.ts refreshes sessions for us.
        }
      },
    },
  });
}
