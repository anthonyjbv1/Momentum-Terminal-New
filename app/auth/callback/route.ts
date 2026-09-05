import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * Auth callback. Supabase sends users here from email links (signup
 * confirmation, magic link, password recovery). Two link styles are handled:
 *   - PKCE:      ?code=...              -> exchangeCodeForSession
 *   - Token hash: ?token_hash=...&type=... -> verifyOtp
 * On success the session cookies are set and the user is redirected to `next`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const rawNext = searchParams.get("next") ?? "/account";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/account";

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
