import type { EngineConfig } from "@/lib/engine/config";
import { dayStateFromSignals, EMPTY_DAY, utcDay, type NewsVolumeDayState } from "@/lib/engine/news-volume";
import { readMetricPayload } from "@/lib/engine/sentiment/metric";
import type { ScoredSignal } from "@/lib/engine/types";

/**
 * THE FOLLOWER TUNE (FOLLOWER_TUNE_ENABLED, 2026-10-09; ships off).
 *
 * WHAT IT REPLACES. Twitch follower_count is a relative rate of a count that
 * only rises, read every hour against the person's own week. Kai Cenat's
 * thirty days to 10-09: seven firings, every one upward, 9.2 points, with
 * two pairs an hour apart (+2.7σ then +9.2σ on 09-30, +2.6σ then +12.0σ on
 * 10-09) where one spike crossed the register rule twice. No lull has ever
 * fired: the mean rate sits at the sd floor, and the lowest reading in the
 * window was −0.85σ, so the metric is one-sided in practice.
 *
 * THE RULE: the variant C shape (lib/engine/news-volume.ts) without the
 * direction rule, because following is a positive act and there are no
 * stories to sign the surge by.
 *
 *   1. UPWARD ONLY. A firing at or under zero sigma (a lull) reads as nothing
 *      and leaves the day alone.
 *   2. PER-FIRING CAP. A firing's reading is the metric scorer's own impact,
 *      capped at ceilingPoints (0.75).
 *   3. PEAK-ONLY, PER PERSON PER UTC DAY. Only a firing that reaches the
 *      day's peak sigma so far moves the day, and it moves it to its own
 *      reading: its delta is the reading less what the day already had,
 *      never negative. A smaller firing contributes nothing.
 *   4. CEILING 0.75 PER PERSON PER UTC DAY, which (2) and (3) give: the
 *      day's total is its peak firing's capped reading. One spike cannot
 *      fire twice: the second, larger reading of the same spike takes the
 *      peak and adds only what the first had not.
 *
 * WHERE IT RUNS. In the tick, after the news-volume tunes, only while
 * followerGrowth.enabled is on. Off, the metric scorer's reading stands
 * exactly as before. The day's state is read back from the person's
 * processed follower_count signals of the day (dayStateFromSignals), as the
 * news-volume tune reads its own: nothing new is written anywhere.
 */

export type FollowerGrowthConfig = EngineConfig["followerGrowth"];

export interface FollowerGrowthDetail {
  sigma: number;
  /** The metric scorer's impact, as scored. */
  scored: number;
  /** The firing's own reading: the scored impact, capped; 0 for a lull. */
  reading: number;
  zeroBecause: "lull" | "not_the_peak" | "day_already_given" | null;
  dayBefore: { peakSigma: number | null; applied: number };
  /** What the firing contributes. */
  delta: number;
}

/** True for a follower_count metric signal, with its sigma. */
export function followerGrowthSigma(payload: ScoredSignal["signal"]["rawPayload"], config: FollowerGrowthConfig): number | null {
  const metric = readMetricPayload(payload);
  return metric && metric.metric === config.metric ? metric.sigma : null;
}

/** One firing's reading and what it contributes given the day so far. Pure. */
export function readFollowerGrowth(input: { sigma: number; scored: number; at: Date }, day: NewsVolumeDayState | null, config: FollowerGrowthConfig): { detail: FollowerGrowthDetail; day: NewsVolumeDayState } {
  const today = utcDay(input.at);
  const before: NewsVolumeDayState = day && day.day === today ? day : { day: today, ...EMPTY_DAY };
  const dayBefore = { peakSigma: Number.isFinite(before.peakSigma) ? before.peakSigma : null, applied: before.applied };
  const base = { sigma: input.sigma, scored: input.scored, dayBefore };
  if (!(input.sigma > 0)) return { detail: { ...base, reading: 0, zeroBecause: "lull", delta: 0 }, day: before };
  const reading = Math.min(config.ceilingPoints, Math.max(0, input.scored));
  if (!(input.sigma >= before.peakSigma)) return { detail: { ...base, reading, zeroBecause: "not_the_peak", delta: 0 }, day: before };
  const delta = Math.max(0, Math.min(config.ceilingPoints, reading - before.applied));
  return {
    detail: { ...base, reading, zeroBecause: delta === 0 ? "day_already_given" : null, delta },
    day: { day: today, peakSigma: input.sigma, applied: before.applied + delta },
  };
}

/** Applies the tune to one person's scored signals, in time order, each firing updating the day for the next. Other signals pass through untouched. */
export function tuneFollowerGrowth(scored: ScoredSignal[], today: NewsVolumeDayState | null | undefined, config: FollowerGrowthConfig): ScoredSignal[] {
  const firings = scored
    .map((entry, index) => ({ entry, index, sigma: followerGrowthSigma(entry.signal.rawPayload, config) }))
    .filter((item): item is { entry: ScoredSignal; index: number; sigma: number } => item.sigma !== null)
    .sort((a, b) => a.entry.signal.occurredAt.getTime() - b.entry.signal.occurredAt.getTime() || a.entry.signal.id.localeCompare(b.entry.signal.id));
  if (firings.length === 0) return scored;
  const out = [...scored];
  let day = today ?? null;
  for (const firing of firings) {
    const read = readFollowerGrowth({ sigma: firing.sigma, scored: firing.entry.impact, at: firing.entry.signal.occurredAt }, day, config);
    day = read.day;
    out[firing.index] = { ...firing.entry, impact: read.detail.delta, followerGrowth: read.detail };
  }
  return out;
}

/** The day's state per person from today's processed follower_count firings, as the store loads them. */
export function followerGrowthDayStates(rows: ReadonlyArray<{ person_id: string; impact_score: number | string | null; occurred_at: string; sigma: number | string | null }>, activeIds: ReadonlySet<string>, now: Date): Map<string, NewsVolumeDayState> {
  const byPerson = new Map<string, Array<{ sigma: number | null; impact: number; occurredAt: Date }>>();
  for (const row of rows) {
    if (!activeIds.has(row.person_id)) continue;
    const sigma = row.sigma === null ? null : Number(row.sigma);
    byPerson.set(row.person_id, [...(byPerson.get(row.person_id) ?? []), { sigma: sigma !== null && Number.isFinite(sigma) ? sigma : null, impact: Number(row.impact_score ?? 0), occurredAt: new Date(row.occurred_at) }]);
  }
  const out = new Map<string, NewsVolumeDayState>();
  for (const [personId, list] of byPerson) {
    const state = dayStateFromSignals(list, now);
    if (state) out.set(personId, state);
  }
  return out;
}
