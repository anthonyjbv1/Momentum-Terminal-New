import { describeEngineOverrides, engineConfigFromEnv } from "@/lib/engine/config";
import { deadlineAfter } from "@/lib/engine/deadline";
import { createSupabaseMemoryStore } from "@/lib/engine/memory/store";
import { createSupabaseNarrativeStore } from "@/lib/engine/narratives";
import { runPostTick, type PostTickSummary } from "@/lib/engine/post-tick";
import { getSentimentScorer } from "@/lib/engine/sentiment";
import { createSupabaseEngineStore } from "@/lib/engine/store";
import { runEngineTick } from "@/lib/engine/tick";
import type { TickSummary, TickTrigger } from "@/lib/engine/types";
import { getEngineEnvOverrides } from "@/lib/env";
import { routedComplete } from "@/lib/llm/routing";
import { createSupabaseUsageLogger } from "@/lib/llm/usage";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * The production tick: Supabase-backed Engine store, the scorer selected by
 * SCORER, runEngineTick, then the post-tick step (narratives + memory).
 * /api/engine/tick and the cron heartbeat both call this and nothing else,
 * so there is exactly one tick path.
 *
 * ONE DEADLINE for the whole of it. It starts here, before the store is
 * even built, and is handed to the tick (which gates every scoring call on
 * it) and to the post-tick step (which gates memory summaries on it). The
 * caller may cap the budget below the config default — the cron does, so a
 * second tick never outlives the invocation.
 */

export interface FullTickResult extends TickSummary {
  scorer: string;
  postTick: PostTickSummary | null;
}

export interface FullTickOptions {
  dryRun?: boolean;
  trigger?: TickTrigger;
  /** Wall-clock budget for this tick; the config default applies when this is larger or absent. */
  budgetMs?: number;
}

export async function runFullTick(options: FullTickOptions = {}): Promise<FullTickResult> {
  const { dryRun = false, trigger = "manual" } = options;

  // The defaults, with any deliberate override from the environment (the
  // controlled test may lower the Trading Activity minimum-sample guard).
  const config = engineConfigFromEnv(getEngineEnvOverrides());
  for (const override of describeEngineOverrides(config)) console.info(`[engine] override: ${override}`);

  const budgetMs = Math.min(config.tick.budgetMs, options.budgetMs ?? Number.POSITIVE_INFINITY);
  const deadline = deadlineAfter(budgetMs);

  const admin = createSupabaseAdminClient();
  const scorer = getSentimentScorer();

  const summary = await runEngineTick({ store: createSupabaseEngineStore(admin), scorer, dryRun, trigger, config, deadline });

  const postTick = dryRun
    ? null
    : await runPostTick(summary, {
        narrativeStore: createSupabaseNarrativeStore(admin),
        memoryStore: createSupabaseMemoryStore(admin),
        usageLogger: createSupabaseUsageLogger(admin),
        complete: (request) => routedComplete(request),
        config,
        deadline,
      });

  return { ...summary, scorer: scorer.name, postTick };
}
