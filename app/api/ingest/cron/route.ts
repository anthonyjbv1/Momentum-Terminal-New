import { NextResponse, type NextRequest } from "next/server";

import { getCronSecretOrNull, getIngestSecretOrNull, isIngestCronEnabled } from "@/lib/env";
import { INGEST_CRON_DEFAULTS, authorizeIngestCronRequest, runScheduledIngestion } from "@/lib/ingest/cron";
import { runIngestion } from "@/lib/ingest/runner";
import { createSupabaseIngestStore } from "@/lib/ingest/store";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * GET /api/ingest/cron — the scheduled ingestion heartbeat (see vercel.json:
 * every fifteen minutes; each source still keeps its own interval). A
 * DIFFERENT job from /api/engine/cron, behind a different flag.
 *
 *   1. INGEST_CRON_ENABLED must be exactly "true", otherwise the handler
 *      returns "skipped (disabled)" immediately: no auth check, no database
 *      read, no poll. The flag comes first so the endpoint is externally
 *      observable without a secret and can do nothing while it is off.
 *   2. The caller must be Vercel Cron (Authorization: Bearer CRON_SECRET) or
 *      hold INGEST_SECRET.
 *   3. A run still in flight makes this invocation skip rather than poll
 *      everything twice.
 *
 * Nothing here advances a score or calls a model: ingestion writes snapshots,
 * observations and signals, and the Engine is what reads them. The manual
 * POST /api/ingest is untouched and still works exactly as before.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // 1. The flag, before anything else.
  if (!isIngestCronEnabled()) {
    return NextResponse.json(await runScheduledIngestion({ enabled: false, run: async () => { throw new Error("unreachable"); } }));
  }

  // 2. Authentication.
  const auth = authorizeIngestCronRequest(request.headers, { cronSecret: getCronSecretOrNull(), ingestSecret: getIngestSecretOrNull() });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  // 3. The overlap guard, then the run.
  try {
    const store = createSupabaseIngestStore(createSupabaseAdminClient());
    const since = new Date(Date.now() - INGEST_CRON_DEFAULTS.staleAfterMinutes * 60_000);
    const result = await runScheduledIngestion({
      enabled: true,
      openRun: await store.openRunStartedSince(since),
      run: () => runIngestion({ store, trigger: "cron" }),
    });
    return NextResponse.json(result, { status: result.error ? 500 : 200 });
  } catch (error) {
    console.error("[ingest/cron] failed:", error);
    return NextResponse.json({ error: "Scheduled ingestion failed", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
