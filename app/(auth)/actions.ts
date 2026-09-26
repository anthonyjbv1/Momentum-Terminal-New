"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { clientIpFrom } from "@/lib/auth/username-availability";
import { absoluteUrl, isBetaSignupEnabled, isGoogleAuthEnabled } from "@/lib/env";
import { isValidEmail } from "@/lib/landing/waitlist";
import { createSupabaseRateLimiter } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/** State returned to the login forms via useActionState. */
export type AuthFormState = {
  error?: string;
  message?: string;
  /** Echoed back so the form can keep what the user typed after an error. */
  values?: Record<string, string>;
};

/** Only allow same-origin relative paths as post-auth destinations. */
function safeNextPath(raw: FormDataEntryValue | null, fallback = "/profile"): string {
  const value = typeof raw === "string" ? raw : "";
  return value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function login(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = field(formData, "email").trim().toLowerCase();
  const password = field(formData, "password");
  const next = safeNextPath(formData.get("next"));
  const values = { email };

  if (!email || !password) {
    return { error: "Email and password are required.", values };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message, values };
  }

  redirect(next);
}

/** Per address: five sign-in links in ten minutes. */
const LINK_LIMIT = { limit: 5, windowSeconds: 600 } as const;

/**
 * A sign-in link by email, for an account that already exists (Phase 32).
 * Never creates one (shouldCreateUser: false): accounts come only from the
 * join page. The answer is the same whether or not the address has an
 * account, so the form cannot be used to find out who is a member.
 */
export async function requestSignInLink(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  if (!isBetaSignupEnabled()) return { error: "Sign-in links are not available yet." };
  const email = field(formData, "email").trim().toLowerCase();
  const next = safeNextPath(formData.get("next"), "/");
  if (!isValidEmail(email)) return { error: "Enter the email address your account uses.", values: { email } };

  const admin = createSupabaseAdminClient();
  const ip = clientIpFrom(await headers());
  try {
    const decision = await createSupabaseRateLimiter(admin).hit(`signin_link:${ip}`, LINK_LIMIT.limit, LINK_LIMIT.windowSeconds);
    if (!decision.allowed) return { error: "Too many links asked for from your connection. Please wait a few minutes.", values: { email } };
  } catch {
    return { error: "Something went wrong on our side. Please try again in a moment.", values: { email } };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: absoluteUrl(`/auth/callback?next=${encodeURIComponent(next)}`) } });
  // An unknown address comes back as an error from GoTrue; it is answered like a known one.
  if (error && !/signups not allowed|user not found|otp/i.test(error.message)) console.warn("[login] sign-in link failed:", error.message);
  return { message: `If ${email} has an account, a sign-in link is on its way. It works once.` };
}

/** Google, for an account that already exists or for an invited address that has attested on its join page. */
export async function signInWithGoogle(formData: FormData): Promise<void> {
  if (!isGoogleAuthEnabled()) redirect("/login");
  const next = safeNextPath(formData.get("next"), "/");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: absoluteUrl(`/auth/callback?next=${encodeURIComponent(next)}`) } });
  if (error || !data.url) redirect("/login?error=auth_callback");
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
