import { NextResponse, type NextRequest } from "next/server";

import { authorizeSharedSecret } from "@/lib/api-auth";
import { getEngineSecretOrNull, getIngestSecretOrNull, getScorerName, isEngineCronEnabled } from "@/lib/env";
import { resolveRoute } from "@/lib/llm/routing";
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/llm/providers/anthropic";
import type { LLMTaskType } from "@/lib/llm/types";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * GET /api/admin/health — the operator's view of the data pipeline.
 *
 * Per source: last poll, last success, last error and its reason, the
 * trailing-day poll count, error rate and latency (the source_health view).
 * The recent ingest runs. LLM cost per tick (the llm_cost_per_tick view).
 * Whether the cron is enabled, and which provider, model and effort each
 * LLM task type is routed to in THIS deployment's environment (the
 * configured model, not the adapter's default), so the cost of a run can be
 * read against the model that actually served it.
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
    const taskTypes: LLMTaskType[] = ["sentiment", "anomaly", "narrative", "memory"];
    const routes = taskTypes.map((taskType) => {
      const route = resolveRoute(taskType);
      return {
        taskType,
        route,
        // The provider's own default applies when no model is configured; the Anthropic adapter's is named here.
        model: route.model ?? (route.providerName === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : null),
      };
    });
    // Whether each configured model string has a price row, matched exactly as llm_cost_per_tick joins. The
    // Anthropic adapter records the model the API echoes: a dated ID comes back as itself, an alias as the
    // dated ID it resolves to, and the price table carries both spellings for Haiku 4.5.
    const models = [...new Set(routes.map((entry) => entry.model).filter((model): model is string => model !== null))];
    const prices = models.length > 0 ? await admin.from("llm_model_prices").select("model").in("model", models) : { data: [], error: null };
    if (prices.error) throw new Error(`llm_model_prices: ${prices.error.message}`);
    const pricedModels = new Set((prices.data ?? []).map((row) => row.model));
    const llm = {
      scorer: getScorerName(),
      routes: Object.fromEntries(
        routes.map(({ taskType, route, model }) => [
          taskType,
          {
            provider: route.providerName,
            model,
            modelSource: route.model !== undefined ? "configured" : "provider default",
            priced: model !== null && pricedModels.has(model),
            effort: route.effort,
            maxTokens: route.maxTokens,
          },
        ]),
      ),
    };

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      cronEnabled: isEngineCronEnabled(),
      llm,
      sources: sources.data ?? [],
      recentRuns: (recentRuns.data ?? []).map((run) => ({ ...run, summary: undefined, hasSummary: run.summary !== null })),
      llmCostPerTick: llmCost.data ?? [],
    });
  } catch (error) {
    console.error("[admin/health] failed:", error);
    return NextResponse.json({ error: "Health read failed", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
