"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { checkUsernameAvailability, clientIpFrom } from "@/lib/auth/username-availability";
import { absoluteUrl, isBetaSignupEnabled, isGoogleAuthEnabled } from "@/lib/env";
import { parseJoinForm, submitJoin, type JoinOutcome } from "@/lib/invites/join";
import { attestInvite } from "@/lib/invites/server";
import { createSupabaseRateLimiter } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/** What the join form shows after a submit. */
export type JoinFormState = { outcome: JoinOutcome | null; values: { username: string; display_name: string } };

/**
 * The join form's one action (Phase 32). Everything it decides is in
 * lib/invites/join.ts; this file only hands it the real dependencies. New
 * accounts land on the onboarding screens (/start) after the email link or
 * the Google round trip, through /auth/callback.
 */
export async function joinAction(_prev: JoinFormState, form: FormData): Promise<JoinFormState> {
  const input = parseJoinForm(form);
  const requestHeaders = await headers();
  const ip = clientIpFrom(requestHeaders);
  const admin = createSupabaseAdminClient();
  const callback = absoluteUrl("/auth/callback?next=/start");

  const outcome = await submitJoin(input, {
    enabled: isBetaSignupEnabled(),
    googleEnabled: isGoogleAuthEnabled(),
    limiter: createSupabaseRateLimiter(admin),
    ip,
    usernameAvailable: async (username) => {
      const result = await checkUsernameAvailability(username, ip);
      if (result.ok) return result.available ? "available" : "taken";
      return result.reason === "rate_limited" ? "rate_limited" : "unavailable";
    },
    attest: attestInvite,
    sendLink: async (email) => {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: callback } });
      if (error) {
        console.warn("[join] sign-in link failed:", error.message);
        return { ok: false, message: "The sign-in email could not be sent. Please try again in a moment." };
      }
      return { ok: true };
    },
    googleUrl: async () => {
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback } });
      if (error || !data.url) {
        console.warn("[join] Google sign-in failed:", error?.message ?? "no url");
        return { ok: false, message: "Google sign-in could not start. Use the email link instead." };
      }
      return { ok: true, url: data.url };
    },
  });

  if (outcome.kind === "redirect") redirect(outcome.url);
  return { outcome, values: { username: input.username, display_name: input.displayName } };
}
