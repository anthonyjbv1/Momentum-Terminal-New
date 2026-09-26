import type { ConnectorQuality } from "@/lib/connectors/types";
import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/config";
import { isSignalQualityEnabled } from "@/lib/env";

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
