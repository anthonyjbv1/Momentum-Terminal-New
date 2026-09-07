import { LLMError, type LLMProvider, type LLMResponse } from "../types";

/**
 * Google Gemini adapter — STUB. Interface-compliant; throws until implemented.
 *
 * TODO(activation): call the Gemini API generateContent endpoint with the
 * GEMINI_API_KEY env var, map systemPrompt -> systemInstruction, userPrompt ->
 * contents, responseFormat json -> generationConfig.responseMimeType
 * "application/json" (+ responseSchema), and usageMetadata -> LLMUsage.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";

  async complete(): Promise<LLMResponse> {
    throw new LLMError(
      "Gemini provider is not configured: implement lib/llm/providers/gemini.ts and set GEMINI_API_KEY.",
      { kind: "not_configured", provider: this.name },
    );
  }
}
