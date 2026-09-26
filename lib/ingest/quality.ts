import type { ConnectorQuality } from "@/lib/connectors/types";
import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/config";
import { isSignalQualityEnabled } from "@/lib/env";
import { LIVE_QUALITY_DEFAULTS, type LiveQualityRules } from "@/lib/ingest/live/rules";

/**
 * The ingestion half of the Phase 31 switch. When SIGNAL_QUALITY_ENABLED is
 * on, every news connector is handed the quality rules; the stale limit is
 * the Engine's own freshness horizon, so ingestion refuses exactly what the
 * Engine would have weighted at zero. Off (the default), nothing is handed
 * over and the connectors behave as they did.
 */
export function ingestQualityFromEnv(): ConnectorQuality | undefined {
  return isSignalQualityEnabled() ? { maxAgeHours: DEFAULT_ENGINE_CONFIG.signals.freshnessMaxAgeHours } : undefined;
}

/**
 * The live-mode half of the same switch (after Kai Cenat's stream of
 * 2026-09-26): four-minute sampling, the smoothed and confirmed surge, the
 * session shape, the per-session caps, confidence read from the threshold,
 * and the clip-burst floors (lib/ingest/live/rules.ts). Off, nothing is
 * handed over and live mode samples and judges as it did.
 */
export function liveQualityFromEnv(): LiveQualityRules | undefined {
  return isSignalQualityEnabled() ? LIVE_QUALITY_DEFAULTS : undefined;
}
