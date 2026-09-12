import { NextResponse, type NextRequest } from "next/server";

import { getIngestSecretOrNull } from "@/lib/env";
import { authorizeIngestRequest } from "@/lib/ingest/auth";
import { runIngestion } from "@/lib/ingest/runner";
import { createSupabaseIngestStore } from "@/lib/ingest/store";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * POST or GET /api/ingest — run data ingestion for every active source.
 *
 * Protected by INGEST_SECRET (header `x-ingest-secret` or `Authorization:
 * Bearer`). Optional `?source=youtube` (repeatable) limits the run to the
 * named sources; `?force=1` polls a source even if it was polled within its
 * poll_interval_minutes. Responds with the IngestSummary as JSON.
 *
 * This is the manual, service-role-triggered run: it produces snapshots,
 * observations and signals and advances no score (the Engine tick is a
 * separate call). Nothing schedules it; trigger it by hand, e.g.
 *   curl -X POST -H "x-ingest-secret: $INGEST_SECRET" "https://<host>/api/ingest?force=1"
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: NextRequest) {
  const auth = authorizeIngestRequest(request.headers, getIngestSecretOrNull());
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  const params = request.nextUrl.searchParams;
  const requestedSources = params.getAll("source").filter(Boolean);
  const force = ["1", "true"].includes((params.get("force") ?? "").toLowerCase());

  try {
    const store = createSupabaseIngestStore(createSupabaseAdminClient());
    const summary = await runIngestion({
      store,
      sources: requestedSources.length > 0 ? requestedSources : undefined,
      force,
      trigger: "manual",
    });
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[ingest] run failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "Ingestion failed", detail: message }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
