/**
 * The operator's invite form (Phase 32), parsed. Pure, so the limits are
 * tested without a server: a pasted list of addresses (any mix of commas,
 * semicolons, spaces and new lines), and a count from the waitlist.
 */

export const MAX_TYPED_INVITES = 50;
export const MAX_WAITLIST_INVITES = 50;

const EMAIL = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;

export interface ParsedInviteForm {
  emails: string[];
  invalid: string[];
  fromWaitlist: number;
  error: string | null;
}

export function parseInviteForm(rawEmails: unknown, rawCount: unknown): ParsedInviteForm {
  const text = typeof rawEmails === "string" ? rawEmails : "";
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const piece of text.split(/[\s,;]+/)) {
    const candidate = piece.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!candidate) continue;
    if (!EMAIL.test(candidate)) {
      invalid.push(candidate.slice(0, 80));
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    emails.push(candidate);
  }
  const countText = typeof rawCount === "string" ? rawCount.trim() : "";
  const count = countText === "" ? 0 : Number(countText);
  let error: string | null = null;
  if (!Number.isInteger(count) || count < 0) error = "The waitlist count must be a whole number, 0 or more.";
  else if (count > MAX_WAITLIST_INVITES) error = `Invite at most ${MAX_WAITLIST_INVITES} from the waitlist at a time.`;
  else if (emails.length > MAX_TYPED_INVITES) error = `Paste at most ${MAX_TYPED_INVITES} addresses at a time.`;
  else if (emails.length === 0 && count === 0) error = invalid.length > 0 ? "None of those is an email address." : "Paste addresses, or choose how many to invite from the waitlist.";
  return { emails, invalid, fromWaitlist: Number.isInteger(count) && count > 0 ? count : 0, error };
}

type IssueOutcome = { created: number; sent: number; failed: Array<{ email: string; error: string }>; skipped: Array<{ email: string; reason: string }> };

/**
 * The outcome of an issue, as one sentence for the console. An invite counts
 * as sent only when Resend accepted it; an address that already has an
 * account is never invited and is named first, as a warning.
 */
export function issueSentence(report: IssueOutcome, invalid: string[]): string {
  const parts: string[] = [];
  const members = report.skipped.filter((s) => s.reason === "member").map((s) => s.email);
  const others = report.skipped.filter((s) => s.reason !== "member");
  if (members.length > 0) parts.push(`Already ${members.length === 1 ? "has an account" : "have accounts"}, so no invite was sent: ${members.join(", ")}. They can sign in at /login.`);
  if (report.created === 0) {
    if (members.length === 0) parts.push("No invite was sent.");
  } else if (report.sent === report.created) parts.push(`Sent ${report.sent} ${report.sent === 1 ? "invite" : "invites"}; Resend accepted ${report.sent === 1 ? "it" : "each"}.`);
  else parts.push(`Sent ${report.sent} of ${report.created} invites.`);
  if (report.failed.length > 0) parts.push(`Not sent, Resend did not accept: ${report.failed.map((f) => `${f.email} (${f.error})`).join(", ")}. Saved as not sent; fix the cause, then use Resend on the row.`);
  if (others.length > 0) parts.push(`Skipped: ${others.map((s) => `${s.email} (${SKIP_WORDS[s.reason] ?? s.reason})`).join(", ")}.`);
  if (invalid.length > 0) parts.push(`Not addresses: ${invalid.join(", ")}.`);
  return parts.join(" ");
}

/** Whether the outcome is all good: every invite created was accepted by Resend, and nothing was skipped or unreadable. */
export function issueSucceeded(report: IssueOutcome, invalid: string[]): boolean {
  return report.created > 0 && report.sent === report.created && report.failed.length === 0 && report.skipped.length === 0 && invalid.length === 0;
}

const SKIP_WORDS: Record<string, string> = {
  invalid: "not an address",
  already_invited: "already has an open invite; use Resend on its row",
  no_token: "no token",
};
