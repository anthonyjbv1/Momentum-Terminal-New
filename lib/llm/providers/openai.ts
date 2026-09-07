import { LLMError, type LLMProvider, type LLMResponse } from "../types";

/**
 * OpenAI adapter — STUB. Interface-compliant; throws until implemented.
 *
 * TODO(activation): call the Responses API (or Chat Completions) with the
 * OPENAI_API_KEY env var, map systemPrompt -> instructions / system message,
 * userPrompt -> user message, responseFormat json -> `text.format` /
 * `response_format: { type: "json_schema" }`, and usage -> LLMUsage
 * (input_tokens / output_tokens, cached_tokens -> cacheReadInputTokens).
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";

  async complete(): Promise<LLMResponse> {
    throw new LLMError(
      "OpenAI provider is not configured: implement lib/llm/providers/openai.ts and set OPENAI_API_KEY.",
      { kind: "not_configured", provider: this.name },
    );
  }
}
