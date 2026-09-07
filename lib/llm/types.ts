/**
 * Provider-agnostic LLM abstraction.
 *
 * The rest of the system only ever sees LLMProvider / LLMRequest / LLMResponse.
 * Everything vendor-specific (auth, request shape, response parsing, error
 * mapping) lives inside one adapter under lib/llm/providers/.
 */

/** The kinds of work the Engine sends to an LLM. Used for routing and usage logging. */
export type LLMTaskType = "sentiment" | "anomaly" | "narrative" | "memory";

export type LLMEffort = "low" | "medium" | "high";

export type LLMJsonSchema = { [key: string]: unknown };

export type LLMResponseFormat =
  | { type: "text" }
  /** Ask for a JSON object. When a schema is given, adapters that support structured output enforce it. */
  | { type: "json"; schema?: LLMJsonSchema; name?: string };

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Output cap. Adapters apply a sensible default when omitted. */
  maxTokens?: number;
  /** Sampling temperature. Adapters ignore it on models that reject sampling parameters. */
  temperature?: number;
  responseFormat?: LLMResponseFormat;
  /** Overrides the provider's default model for this call. */
  model?: string;
  /** Reasoning effort hint. Adapters map it to their own knob or ignore it. */
  effort?: LLMEffort;
  timeoutMs?: number;
  /** What this call is for; carried into usage logs. */
  taskType?: LLMTaskType;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface LLMResponse {
  /** Raw text of the completion. */
  text: string;
  /** Parsed JSON when responseFormat.type === "json". */
  structuredData?: unknown;
  usage: LLMUsage;
  provider: string;
  model: string;
  stopReason: string | null;
  latencyMs: number;
}

export interface LLMProvider {
  /** Registry name, e.g. "anthropic". */
  readonly name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export type LLMErrorKind =
  | "not_configured"
  | "authentication"
  | "invalid_request"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "refusal"
  | "invalid_response"
  | "unknown";

/** Every adapter converts its vendor errors into this one class. */
export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { kind: LLMErrorKind; provider: string; status?: number; retryable?: boolean }) {
    super(message);
    this.name = "LLMError";
    this.kind = options.kind;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
