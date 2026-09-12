/**
 * Single place that reads environment variables.
 *
 * NEXT_PUBLIC_* variables are inlined into the browser bundle at build time,
 * which only works when they are referenced as literal `process.env.NAME`
 * expressions — hence no dynamic lookups here.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.local.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Supabase project URL, e.g. https://<project-ref>.supabase.co */
export function getSupabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/**
 * Publishable key (sb_publishable_...) or legacy anon JWT. Safe in the browser;
 * all queries made with it are subject to Row Level Security.
 */
export function getSupabasePublishableKey(): string {
  return required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * Secret key (sb_secret_...) or legacy service_role JWT. SERVER ONLY.
 * Bypasses Row Level Security — only read this from trusted server code.
 */
export function getSupabaseServiceRoleKey(): string {
  return required(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY,
  );
}

/** Public base URL of the app, used to build auth redirect links. */
export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

// ---------------------------------------------------------------------------
// Data ingestion (Phase 2)
// ---------------------------------------------------------------------------

/** YouTube Data API v3 key. SERVER ONLY — read inside connectors, never in client code. */
export function getYouTubeApiKey(): string {
  return required("YOUTUBE_API_KEY", process.env.YOUTUBE_API_KEY);
}

/**
 * Shared secret that authorises calls to /api/ingest. SERVER ONLY.
 * Returns null when unset so the route can fail closed with a clear message.
 */
export function getIngestSecretOrNull(): string | null {
  const value = process.env.INGEST_SECRET?.trim();
  return value ? value : null;
}

// ---------------------------------------------------------------------------
// The Engine (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Shared secret that authorises calls to /api/engine/tick. SERVER ONLY.
 * Returns null when unset so the route can fail closed with a clear message.
 */
export function getEngineSecretOrNull(): string | null {
  const value = process.env.ENGINE_SECRET?.trim();
  return value ? value : null;
}

/**
 * The Engine tunables that may be overridden from the environment during the
 * controlled test, as raw strings; lib/engine/config.ts parses them strictly
 * and ignores anything malformed. SERVER ONLY.
 *
 *   ENGINE_TRADING_MIN_POPULATED_WINDOWS  the Trading Activity minimum-sample
 *                                         guard (code default 30, unchanged)
 */
export function getEngineEnvOverrides(): { tradingMinPopulatedWindows: string | undefined } {
  return { tradingMinPopulatedWindows: process.env.ENGINE_TRADING_MIN_POPULATED_WINDOWS };
}

// ---------------------------------------------------------------------------
// LLM reasoning layer (Phase 4) — all SERVER ONLY
// ---------------------------------------------------------------------------

export const DEFAULT_LLM_PROVIDER_NAME = "anthropic";
export const DEFAULT_SCORER_NAME = "llm";

/** Active LLM provider registry name (LLM_PROVIDER). */
export function getLLMProviderName(): string {
  return process.env.LLM_PROVIDER?.trim() || DEFAULT_LLM_PROVIDER_NAME;
}

/** Model string for the active provider (LLM_MODEL), or null for the provider default. */
export function getLLMModelOrNull(): string | null {
  const value = process.env.LLM_MODEL?.trim();
  return value ? value : null;
}

/** Which SentimentScorer the Engine uses: SCORER (default "llm"; "rules" is the instant fallback). */
export function getScorerName(): string {
  return process.env.SCORER?.trim() || process.env.SENTIMENT_SCORER?.trim() || DEFAULT_SCORER_NAME;
}

export interface LLMRouteOverride {
  provider?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
}

function effortOrUndefined(value: string | undefined): LLMRouteOverride["effort"] {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

/**
 * Optional per-task routing overrides. Each task type has its own trio of
 * variables so a cheap model can serve simple scoring while a premium one
 * handles anomaly reasoning.
 */
export function getLLMRouteOverride(taskType: "sentiment" | "anomaly" | "narrative" | "memory"): LLMRouteOverride {
  switch (taskType) {
    case "sentiment":
      return {
        provider: process.env.LLM_PROVIDER_SENTIMENT?.trim() || undefined,
        model: process.env.LLM_MODEL_SENTIMENT?.trim() || undefined,
        effort: effortOrUndefined(process.env.LLM_EFFORT_SENTIMENT?.trim()),
      };
    case "anomaly":
      return {
        provider: process.env.LLM_PROVIDER_ANOMALY?.trim() || undefined,
        model: process.env.LLM_MODEL_ANOMALY?.trim() || undefined,
        effort: effortOrUndefined(process.env.LLM_EFFORT_ANOMALY?.trim()),
      };
    case "narrative":
      return {
        provider: process.env.LLM_PROVIDER_NARRATIVE?.trim() || undefined,
        model: process.env.LLM_MODEL_NARRATIVE?.trim() || undefined,
        effort: effortOrUndefined(process.env.LLM_EFFORT_NARRATIVE?.trim()),
      };
    case "memory":
      return {
        provider: process.env.LLM_PROVIDER_MEMORY?.trim() || undefined,
        model: process.env.LLM_MODEL_MEMORY?.trim() || undefined,
        effort: effortOrUndefined(process.env.LLM_EFFORT_MEMORY?.trim()),
      };
  }
}

// ---------------------------------------------------------------------------
// Engine cron heartbeat — SERVER ONLY
// ---------------------------------------------------------------------------

/**
 * The on/off switch for autonomous ticking. Only the exact string "true"
 * enables it; anything else (unset, "false", "1", "TRUE") keeps the Engine
 * idle so nothing runs and nothing costs.
 */
export function isEngineCronEnabled(): boolean {
  return process.env.ENGINE_CRON_ENABLED?.trim() === "true";
}

/** Vercel's CRON_SECRET (sent as `Authorization: Bearer` on scheduled invocations), or null. */
export function getCronSecretOrNull(): string | null {
  const value = process.env.CRON_SECRET?.trim();
  return value ? value : null;
}
