import "server-only";

import type { Session, User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";

import { createSupabaseServerClient } from "@/lib/supabase-server";
import type { UserProfile } from "@/types";

/**
 * Auth session helpers for server code (Server Components, Server Actions,
 * Route Handlers). All results are memoised per request with React cache().
 */

/**
 * The signed-in auth user, verified against the Supabase Auth server.
 * Returns null when nobody is signed in. Use this (not getCurrentSession)
 * whenever you are about to trust the identity.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * The raw session from the request cookies (access token, refresh token,
 * expiry). Handy when you need the access token to call another service.
 * NOT verified server-side — use getCurrentUser() for authorization decisions.
 */
export const getCurrentSession = cache(async (): Promise<Session | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
});

/**
 * The signed-in user's public.users row (profile + wallet), or null.
 */
export const getCurrentProfile = cache(async (): Promise<UserProfile | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("users").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  return data;
});

/**
 * Guard for protected server code. Redirects to /login (remembering where the
 * user was heading) when nobody is signed in; otherwise returns the user.
 */
export async function requireUser(returnTo?: string): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login");
  }
  return user;
}
