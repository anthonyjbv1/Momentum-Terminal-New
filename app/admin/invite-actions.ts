"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/admin/auth";
import { getResendApiKeyOrNull, isBetaSignupEnabled } from "@/lib/env";
import { issueSentence, parseInviteForm } from "@/lib/invites/admin-form";
import { issueInvites, resendInvite, revokeInvite } from "@/lib/invites/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * THE INVITE ACTIONS (Phase 32). Plain forms on /admin, each calling the
 * matching admin RPC as the signed-in operator, so assert_admin() in the
 * database is the boundary and every call leaves its audit row. Sending and
 * resending are refused while BETA_SIGNUP_ENABLED is off (an invite link
 * would lead to a page that does not exist) and while no Resend key is set
 * (nothing would arrive). Revoking works either way.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finish(notice: string): never {
  revalidatePath("/admin");
  redirect(`/admin?signup=${encodeURIComponent(notice.slice(0, 600))}#signup`);
}

function sendingRefusal(): string | null {
  if (!isBetaSignupEnabled()) return 'Sending is off: BETA_SIGNUP_ENABLED is not "true" in this environment, so an invite link would lead nowhere. Nothing was issued.';
  if (!getResendApiKeyOrNull()) return "RESEND_API_KEY is not set in this environment, so no email could be sent. Nothing was issued.";
  return null;
}

export async function issueInvitesAction(form: FormData): Promise<void> {
  await requireAdmin();
  const refusal = sendingRefusal();
  if (refusal) finish(refusal);
  const parsed = parseInviteForm(form.get("emails"), form.get("from_waitlist"));
  if (parsed.error) finish(parsed.error);
  let sentence: string;
  try {
    const report = await issueInvites(await createSupabaseServerClient(), parsed.emails, parsed.fromWaitlist);
    sentence = issueSentence(report, parsed.invalid);
  } catch (error) {
    sentence = `Nothing was issued: ${error instanceof Error ? error.message : String(error)}`;
  }
  finish(sentence);
}

export async function resendInviteAction(form: FormData): Promise<void> {
  await requireAdmin();
  const refusal = sendingRefusal();
  if (refusal) finish(refusal.replace("Nothing was issued.", "Nothing was resent."));
  const id = String(form.get("invite_id") ?? "");
  if (!UUID.test(id)) finish("Unknown invite.");
  let sentence: string;
  try {
    const result = await resendInvite(await createSupabaseServerClient(), id);
    sentence = !result.ok
      ? `Not resent: the invite is ${result.code}.`
      : result.sent
        ? "Resent with a new link; the old link no longer works."
        : `A new link was made (the old one no longer works), but the email failed: ${result.error}.`;
  } catch (error) {
    sentence = `Not resent: ${error instanceof Error ? error.message : String(error)}`;
  }
  finish(sentence);
}

export async function revokeInviteAction(form: FormData): Promise<void> {
  await requireAdmin();
  const id = String(form.get("invite_id") ?? "");
  if (!UUID.test(id)) finish("Unknown invite.");
  const note = String(form.get("note") ?? "").trim().slice(0, 300);
  let sentence: string;
  try {
    const result = await revokeInvite(await createSupabaseServerClient(), id, note);
    sentence = result.ok ? "Revoked. The link no longer works." : `Not revoked: the invite is ${result.code}.`;
  } catch (error) {
    sentence = `Not revoked: ${error instanceof Error ? error.message : String(error)}`;
  }
  finish(sentence);
}
