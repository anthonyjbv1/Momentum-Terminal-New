import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { OpenAIProvider } from "./providers/openai";
import { createLLMProvider, getLLMProvider, listLLMProviders, resetLLMProviders } from "./registry";
import { resolveRoute, routedComplete } from "./routing";
import { LLMError, type LLMProvider, type LLMRequest } from "./types";

const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL", "LLM_MODEL_SENTIMENT", "LLM_PROVIDER_NARRATIVE", "LLM_EFFORT_ANOMALY", "ANTHROPIC_API_KEY"];

describe("LLM provider registry", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetLLMProviders();
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetLLMProviders();
  });

  it("registers the four adapters and defaults to anthropic", () => {
    expect(listLLMProviders()).toEqual(["anthropic", "openai", "gemini", "openai-compatible"]);
    expect(createLLMProvider()).toBeInstanceOf(AnthropicProvider);
    expect(createLLMProvider("openai")).toBeInstanceOf(OpenAIProvider);
    expect(createLLMProvider("gemini")).toBeInstanceOf(GeminiProvider);
    expect(createLLMProvider("openai-compatible")).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("swaps providers with LLM_PROVIDER alone", () => {
    process.env.LLM_PROVIDER = "gemini";
    expect(getLLMProvider().name).toBe("gemini");
    process.env.LLM_PROVIDER = "OpenAI-Compatible";
    resetLLMProviders();
    expect(getLLMProvider().name).toBe("openai-compatible");
  });

  it("rejects unknown providers", () => {
    expect(() => createLLMProvider("bard")).toThrow(LLMError);
    expect(() => createLLMProvider("bard")).toThrow(/Unknown LLM provider "bard"/);
  });

  it("stub adapters are interface-compliant and throw a clean not_configured error", async () => {
    const request: LLMRequest = { systemPrompt: "s", userPrompt: "u" };
    for (const name of ["openai", "gemini", "openai-compatible"]) {
      const provider = createLLMProvider(name);
      expect(provider.name).toBe(name);
      await expect(provider.complete(request)).rejects.toMatchObject({ kind: "not_configured", provider: name });
    }
  });

  it("the anthropic adapter throws not_configured without an API key", async () => {
    const provider = new AnthropicProvider({ apiKey: undefined });
    await expect(provider.complete({ systemPrompt: "s", userPrompt: "u" })).rejects.toMatchObject({ kind: "not_configured", provider: "anthropic" });
  });
});

describe("model routing", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("points every task at LLM_PROVIDER / LLM_MODEL by default", () => {
    process.env.LLM_MODEL = "claude-opus-5";
    expect(resolveRoute("sentiment")).toEqual({ providerName: "anthropic", model: "claude-opus-5", effort: "low", maxTokens: 1500 });
    expect(resolveRoute("narrative")).toMatchObject({ providerName: "anthropic", model: "claude-opus-5", effort: "low" });
    delete process.env.LLM_MODEL;
    expect(resolveRoute("memory").model).toBeUndefined(); // provider default
  });

  it("routes individual task types to other providers / models via env", () => {
    process.env.LLM_MODEL = "claude-opus-5";
    process.env.LLM_MODEL_SENTIMENT = "claude-haiku-4-5";
    process.env.LLM_PROVIDER_NARRATIVE = "gemini";
    process.env.LLM_EFFORT_ANOMALY = "high";
    expect(resolveRoute("sentiment")).toMatchObject({ providerName: "anthropic", model: "claude-haiku-4-5" });
    expect(resolveRoute("narrative")).toMatchObject({ providerName: "gemini", model: "claude-opus-5" });
    expect(resolveRoute("anomaly")).toMatchObject({ providerName: "anthropic", effort: "high" });
  });

  it("routedComplete hands the routed model, effort and token budget to the provider", async () => {
    process.env.LLM_MODEL_SENTIMENT = "cheap-model";
    const seen: LLMRequest[] = [];
    const fake: LLMProvider = {
      name: "fake",
      complete: vi.fn(async (request: LLMRequest) => {
        seen.push(request);
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: request.model ?? "default", stopReason: "end_turn", latencyMs: 1 };
      }),
    };
    const response = await routedComplete({ taskType: "sentiment", systemPrompt: "s", userPrompt: "u" }, { getProvider: () => fake });
    expect(response.model).toBe("cheap-model");
    expect(seen[0]).toMatchObject({ model: "cheap-model", effort: "low", maxTokens: 1500 });
  });
});
