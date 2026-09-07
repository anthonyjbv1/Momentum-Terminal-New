import { authorizeSharedSecret, type SharedSecretAuthResult } from "@/lib/api-auth";

export type IngestAuthResult = SharedSecretAuthResult;

/** Authorisation for /api/ingest: `x-ingest-secret` header or Bearer token equal to INGEST_SECRET. */
export function authorizeIngestRequest(headers: Headers, configuredSecret: string | null): IngestAuthResult {
  return authorizeSharedSecret(headers, configuredSecret, { headerName: "x-ingest-secret", envName: "INGEST_SECRET" });
}
