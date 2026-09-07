import { getLLMModelOrNull, getLLMProviderName, getLLMRouteOverride } from "@/lib/env";

import { getLLMProvider } from "./registry";
import type { LLMEffort, LLMProvider, LLMRequest, LLMResponse, LLMTaskType } from "./types";

/**
 * Model routing. Every LLM call names a task type; the route decides which
 * provider, model and effort serve it. Today everything points at
 * LLM_PROVIDER / LLM_MODEL, but a cheap model for simple scoring and a premium
 * one for anomaly reasoning is one env var away:
 *
 *   LLM_MODEL_SENTIMENT=claude-haiku-4-5   LLM_MODEL_ANOMALY=claude-opus-5
 *   LLM_PROVIDER_NARRATIVE=openai-compatible  LLM_MODEL_NARRATIVE=llama-3.3-70b
 */

export interface LLMRoute {
  providerName: string;
  /** undefined = the provider's own default model. */
  model: string | undefined;
  effort: LLMEffort;
  maxTokens: number;
}

const TASK_DEFAULTS: Record<LLMTaskType, { effort: LLMEffort; maxTokens: number }> = {
  sentiment: { effort: "low", maxTokens: 1500 },
  anomaly: { effort: "medium", maxTokens: 1500 },
  narrative: { effort: "low", maxTokens: 300 },
  memory: { effort: "low", maxTokens: 400 },
};

export function resolveRoute(taskType: LLMTaskType): LLMRoute {
  const override = getLLMRouteOverride(taskType);
  return {
    providerName: override.provider ?? getLLMProviderName(),
    model: override.model ?? getLLMModelOrNull() ?? undefined,
    effort: override.effort ?? TASK_DEFAULTS[taskType].effort,
    maxTokens: TASK_DEFAULTS[taskType].maxTokens,
  };
}

export type RoutedRequest = Omit<LLMRequest, "model" | "effort" | "taskType"> & { taskType: LLMTaskType };

export interface RoutingDeps {
  getProvider?: (name: string) => LLMProvider;
}

/** Complete a request through the provider/model routed for its task type. */
export async function routedComplete(request: RoutedRequest, deps: RoutingDeps = {}): Promise<LLMResponse> {
  const route = resolveRoute(request.taskType);
  const provider = (deps.getProvider ?? getLLMProvider)(route.providerName);
  return provider.complete({
    ...request,
    model: route.model,
    effort: route.effort,
    maxTokens: request.maxTokens ?? route.maxTokens,
  });
}
