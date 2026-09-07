import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnthropicProvider } from "./providers/anthropic";
import { LLMError } from "./types";

type FakeClient = { messages: { create: ReturnType<typeof vi.fn> } };

function message(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

function provider(client: FakeClient, options: Record<string, unknown> = {}) {
  return new AnthropicProvider({ apiKey: "test-key", client: client as unknown as Pick<Anthropic, "messages">, ...options });
}

describe("AnthropicProvider", () => {
  beforeEach(() => {
    delete process.env.LLM_MODEL;
  });

  it("builds a Messages API request with a cached system prompt, effort and a JSON schema", async () => {
    const client: FakeClient = { messages: { create: vi.fn(async () => message('{"ok":true}')) } };
    const result = await provider(client).complete({
      systemPrompt: "SYSTEM",
      userPrompt: "USER",
      maxTokens: 500,
      effort: "low",
      temperature: 0.3,
      timeoutMs: 1234,
      responseFormat: { type: "json", schema: { type: "object" } },
    });

    const [params, options] = client.messages.create.mock.calls[0];
    expect(params).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 500,
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "USER" }],
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(params.temperature).toBeUndefined(); // claude-opus-5 rejects sampling parameters
    expect(options).toEqual({ timeout: 1234 });
    expect(result).toMatchObject({
      text: '{"ok":true}',
      structuredData: { ok: true },
      provider: "anthropic",
      model: "claude-opus-5",
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
    });
  });

  it("passes temperature and skips effort on models that support / reject them", async () => {
    const client: FakeClient = { messages: { create: vi.fn(async () => message("hi")) } };
    await provider(client).complete({ systemPrompt: "s", userPrompt: "u", model: "claude-haiku-4-5", temperature: 0.2, effort: "low" });
    const [params] = client.messages.create.mock.calls[0];
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.temperature).toBe(0.2);
    expect(params.output_config).toBeUndefined();
  });

  it("honours LLM_MODEL as the default model", async () => {
    process.env.LLM_MODEL = "claude-sonnet-5";
    const client: FakeClient = { messages: { create: vi.fn(async () => message("hi")) } };
    await provider(client).complete({ systemPrompt: "s", userPrompt: "u" });
    expect(client.messages.create.mock.calls[0][0].model).toBe("claude-sonnet-5");
  });

  it("maps a refusal stop reason to an LLMError", async () => {
    const client: FakeClient = { messages: { create: vi.fn(async () => message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "x", explanation: "policy" } })) } };
    await expect(provider(client).complete({ systemPrompt: "s", userPrompt: "u" })).rejects.toMatchObject({ kind: "refusal", provider: "anthropic" });
  });

  it("retries once without the schema when the model rejects output_config.format", async () => {
    const client: FakeClient = {
      messages: {
        create: vi
          .fn()
          .mockRejectedValueOnce(new Anthropic.BadRequestError(400, { type: "error", message: "output_config.format is not supported on this model" }, undefined, new Headers()))
          .mockResolvedValueOnce(message('Sure:\n```json\n{"a":1}\n```')),
      },
    };
    const result = await provider(client).complete({ systemPrompt: "s", userPrompt: "u", responseFormat: { type: "json", schema: { type: "object" } } });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(client.messages.create.mock.calls[1][0].output_config).toBeUndefined();
    expect(result.structuredData).toEqual({ a: 1 });
  });

  it("maps SDK errors to LLMError kinds", async () => {
    const cases: Array<[unknown, string, boolean]> = [
      [new Anthropic.RateLimitError(429, { type: "error" }, "slow down", new Headers()), "rate_limit", true],
      [new Anthropic.AuthenticationError(401, { type: "error" }, "bad key", new Headers()), "authentication", false],
      [new Anthropic.APIConnectionTimeoutError(), "timeout", true],
      [new Anthropic.APIConnectionError({ message: "socket hang up" }), "network", true],
      [new Anthropic.InternalServerError(500, { type: "error" }, "boom", new Headers()), "server", true],
      [new Anthropic.NotFoundError(404, { type: "error" }, "no model", new Headers()), "invalid_request", false],
    ];
    for (const [error, kind, retryable] of cases) {
      const client: FakeClient = { messages: { create: vi.fn().mockRejectedValue(error) } };
      const promise = provider(client).complete({ systemPrompt: "s", userPrompt: "u" });
      await expect(promise).rejects.toBeInstanceOf(LLMError);
      await expect(promise).rejects.toMatchObject({ kind, retryable });
    }
  });

  it("raises invalid_response when JSON was requested but not returned", async () => {
    const client: FakeClient = { messages: { create: vi.fn(async () => message("no json at all")) } };
    await expect(provider(client).complete({ systemPrompt: "s", userPrompt: "u", responseFormat: { type: "json" } })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
