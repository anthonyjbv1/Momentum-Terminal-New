import type { EngineConfig } from "@/lib/engine/config";
import { readMetricPayload } from "@/lib/engine/sentiment/metric";
import type { ScoredSignal } from "@/lib/engine/types";

/**
 * THE NEWS-VOLUME TUNE (variant C, chosen 2026-10-01, re-run 2026-10-02).
 *
 * WHAT IT REPLACES. The news_volume_24h metric fires on every tick the
 * person's trailing-24h story count sits two sigma or more from their own
 * baseline, and the metric scorer reads it as a positive move of up to 0.75
 * points per firing whichever way the stories lean. A surge day therefore
 * fired many times (twelve on Mahomes's 09-28, eleven on Kai Cenat's 10-01)
 * and added several points, all positive, even when the stories behind it
 * were allegations. Replayed over 09-28 to 10-02, every surge day cleared the
 * per-firing cap by repetition alone.
 *
 * THE RULE, as replayed and chosen (lib/engine/news-volume.test.ts holds the
 * replay's own numbers):
 *
 *   1. PEAK-ONLY, PER PERSON PER UTC DAY. A day's news-volume contribution is
 *      the reading of its largest-sigma firing, not the sum of its firings.
 *      Live, the Engine cannot see the day's future, so it keeps a running
 *      peak: a firing whose sigma reaches the day's peak so far contributes
 *      the DIFFERENCE between its own reading and what the day has already
 *      been given; a smaller one contributes nothing. A firing that TIES the
 *      peak re-reads the day with its newer window (the same count, the
 *      stories as they stand now), which is what the replay did: the day
 *      ends at the newest reading taken at its largest sigma.
 *   2. COUNT BALANCE. The stories driving the surge are the person's article
 *      signals in the metric's own window (the 24 hours up to the firing)
 *      that carry a non-zero impact. Their balance is the confidence-
 *      weighted vote: sum of direction × confidence over sum of confidence,
 *      in −1..+1. The reading takes the balance's sign.
 *   3. DEAD ZONE. A balance inside ±0.25 is mixed coverage (Nvidia's three
 *      days read 0.03, −0.13, 0.05 on 13 to 19 signed stories) and reads
 *      as nothing.
 *   4. MINIMUM 3 SIGNED STORIES. One negative story among nine neutral ones
 *      is not a surge with a lean (Bezos 09-29); below three signed stories
 *      the firing reads as nothing.
 *   5. LULLS CONTRIBUTE NOTHING. The metric also fires on a count two sigma
 *      BELOW the baseline; the rule scales a surge's stories and a lull has
 *      none, so a non-positive sigma reads as nothing (Huang 10-02).
 *   6. SIZE: the volume scales the stories. The multiplier is sigma over the
 *      firing threshold, at most 2 (four sigma doubles the stories); the
 *      reading is (multiplier − 1) × |the window's signed story impact|,
 *      signed by the balance. At the threshold the surge adds nothing.
 *   7. CEILING 0.75 POINTS PER PERSON PER UTC DAY, one full-confidence
 *      firing as the metric stands today: the surge can never outweigh the
 *      biggest story of its own window (1.23 points, the largest seen).
 *
 * WHERE IT RUNS. In the tick, after the per-person signals are scored and
 * the story confirmation has run, and only while newsVolume.enabled is on.
 * Off, the metric scorer's reading stands exactly as before. The replaced
 * impact is the one stored on the signal and summed by the Signals force,
 * so the day's state (the peak sigma, what was applied) is read back from
 * the person's processed news-volume signals of the day: nothing new is
 * written anywhere.
 */

export type NewsVolumeConfig = EngineConfig["newsVolume"];

/** A story in the firing's window: when it happened, its stored impact and the scorer's confidence. */
export interface WindowStory {
  occurredAt: Date;
  impact: number;
  confidence: number;
}

/** What the person's day has already been given, read back from their processed news-volume signals. */
export interface NewsVolumeDayState {
  /** The UTC day (YYYY-MM-DD) the state describes. */
  day: string;
  /** The largest sigma applied so far that day; -Infinity before the first. */
  peakSigma: number;
  /** The points the day's news-volume firings have already added, net. */
  applied: number;
}

/** Everything the tune needs for one person, loaded by the store while the switch is on. */
export interface NewsVolumeContext {
  /** The person's processed article signals with a non-zero impact over the trailing window, oldest first. */
  stories: WindowStory[];
  /** The day's state as the store read it; null when the person has no processed news-volume signal today. */
  today: NewsVolumeDayState | null;
}

/** The working behind one firing's reading, carried into the tick summary and the force's audit trail. */
export interface NewsVolumeDetail {
  sigma: number;
  /** The stories in the window with a non-zero impact. */
  signedStories: number;
  /** The confidence-weighted vote, −1..+1; 0 with no signed story. */
  balance: number;
  /** The window's signed story impact, summed. */
  signedImpact: number;
  /** The volume multiplier before the ceiling: sigma over the threshold, at most maxMultiplier; 0 for a lull. */
  multiplier: number;
  /** The firing's own reading, after the ceiling, before the day's state: what the day's total becomes if this is its peak. */
  reading: number;
  /** Why the reading is 0, when it is. */
  zeroBecause: "lull" | "too_few_signed" | "dead_zone" | "at_threshold" | "not_the_peak" | null;
  /** The day's state before this firing. */
  dayBefore: { peakSigma: number | null; applied: number };
  /** What the firing contributes: the reading less what the day already had, when it reaches the day's peak; else 0. */
  delta: number;
}

export const EMPTY_DAY: Omit<NewsVolumeDayState, "day"> = { peakSigma: Number.NEGATIVE_INFINITY, applied: 0 };

/** The UTC day a moment falls in, as YYYY-MM-DD. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The confidence-weighted vote of the signed stories, and their impact together. */
export function storyBalance(stories: readonly WindowStory[]): { balance: number; signedImpact: number; signedStories: number } {
  let votes = 0;
  let weight = 0;
  let signedImpact = 0;
  let signedStories = 0;
  for (const story of stories) {
    if (!Number.isFinite(story.impact) || story.impact === 0) continue;
    const confidence = Number.isFinite(story.confidence) ? Math.max(0, story.confidence) : 0;
    votes += Math.sign(story.impact) * confidence;
    weight += confidence;
    signedImpact += story.impact;
    signedStories += 1;
  }
  return { balance: weight > 0 ? votes / weight : 0, signedImpact, signedStories };
}

/** The stories inside the firing's window: after (at − windowHours), up to and including at. */
export function storiesInWindow(stories: readonly WindowStory[], at: Date, windowHours: number): WindowStory[] {
  const from = at.getTime() - windowHours * 3600 * 1000;
  return stories.filter((story) => story.occurredAt.getTime() > from && story.occurredAt.getTime() <= at.getTime());
}

/**
 * One firing's reading and what it contributes given the day so far. Pure:
 * returns the detail and the day's state after it.
 */
export function readNewsVolume(
  input: { sigma: number; at: Date; stories: readonly WindowStory[] },
  day: NewsVolumeDayState | null,
  config: NewsVolumeConfig,
): { detail: NewsVolumeDetail; day: NewsVolumeDayState } {
  const today = utcDay(input.at);
  const before: NewsVolumeDayState = day && day.day === today ? day : { day: today, ...EMPTY_DAY };
  const window = storiesInWindow(input.stories, input.at, config.windowHours);
  const { balance, signedImpact, signedStories } = storyBalance(window);
  const dayBefore = { peakSigma: Number.isFinite(before.peakSigma) ? before.peakSigma : null, applied: before.applied };

  const base: Omit<NewsVolumeDetail, "multiplier" | "reading" | "zeroBecause" | "delta"> = { sigma: input.sigma, signedStories, balance, signedImpact, dayBefore };

  // A lull is not a surge: nothing to scale.
  if (!(input.sigma > 0)) return { detail: { ...base, multiplier: 0, reading: 0, zeroBecause: "lull", delta: 0 }, day: before };

  const multiplier = Math.min(config.maxMultiplier, input.sigma / config.thresholdSigma);
  let reading = 0;
  let zeroBecause: NewsVolumeDetail["zeroBecause"] = null;
  if (signedStories < config.minSignedStories) zeroBecause = "too_few_signed";
  else if (Math.abs(balance) < config.deadZone) zeroBecause = "dead_zone";
  else if (multiplier <= 1) zeroBecause = "at_threshold";
  else {
    const raw = (multiplier - 1) * Math.abs(signedImpact);
    reading = Math.sign(balance) * Math.min(raw, config.ceilingPoints);
  }

  // Peak-only: only a firing that reaches the day's peak so far moves the
  // day, and it moves it to its own reading; a tie re-reads with the newer window.
  if (!(input.sigma >= before.peakSigma)) {
    return { detail: { ...base, multiplier, reading, zeroBecause: zeroBecause ?? "not_the_peak", delta: 0 }, day: before };
  }
  const delta = reading - before.applied;
  return {
    detail: { ...base, multiplier, reading, zeroBecause, delta },
    day: { day: today, peakSigma: input.sigma, applied: reading },
  };
}

/** True for a news_volume_24h metric signal (the metric the tune replaces), with its sigma. */
export function newsVolumeSigma(payload: ScoredSignal["signal"]["rawPayload"], config: NewsVolumeConfig): number | null {
  const metric = readMetricPayload(payload);
  return metric && metric.metric === config.metric ? metric.sigma : null;
}

function isArticle(payload: unknown): boolean {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).kind === "article";
}

/**
 * Applies the tune to one person's scored signals: every news-volume firing
 * in the tick, in time order, takes the rule's delta as its impact, each
 * updating the day's state for the next. The window's stories are the ones
 * the store loaded plus the articles this very tick scored for the person,
 * so a surge and its stories arriving together are read together. Signals
 * that are not the metric are returned untouched.
 */
export function tuneNewsVolume(scored: ScoredSignal[], context: NewsVolumeContext | undefined, config: NewsVolumeConfig): ScoredSignal[] {
  const firings = scored
    .map((entry, index) => ({ entry, index, sigma: newsVolumeSigma(entry.signal.rawPayload, config) }))
    .filter((item): item is { entry: ScoredSignal; index: number; sigma: number } => item.sigma !== null)
    .sort((a, b) => a.entry.signal.occurredAt.getTime() - b.entry.signal.occurredAt.getTime() || a.entry.signal.id.localeCompare(b.entry.signal.id));
  if (firings.length === 0) return scored;

  const stories: WindowStory[] = [
    ...(context?.stories ?? []),
    ...scored
      .filter((entry) => entry.impact !== 0 && isArticle(entry.signal.rawPayload))
      .map((entry) => ({ occurredAt: entry.signal.occurredAt, impact: entry.impact, confidence: entry.sentiment.confidence })),
  ];

  const out = [...scored];
  let day = context?.today ?? null;
  for (const firing of firings) {
    const read = readNewsVolume({ sigma: firing.sigma, at: firing.entry.signal.occurredAt, stories }, day, config);
    day = read.day;
    out[firing.index] = { ...firing.entry, impact: read.detail.delta, newsVolume: read.detail };
  }
  return out;
}

/**
 * The day's state from the person's processed news-volume signals of the
 * UTC day `now` falls in: the largest sigma among them and their impacts
 * summed (each impact was a delta, so the sum is what the day has been
 * given). Null when there are none.
 */
export function dayStateFromSignals(rows: ReadonlyArray<{ sigma: number | null; impact: number; occurredAt: Date }>, now: Date): NewsVolumeDayState | null {
  const today = utcDay(now);
  let peakSigma = Number.NEGATIVE_INFINITY;
  let applied = 0;
  let any = false;
  for (const row of rows) {
    if (utcDay(row.occurredAt) !== today || row.sigma === null || !Number.isFinite(row.sigma)) continue;
    any = true;
    peakSigma = Math.max(peakSigma, row.sigma);
    applied += Number.isFinite(row.impact) ? row.impact : 0;
  }
  return any ? { day: today, peakSigma, applied } : null;
}
