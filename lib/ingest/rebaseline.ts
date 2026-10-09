import { readMetricConfigs } from "@/lib/ingest/metrics";
import type { Json } from "@/types/database";

/**
 * THE BASELINE-CUT REMINDER (2026-10-09).
 *
 * A metric whose feed changed shape carries `baseline_since` on its source
 * row and, for the week the new baseline takes to form, a `min_samples` far
 * above its everyday value (672: seven days of fifteen-minute polls), so it
 * emits nothing until the new feed has a week of its own history. The
 * everyday value is 24. Nothing restores it on its own: the operator does,
 * and the health check says when. Pure; the route feeds it the source rows.
 */

export const REBASELINE_HOLD_DAYS = 7;
export const DEFAULT_MIN_SAMPLES_AFTER_CUT = 24;
const DAY_MS = 86_400_000;

export interface RebaselineMetric {
  source: string;
  metric: string;
  baselineSince: string;
  minSamples: number;
  /** When the hold ends: baseline_since plus seven days. */
  restoreMinSamplesAt: string;
  /** Whether the everyday min_samples is back on the row. */
  restored: boolean;
}

export function rebaselineStatus(sources: Array<{ name: string; config: Json | null }>, now: Date): { metrics: RebaselineMetric[]; warnings: string[] } {
  const metrics: RebaselineMetric[] = [];
  const warnings: string[] = [];
  for (const source of sources) {
    const config = source.config && typeof source.config === "object" && !Array.isArray(source.config) ? (source.config as Record<string, Json | undefined>) : {};
    for (const metric of readMetricConfigs(config).metrics) {
      if (!metric.baselineSince) continue;
      const restoreAt = new Date(metric.baselineSince.getTime() + REBASELINE_HOLD_DAYS * DAY_MS);
      const restored = metric.minSamples <= DEFAULT_MIN_SAMPLES_AFTER_CUT;
      metrics.push({ source: source.name, metric: metric.metricKey, baselineSince: metric.baselineSince.toISOString(), minSamples: metric.minSamples, restoreMinSamplesAt: restoreAt.toISOString(), restored });
      if (restored) continue;
      const due = now.getTime() >= restoreAt.getTime();
      warnings.push(
        due
          ? `${source.name}.${metric.metricKey}: min_samples is still ${metric.minSamples}; the baseline cut of ${metric.baselineSince.toISOString()} is ${REBASELINE_HOLD_DAYS} days old, set min_samples back to ${DEFAULT_MIN_SAMPLES_AFTER_CUT}`
          : `${source.name}.${metric.metricKey}: baseline cut at ${metric.baselineSince.toISOString()}, min_samples ${metric.minSamples} until ${restoreAt.toISOString()}, then back to ${DEFAULT_MIN_SAMPLES_AFTER_CUT}`,
      );
    }
  }
  return { metrics, warnings };
}
