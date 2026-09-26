"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentProfile } from "@/lib/auth";
import { isBetaSignupEnabled } from "@/lib/env";
import { PROFILE } from "@/lib/profile/copy";
import { AVATAR_PATH_PATTERN, DELETE_REFUSALS, avatarObjectPath, checkAvatar, validateDisplayName } from "@/lib/profile/model";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * The member profile's actions (Phase 32), all behind BETA_SIGNUP_ENABLED.
 * Settings are written as the member under RLS (the column grants allow
 * display_name and email_updates and nothing else). The photo is stored with
 * the service role, in the member's own folder of the private bucket, only
 * after the session has named the member. Deletion is the database's
 * delete_my_account(), run as the member.
 */

export type ProfileFormState = { ok?: string; error?: string };

const AVATAR_BUCKET = "avatars";

async function member() {
  if (!isBetaSignupEnabled()) redirect("/profile");
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login?next=/profile");
  return profile;
}

export async function updateDisplayNameAction(_prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const profile = await member();
  const checked = validateDisplayName(form.get("display_name"));
  if (!checked.ok) return { error: checked.message };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("users").update({ display_name: checked.value }).eq("id", profile.id);
  if (error) return { error: "Could not save. Nothing was changed." };
  revalidatePath("/", "layout");
  return { ok: PROFILE.settings.saved };
}

export async function updateEmailUpdatesAction(_prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const profile = await member();
  const on = form.get("email_updates") === "on";
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("users").update({ email_updates: on }).eq("id", profile.id);
  if (error) return { error: "Could not save. Nothing was changed." };
  revalidatePath("/profile");
  return { ok: PROFILE.settings.saved };
}

export async function uploadAvatarAction(_prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const profile = await member();
  const file = form.get("photo");
  if (!(file instanceof File)) return { error: "Choose a photo first." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkAvatar(file.size, bytes);
  if (!checked.ok) return { error: checked.message };

  const path = avatarObjectPath(profile.id, randomBytes(12).toString("hex"), checked.extension);
  const admin = createSupabaseAdminClient();
  const { error: uploadError } = await admin.storage.from(AVATAR_BUCKET).upload(path, bytes, { contentType: checked.contentType, upsert: false });
  if (uploadError) return { error: "The photo could not be stored. Nothing was changed." };
  const { error: rowError } = await admin.from("users").update({ avatar_path: path }).eq("id", profile.id).is("deleted_at", null);
  if (rowError) {
    await admin.storage.from(AVATAR_BUCKET).remove([path]);
    return { error: "The photo could not be saved. Nothing was changed." };
  }
  if (profile.avatar_path && AVATAR_PATH_PATTERN.test(profile.avatar_path)) await admin.storage.from(AVATAR_BUCKET).remove([profile.avatar_path]);
  revalidatePath("/", "layout");
  return { ok: PROFILE.photo.saved };
}

export async function removeAvatarAction(_prev: ProfileFormState): Promise<ProfileFormState> {
  const profile = await member();
  if (!profile.avatar_path) return { ok: PROFILE.photo.removed };
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("users").update({ avatar_path: null }).eq("id", profile.id);
  if (error) return { error: "Could not remove the photo. Nothing was changed." };
  if (AVATAR_PATH_PATTERN.test(profile.avatar_path)) await admin.storage.from(AVATAR_BUCKET).remove([profile.avatar_path]);
  revalidatePath("/", "layout");
  return { ok: PROFILE.photo.removed };
}

export type DeleteState = { error?: string; code?: string };

export async function deleteAccountAction(_prev: DeleteState, form: FormData): Promise<DeleteState> {
  await member();
  if (form.get("confirm") !== "on") return { error: DELETE_REFUSALS.unconfirmed, code: "unconfirmed" };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_my_account");
  if (error) return { error: DELETE_REFUSALS.unavailable, code: "unavailable" };
  const result = (data ?? {}) as { ok?: boolean; code?: string; avatar_path?: string | null };
  if (!result.ok) {
    const code = result.code ?? "unavailable";
    return { error: DELETE_REFUSALS[code] ?? DELETE_REFUSALS.unavailable, code };
  }

  // The row no longer points at the photo; the object itself goes now.
  if (result.avatar_path && AVATAR_PATH_PATTERN.test(result.avatar_path)) {
    const { error: removeError } = await createSupabaseAdminClient().storage.from(AVATAR_BUCKET).remove([result.avatar_path]);
    if (removeError) console.warn("[profile] deleted account's photo was not removed:", removeError.message);
  }
  // The auth user is gone; clear this browser's session cookies without asking the server about it.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login?deleted=1");
}
