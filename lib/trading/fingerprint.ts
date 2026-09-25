import { createHash } from "node:crypto";

/**
 * THE FINGERPRINT (Phase 29): sha256(salt | address | user agent), hex, or
 * null without a salt or without either input. The order route computes it
 * from the request's own headers and hands it to place_order(), which stores
 * it on the order (trade_orders.fingerprint_hash) for the shared-
 * infrastructure detector; neither the address nor the agent string is ever
 * stored, logged or sent anywhere.
 *
 * The address is the first hop of x-forwarded-for (what the platform sets
 * from the connection), falling back to x-real-ip. The client cannot supply
 * the hash: it is never read from a body.
 */
export function fingerprintFor(headers: Headers, salt: string | null): string | null {
  if (!salt) return null;
  const forwarded = headers.get("x-forwarded-for") ?? "";
  const address = (forwarded.split(",")[0] ?? "").trim() || (headers.get("x-real-ip") ?? "").trim();
  const agent = (headers.get("user-agent") ?? "").trim();
  if (!address && !agent) return null;
  return createHash("sha256").update(`${salt}|${address}|${agent}`).digest("hex");
}
