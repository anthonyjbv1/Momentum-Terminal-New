/**
 * THE AGE-MATCHED VIDEO PACE (YOUTUBE_PACE_AGE_MATCHED_ENABLED, 2026-10-09).
 *
 * THE PACE METRIC IT REPLACES. `recent_video_views` is the summed views of
 * the channel's newest ten uploads, read as a relative rate against the sum
 * an hour earlier. The basket changes under it: a new upload enters with a
 * few hours of views and the oldest leaves with weeks of them, so the sum
 * drops by that video's whole count in one poll and the rate reads as a
 * collapse of the channel. MrBeast fired −1.50 (−9.1σ, −12.9σ, −10.9σ,
 * −8.5σ) on 09-18, 09-27, 10-03 and 10-09, each on an upload leaving the
 * basket, and a cluster of ± firings on 09-16 to 09-18 on a new upload
 * entering it. The gap between uploads was being scored, not the videos.
 *
 * THE REPLACEMENT. Each poll records every recent upload's views with its
 * publication time (the per-video ledger, raw_video_view_samples, written
 * whether or not the switch is on, so the day the switch is flipped the
 * ledger already has history). The reading: the NEWEST upload's views at
 * its own age against what the channel's other recent uploads had at that
 * same age (each peer's views linearly interpolated between the two ledger
 * samples that bracket the age; a peer whose ledger does not reach that age
 * is not a peer). The typical is the median over at least `minPeers` peers,
 * and the reading is log2(views / typical): 0 is exactly the channel's
 * usual pace, +1 is twice it, −1 is half. Read as a level metric against
 * its own fortnight (sd floor 0.5: a video at half the usual pace is one
 * unit, the floor keeps a steady channel from reading noise as news). The
 * reading is silent (no metric, no observation) while the newest upload is
 * younger than `minAgeHours` (views in the first hours are a premiere's
 * shape, not a pace) or older than `maxAgeDays` (a fortnight on, the
 * channel's pace is its next upload's), or while fewer than `minPeers`
 * peers reach the age. A video's age is counted from its publication time
 * as the API reports it; an upload the API gives no time for is never the
 * newest and never a peer.
 */

export const VIDEO_PACE_METRIC = "video_pace_age_matched";

/** One ledger row: a video's views as read at one poll. */
export interface VideoViewSample {
  videoId: string;
  publishedAt: Date | null;
  views: number;
  recordedAt: Date;
}

export interface AgeMatchedPaceOptions {
  /** The newest upload is judged only once it is at least this old. */
  minAgeHours: number;
  /** ...and no longer than this: afterwards the channel's pace is its next upload's. */
  maxAgeDays: number;
  /** Peers whose ledger reaches the newest upload's age, for a reading at all. */
  minPeers: number;
}

export const DEFAULT_PACE_OPTIONS: AgeMatchedPaceOptions = { minAgeHours: 6, maxAgeDays: 14, minPeers: 3 };

export interface AgeMatchedPace {
  /** log2(views / typical): 0 is the channel's usual pace at this age. */
  reading: number;
  videoId: string;
  ageHours: number;
  views: number;
  typical: number;
  peers: number;
  /** The peers' interpolated views at the age, for the log. */
  peerViews: number[];
}

const HOUR_MS = 3_600_000;

/**
 * THE LEDGER-READY REMINDER (2026-10-09), for the health check, like the
 * baseline-cut reminder: the switch goes on only once the ledger holds two
 * weeks (the peers must reach the newest upload's age), and nothing marks
 * the day on its own. The ledger began with the migration of 2026-10-09
 * 17:45 UTC; its first row says exactly when.
 */
export const PACE_LEDGER_DAYS = 14;
export const PACE_LEDGER_MIGRATED_AT = new Date("2026-10-09T17:45:00.000Z");

export interface VideoPaceStatus {
  switchOn: boolean;
  /** The ledger's first row, or the migration when it has none yet. */
  ledgerSince: string;
  ledgerHasRows: boolean;
  /** When the ledger holds two weeks: ledgerSince plus PACE_LEDGER_DAYS. */
  readyOn: string;
  ready: boolean;
  warnings: string[];
}

export function videoPaceStatus(input: { firstRecordedAt: Date | null; switchOn: boolean }, now: Date): VideoPaceStatus {
  const since = input.firstRecordedAt ?? PACE_LEDGER_MIGRATED_AT;
  const readyOn = new Date(since.getTime() + PACE_LEDGER_DAYS * 24 * HOUR_MS);
  const ready = now.getTime() >= readyOn.getTime();
  const warnings: string[] = [];
  if (!input.switchOn) {
    warnings.push(
      ready
        ? `youtube.${VIDEO_PACE_METRIC}: the ledger has held ${PACE_LEDGER_DAYS} days since ${readyOn.toISOString()}; replay the window from it, then set YOUTUBE_PACE_AGE_MATCHED_ENABLED=true`
        : `youtube.${VIDEO_PACE_METRIC}: ledger since ${since.toISOString()}${input.firstRecordedAt ? "" : " (the migration; no row yet)"}, ${PACE_LEDGER_DAYS} days of history on ${readyOn.toISOString()}; YOUTUBE_PACE_AGE_MATCHED_ENABLED stays off until then`,
    );
  }
  return { switchOn: input.switchOn, ledgerSince: since.toISOString(), ledgerHasRows: input.firstRecordedAt !== null, readyOn: readyOn.toISOString(), ready, warnings };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A video's views at `ageHours`, linearly interpolated between the two samples that bracket it; null when its ledger does not reach that age on both sides. */
export function viewsAtAge(samples: readonly VideoViewSample[], ageHours: number): number | null {
  const points = samples
    .filter((sample) => sample.publishedAt !== null && Number.isFinite(sample.views))
    .map((sample) => ({ age: (sample.recordedAt.getTime() - (sample.publishedAt as Date).getTime()) / HOUR_MS, views: sample.views }))
    .filter((point) => point.age >= 0)
    .sort((a, b) => a.age - b.age);
  if (points.length === 0) return null;
  const exact = points.find((point) => point.age === ageHours);
  if (exact) return exact.views;
  const below = [...points].reverse().find((point) => point.age < ageHours);
  const above = points.find((point) => point.age > ageHours);
  if (!below || !above) return null;
  const span = above.age - below.age;
  return span > 0 ? below.views + ((above.views - below.views) * (ageHours - below.age)) / span : below.views;
}

/**
 * The reading from the ledger (every sample of the channel's recent uploads,
 * the current poll's included) at `now`, or null when it is silent. The
 * newest upload is the one with the latest publication time; its views are
 * its newest sample's.
 */
export function ageMatchedPace(samples: readonly VideoViewSample[], now: Date, options: AgeMatchedPaceOptions = DEFAULT_PACE_OPTIONS): AgeMatchedPace | null {
  const byVideo = new Map<string, VideoViewSample[]>();
  for (const sample of samples) {
    if (sample.publishedAt === null) continue;
    byVideo.set(sample.videoId, [...(byVideo.get(sample.videoId) ?? []), sample]);
  }
  if (byVideo.size === 0) return null;
  const published = (id: string) => (byVideo.get(id)![0].publishedAt as Date).getTime();
  const newestId = [...byVideo.keys()].sort((a, b) => published(b) - published(a) || a.localeCompare(b))[0];
  const ageHours = (now.getTime() - published(newestId)) / HOUR_MS;
  if (ageHours < options.minAgeHours || ageHours > options.maxAgeDays * 24) return null;
  const latest = [...byVideo.get(newestId)!].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0];
  if (!(latest.views >= 0)) return null;

  const peerViews: number[] = [];
  for (const [videoId, history] of byVideo) {
    if (videoId === newestId || published(videoId) >= published(newestId)) continue;
    const at = viewsAtAge(history, ageHours);
    if (at !== null && at > 0) peerViews.push(at);
  }
  if (peerViews.length < options.minPeers) return null;
  const typical = median(peerViews);
  if (!(typical > 0)) return null;
  const reading = Math.log2(Math.max(latest.views, 1) / typical);
  return { reading: Math.round(reading * 1000) / 1000, videoId: newestId, ageHours: Math.round(ageHours * 10) / 10, views: latest.views, typical: Math.round(typical), peers: peerViews.length, peerViews: peerViews.map((v) => Math.round(v)) };
}
