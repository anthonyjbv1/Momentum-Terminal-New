import { timingSafeEqual } from "node:crypto";

/**
 * Authorisation for /api/ingest. The caller must present the INGEST_SECRET
 * either as `x-ingest-secret: <secret>` or `Authorization: Bearer <secret>`
 * (the latter is what Vercel Cron sends when CRON_SECRET is configured).
 */
export type IngestAuthResult = { ok: true } | { ok: false; status: 401 | 503; message: string };

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function extractPresentedSecret(headers: Headers): string | null {
  const direct = headers.get("x-ingest-secret");
  if (direct) return direct.trim();
  const authorization = headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  return null;
}

export function authorizeIngestRequest(headers: Headers, configuredSecret: string | null): IngestAuthResult {
  if (!configuredSecret) {
    return { ok: false, status: 503, message: "INGEST_SECRET is not configured on the server." };
  }
  const presented = extractPresentedSecret(headers);
  if (!presented || !constantTimeEquals(presented, configuredSecret)) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }
  return { ok: true };
}
