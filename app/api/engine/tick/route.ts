import { NextResponse, type NextRequest } from "next/server";

import { authorizeSharedSecret } from "@/lib/api-auth";
import { createSupabaseEngineStore, runEngineTick } from "@/lib/engine";
import { getEngineSecretOrNull } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * POST or GET /api/engine/tick — run one Engine tick.
 *
 * Protected by ENGINE_SECRET (`x-engine-secret` header or `Authorization:
 * Bearer`). `?dryRun=1` computes the tick and returns the summary without
 * persisting anything. Responds with the TickSummary as JSON.
 *
 * Manual trigger only for now — the 30-second schedule is wired once a tick
 * has been verified by hand:
 *   curl -X POST -H "x-engine-secret: $ENGINE_SECRET" http://localhost:3000/api/engine/tick
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: NextRequest) {
  const auth = authorizeSharedSecret(request.headers, getEngineSecretOrNull(), {
    headerName: "x-engine-secret",
    envName: "ENGINE_SECRET",
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  const dryRunParam = request.nextUrl.searchParams.get("dryRun");
  const dryRun = dryRunParam === "1" || dryRunParam === "true";

  try {
    const store = createSupabaseEngineStore(createSupabaseAdminClient());
    const summary = await runEngineTick({ store, dryRun });
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[engine] tick failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "Engine tick failed", detail: message }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
