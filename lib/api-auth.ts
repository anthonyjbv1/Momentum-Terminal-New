import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret authorisation for internal endpoints (/api/ingest,
 * /api/engine/tick). The caller presents the secret either in the named
 * header (e.g. `x-engine-secret: <secret>`) or as `Authorization: Bearer
 * <secret>` (what Vercel Cron sends when CRON_SECRET is configured).
 */
export type SharedSecretAuthResult = { ok: true } | { ok: false; status: 401 | 503; message: string };

export interface SharedSecretOptions {
  /** Header that carries the secret, e.g. "x-ingest-secret". */
  headerName: string;
  /** Env var name, used only in the 503 message when the secret is unset. */
  envName: string;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function extractPresentedSecret(headers: Headers, headerName: string): string | null {
  const direct = headers.get(headerName);
  if (direct) return direct.trim();
  const authorization = headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  return null;
}

export function authorizeSharedSecret(
  headers: Headers,
  configuredSecret: string | null,
  options: SharedSecretOptions,
): SharedSecretAuthResult {
  if (!configuredSecret) {
    return { ok: false, status: 503, message: `${options.envName} is not configured on the server.` };
  }
  const presented = extractPresentedSecret(headers, options.headerName);
  if (!presented || !constantTimeEquals(presented, configuredSecret)) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }
  return { ok: true };
}
