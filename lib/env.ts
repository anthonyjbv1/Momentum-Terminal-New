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

/**
 * THE SITE'S PUBLIC ADDRESS, from one variable. Auth redirect links, the
 * landing page's canonical URL, its OG image and every absolute link derive
 * from this; nothing in the code names a hostname. It is the Vercel URL
 * today and becomes the custom domain by changing this one value.
 * lib/site-url.test.ts fails the build if a vercel.app hostname is ever
 * written as a literal in app code.
 */
export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

/** The same, with no trailing slash: what a path is appended to. */
export function getSiteOrigin(): string {
  return getSiteUrl().replace(/\/+$/, "");
}

/** An absolute URL on this site for a path such as "/privacy". */
export function absoluteUrl(path: string): string {
  return `${getSiteOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}

// ---------------------------------------------------------------------------
// Data ingestion (Phase 2)
// ---------------------------------------------------------------------------

/** YouTube Data API v3 key. SERVER ONLY — read inside connectors, never in client code. */
export function getYouTubeApiKey(): string {
  return required("YOUTUBE_API_KEY", process.env.YOUTUBE_API_KEY);
}

/**
 * The same key, or null when unset. Connectors report availability with this
 * so a missing credential makes the source inactive for the run instead of
 * failing it.
 */
export function getYouTubeApiKeyOrNull(): string | null {
  const value = process.env.YOUTUBE_API_KEY?.trim();
  return value ? value : null;
}

/** Spotify Web API client credentials (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET), or null when either is unset. SERVER ONLY. */
export function getSpotifyCredentialsOrNull(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Twitch Helix app credentials (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET), or null when either is unset. SERVER ONLY. */
export function getTwitchCredentialsOrNull(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** API-Sports key (APISPORTS_API_KEY), or null when unset. SERVER ONLY. One key spans the sport hosts it is subscribed to. */
export function getApiSportsKeyOrNull(): string | null {
  const value = process.env.APISPORTS_API_KEY?.trim();
  return value ? value : null;
}

/** Finnhub key (FINNHUB_API_KEY), or null when unset. SERVER ONLY. */
export function getFinnhubKeyOrNull(): string | null {
  const value = process.env.FINNHUB_API_KEY?.trim();
  return value ? value : null;
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
 *   ENGINE_TARGET_DRIFT_ENABLED           the drifting Gravity target (Phase
 *                                         14); exactly "true" turns it on
 *   ENGINE_VOLUME_REFERENCE               the volume weight's reference rate
 *                                         (code default 4, derived from the
 *                                         roster's measured geometric mean);
 *                                         expected to need re-deriving as
 *                                         subjects and sources are added
 *   ENGINE_MOOD_WINDOW_MINUTES            the window Market Mood is read over
 *                                         (code default 60)
 *   ENGINE_MOOD_RATE_PER_HOUR             Market Mood's points-per-hour rate
 *                                         (code default 1.41, derived to hold
 *                                         the force's measured contribution)
 */
export function getEngineEnvOverrides(): {
  tradingMinPopulatedWindows: string | undefined;
  targetDriftEnabled: string | undefined;
  volumeReference: string | undefined;
  moodWindowMinutes: string | undefined;
  moodRatePerHour: string | undefined;
} {
  return {
    tradingMinPopulatedWindows: process.env.ENGINE_TRADING_MIN_POPULATED_WINDOWS,
    targetDriftEnabled: process.env.ENGINE_TARGET_DRIFT_ENABLED,
    volumeReference: process.env.ENGINE_VOLUME_REFERENCE,
    moodWindowMinutes: process.env.ENGINE_MOOD_WINDOW_MINUTES,
    moodRatePerHour: process.env.ENGINE_MOOD_RATE_PER_HOUR,
  };
}

/**
 * The switch of the drifting Gravity target, as the operator console reports
 * it. The Engine reads it through getEngineEnvOverrides(); this is the same
 * rule (exactly "true") in one place for display.
 */
export function isTargetDriftEnabled(): boolean {
  return process.env.ENGINE_TARGET_DRIFT_ENABLED?.trim() === "true";
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

/**
 * The on/off switch for autonomous INGESTION, independent of the Engine's.
 *
 * Two jobs, two schedules, two flags, on purpose: ingestion accumulates the
 * baselines every metric needs (a week of history before upload cadence says
 * anything, 24 samples before a deviation counts) while the Engine stays
 * dormant, so data builds with no score moving and no LLM cost. Turning one on
 * never turns the other on. Only the exact string "true" enables it, and it
 * ships unset, which is off.
 */
export function isIngestCronEnabled(): boolean {
  return process.env.INGEST_CRON_ENABLED?.trim() === "true";
}

/** Vercel's CRON_SECRET (sent as `Authorization: Bearer` on scheduled invocations), or null. */
export function getCronSecretOrNull(): string | null {
  const value = process.env.CRON_SECRET?.trim();
  return value ? value : null;
}
