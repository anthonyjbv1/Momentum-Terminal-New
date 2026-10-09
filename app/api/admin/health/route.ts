import { NextResponse, type NextRequest } from "next/server";

import { authorizeSharedSecret } from "@/lib/api-auth";
import { apiSportsWarnings } from "@/lib/connectors/apisports";
import { getEngineSecretOrNull, getIngestSecretOrNull, getScorerName, isEngineCronEnabled, isGoogleNewsFreshEnabled, isTwitchRampUpEnabled, isYouTubePaceAgeMatchedEnabled } from "@/lib/env";
import { videoPaceStatus } from "@/lib/connectors/youtube-pace";
import { fallbackStatus, type TickScoringRow } from "@/lib/engine/fallback-health";
import { DEFAULT_MIN_SAMPLES_AFTER_CUT, REBASELINE_HOLD_DAYS, rebaselineStatus } from "@/lib/ingest/rebaseline";
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
    const [sources, recentRuns, llmCost, apisportsPoll, sourceConfigs, ledgerFirst, recentTicks, apisportsNbaPoll] = await Promise.all([
      admin.from("source_health").select("*").order("name"),
      admin.from("ingest_runs").select("*").order("started_at", { ascending: false }).limit(runs),
      admin.from("llm_cost_per_tick").select("*").order("tick_number", { ascending: false, nullsFirst: false }).limit(ticks),
      // The newest API-Sports poll's account of the subscription and the day's usage (2026-10-09).
      admin.from("source_polls").select("started_at, detail, data_sources!inner(name)").eq("data_sources.name", "apisports").not("detail->apisports", "is", null).order("started_at", { ascending: false }).limit(1).maybeSingle(),
      // Every source's metric declarations, for the baseline-cut reminder (2026-10-09).
      admin.from("data_sources").select("name, config").eq("is_active", true),
      // The per-video ledger's first row, for the ledger-ready reminder (2026-10-09).
      admin.from("raw_video_view_samples").select("recorded_at").order("recorded_at", { ascending: true }).limit(1).maybeSingle(),
      // The recent ticks' scoring accounts, for the fallback warning (2026-10-09): a tick that scored by the rules instead of the model.
      admin.from("engine_ticks").select("tick_number, started_at, scoring:summary->scoring").order("tick_number", { ascending: false }).limit(ticks),
      // The newest API-NBA poll's account of ITS subscription (a separate plan on the same key, 2026-10-09).
      admin.from("source_polls").select("started_at, detail, data_sources!inner(name)").eq("data_sources.name", "apisports_nba").not("detail->apisports_nba", "is", null).order("started_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    for (const [label, result] of Object.entries({ sources, recentRuns, llmCost, apisportsPoll, sourceConfigs, ledgerFirst, recentTicks, apisportsNbaPoll })) {
      if (result.error) throw new Error(`${label}: ${result.error.message}`);
    }
    // The daily subscription check: the plan and its end as the last poll read them, and
    // the warnings the operator must see (a Free plan, an end within five days).
    const apisportsDetail = ((apisportsPoll.data?.detail as { apisports?: Record<string, unknown> } | null)?.apisports ?? null) as Record<string, unknown> | null;
    const apisports = apisportsDetail
      ? {
          readAt: apisportsPoll.data?.started_at ?? null,
          ...apisportsDetail,
          warnings: apiSportsWarnings(
            {
              plan: typeof apisportsDetail.plan === "string" ? apisportsDetail.plan : null,
              subscriptionEnd: typeof apisportsDetail.subscription_end === "string" ? apisportsDetail.subscription_end : null,
              subscriptionActive: typeof apisportsDetail.subscription_active === "boolean" ? apisportsDetail.subscription_active : null,
            },
            new Date(),
          ),
        }
      : { readAt: null, warnings: ["API-Sports has not reported its subscription yet: no poll detail recorded"] };
    const warnings = [...apisports.warnings];
    const lastRead = apisports.readAt ? Date.parse(apisports.readAt) : Number.NaN;
    if (Number.isFinite(lastRead) && Date.now() - lastRead > 24 * 3_600_000) warnings.push(`API-Sports subscription last read ${apisports.readAt}: more than a day ago`);
    // The NBA plan, the same daily check; silent until the source has a mapping that polls.
    const nbaDetail = ((apisportsNbaPoll.data?.detail as { apisports_nba?: Record<string, unknown> } | null)?.apisports_nba ?? null) as Record<string, unknown> | null;
    const apisportsNba = nbaDetail
      ? {
          readAt: apisportsNbaPoll.data?.started_at ?? null,
          ...nbaDetail,
          warnings: apiSportsWarnings(
            {
              plan: typeof nbaDetail.plan === "string" ? nbaDetail.plan : null,
              subscriptionEnd: typeof nbaDetail.subscription_end === "string" ? nbaDetail.subscription_end : null,
              subscriptionActive: typeof nbaDetail.subscription_active === "boolean" ? nbaDetail.subscription_active : null,
            },
            new Date(),
          ).map((warning) => `API-NBA: ${warning}`),
        }
      : { readAt: null, warnings: [] as string[] };
    warnings.push(...apisportsNba.warnings);
    const nbaLastRead = apisportsNba.readAt ? Date.parse(apisportsNba.readAt) : Number.NaN;
    if (Number.isFinite(nbaLastRead) && Date.now() - nbaLastRead > 24 * 3_600_000) warnings.push(`API-NBA subscription last read ${apisportsNba.readAt}: more than a day ago`);
    // The baseline cuts in force, and the date each metric's min_samples is
    // due back to its everyday value, so the hold is not forgotten.
    const rebaseline = rebaselineStatus((sourceConfigs.data ?? []).map((row) => ({ name: row.name, config: row.config })), new Date());
    warnings.push(...rebaseline.warnings);
    // The age-matched pace: when the ledger holds two weeks, so the switch day is tracked (2026-10-09).
    const videoPace = videoPaceStatus({ firstRecordedAt: ledgerFirst.data?.recorded_at ? new Date(ledgerFirst.data.recorded_at) : null, switchOn: isYouTubePaceAgeMatchedEnabled() }, new Date());
    warnings.push(...videoPace.warnings);
    // The fallback warning: every recent tick that scored by the rules fallback, with the failed calls' reasons from the usage ledger.
    const tickRows: TickScoringRow[] = (recentTicks.data ?? []).map((row) => ({ tickNumber: Number(row.tick_number), startedAt: String(row.started_at), scoring: (row.scoring ?? null) as TickScoringRow["scoring"] }));
    const fallbackTickNumbers = tickRows.filter((row) => (row.scoring?.fallbacks ?? 0) > 0).map((row) => row.tickNumber);
    const failedCalls = fallbackTickNumbers.length > 0 ? await admin.from("llm_usage").select("tick_number, error").eq("task_type", "sentiment").eq("status", "failed").in("tick_number", fallbackTickNumbers).limit(200) : { data: [], error: null };
    if (failedCalls.error) throw new Error(`failedCalls: ${failedCalls.error.message}`);
    const fallbacks = fallbackStatus(tickRows, (failedCalls.data ?? []).map((row) => ({ tickNumber: row.tick_number === null ? null : Number(row.tick_number), error: row.error })));
    warnings.push(...fallbacks.warnings);
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
      warnings,
      apisports,
      apisportsNba,
      googleNewsFresh: isGoogleNewsFreshEnabled(),
      // The scoring batch's two switches (2026-10-09), both shipped off.
      youtubePaceAgeMatched: isYouTubePaceAgeMatchedEnabled(),
      twitchRampUp: isTwitchRampUpEnabled(),
      videoPace,
      fallbacks: { ticksRead: tickRows.length, ticks: fallbacks.ticks },
      rebaseline: { holdDays: REBASELINE_HOLD_DAYS, minSamplesAfterHold: DEFAULT_MIN_SAMPLES_AFTER_CUT, metrics: rebaseline.metrics },
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
