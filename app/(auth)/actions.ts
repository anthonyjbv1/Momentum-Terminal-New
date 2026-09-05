"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getSiteUrl } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/** State returned to the login/signup forms via useActionState. */
export type AuthFormState = {
  error?: string;
  message?: string;
  /** Echoed back so the form can keep what the user typed after an error. */
  values?: Record<string, string>;
};

const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
const MIN_PASSWORD_LENGTH = 8;

/** Only allow same-origin relative paths as post-auth destinations. */
function safeNextPath(raw: FormDataEntryValue | null, fallback = "/account"): string {
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

export async function signup(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = field(formData, "email").trim().toLowerCase();
  const password = field(formData, "password");
  const username = field(formData, "username").trim().toLowerCase();
  const displayName = field(formData, "display_name").trim();
  const values = { email, username, display_name: displayName };

  if (!email || !password || !username) {
    return { error: "Email, username and password are required.", values };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return {
      error: "Username must be 3–30 characters using lowercase letters, numbers or underscores.",
      values,
    };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, values };
  }

  const supabase = await createSupabaseServerClient();

  const { data: available, error: availabilityError } = await supabase.rpc("username_available", {
    p_username: username,
  });
  if (availabilityError) {
    console.error("[signup] username_available RPC failed:", availabilityError.message);
    return { error: "Could not check username availability. Please try again.", values };
  }
  if (!available) {
    return { error: "That username is already taken.", values };
  }

  // The on_auth_user_created trigger reads username / display_name from this
  // metadata to build the public.users row with the $1,000 demo balance.
  const origin = (await headers()).get("origin") ?? getSiteUrl();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username, display_name: displayName || username },
      emailRedirectTo: `${origin}/auth/callback?next=/account`,
    },
  });
  if (error) {
    return { error: error.message, values };
  }

  // With email confirmation on, Supabase returns a placeholder user with no
  // identities when the email is already registered (to avoid enumeration).
  if (data.user && data.user.identities?.length === 0) {
    return { error: "An account with that email already exists. Try logging in.", values };
  }

  if (data.session) {
    // Email confirmation is disabled: the user is signed in immediately.
    redirect("/account");
  }

  return {
    message: `Almost there — check ${email} for a confirmation link to finish creating your account.`,
  };
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
