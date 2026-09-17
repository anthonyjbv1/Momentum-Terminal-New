import { NextResponse, type NextRequest } from "next/server";

import { getCronSecretOrNull, getIngestSecretOrNull, isIngestCronEnabled } from "@/lib/env";
import { authorizeIngestCronRequest } from "@/lib/ingest/cron";
import { LIVE_CRON_DEFAULTS, runScheduledLiveCheck } from "@/lib/ingest/live/cron";
import { runLiveMode } from "@/lib/ingest/live/runner";
import { createSupabaseLiveStore } from "@/lib/ingest/live/store";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * GET /api/ingest/live — the live-mode heartbeat (Phase 16; see vercel.json:
 * every minute). Who among the mapped broadcasters is on air, and for each
 * one who is, a sample every few minutes: the audience against the session
 * itself, the clips being made, the session's shape, and the session's
 * closing metrics when it ends.
 *
 *   1. INGEST_CRON_ENABLED must be exactly "true", checked before anything
 *      else: live mode is ingestion and shares its switch.
 *   2. The caller must be Vercel Cron (Authorization: Bearer CRON_SECRET)
 *      or hold INGEST_SECRET.
 *   3. The fire runs under a budget below maxDuration; what it cannot
 *      sample this minute it samples the next.
 *
 * Nothing here advances a score or calls a model.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isIngestCronEnabled()) {
    return NextResponse.json(await runScheduledLiveCheck({ enabled: false, run: async () => { throw new Error("unreachable"); } }));
  }

  const auth = authorizeIngestCronRequest(request.headers, { cronSecret: getCronSecretOrNull(), ingestSecret: getIngestSecretOrNull() });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  try {
    const store = createSupabaseLiveStore(createSupabaseAdminClient());
    const result = await runScheduledLiveCheck({
      enabled: true,
      run: () => runLiveMode({ store, budgetMs: LIVE_CRON_DEFAULTS.budgetMs, timeoutMs: LIVE_CRON_DEFAULTS.fetchTimeoutMs }),
    });
    return NextResponse.json(result, { status: result.error ? 500 : 200 });
  } catch (error) {
    console.error("[ingest/live] failed:", error);
    return NextResponse.json({ error: "Live check failed", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
