import { LLMError, type LLMProvider, type LLMResponse } from "../types";

/**
 * Generic OpenAI-compatible adapter — STUB. Interface-compliant; throws until
 * implemented. Covers Groq, Together.ai, Fireworks, vLLM, Ollama and most
 * open-source inference services, which all speak the OpenAI Chat Completions
 * request and response format.
 *
 * TODO(activation): POST {OPENAI_COMPATIBLE_BASE_URL}/chat/completions with
 * Authorization: Bearer {OPENAI_COMPATIBLE_API_KEY}; map systemPrompt ->
 * {role:"system"}, userPrompt -> {role:"user"}, responseFormat json ->
 * response_format {type:"json_object"} where supported (otherwise rely on the
 * prompt + extractJson), usage.prompt_tokens / completion_tokens -> LLMUsage.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";

  async complete(): Promise<LLMResponse> {
    throw new LLMError(
      "OpenAI-compatible provider is not configured: implement lib/llm/providers/openai-compatible.ts and set OPENAI_COMPATIBLE_BASE_URL + OPENAI_COMPATIBLE_API_KEY.",
      { kind: "not_configured", provider: this.name },
    );
  }
}
