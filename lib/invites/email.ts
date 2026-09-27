/**
 * THE INVITATION EMAIL (Phase 32).
 *
 * Sent by our server through Resend's API from the verified domain, one
 * message per invite. The magic-link and confirmation emails are not ours:
 * Supabase sends those through the same domain over SMTP.
 *
 * The copy follows the house rules: paper trading said plainly, no urgency,
 * the expiry as a date rather than a countdown, and a line for anyone who
 * never asked. The link is the only place the token ever exists.
 */

export const INVITE_FROM = "Momentum Terminal <info@momentumterminal.app>";
export const INVITE_REPLY_TO = "info@momentumterminal.app";
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface InviteEmailInput {
  to: string;
  link: string;
  expiresAt: Date;
}

export interface InviteEmail {
  from: string;
  reply_to: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/** "Saturday 10 October 2026", in UTC so every recipient reads the same date, assembled from parts so no runtime's punctuation leaks in. */
export function expiryDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function inviteEmail({ to, link, expiresAt }: InviteEmailInput): InviteEmail {
  const date = expiryDate(expiresAt);
  const lines = [
    "You asked to join the Momentum Terminal beta, and a place is ready for you.",
    "",
    `Accept the invitation: ${link}`,
    "",
    `The link works once, for this address only, until ${date}.`,
    "",
    "Momentum Terminal is paper trading: you start with a paper balance, and no real money is involved at any point.",
    "",
    "If you did not ask to join, ignore this email and nothing will happen.",
    "",
    "Momentum Terminal",
  ];
  const safe = escapeHtml(link);
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 20px;background:#000;color:#f5f5f5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:480px;margin:0 auto;">
      <p style="font-size:16px;line-height:1.6;margin:0 0 24px;">You asked to join the Momentum Terminal beta, and a place is ready for you.</p>
      <p style="margin:0 0 24px;"><a href="${safe}" style="display:inline-block;background:#f5f5f5;color:#000;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:999px;">Accept the invitation</a></p>
      <p style="font-size:14px;line-height:1.6;color:#a3a3a3;margin:0 0 16px;">The link works once, for this address only, until ${escapeHtml(date)}.</p>
      <p style="font-size:14px;line-height:1.6;color:#a3a3a3;margin:0 0 16px;">Momentum Terminal is paper trading: you start with a paper balance, and no real money is involved at any point.</p>
      <p style="font-size:14px;line-height:1.6;color:#a3a3a3;margin:0 0 32px;">If you did not ask to join, ignore this email and nothing will happen.</p>
      <p style="font-size:13px;color:#737373;margin:0;">Momentum Terminal</p>
    </div>
  </body>
</html>`;
  return { from: INVITE_FROM, reply_to: INVITE_REPLY_TO, to: [to], subject: "Your invitation to Momentum Terminal", text: lines.join("\n"), html };
}

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export interface SendDeps {
  apiKey: string | null;
  fetch?: typeof fetch;
}

/** Sends one invitation. Never throws: a failure is a result the console records against the invite. */
export async function sendInviteEmail(input: InviteEmailInput, deps: SendDeps): Promise<SendResult> {
  if (!deps.apiKey) return { ok: false, error: "RESEND_API_KEY is not set" };
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(inviteEmail(input)),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
    if (!response.ok) return { ok: false, error: `Resend ${response.status}: ${body?.message ?? body?.name ?? "request failed"}`.slice(0, 300) };
    // Accepted means Resend gave the message an id; a 2xx without one is not proof it was queued.
    if (typeof body?.id !== "string" || body.id === "") return { ok: false, error: `Resend ${response.status} without a message id: not counted as sent` };
    return { ok: true, id: body.id };
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}
