import Anthropic from "@anthropic-ai/sdk";

import { extractJson } from "../json";
import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "../types";

/**
 * Anthropic adapter — the Messages API through the official SDK.
 *
 * Everything Anthropic-specific stays in this file: the API key, the request
 * shape (system prompt with a cache breakpoint, output_config for effort and
 * JSON schema), response parsing (text blocks, usage, refusal stop reason) and
 * error mapping. Nothing outside lib/llm/ imports the SDK.
 *
 * Model: LLM_MODEL (or the request's model) — defaults to claude-opus-5.
 */

export const ANTHROPIC_PROVIDER_NAME = "anthropic";
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Models that still accept sampling parameters. Newer models reject `temperature` with a 400. */
const SAMPLING_SUPPORTED = /^claude-(haiku-4-5|sonnet-4-6|opus-4-6|opus-4-5|sonnet-4-5)/;
/** Models on which `output_config.effort` is not accepted. */
const EFFORT_UNSUPPORTED = /^claude-(haiku-4-5|sonnet-4-5)/;

export interface AnthropicProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Pre-built client (tests inject a fake). */
  client?: Pick<Anthropic, "messages">;
}

type MessageParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

export class AnthropicProvider implements LLMProvider {
  readonly name = ANTHROPIC_PROVIDER_NAME;
  private readonly apiKey: string | undefined;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private client: Pick<Anthropic, "messages"> | null;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.defaultModel = options.defaultModel ?? process.env.LLM_MODEL?.trim() ?? ANTHROPIC_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 1;
    this.client = options.client ?? null;
  }

  private getClient(): Pick<Anthropic, "messages"> {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new LLMError("ANTHROPIC_API_KEY is not set; the Anthropic provider is not configured.", {
        kind: "not_configured",
        provider: this.name,
      });
    }
    this.client = new Anthropic({ apiKey: this.apiKey, timeout: this.timeoutMs, maxRetries: this.maxRetries });
    return this.client;
  }

  buildParams(request: LLMRequest): MessageParams {
    const model = request.model?.trim() || this.defaultModel;
    const params: MessageParams = {
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      // The system prompt is the stable prefix: mark it cacheable so repeated
      // calls in a tick pay for it once.
      system: [{ type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.userPrompt }],
    };

    if (request.temperature !== undefined && SAMPLING_SUPPORTED.test(model)) {
      params.temperature = request.temperature;
    }

    const outputConfig: Anthropic.Messages.OutputConfig = {};
    if (request.effort && !EFFORT_UNSUPPORTED.test(model)) outputConfig.effort = request.effort;
    if (request.responseFormat?.type === "json" && request.responseFormat.schema) {
      outputConfig.format = { type: "json_schema", schema: request.responseFormat.schema };
    }
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;

    return params;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const client = this.getClient();
    const params = this.buildParams(request);
    const options = request.timeoutMs ? { timeout: request.timeoutMs } : undefined;
    const startedAt = Date.now();

    let message: Anthropic.Message;
    try {
      message = await client.messages.create(params, options);
    } catch (error) {
      // A model that does not accept the structured-output schema: retry once
      // with prompt-only JSON and parse the text ourselves.
      if (
        error instanceof Anthropic.BadRequestError &&
        params.output_config?.format &&
        /output_config|format|json_schema/i.test(error.message)
      ) {
        delete params.output_config.format;
        if (Object.keys(params.output_config).length === 0) delete params.output_config;
        try {
          message = await client.messages.create(params, options);
        } catch (retryError) {
          throw this.mapError(retryError);
        }
      } else {
        throw this.mapError(error);
      }
    }

    const latencyMs = Date.now() - startedAt;

    if (message.stop_reason === "refusal") {
      const details = (message as unknown as { stop_details?: { explanation?: string | null } | null }).stop_details;
      throw new LLMError(`Anthropic declined the request${details?.explanation ? `: ${details.explanation}` : ""}`, {
        kind: "refusal",
        provider: this.name,
      });
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const response: LLMResponse = {
      text,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      provider: this.name,
      model: message.model,
      stopReason: message.stop_reason,
      latencyMs,
    };

    if (request.responseFormat?.type === "json") {
      response.structuredData = extractJson(text, this.name);
    }
    return response;
  }

  private mapError(error: unknown): LLMError {
    if (error instanceof LLMError) return error;
    const provider = this.name;
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new LLMError(`Anthropic authentication failed: ${error.message}`, { kind: "authentication", provider, status: error.status });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new LLMError(`Anthropic rate limit: ${error.message}`, { kind: "rate_limit", provider, status: 429, retryable: true });
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new LLMError(`Anthropic request timed out: ${error.message}`, { kind: "timeout", provider, retryable: true });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new LLMError(`Anthropic connection error: ${error.message}`, { kind: "network", provider, retryable: true });
    }
    if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
      return new LLMError(`Anthropic rejected the request: ${error.message}`, { kind: "invalid_request", provider, status: error.status });
    }
    if (error instanceof Anthropic.InternalServerError) {
      return new LLMError(`Anthropic server error: ${error.message}`, { kind: "server", provider, status: error.status, retryable: true });
    }
    if (error instanceof Anthropic.APIError) {
      const retryable = typeof error.status === "number" && error.status >= 500;
      return new LLMError(`Anthropic API error: ${error.message}`, { kind: retryable ? "server" : "unknown", provider, status: error.status, retryable });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new LLMError(`Anthropic call failed: ${message}`, { kind: "unknown", provider });
  }
}
