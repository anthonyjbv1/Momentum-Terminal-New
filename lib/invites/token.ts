import { createHash, randomBytes } from "node:crypto";

/**
 * INVITE TOKENS (Phase 32).
 *
 * A token is 32 random bytes, base64url: 43 characters, 256 bits, never
 * guessed. It exists in exactly one place, the link in the invitation email.
 * The database keeps its SHA-256 (hex) and nothing else, so a read of the
 * invites table cannot be turned into a working link, and a resend (a new
 * token) kills the old link by replacing the only thing that matched it.
 */

export const INVITE_TOKEN_BYTES = 32;
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

/** Whether a path segment could be a token at all: the join page refuses anything else before touching the database. */
export function isInviteTokenShape(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN_PATTERN.test(value);
}
