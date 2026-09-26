import { NextResponse } from "next/server";

import { getCurrentProfile } from "@/lib/auth";
import { AVATAR_PATH_PATTERN } from "@/lib/profile/model";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * GET /api/me/avatar (Phase 32): the signed-in member's own uploaded photo.
 * The bucket is private; this route names the member from the session,
 * signs a one-minute URL for their object and redirects to it. Nobody can
 * ask for anyone else's photo here, because the route takes no id. Not
 * behind the beta switch: a photo uploaded while it was on keeps showing
 * (in the banner) if it is turned off again, rather than breaking.
 */
export const dynamic = "force-dynamic";

const SIGNED_URL_SECONDS = 60;

export async function GET() {
  const profile = await getCurrentProfile().catch(() => null);
  if (!profile) return new NextResponse(null, { status: 401 });
  const path = profile.avatar_path;
  if (!path || !AVATAR_PATH_PATTERN.test(path)) return new NextResponse(null, { status: 404 });

  const { data, error } = await createSupabaseAdminClient().storage.from("avatars").createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return new NextResponse(null, { status: 404 });
  const response = NextResponse.redirect(data.signedUrl, 302);
  // The ?v= on the request changes with every upload, so a short private cache is safe.
  response.headers.set("cache-control", "private, max-age=50");
  return response;
}
