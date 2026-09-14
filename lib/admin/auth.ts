import "server-only";

import { notFound } from "next/navigation";
import { cache } from "react";

import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * ADMIN ACCESS (Phase 9).
 *
 * /admin is its own route tree, outside the (app) group, for a reason that
 * outlives the closed test: the Phase 7 auth gate is one removable file, and
 * when the beta opens and that file goes, every route inside the main app
 * becomes reachable by anyone. Admin routes living in that tree would have to
 * be re-secured at exactly the moment attention is elsewhere. Kept separate,
 * the role check below is the only thing that has ever guarded them, so
 * removing the gate cannot expose them.
 *
 * The rules:
 *   - the existing Supabase session identifies the operator; there are no
 *     separate admin credentials to lose
 *   - `users.is_admin` is the flag, set only by the service role: the
 *     authenticated UPDATE grant covers username, display_name and avatar_url,
 *     so no one can grant it to themselves
 *   - enforcement is SERVER-SIDE on every route and before every query
 *   - a non-admin gets 404, not 403. A 403 advertises that the route exists;
 *     a 404 says only what an unauthenticated crawler would learn anyway.
 */

export interface AdminUser {
  id: string;
  email: string;
  username: string;
}

/**
 * The signed-in operator, or null for anyone else — signed out, or signed in
 * without the flag. Read through the USER's own client, so RLS applies and the
 * answer is about the caller rather than about whoever the service role can
 * see. Cached per request: several sections check it.
 */
export const getAdminUser = cache(async (): Promise<AdminUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data, error } = await supabase.from("users").select("id, email, username, is_admin").eq("id", auth.user.id).maybeSingle();
  if (error || !data || !data.is_admin) return null;
  return { id: data.id, email: data.email, username: data.username };
});

/**
 * Guards an admin route or an admin query. Returns the operator, or renders
 * the 404 page and never returns. Every admin read calls this FIRST — the
 * service-role client is only ever built after it has passed.
 */
export async function requireAdmin(): Promise<AdminUser> {
  const user = await getAdminUser();
  if (!user) notFound();
  return user;
}
