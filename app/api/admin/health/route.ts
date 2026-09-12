import { NextResponse, type NextRequest } from "next/server";

import { authorizeSharedSecret } from "@/lib/api-auth";
import { getEngineSecretOrNull, getIngestSecretOrNull, isEngineCronEnabled } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * GET /api/admin/health — the operator's view of the data pipeline.
 *
 * Per source: last poll, last success, last error and its reason, the
 * trailing-day poll count, error rate and latency (the source_health view).
 * The recent ingest runs. LLM cost per tick (the llm_cost_per_tick view).
 * Whether the cron is enabled.
 *
 * Protected by INGEST_SECRET or ENGINE_SECRET (`x-ingest-secret`,
 * `x-engine-secret`, or `Authorization: Bearer`). Service-role reads; the
 * raw metric tables are not exposed here or anywhere.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorize(headers: Headers) {
  const ingest = authorizeSharedSecret(headers, getIngestSecretOrNull(), { headerName: "x-ingest-secret", envName: "INGEST_SECRET" });
  if (ingest.ok) return ingest;
  const engine = authorizeSharedSecret(headers, getEngineSecretOrNull(), { headerName: "x-engine-secret", envName: "ENGINE_SECRET" });
  if (engine.ok) return engine;
  // Report the more useful failure: a wrong secret over a missing one.
  return ingest.status === 401 ? ingest : engine;
}

export async function GET(request: NextRequest) {
  const auth = authorize(request.headers);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  const runs = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get("runs") ?? 10) || 10));
  const ticks = Math.min(200, Math.max(1, Number(request.nextUrl.searchParams.get("ticks") ?? 20) || 20));

  try {
    const admin = createSupabaseAdminClient();
    const [sources, recentRuns, llmCost] = await Promise.all([
      admin.from("source_health").select("*").order("name"),
      admin.from("ingest_runs").select("*").order("started_at", { ascending: false }).limit(runs),
      admin.from("llm_cost_per_tick").select("*").order("tick_number", { ascending: false, nullsFirst: false }).limit(ticks),
    ]);
    for (const [label, result] of Object.entries({ sources, recentRuns, llmCost })) {
      if (result.error) throw new Error(`${label}: ${result.error.message}`);
    }
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      cronEnabled: isEngineCronEnabled(),
      sources: sources.data ?? [],
      recentRuns: (recentRuns.data ?? []).map((run) => ({ ...run, summary: undefined, hasSummary: run.summary !== null })),
      llmCostPerTick: llmCost.data ?? [],
    });
  } catch (error) {
    console.error("[admin/health] failed:", error);
    return NextResponse.json({ error: "Health read failed", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
