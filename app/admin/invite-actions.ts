"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/admin/auth";
import { getResendApiKeyOrNull, isBetaSignupEnabled } from "@/lib/env";
import { issueSentence, issueSucceeded, parseInviteForm } from "@/lib/invites/admin-form";
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

/** Back to the console with the outcome; `ok` only when everything asked for happened. */
function finish(notice: string, ok = false): never {
  revalidatePath("/admin");
  redirect(`/admin?signup=${encodeURIComponent(notice.slice(0, 600))}${ok ? "&signup_ok=1" : ""}#signup`);
}

function sendingRefusal(action: string): string | null {
  const betaSignup = isBetaSignupEnabled();
  const resendKeySet = getResendApiKeyOrNull() !== null;
  if (betaSignup && resendKeySet) return null;
  // Booleans only: the key's presence, never its value.
  console.log(JSON.stringify({ source: "invite-send", action, refused: true, betaSignup, resendKeySet }));
  if (!betaSignup) return 'Sending is off: BETA_SIGNUP_ENABLED is not "true" in this environment, so an invite link would lead nowhere. Nothing was issued.';
  return "RESEND_API_KEY is not readable in this environment, so no email could be sent. Nothing was issued. Set it for Production in Vercel, then redeploy: a variable reaches only deployments built after it was set.";
}

export async function issueInvitesAction(form: FormData): Promise<void> {
  await requireAdmin();
  const refusal = sendingRefusal("issue");
  if (refusal) finish(refusal);
  const parsed = parseInviteForm(form.get("emails"), form.get("from_waitlist"));
  if (parsed.error) finish(parsed.error);
  let sentence: string;
  let ok = false;
  try {
    const report = await issueInvites(await createSupabaseServerClient(), parsed.emails, parsed.fromWaitlist);
    sentence = issueSentence(report, parsed.invalid);
    ok = issueSucceeded(report, parsed.invalid);
  } catch (error) {
    sentence = `Nothing was issued: ${error instanceof Error ? error.message : String(error)}`;
  }
  finish(sentence, ok);
}

export async function resendInviteAction(form: FormData): Promise<void> {
  await requireAdmin();
  const refusal = sendingRefusal("resend");
  if (refusal) finish(refusal.replace("Nothing was issued.", "Nothing was resent."));
  const id = String(form.get("invite_id") ?? "");
  if (!UUID.test(id)) finish("Unknown invite.");
  let sentence: string;
  let ok = false;
  try {
    // Only the email's first line depends on it; the console renders it from the row.
    const result = await resendInvite(await createSupabaseServerClient(), id, form.get("from_waitlist") === "1");
    ok = result.ok && result.sent;
    sentence = !result.ok
      ? `Not resent: the invite is ${result.code}.`
      : result.sent
        ? "Resent with a new link; Resend accepted it. The old link no longer works."
        : `Not sent: Resend did not accept it (${result.error}). A new link was made and the old one no longer works; the row stays not sent.`;
  } catch (error) {
    sentence = `Not resent: ${error instanceof Error ? error.message : String(error)}`;
  }
  finish(sentence, ok);
}

export async function revokeInviteAction(form: FormData): Promise<void> {
  await requireAdmin();
  const id = String(form.get("invite_id") ?? "");
  if (!UUID.test(id)) finish("Unknown invite.");
  const note = String(form.get("note") ?? "").trim().slice(0, 300);
  let sentence: string;
  let ok = false;
  try {
    const result = await revokeInvite(await createSupabaseServerClient(), id, note);
    sentence = result.ok ? "Revoked. The link no longer works." : `Not revoked: the invite is ${result.code}.`;
    ok = result.ok;
  } catch (error) {
    sentence = `Not revoked: ${error instanceof Error ? error.message : String(error)}`;
  }
  finish(sentence, ok);
}
