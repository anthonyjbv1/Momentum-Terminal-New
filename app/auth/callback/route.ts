import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { callbackErrorDestination } from "@/lib/invites/join";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * Auth callback. Supabase sends users here from email links (sign-in links,
 * confirmation) and from Google. Two link styles are handled:
 *   - PKCE:       ?code=...                -> exchangeCodeForSession
 *   - Token hash: ?token_hash=...&type=... -> verifyOtp (works on another device)
 * On success the session cookies are set and the user is redirected to `next`.
 *
 * Phase 32: a provider that reports an error instead of a session is sent to
 * the login page with the reason. An account the database refused (no open
 * invite for that address, which is what a different Google address means)
 * reads as "not_invited".
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const rawNext = searchParams.get("next") ?? "/profile";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/profile";

  const failure = callbackErrorDestination(searchParams);
  if (failure && !code && !tokenHash) {
    return NextResponse.redirect(`${origin}${failure}`);
  }

  const supabase = await createSupabaseServerClient();

  let succeeded = false;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    succeeded = !error;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    succeeded = !error;
  }

  if (!succeeded) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback`);
  }

  // Behind Vercel's proxy the original host arrives in x-forwarded-host.
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (process.env.NODE_ENV === "development" || !forwardedHost) {
    return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`https://${forwardedHost}${next}`);
}
