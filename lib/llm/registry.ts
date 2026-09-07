import { getLLMProviderName } from "@/lib/env";

import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { OpenAIProvider } from "./providers/openai";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { LLMError, type LLMProvider } from "./types";

/**
 * Provider registry / factory. The active provider is chosen by the
 * LLM_PROVIDER env var (default "anthropic"). Swapping vendors is a one-line
 * env change; nothing else in the codebase references a vendor.
 */

type ProviderFactory = () => LLMProvider;

const FACTORIES: Record<string, ProviderFactory> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  gemini: () => new GeminiProvider(),
  "openai-compatible": () => new OpenAICompatibleProvider(),
};

const instances = new Map<string, LLMProvider>();

export function listLLMProviders(): string[] {
  return Object.keys(FACTORIES);
}

/** Register (or replace) a provider factory, e.g. from tests or a plugin. */
export function registerLLMProvider(name: string, factory: ProviderFactory): void {
  FACTORIES[name.toLowerCase()] = factory;
  instances.delete(name.toLowerCase());
}

/** Build a fresh provider instance by name. */
export function createLLMProvider(name: string = getLLMProviderName()): LLMProvider {
  const key = name.trim().toLowerCase();
  const factory = FACTORIES[key];
  if (!factory) {
    throw new LLMError(`Unknown LLM provider "${name}". Registered providers: ${listLLMProviders().join(", ")}`, {
      kind: "not_configured",
      provider: key,
    });
  }
  return factory();
}

/** Shared instance per provider name (adapters keep an HTTP client). */
export function getLLMProvider(name: string = getLLMProviderName()): LLMProvider {
  const key = name.trim().toLowerCase();
  let provider = instances.get(key);
  if (!provider) {
    provider = createLLMProvider(key);
    instances.set(key, provider);
  }
  return provider;
}

/** Drop cached instances (tests, or after env changes at runtime). */
export function resetLLMProviders(): void {
  instances.clear();
}
