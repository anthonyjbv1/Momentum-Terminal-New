import type { EngineConfig } from "@/lib/engine/config";
import { readMetricPayload } from "@/lib/engine/sentiment/metric";
import type { ScoredSignal } from "@/lib/engine/types";

/**
 * THE TUNE BLOCK RECORD (2026-10-14).
 *
 * Every tune that replaces a metric firing's reading (the news-volume and
 * company-news tunes, the follower tune, the view tune) can read a firing
 * as nothing: a lull, a sub-threshold or mixed-coverage surge, a firing
 * smaller than the day's peak, a day already given its ceiling. Each tune
 * writes why on the signal (`zeroBecause`), and the Signals force carries
 * that working in its score_events row's `signals[]`. But a row is written
 * only for a non-zero force, so when the zeroed firing was the person's only
 * signal of the tick, the reason reached engine_ticks.summary and nowhere
 * else: the 21:15 follower firings of 2026-10-13 (σ −7.37 and −7.04, both
 * read as a lull) left no score_events row at all.
 *
 * Now the Signals force's details carry `tuneBlocks`, one entry per firing a
 * tune zeroed, and a Signals row that carries any is written even at zero
 * impact (apply_engine_tick and the table's check allow exactly that case).
 * Nothing about the score changes: a zero row adds zero, and every reader of
 * score_events already skips or sums zero.
 */

export type TuneName = "newsVolume" | "companyNewsVolume" | "followerGrowth" | "viewCount";

export interface TuneBlock {
  /** The signal the tune zeroed. */
  id: string;
  metric: string;
  tune: TuneName;
  /** The tune's reason, as it wrote it on the signal. */
  reason: string;
  sigma: number | null;
  /** The metric scorer's impact before the tune replaced it; null where the tune's detail does not keep it (the news-volume tunes). */
  scored: number | null;
}

/** The firings a tune read as nothing this tick, in the order they were scored. */
export function tuneBlocksOf(scored: ReadonlyArray<ScoredSignal>, config: EngineConfig): TuneBlock[] {
  const out: TuneBlock[] = [];
  for (const entry of scored) {
    const metric = readMetricPayload(entry.signal.rawPayload);
    if (!metric) continue;
    const block = blockOf(entry, metric.metric, config);
    if (block) out.push({ id: entry.signal.id, metric: metric.metric, sigma: Number.isFinite(metric.sigma) ? metric.sigma : null, ...block });
  }
  return out;
}

function blockOf(entry: ScoredSignal, metric: string, config: EngineConfig): { tune: TuneName; reason: string; scored: number | null } | null {
  if (entry.newsVolume?.zeroBecause) {
    const tune: TuneName = metric === config.companyNewsVolume.metric && metric !== config.newsVolume.metric ? "companyNewsVolume" : "newsVolume";
    return { tune, reason: entry.newsVolume.zeroBecause, scored: null };
  }
  if (entry.followerGrowth?.zeroBecause) return { tune: "followerGrowth", reason: entry.followerGrowth.zeroBecause, scored: entry.followerGrowth.scored };
  if (entry.viewCount?.zeroBecause) return { tune: "viewCount", reason: entry.viewCount.zeroBecause, scored: entry.viewCount.scored };
  return null;
}

/** Whether a Signals force row is written: a non-zero impact, or a zero one that records a tune's block. */
export function writesSignalsRow(impact: number, details: Record<string, unknown>): boolean {
  if (impact !== 0) return true;
  const blocks = details.tuneBlocks;
  return Array.isArray(blocks) && blocks.length > 0;
}
