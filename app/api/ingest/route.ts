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
 * named sources. Responds with the IngestSummary as JSON.
 *
 * Runs with the service-role client: trusted server code only. Scheduling is
 * deliberately not set up yet; trigger it manually, e.g.
 *   curl -X POST -H "x-ingest-secret: $INGEST_SECRET" http://localhost:3000/api/ingest
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: NextRequest) {
  const auth = authorizeIngestRequest(request.headers, getIngestSecretOrNull());
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  const requestedSources = request.nextUrl.searchParams.getAll("source").filter(Boolean);

  try {
    const store = createSupabaseIngestStore(createSupabaseAdminClient());
    const summary = await runIngestion({
      store,
      sources: requestedSources.length > 0 ? requestedSources : undefined,
    });
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[ingest] run failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "Ingestion failed", detail: message }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
