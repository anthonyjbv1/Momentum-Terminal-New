import { MINIMUM_AGE, PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal/versions";
import type { RateLimiter } from "@/lib/rate-limit";

import { isInviteTokenShape } from "./token";

/**
 * THE JOIN PAGE, AS LOGIC (Phase 32).
 *
 * /join/<token> is where an invitation lands. The page reads the invite, and
 * the form asks for a username (a display name is optional), the 18+
 * attestation and the acceptance of the Terms and the Privacy notice, then
 * sends the person on by one of two ways in:
 *
 *   email    Supabase emails a one-time sign-in link to the invited address
 *            (creating the account when the link is asked for)
 *   google   Supabase sends the browser to Google, and the account is
 *            created when Google sends it back
 *
 * Either way the account is created by GoTrue, and the database's trigger
 * accepts it only for the invited address, only once the attestation below
 * is on the invite. So this module refuses early and says why in plain
 * words; the database refuses regardless.
 *
 * Everything the page does is injected, so the refusals are tests.
 */

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InviteView {
  email: string | null;
  status: InviteStatus;
  expiresAt: string;
  attested: boolean;
  desiredUsername: string | null;
  desiredDisplayName: string | null;
}

/** What the join page shows for a token, before any form. */
export type JoinPageState =
  | { kind: "closed" }
  | { kind: "not_found" }
  | { kind: "open"; invite: InviteView }
  | { kind: "used" }
  | { kind: "revoked" }
  | { kind: "expired" }
  /** The invite could not be checked (the database did not answer). Nothing was used up. */
  | { kind: "unavailable" };

export function readInviteView(value: unknown): InviteView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row.status;
  if (status !== "pending" && status !== "accepted" && status !== "revoked" && status !== "expired") return null;
  return {
    email: typeof row.email === "string" ? row.email : null,
    status,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : "",
    attested: row.attested === true,
    desiredUsername: typeof row.desired_username === "string" ? row.desired_username : null,
    desiredDisplayName: typeof row.desired_display_name === "string" ? row.desired_display_name : null,
  };
}

/** The page's state for a token, with the switch as the first rule: off, there is no join page at all. */
export async function joinPageState(token: string, deps: { enabled: boolean; lookup: (token: string) => Promise<InviteView | null> }): Promise<JoinPageState> {
  if (!deps.enabled) return { kind: "closed" };
  if (!isInviteTokenShape(token)) return { kind: "not_found" };
  let invite: InviteView | null;
  try {
    invite = await deps.lookup(token);
  } catch (error) {
    console.warn("[join] invite lookup failed:", error instanceof Error ? error.message : error);
    return { kind: "unavailable" };
  }
  if (!invite) return { kind: "not_found" };
  if (invite.status === "accepted") return { kind: "used" };
  if (invite.status === "revoked") return { kind: "revoked" };
  if (invite.status === "expired") return { kind: "expired" };
  return { kind: "open", invite };
}

export const JOIN_METHODS = ["email", "google"] as const;
export type JoinMethod = (typeof JOIN_METHODS)[number];

/** Per address: ten attempts in ten minutes. A person retyping a username never meets it. */
export const JOIN_RATE_LIMIT = { limit: 10, windowSeconds: 600 } as const;

const USERNAME = /^[a-z0-9_]{3,30}$/;

export interface JoinSubmission {
  token: string;
  username: string;
  displayName: string;
  ageAttested: boolean;
  termsAccepted: boolean;
  method: JoinMethod;
}

/** A checkbox arrives as "on" (or its value) when ticked and not at all when not. */
function ticked(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "yes";
}

export function parseJoinForm(form: FormData): JoinSubmission {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  const method = text("method");
  return {
    token: text("token").trim(),
    username: text("username").trim().toLowerCase(),
    displayName: text("display_name").trim().slice(0, 80),
    ageAttested: ticked(form.get("age")),
    termsAccepted: ticked(form.get("terms")),
    method: (JOIN_METHODS as readonly string[]).includes(method) ? (method as JoinMethod) : "email",
  };
}

export type JoinOutcome =
  | { kind: "error"; message: string; field?: "username" | "age" | "terms" }
  | { kind: "link_sent"; email: string }
  | { kind: "redirect"; url: string };

export const JOIN_MESSAGES = {
  closed: "Joining is not open yet.",
  invalid: "This invitation link is not valid. Check that the whole link was copied.",
  used: "This invitation has already been used. If it was yours, log in instead.",
  revoked: "This invitation has been withdrawn.",
  expired: "This invitation has expired. Reply to the invitation email and we can send a new one.",
  age: `You need to be ${MINIMUM_AGE} or older to join.`,
  terms: "Please accept the Terms and the Privacy notice to continue.",
  username: "Usernames are 3 to 30 characters: lowercase letters, numbers or underscores.",
  usernameTaken: "That username is taken. Try another.",
  rateLimited: "Too many attempts from your connection. Please wait a few minutes and try again.",
  unavailable: "Something went wrong on our side. Please try again in a moment.",
  lookupUnavailable: "The invitation could not be checked just now. Nothing has been used up: open the same link again in a few minutes.",
  googleOff: "Google sign-in is not available yet. Use the email link instead.",
} as const;

export interface JoinDeps {
  enabled: boolean;
  googleEnabled: boolean;
  limiter: RateLimiter;
  ip: string;
  /** Is the username free? Service role, behind its own per-address limit. */
  usernameAvailable: (username: string) => Promise<"available" | "taken" | "rate_limited" | "unavailable">;
  /** invite_attest(): records the attestation on the invite, with the hash of this request's one-time secret, or says why not. */
  attest: (input: { token: string; username: string; displayName: string | null; termsVersion: string; privacyVersion: string; joinNonceHash: string }) => Promise<{ ok: true; email: string } | { ok: false; code: string }>;
  /**
   * A fresh one-time secret and its SHA-256. The hash goes on the invite; the
   * secret goes only into the sign-in request, where the database trigger
   * checks it before an email sign-up may create the account.
   */
  newNonce: () => { nonce: string; hash: string };
  /** signInWithOtp for the invited address, carrying the secret, creating the account when the link is asked for. */
  sendLink: (email: string, joinNonce: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** signInWithOAuth: the URL to send the browser to. */
  googleUrl: () => Promise<{ ok: true; url: string } | { ok: false; message: string }>;
}

const ATTEST_REFUSALS: Record<string, { message: string; field?: "username" | "age" | "terms" }> = {
  unknown: { message: JOIN_MESSAGES.invalid },
  accepted: { message: JOIN_MESSAGES.used },
  revoked: { message: JOIN_MESSAGES.revoked },
  expired: { message: JOIN_MESSAGES.expired },
  age_not_attested: { message: JOIN_MESSAGES.age, field: "age" },
  terms_not_accepted: { message: JOIN_MESSAGES.terms, field: "terms" },
  bad_username: { message: JOIN_MESSAGES.username, field: "username" },
  username_taken: { message: JOIN_MESSAGES.usernameTaken, field: "username" },
};

export async function submitJoin(input: JoinSubmission, deps: JoinDeps): Promise<JoinOutcome> {
  if (!deps.enabled) return { kind: "error", message: JOIN_MESSAGES.closed };
  if (!isInviteTokenShape(input.token)) return { kind: "error", message: JOIN_MESSAGES.invalid };
  // The attestation is checked here AND in the database: a form that lost its
  // checkbox, or a request made without the form, is refused both times.
  if (!input.ageAttested) return { kind: "error", message: JOIN_MESSAGES.age, field: "age" };
  if (!input.termsAccepted) return { kind: "error", message: JOIN_MESSAGES.terms, field: "terms" };
  if (!USERNAME.test(input.username)) return { kind: "error", message: JOIN_MESSAGES.username, field: "username" };
  if (input.method === "google" && !deps.googleEnabled) return { kind: "error", message: JOIN_MESSAGES.googleOff };

  try {
    const decision = await deps.limiter.hit(`join:${deps.ip}`, JOIN_RATE_LIMIT.limit, JOIN_RATE_LIMIT.windowSeconds);
    if (!decision.allowed) return { kind: "error", message: JOIN_MESSAGES.rateLimited };
  } catch {
    return { kind: "error", message: JOIN_MESSAGES.unavailable };
  }

  const availability = await deps.usernameAvailable(input.username);
  if (availability === "taken") return { kind: "error", message: JOIN_MESSAGES.usernameTaken, field: "username" };
  if (availability === "rate_limited") return { kind: "error", message: JOIN_MESSAGES.rateLimited };
  if (availability === "unavailable") return { kind: "error", message: JOIN_MESSAGES.unavailable };

  const nonce = deps.newNonce();
  const attested = await deps.attest({ token: input.token, username: input.username, displayName: input.displayName || null, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, joinNonceHash: nonce.hash });
  if (!attested.ok) {
    const refusal = ATTEST_REFUSALS[attested.code] ?? { message: JOIN_MESSAGES.unavailable };
    return { kind: "error", ...refusal };
  }

  if (input.method === "google") {
    const google = await deps.googleUrl();
    return google.ok ? { kind: "redirect", url: google.url } : { kind: "error", message: google.message };
  }
  const sent = await deps.sendLink(attested.email, nonce.nonce);
  return sent.ok ? { kind: "link_sent", email: attested.email } : { kind: "error", message: sent.message };
}

/**
 * Where the auth callback sends a person after Supabase or Google reports an
 * error instead of a session. A refused account (the trigger raising) comes
 * back from GoTrue as "Database error saving new user"; for someone using
 * Google that almost always means a different address from the one invited.
 */
export function callbackErrorDestination(params: URLSearchParams): string | null {
  const error = params.get("error") ?? params.get("error_code");
  const description = params.get("error_description") ?? "";
  if (!error && !description) return null;
  if (/database error saving new user|signup_requires/i.test(description)) return "/login?error=not_invited";
  return "/login?error=auth_callback";
}
