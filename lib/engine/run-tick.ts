import { describeEngineOverrides, engineConfigFromEnv } from "@/lib/engine/config";
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
 */

export interface FullTickResult extends TickSummary {
  scorer: string;
  postTick: PostTickSummary | null;
}

export interface FullTickOptions {
  dryRun?: boolean;
  trigger?: TickTrigger;
}

export async function runFullTick(options: FullTickOptions = {}): Promise<FullTickResult> {
  const { dryRun = false, trigger = "manual" } = options;
  const admin = createSupabaseAdminClient();
  const scorer = getSentimentScorer();

  // The defaults, with any deliberate override from the environment (the
  // controlled test may lower the Trading Activity minimum-sample guard).
  const config = engineConfigFromEnv(getEngineEnvOverrides());
  for (const override of describeEngineOverrides(config)) console.info(`[engine] override: ${override}`);

  const summary = await runEngineTick({ store: createSupabaseEngineStore(admin), scorer, dryRun, trigger, config });

  const postTick = dryRun
    ? null
    : await runPostTick(summary, {
        narrativeStore: createSupabaseNarrativeStore(admin),
        memoryStore: createSupabaseMemoryStore(admin),
        usageLogger: createSupabaseUsageLogger(admin),
        complete: (request) => routedComplete(request),
        config,
      });

  return { ...summary, scorer: scorer.name, postTick };
}
