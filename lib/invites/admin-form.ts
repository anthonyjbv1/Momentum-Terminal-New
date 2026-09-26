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

/** The outcome of an issue, as one sentence for the console. */
export function issueSentence(report: { created: number; sent: number; failed: Array<{ email: string; error: string }>; skipped: Array<{ email: string; reason: string }> }, invalid: string[]): string {
  const parts = [`Issued ${report.created} ${report.created === 1 ? "invite" : "invites"}, emailed ${report.sent}.`];
  if (report.failed.length > 0) parts.push(`Not delivered: ${report.failed.map((f) => `${f.email} (${f.error})`).join(", ")}. Use Resend on those rows.`);
  if (report.skipped.length > 0) parts.push(`Skipped: ${report.skipped.map((s) => `${s.email} (${SKIP_WORDS[s.reason] ?? s.reason})`).join(", ")}.`);
  if (invalid.length > 0) parts.push(`Not addresses: ${invalid.join(", ")}.`);
  return parts.join(" ");
}

const SKIP_WORDS: Record<string, string> = {
  invalid: "not an address",
  member: "already a member",
  already_invited: "already has an open invite",
  no_token: "no token",
};
