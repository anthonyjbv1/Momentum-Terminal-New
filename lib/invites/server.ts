import "server-only";

import { absoluteUrl, getResendApiKeyOrNull } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import type { TypedSupabaseClient } from "@/types";

import { sendInviteEmail, type SendResult } from "./email";
import { readInviteView, type InviteView } from "./join";
import { hashInviteToken, newInviteToken } from "./token";

/**
 * Invites, server side (Phase 32). The join page reads and attests through
 * the service role (a visitor with a link has no session); the operator's
 * actions go through the operator's OWN client, so each admin RPC's
 * assert_admin() is the boundary and writes the audit row.
 */

export function joinLink(token: string): string {
  return absoluteUrl(`/join/${token}`);
}

export async function lookupInvite(token: string): Promise<InviteView | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("invite_for_token", { p_token_hash: hashInviteToken(token) });
  if (error) throw new Error(`invite lookup failed: ${error.message}`);
  return readInviteView(data);
}

export async function attestInvite(input: { token: string; username: string; displayName: string | null; termsVersion: string; privacyVersion: string; joinNonceHash: string }): Promise<{ ok: true; email: string } | { ok: false; code: string }> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("invite_attest", {
    p_token_hash: hashInviteToken(input.token),
    p_username: input.username,
    p_display_name: input.displayName ?? "",
    p_age_attested: true,
    p_terms_version: input.termsVersion,
    p_privacy_version: input.privacyVersion,
    p_join_nonce_hash: input.joinNonceHash,
  });
  if (error) return { ok: false, code: "unavailable" };
  const record = (data ?? {}) as Record<string, unknown>;
  if (record.ok === true && typeof record.email === "string") return { ok: true, email: record.email };
  return { ok: false, code: typeof record.code === "string" ? record.code : "unavailable" };
}

// ---------------------------------------------------------------------------
// The operator's side
// ---------------------------------------------------------------------------

export interface IssueReport {
  created: number;
  sent: number;
  failed: Array<{ email: string; error: string }>;
  skipped: Array<{ email: string; reason: string }>;
}

/** "a***@example.com": enough to tell two sends apart in a log, never the address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at <= 0 ? "***" : `${email[0]}***${email.slice(at)}`;
}

/**
 * One send: Resend first, then the row. The row says sent only when Resend
 * accepted the message (an id came back); a refusal is recorded as the
 * invite's last error. Every attempt leaves one log line, with the address
 * masked and never the key or the link.
 */
async function deliver(client: TypedSupabaseClient, inviteId: string, email: string, token: string, expiresAt: Date, fromWaitlist: boolean): Promise<SendResult> {
  const apiKey = getResendApiKeyOrNull();
  const result = await sendInviteEmail({ to: email, link: joinLink(token), expiresAt, fromWaitlist }, { apiKey });
  const recorded = await client.rpc("admin_record_invite_send", { p_invite_id: inviteId, p_ok: result.ok, p_error: result.ok ? undefined : result.error });
  console.log(
    JSON.stringify({
      source: "invite-send",
      invite: inviteId,
      to: maskEmail(email),
      fromWaitlist,
      resendKeySet: apiKey !== null,
      accepted: result.ok,
      resendId: result.ok ? result.id : null,
      error: result.ok ? null : result.error,
      recordError: recorded.error?.message ?? null,
    }),
  );
  if (result.ok && recorded.error) return { ok: false, error: `Resend accepted it (id ${result.id}) but the row could not be marked sent: ${recorded.error.message}` };
  return result;
}

export const INVITE_EXPIRY_DAYS = 14;

/** Issues invites to typed addresses and the waitlist's oldest N, then emails each one. */
export async function issueInvites(client: TypedSupabaseClient, emails: string[], fromWaitlist: number): Promise<IssueReport> {
  const tokens = Array.from({ length: emails.length + Math.max(0, fromWaitlist) }, () => newInviteToken());
  const { data, error } = await client.rpc("admin_issue_invites", {
    p_emails: emails,
    p_from_waitlist: Math.max(0, fromWaitlist),
    p_token_hashes: tokens.map((token) => token.hash),
    p_expires_days: INVITE_EXPIRY_DAYS,
  });
  if (error) throw new Error(error.message);
  const record = (data ?? {}) as { created?: Array<{ id: string; email: string; token_index: number }>; skipped?: Array<{ email: string; reason: string }> };
  const created = record.created ?? [];
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const report: IssueReport = { created: created.length, sent: 0, failed: [], skipped: record.skipped ?? [] };
  // Invited by address or from the waitlist, as the operator asked: the typed
  // addresses are the ones in the form (the RPC lower-cases them the same way);
  // every other invite it created came from "the oldest N on the waitlist".
  const typed = new Set(emails.map((email) => email.trim().toLowerCase()));
  for (const invite of created) {
    const token = tokens[invite.token_index - 1];
    const result = await deliver(client, invite.id, invite.email, token.token, expiresAt, !typed.has(invite.email.toLowerCase()));
    if (result.ok) report.sent += 1;
    else report.failed.push({ email: invite.email, error: result.error });
  }
  return report;
}

/**
 * A new token (the old link dies), a fresh expiry, and the email again.
 * `fromWaitlist` is the row's "From" in the console (the invite carries a
 * waitlist entry): it chooses the email's first line and nothing else.
 */
export async function resendInvite(client: TypedSupabaseClient, inviteId: string, fromWaitlist: boolean): Promise<{ ok: true; sent: boolean; error?: string } | { ok: false; code: string }> {
  const token = newInviteToken();
  const { data, error } = await client.rpc("admin_resend_invite", { p_invite_id: inviteId, p_token_hash: token.hash, p_expires_days: INVITE_EXPIRY_DAYS });
  if (error) throw new Error(error.message);
  const record = (data ?? {}) as { ok?: boolean; code?: string; email?: string };
  if (!record.ok || typeof record.email !== "string") return { ok: false, code: record.code ?? "failed" };
  const result = await deliver(client, inviteId, record.email, token.token, new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000), fromWaitlist);
  return result.ok ? { ok: true, sent: true } : { ok: true, sent: false, error: result.error };
}

export async function revokeInvite(client: TypedSupabaseClient, inviteId: string, note: string): Promise<{ ok: boolean; code?: string }> {
  const { data, error } = await client.rpc("admin_revoke_invite", { p_invite_id: inviteId, p_note: note || undefined });
  if (error) throw new Error(error.message);
  const record = (data ?? {}) as { ok?: boolean; code?: string };
  return { ok: record.ok === true, code: record.code };
}
