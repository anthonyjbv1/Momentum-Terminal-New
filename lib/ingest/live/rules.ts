import type { LiveStream, RawSignal } from "@/lib/connectors/types";
import { LIVE_MOMENT_KIND } from "@/lib/engine/sentiment/prescored";
import { clamp } from "@/lib/engine/math";
import type { Json } from "@/types/database";

/**
 * LIVE MODE, THE RULES (Phase 16). Pure: what a session is, what is sampled
 * into it, and what one sample means against the session itself.
 *
 * THE PHASE 10 OBJECTION, AND WHERE IT STOPS. Phase 10 refused concurrent
 * viewers as an hourly METRIC because a reading taken at whatever minute the
 * cron fired has a distribution driven by the online/offline mixture, and
 * its sigma describes the schedule, not the person. That objection is about
 * comparing a moment against a fortnight of other moments. It does not apply
 * to comparing a session against ITSELF, sampled on a fixed cadence from its
 * start: "up 18% in ten minutes" is a statement about this broadcast, and the
 * two samples it is made from were taken the same way as every other.
 *
 * So the within-session facts are EVENTS, not metrics:
 *
 *   audience_surge   the audience is up by at least surgeFraction against
 *                    the sample deltaWindowMinutes earlier, after the
 *                    session's warm-up (the first minutes of any stream are
 *                    a ramp and would read as a surge every time), at or
 *                    above minViewers (a channel of forty going to fifty is
 *                    noise), at most once per cooldownMinutes per session
 *   audience_drop    the mirror, OFF by default (dropFraction null): a
 *                    ten-minute loss is most often the stream winding down
 *                    or a raid moving on, and the stream's end is detected
 *                    separately; the drop is recorded on the session either
 *                    way, and can be switched on per source or per person
 *   clip_burst       clips created in the trailing clipWindowMinutes, as a
 *                    rate, at burstMultiple times the session's own rate so
 *                    far (floored at floorClipsPerHour so a slow start
 *                    cannot make any pace a burst), with at least
 *                    burstMinClips in the window; once per cooldown
 *
 * Each carries a DECLARED direction and a confidence from its magnitude
 * (fraction / fullConfidenceFraction, (multiple − 1) / (fullConfidenceMultiple
 * − 1), both bounded to 1), scored by the Engine's prescored scorer without
 * a model call, and aged like any event. There is no sigma anywhere in
 * this: a session of thirty samples is one ramp-and-decay curve, and its
 * standard deviation would describe how long the stream ran, not how
 * unusual a moment was. The fraction is the honest unit.
 *
 * What IS a metric: the session as a whole, once, when it ends. Peak
 * concurrent viewers per session and clips per stream hour per session are
 * per-session aggregates sampled once per session, and a session is the
 * person's own choice of when and how long to stream. Judged against the
 * person's trailing sessions through the ordinary metric pipeline, their
 * sigma describes how big and how clippable this stream was for THEM, and
 * a two-minute sampling cadence moves the peak by less than the difference
 * between any two sessions. Only a COMPLETE session feeds them: one watched
 * from within startGraceMinutes of its start with no gap in the samples
 * longer than maxGapMinutes, so a session joined late or half-watched
 * through an outage cannot write a false low into the baseline.
 *
 * Not registered, on purpose: the session's average viewers (redundant with
 * the peak), peak-to-average and time-to-peak (they describe the stream's
 * format and length before they describe the person), and category
 * switches (a switch has no direction). All four are recorded on the
 * session row and said in the session's summary event.
 */

export interface LiveConfig {
  enabled: boolean;
  /** How often a live broadcaster is sampled, in minutes: 1 to 5. */
  sampleIntervalMinutes: number;
  /** No moment fires inside the first minutes of a session: every stream ramps. */
  warmupMinutes: number;
  /** The audience delta is measured against the sample this many minutes earlier. */
  deltaWindowMinutes: number;
  /** Fractional rise over the window that is a surge. */
  surgeFraction: number;
  /** Fractional fall over the window that is a drop; null switches drops off. */
  dropFraction: number | null;
  /** Neither end of the delta counts below this audience. */
  minViewers: number;
  /** The fraction at which a surge or drop reads at confidence 1. */
  fullConfidenceFraction: number;
  /** Minutes between two moments of one kind in one session. */
  cooldownMinutes: number;
  /** Clips are counted up to this many minutes behind now, for Helix to have indexed them. */
  clipLagMinutes: number;
  /** The trailing window the clip rate is measured over. */
  clipWindowMinutes: number;
  /** The trailing rate as a multiple of the session's rate that is a burst. */
  burstMultiple: number;
  /** Clips in the window below which nothing is a burst. */
  burstMinClips: number;
  /** The session rate is floored here, in clips per hour, before the multiple is taken. */
  floorClipsPerHour: number;
  /** The multiple at which a burst reads at confidence 1. */
  fullConfidenceMultiple: number;
  /** Consecutive checks that do not list the broadcaster before the session is closed. */
  endAfterMissedChecks: number;
  /** A session first seen more than this many minutes after it began was joined late: incomplete. */
  startGraceMinutes: number;
  /** A gap between samples longer than this makes the session incomplete. */
  maxGapMinutes: number;
  /** Pages of clips read per window before the count is a floor. */
  clipMaxPages: number;
  /** The Phase 31 quality rules, present only while SIGNAL_QUALITY_ENABLED is on (see withLiveQuality). */
  quality?: LiveQualityRules;
}

export const DEFAULT_LIVE_CONFIG: Omit<LiveConfig, "enabled"> = {
  sampleIntervalMinutes: 2,
  warmupMinutes: 20,
  deltaWindowMinutes: 10,
  surgeFraction: 0.2,
  dropFraction: null,
  minViewers: 500,
  fullConfidenceFraction: 0.5,
  cooldownMinutes: 30,
  clipLagMinutes: 2,
  clipWindowMinutes: 10,
  burstMultiple: 3,
  burstMinClips: 5,
  floorClipsPerHour: 6,
  fullConfidenceMultiple: 6,
  endAfterMissedChecks: 2,
  startGraceMinutes: 5,
  maxGapMinutes: 6,
  clipMaxPages: 3,
};

export const MIN_SAMPLE_INTERVAL_MINUTES = 1;
export const MAX_SAMPLE_INTERVAL_MINUTES = 5;

/**
 * THE QUALITY RULES (Phase 31 switch, from Kai Cenat's stream of 2026-09-26).
 * That session fired four audience surges and a clip burst; one of the five
 * was real. The ramp read as a surge at minute 20, two single readings that
 * reverted within minutes read as surges, and the burst compared 12 clips in
 * ten minutes with a session pace of two clips in eight. What the session
 * showed, and what each rule answers:
 *
 *   Helix refreshes viewer_count about every four minutes: 117 of 214
 *   samples repeated the one before. Sampling every two minutes reads the
 *   same number twice, so the quality cadence is four minutes.
 *
 *   A single reading is not a level, and a base half an hour back cannot
 *   tell a step from a climb. A surge is a STEP: the mean audience of the
 *   last stepWindowMinutes (AFTER, which must hold at least
 *   minRecentDistinct different readings, so one stale number repeated
 *   cannot stand for the present) against the mean of the stepWindowMinutes
 *   before that (BEFORE, at least minBeforeSamples samples), at stepFraction.
 *   Replayed on 2026-09-26 at both sampling phases, the smoothed rule it
 *   replaced (the last five minutes against 30 to 60 minutes back, at 20%)
 *   fired nothing, the real step included (+19.8% at its peak), and lowered
 *   to fire on the step it fired first on the two-hour climb from 31,000 to
 *   38,000, which read +20.8% and +21.8% at minutes 92 and 110. Ten minutes
 *   against the ten before reads the climb at most +11.5% (minutes 80 and
 *   150) and the minute-248 step +15% to +16%: stepFraction sits between.
 *   Nothing is judged before judgeFromMinutes, and BEFORE never takes a
 *   sample from the session's warm-up (warmupMinutes): a before window that
 *   averaged the ramp in would read the plateau after it as a surge (the
 *   replay of 2026-09-26 did exactly that until this was added).
 *
 *   Clip rates divide by the span the counted windows actually cover. The
 *   Phase 16 rule counts every window reaching into the trailing minutes but
 *   divides by the trailing minutes alone; at four-minute windows that
 *   overstated a 2.8× hour as 3.7× in the same replay.
 *
 *   A surge must hold: the step is read at the previous sample, and this
 *   sample's own reading must still clear stepFraction against that step's
 *   BEFORE; the moment is stamped at the confirmation. The next sample's step
 *   is not the confirmation: the step walks through the AFTER window in ten
 *   minutes and clears the threshold for one or two samples at most (on
 *   2026-09-26 at the odd phase, +11.7% then +15.0%, then +6.5% as the new
 *   level enters BEFORE), and a single spike sits in two consecutive AFTER
 *   windows and would confirm itself.
 *
 *   Once the person has shapeMinSessions complete sessions that reached this
 *   point of a stream, the recent audience must also clear their usual
 *   audience at this elapsed minute (the median across sessions of the mean
 *   in the same shapeBucketMinutes bucket) by shapeFraction. Off until then:
 *   one session is not a shape.
 *
 *   At most maxSurgesPerSession surges a session, surgeCooldownMinutes
 *   apart, every one after the first at laterSurgeConfidenceFactor.
 *
 *   Confidence reads from the threshold, not from zero: a step exactly at
 *   stepFraction is confidence 0 and fullConfidenceStepFraction is 1 (decided
 *   2026-09-28: +20% above the level before the step, not the source row's
 *   +50%, which was set for a 20% threshold and read the 09-26 step of +12.7%
 *   as 0.018; to be revisited once the person has five complete sessions and
 *   the session shape turns on). Clip bursts the same, from burstMultiple to
 *   fullConfidenceMultiple.
 *
 *   Two readings are the minimum (decided 2026-09-28): the step read at the
 *   previous sample and this sample's own reading holding it, eight minutes
 *   apart at the four-minute cadence. A rise that holds two readings and then
 *   reverts is a confirmed step under this rule, by acceptance. The
 *   confidence is read from the STRONGER of those two readings (2026-09-29),
 *   so the sampling phase decides less of it; the threshold, the confirmation,
 *   the caps and the warm-up are unchanged.
 *
 *   A clip burst needs burstMinSessionMinutes of session and
 *   burstMinPriorClips clips before the window, at least burstMinClips in the
 *   window, and is measured against the largest of the session's own pace,
 *   the person's usual clips per stream hour (the median of the per-session
 *   metric once usualClipsMinSessions exist) or, until then, a floor that
 *   scales with the audience (clipsPerHourPerThousandViewers per thousand of
 *   the session's average viewers). One burst a session.
 */
export interface LiveQualityRules {
  sampleIntervalMinutes: number;
  /** A gap longer than this makes the session incomplete (the cadence doubled, so the tolerance does too). */
  maxGapMinutes: number;
  /** The AFTER window and the BEFORE window, each this long. */
  stepWindowMinutes: number;
  /** Different readings AFTER must hold. */
  minRecentDistinct: number;
  /** Samples BEFORE must hold. */
  minBeforeSamples: number;
  /** The rise of AFTER over BEFORE that is a surge (replaces the source row's surgeFraction under the switch). */
  stepFraction: number;
  /** The rise at which a surge is full confidence (replaces the source row's fullConfidenceFraction under the switch). */
  fullConfidenceStepFraction: number;
  /** Nothing is judged before this minute of the session. */
  judgeFromMinutes: number;
  shapeMinSessions: number;
  /** How many of the person's newest complete sessions the shape reads. */
  shapeSessions: number;
  shapeBucketMinutes: number;
  shapeFraction: number;
  maxSurgesPerSession: number;
  surgeCooldownMinutes: number;
  laterSurgeConfidenceFactor: number;
  burstMinSessionMinutes: number;
  burstMinPriorClips: number;
  burstMinClips: number;
  maxBurstsPerSession: number;
  clipsPerHourPerThousandViewers: number;
  usualClipsMinSessions: number;
  /** The window the usual clips per stream hour is read over. */
  usualClipsWindowHours: number;
}

export const LIVE_QUALITY_DEFAULTS: LiveQualityRules = {
  sampleIntervalMinutes: 4,
  maxGapMinutes: 10,
  stepWindowMinutes: 10,
  minRecentDistinct: 2,
  minBeforeSamples: 2,
  stepFraction: 0.12,
  fullConfidenceStepFraction: 0.2,
  judgeFromMinutes: 60,
  shapeMinSessions: 5,
  shapeSessions: 10,
  shapeBucketMinutes: 10,
  shapeFraction: 0.15,
  maxSurgesPerSession: 2,
  surgeCooldownMinutes: 60,
  laterSurgeConfidenceFactor: 0.5,
  burstMinSessionMinutes: 60,
  burstMinPriorClips: 30,
  burstMinClips: 15,
  maxBurstsPerSession: 1,
  clipsPerHourPerThousandViewers: 1,
  usualClipsMinSessions: 5,
  usualClipsWindowHours: 720,
};

/** The live config with the quality rules laid over it; unchanged when they are off. */
export function withLiveQuality(config: LiveConfig, quality: LiveQualityRules | undefined): LiveConfig {
  if (!quality) return config;
  return {
    ...config,
    sampleIntervalMinutes: clamp(quality.sampleIntervalMinutes, MIN_SAMPLE_INTERVAL_MINUTES, MAX_SAMPLE_INTERVAL_MINUTES),
    maxGapMinutes: quality.maxGapMinutes,
    quality,
  };
}

type Config = Record<string, Json | undefined>;

function block(config: Config | undefined): Config | null {
  const live = config?.live;
  return live !== null && live !== undefined && typeof live === "object" && !Array.isArray(live) ? (live as Config) : null;
}

function number(value: Json | undefined, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function integer(value: Json | undefined, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback;
}

/**
 * The live block of a source's config, with the person's own block (their
 * mapping's config.live) layered over it. Null when the source declares no
 * live mode, or declares it off. The sample interval is bounded to 1–5
 * minutes whatever either says.
 */
export function readLiveConfig(sourceConfig: Config | undefined, personConfig?: Config | undefined): LiveConfig | null {
  const source = block(sourceConfig);
  if (!source || source.enabled !== true) return null;
  const person = block(personConfig) ?? {};
  const pick = (key: string): Json | undefined => (person[key] !== undefined ? person[key] : source[key]);
  const d = DEFAULT_LIVE_CONFIG;
  const drop = pick("drop_fraction");
  return {
    enabled: true,
    sampleIntervalMinutes: clamp(number(pick("sample_interval_minutes"), d.sampleIntervalMinutes, 0.01), MIN_SAMPLE_INTERVAL_MINUTES, MAX_SAMPLE_INTERVAL_MINUTES),
    warmupMinutes: number(pick("warmup_minutes"), d.warmupMinutes),
    deltaWindowMinutes: number(pick("delta_window_minutes"), d.deltaWindowMinutes, 1),
    surgeFraction: number(pick("surge_fraction"), d.surgeFraction, 0.01),
    dropFraction: typeof drop === "number" && Number.isFinite(drop) && drop >= 0.01 ? drop : null,
    minViewers: number(pick("min_viewers"), d.minViewers),
    fullConfidenceFraction: number(pick("full_confidence_fraction"), d.fullConfidenceFraction, 0.01),
    cooldownMinutes: number(pick("cooldown_minutes"), d.cooldownMinutes),
    clipLagMinutes: number(pick("clip_lag_minutes"), d.clipLagMinutes),
    clipWindowMinutes: number(pick("clip_window_minutes"), d.clipWindowMinutes, 1),
    burstMultiple: number(pick("burst_multiple"), d.burstMultiple, 1.01),
    burstMinClips: integer(pick("burst_min_clips"), d.burstMinClips, 1),
    floorClipsPerHour: number(pick("floor_clips_per_hour"), d.floorClipsPerHour),
    fullConfidenceMultiple: number(pick("full_confidence_multiple"), d.fullConfidenceMultiple, 1.01),
    endAfterMissedChecks: integer(pick("end_after_missed_checks"), d.endAfterMissedChecks, 1),
    startGraceMinutes: number(pick("start_grace_minutes"), d.startGraceMinutes),
    maxGapMinutes: number(pick("max_gap_minutes"), d.maxGapMinutes, 1),
    clipMaxPages: integer(pick("clip_max_pages"), d.clipMaxPages, 1),
  };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** One broadcast being followed: per broadcaster, per stream id. */
export interface LiveSession {
  id: string;
  personId: string;
  dataSourceId: string;
  streamId: string;
  broadcasterId: string;
  channel: string;
  /** When the platform says the broadcast began. */
  startedAt: Date;
  /** The first check that listed it. */
  firstSeenAt: Date;
  /** The last check that listed it. */
  lastSeenAt: Date;
  lastSampledAt: Date | null;
  endedAt: Date | null;
  /** Consecutive checks that did not list it. */
  missedChecks: number;
  /** Watched from the start with no gap: only a complete session feeds the session metrics. */
  complete: boolean;
  sampleCount: number;
  viewerSum: number;
  viewerLatest: number | null;
  viewerPeak: number | null;
  peakAt: Date | null;
  categoryLatest: string | null;
  categorySwitches: number;
  titleLatest: string | null;
  clipsTotal: number;
  /** Clips are counted up to here; the next window starts here. */
  clipsCountedTo: Date | null;
  lastSurgeAt: Date | null;
  lastDropAt: Date | null;
  lastBurstAt: Date | null;
  /** The largest ten-minute fall seen, recorded whether or not drops emit. */
  largestDropFraction: number | null;
  signalsCreated: number;
}

/** One sample of a session. */
export interface LiveSample {
  sessionId: string;
  sampledAt: Date;
  viewerCount: number | null;
  category: string | null;
  title: string | null;
  clipsWindowFrom: Date | null;
  clipsWindowTo: Date | null;
  clipsInWindow: number;
  clipsTruncated: boolean;
  latencyMs: number | null;
  status: "ok" | "error";
  error: string | null;
  signalsCreated: number;
}

const MINUTE = 60_000;

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MINUTE;
}

/** A session is sampled when its interval has passed, with half a minute of grace for the cron's jitter. */
export function sampleDue(session: Pick<LiveSession, "lastSampledAt">, now: Date, config: LiveConfig): boolean {
  if (!session.lastSampledAt) return true;
  return minutesBetween(session.lastSampledAt, now) >= config.sampleIntervalMinutes - 0.5;
}

/** A session opened now, from the stream as the platform reports it. */
export function openSession(input: { personId: string; dataSourceId: string; stream: LiveStream; now: Date; config: LiveConfig }): Omit<LiveSession, "id"> {
  const { personId, dataSourceId, stream, now, config } = input;
  const startedAt = stream.startedAt ?? now;
  return {
    personId,
    dataSourceId,
    streamId: stream.id,
    broadcasterId: stream.broadcasterId,
    channel: stream.channel,
    startedAt,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSampledAt: null,
    endedAt: null,
    missedChecks: 0,
    // Joined more than the grace after it began: what happened before is unknown.
    complete: minutesBetween(startedAt, now) <= config.startGraceMinutes,
    sampleCount: 0,
    viewerSum: 0,
    viewerLatest: null,
    viewerPeak: null,
    peakAt: null,
    categoryLatest: null,
    categorySwitches: 0,
    titleLatest: null,
    clipsTotal: 0,
    clipsCountedTo: null,
    lastSurgeAt: null,
    lastDropAt: null,
    lastBurstAt: null,
    largestDropFraction: null,
    signalsCreated: 0,
  };
}

/** The clip window this sample counts: from where the last one stopped (or the session's observed start) to now less the lag. Null when it would be empty. */
export function clipWindow(session: Pick<LiveSession, "clipsCountedTo" | "startedAt" | "firstSeenAt" | "complete">, now: Date, config: LiveConfig): { from: Date; to: Date } | null {
  const from = session.clipsCountedTo ?? (session.complete ? session.startedAt : session.firstSeenAt);
  const to = new Date(now.getTime() - config.clipLagMinutes * MINUTE);
  return to.getTime() > from.getTime() ? { from, to } : null;
}

/** The session with one sample folded in: counts, peak, category switches, the clip window advanced. */
export function applySample(session: LiveSession, sample: { now: Date; stream: LiveStream; clips: { from: Date; to: Date; count: number } | null }, config: LiveConfig): LiveSession {
  const { now, stream, clips } = sample;
  const viewers = stream.viewerCount;
  const gap = session.lastSampledAt ? minutesBetween(session.lastSampledAt, now) : 0;
  const next: LiveSession = {
    ...session,
    lastSeenAt: now,
    lastSampledAt: now,
    missedChecks: 0,
    complete: session.complete && gap <= config.maxGapMinutes,
    sampleCount: session.sampleCount + 1,
    viewerSum: session.viewerSum + (viewers ?? 0),
    viewerLatest: viewers,
    titleLatest: stream.title,
    categoryLatest: stream.category,
    categorySwitches: session.categorySwitches + (session.categoryLatest !== null && stream.category !== null && stream.category !== session.categoryLatest ? 1 : 0),
  };
  if (viewers !== null && (session.viewerPeak === null || viewers > session.viewerPeak)) {
    next.viewerPeak = viewers;
    next.peakAt = now;
  }
  if (clips) {
    next.clipsTotal = session.clipsTotal + clips.count;
    next.clipsCountedTo = clips.to;
  }
  return next;
}

// ---------------------------------------------------------------------------
// The moments
// ---------------------------------------------------------------------------

export type LiveMomentKind = "audience_surge" | "audience_drop" | "clip_burst";

export interface LiveMoment {
  moment: LiveMomentKind;
  direction: 1 | -1;
  confidence: number;
  /** The fraction (surge, drop) or the multiple (burst). */
  magnitude: number;
  /** Minutes the comparison spans. */
  windowMinutes: number;
  /** Surge / drop: the two audiences. Burst: clips in the window and the session's rate. */
  from: number;
  to: number;
  rationale: string;
  /** "quality" when the Phase 31 rules judged it; absent for the Phase 16 rules. */
  rule?: "quality";
}

function past(at: Date | null, now: Date, minutes: number): boolean {
  return at === null || minutesBetween(at, now) >= minutes;
}

/** The audience delta against the sample at least deltaWindowMinutes back, or null when no such sample exists yet. */
export function audienceDelta(samples: Array<Pick<LiveSample, "sampledAt" | "viewerCount">>, current: { sampledAt: Date; viewerCount: number | null }, config: LiveConfig): { from: number; to: number; fraction: number; minutes: number } | null {
  if (current.viewerCount === null) return null;
  const reference = samples
    .filter((sample) => sample.viewerCount !== null && minutesBetween(sample.sampledAt, current.sampledAt) >= config.deltaWindowMinutes)
    .sort((a, b) => b.sampledAt.getTime() - a.sampledAt.getTime())[0];
  if (!reference || reference.viewerCount === null || reference.viewerCount <= 0) return null;
  const minutes = minutesBetween(reference.sampledAt, current.sampledAt);
  return { from: reference.viewerCount, to: current.viewerCount, fraction: (current.viewerCount - reference.viewerCount) / reference.viewerCount, minutes };
}

/** A surge or a drop, judged against the session itself; null when this sample is not one. */
export function audienceMoment(session: LiveSession, samples: Array<Pick<LiveSample, "sampledAt" | "viewerCount">>, current: { sampledAt: Date; viewerCount: number | null }, config: LiveConfig): LiveMoment | null {
  if (minutesBetween(session.startedAt, current.sampledAt) < config.warmupMinutes) return null;
  const delta = audienceDelta(samples, current, config);
  if (!delta || Math.max(delta.from, delta.to) < config.minViewers) return null;
  const minutes = Math.round(delta.minutes);
  if (delta.fraction >= config.surgeFraction && past(session.lastSurgeAt, current.sampledAt, config.cooldownMinutes)) {
    return {
      moment: "audience_surge",
      direction: 1,
      confidence: round3(clamp(delta.fraction / config.fullConfidenceFraction, 0, 1)),
      magnitude: round3(delta.fraction),
      windowMinutes: minutes,
      from: delta.from,
      to: delta.to,
      rationale: `audience ${delta.from.toLocaleString("en-US")} → ${delta.to.toLocaleString("en-US")} over ${minutes} min (+${Math.round(delta.fraction * 100)}%), threshold +${Math.round(config.surgeFraction * 100)}%`,
    };
  }
  if (config.dropFraction !== null && -delta.fraction >= config.dropFraction && past(session.lastDropAt, current.sampledAt, config.cooldownMinutes)) {
    return {
      moment: "audience_drop",
      direction: -1,
      confidence: round3(clamp(-delta.fraction / config.fullConfidenceFraction, 0, 1)),
      magnitude: round3(delta.fraction),
      windowMinutes: minutes,
      from: delta.from,
      to: delta.to,
      rationale: `audience ${delta.from.toLocaleString("en-US")} → ${delta.to.toLocaleString("en-US")} over ${minutes} min (${Math.round(delta.fraction * 100)}%), threshold −${Math.round(config.dropFraction * 100)}%`,
    };
  }
  return null;
}

/** The trailing clip rate against the session's own, with the floor; null when there is no window to judge or nothing to judge it against. */
export function clipRate(
  session: Pick<LiveSession, "startedAt" | "clipsTotal" | "clipsCountedTo">,
  samples: Array<Pick<LiveSample, "clipsWindowFrom" | "clipsWindowTo" | "clipsInWindow">>,
  current: { from: Date; to: Date; count: number },
  config: LiveConfig,
  options: { exactSpan?: boolean } = {},
): { trailingClips: number; trailingHours: number; trailingPerHour: number; priorClips: number; sessionPerHour: number; baselinePerHour: number; multiple: number } | null {
  const windowStart = current.to.getTime() - config.clipWindowMinutes * MINUTE;
  const windows = [
    ...samples.filter((sample) => sample.clipsWindowFrom && sample.clipsWindowTo && sample.clipsWindowTo.getTime() > windowStart).map((sample) => ({ from: sample.clipsWindowFrom!, to: sample.clipsWindowTo!, count: sample.clipsInWindow })),
    current,
  ];
  // Every window that reaches into the trailing minutes is counted WHOLE. The
  // Phase 16 rule divides by the trailing minutes alone, which overstates the
  // rate by the part of the oldest window that falls before them: a little at
  // two-minute windows, up to a third at four. exactSpan (the quality rules)
  // divides by the span the counted windows actually cover.
  const oldest = Math.min(...windows.map((window) => window.from.getTime()));
  const earliest = options.exactSpan ? oldest : Math.max(windowStart, oldest);
  const trailingHours = (current.to.getTime() - earliest) / 3_600_000;
  if (!(trailingHours > 0)) return null;
  const trailingClips = windows.reduce((sum, window) => sum + window.count, 0);
  const sessionHours = (current.to.getTime() - session.startedAt.getTime()) / 3_600_000;
  if (!(sessionHours > 0)) return null;
  // The session's pace BEFORE the trailing window, so a burst is not compared with itself.
  const priorHours = sessionHours - trailingHours;
  const priorClips = Math.max(0, session.clipsTotal + current.count - trailingClips);
  const sessionPerHour = priorHours > 1 / 60 ? priorClips / priorHours : 0;
  const baselinePerHour = Math.max(sessionPerHour, config.floorClipsPerHour);
  const trailingPerHour = trailingClips / trailingHours;
  return { trailingClips, trailingHours, trailingPerHour, priorClips, sessionPerHour, baselinePerHour, multiple: baselinePerHour > 0 ? trailingPerHour / baselinePerHour : 0 };
}

/** A burst of clips, judged against the session's own pace; null when this window is not one. */
export function clipMoment(session: LiveSession, samples: Array<Pick<LiveSample, "clipsWindowFrom" | "clipsWindowTo" | "clipsInWindow">>, current: { from: Date; to: Date; count: number }, now: Date, config: LiveConfig): LiveMoment | null {
  if (minutesBetween(session.startedAt, now) < config.warmupMinutes) return null;
  if (!past(session.lastBurstAt, now, config.cooldownMinutes)) return null;
  const rate = clipRate(session, samples, current, config);
  if (!rate || rate.trailingClips < config.burstMinClips || rate.multiple < config.burstMultiple) return null;
  return {
    moment: "clip_burst",
    direction: 1,
    confidence: round3(clamp((rate.multiple - 1) / (config.fullConfidenceMultiple - 1), 0, 1)),
    magnitude: round3(rate.multiple),
    windowMinutes: Math.round(rate.trailingHours * 60),
    from: Math.round(rate.baselinePerHour * 10) / 10,
    to: Math.round(rate.trailingPerHour * 10) / 10,
    rationale: `${rate.trailingClips} clips in ${Math.round(rate.trailingHours * 60)} min (${rate.trailingPerHour.toFixed(1)}/h) against the session's ${rate.sessionPerHour.toFixed(1)}/h (floor ${config.floorClipsPerHour}/h): ${rate.multiple.toFixed(1)}×, threshold ${config.burstMultiple}×`,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// The moments under the quality rules (Phase 31 switch)
// ---------------------------------------------------------------------------

/** Confidence read from the threshold: 0 at the threshold, 1 at `full`. */
export function confidenceAboveThreshold(value: number, threshold: number, full: number): number {
  if (!(full > threshold)) return value >= threshold ? 1 : 0;
  return round3(clamp((value - threshold) / (full - threshold), 0, 1));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface StepAudience {
  /** Mean of the samples in the last stepWindowMinutes. */
  after: number;
  /** Mean of the samples in the stepWindowMinutes before that. */
  before: number;
  fraction: number;
  afterReadings: number;
  afterDistinct: number;
  beforeSamples: number;
}

/**
 * The audience of the last stepWindowMinutes at `at` against the
 * stepWindowMinutes before them, or null when either window cannot be
 * judged: AFTER holds fewer than minRecentDistinct different readings (a
 * number Helix has not refreshed is one reading however often it is read),
 * or BEFORE holds fewer than minBeforeSamples. BEFORE samples taken before
 * `beforeNotBefore` (the end of the session's warm-up) do not count.
 */
export function stepAudience(samples: Array<Pick<LiveSample, "sampledAt" | "viewerCount">>, at: Date, quality: LiveQualityRules, beforeNotBefore?: Date): StepAudience | null {
  const age = (sample: Pick<LiveSample, "sampledAt">) => minutesBetween(sample.sampledAt, at);
  const counted = samples.filter((sample): sample is Pick<LiveSample, "sampledAt"> & { viewerCount: number } => sample.viewerCount !== null && age(sample) >= 0);
  const after = counted.filter((sample) => age(sample) < quality.stepWindowMinutes).map((sample) => sample.viewerCount);
  const before = counted
    .filter((sample) => age(sample) >= quality.stepWindowMinutes && age(sample) < 2 * quality.stepWindowMinutes && (!beforeNotBefore || sample.sampledAt.getTime() >= beforeNotBefore.getTime()))
    .map((sample) => sample.viewerCount);
  const afterDistinct = new Set(after).size;
  if (afterDistinct < quality.minRecentDistinct || before.length < quality.minBeforeSamples) return null;
  const afterMean = mean(after);
  const beforeMean = mean(before);
  if (!(beforeMean > 0)) return null;
  return { after: afterMean, before: beforeMean, fraction: (afterMean - beforeMean) / beforeMean, afterReadings: after.length, afterDistinct, beforeSamples: before.length };
}

/** The person's usual audience at this point of a stream: one mean per past session in the bucket, then the median. */
export interface SessionShape {
  sessions: number;
  median: number;
  /** Median absolute deviation of the per-session means. */
  spread: number;
  bucketFromMinutes: number;
  bucketToMinutes: number;
}

/** The elapsed-minute bucket a moment at `elapsedMinutes` falls in. */
export function shapeBucket(elapsedMinutes: number, quality: LiveQualityRules): { fromMinutes: number; toMinutes: number } {
  const fromMinutes = Math.floor(Math.max(0, elapsedMinutes) / quality.shapeBucketMinutes) * quality.shapeBucketMinutes;
  return { fromMinutes, toMinutes: fromMinutes + quality.shapeBucketMinutes };
}

/** Null until shapeMinSessions sessions reached this bucket: off until there is a shape. */
export function sessionShape(viewersBySession: number[][], bucket: { fromMinutes: number; toMinutes: number }, quality: LiveQualityRules): SessionShape | null {
  const means = viewersBySession.filter((viewers) => viewers.length > 0).map(mean);
  if (means.length < quality.shapeMinSessions) return null;
  const middle = median(means);
  return { sessions: means.length, median: middle, spread: median(means.map((value) => Math.abs(value - middle))), bucketFromMinutes: bucket.fromMinutes, bucketToMinutes: bucket.toMinutes };
}

/** The person's usual clips per stream hour, from the per-session metric, once usualClipsMinSessions exist. */
export function usualClipsPerHour(perSession: number[], quality: LiveQualityRules): number | null {
  const values = perSession.filter((value) => Number.isFinite(value) && value >= 0);
  return values.length >= quality.usualClipsMinSessions ? median(values) : null;
}

const fmtCount = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * A surge under the quality rules: a step above stepFraction at the previous
 * sample, confirmed by this sample's own reading against that step's BEFORE
 * (stamped now), above the
 * person's usual audience at this minute once a shape exists, inside the
 * per-session cap and the cooldown. Drops keep the Phase 16 rule (off by
 * default).
 */
export function qualitySurgeMoment(
  session: LiveSession,
  samples: Array<Pick<LiveSample, "sampledAt" | "viewerCount">>,
  current: { sampledAt: Date; viewerCount: number | null },
  context: { surgesSoFar: number; shape: SessionShape | null },
  config: LiveConfig,
): LiveMoment | null {
  const quality = config.quality;
  if (!quality || current.viewerCount === null) return null;
  if (minutesBetween(session.startedAt, current.sampledAt) < quality.judgeFromMinutes) return null;
  if (context.surgesSoFar >= quality.maxSurgesPerSession) return null;
  if (!past(session.lastSurgeAt, current.sampledAt, quality.surgeCooldownMinutes)) return null;

  const prior = samples.filter((sample) => sample.sampledAt.getTime() < current.sampledAt.getTime());
  const previous = [...prior].reverse().find((sample) => sample.viewerCount !== null);
  if (!previous) return null;
  const warmedUp = new Date(session.startedAt.getTime() + config.warmupMinutes * MINUTE);
  const step = stepAudience(prior, previous.sampledAt, quality, warmedUp);
  if (step === null || step.fraction < quality.stepFraction || Math.max(step.before, step.after) < config.minViewers) return null;
  // The confirmation is the NEW reading against the level before the step, not
  // the next step: a single spike that reverts would otherwise confirm itself.
  const held = (current.viewerCount - step.before) / step.before;
  if (held < quality.stepFraction) return null;
  // Against the person's usual at this minute, once there is one.
  if (context.shape && step.after < context.shape.median * (1 + quality.shapeFraction)) return null;

  const later = context.surgesSoFar >= 1;
  // Confidence from the STRONGER of the two qualifying readings, the step read
  // and the confirming read, each against the level before the step
  // (2026-09-29): which of the two catches the rise's full height depends on
  // the sampling phase, and on 09-26 the two halves read the one step at
  // +12.7% and +15.0%, applying 0.126 and 0.555. Both readings had to clear
  // the threshold to get here, so nothing fires that did not before.
  const strength = Math.max(step.fraction, held);
  const confidence = round3(confidenceAboveThreshold(strength, quality.stepFraction, quality.fullConfidenceStepFraction) * (later ? quality.laterSurgeConfidenceFactor : 1));
  const shapeNote = context.shape ? `; usual at ${context.shape.bucketFromMinutes}–${context.shape.bucketToMinutes} min ${fmtCount(context.shape.median)} over ${context.shape.sessions} sessions` : "; no session shape yet";
  return {
    moment: "audience_surge",
    direction: 1,
    confidence,
    magnitude: round3(step.fraction),
    windowMinutes: 2 * quality.stepWindowMinutes,
    from: Math.round(step.before),
    to: Math.round(step.after),
    rule: "quality",
    rationale:
      `audience ${fmtCount(step.after)} over ${quality.stepWindowMinutes} min (${step.afterDistinct} readings) against ${fmtCount(step.before)} the ${quality.stepWindowMinutes} min before (+${Math.round(step.fraction * 100)}%), ` +
      `held at the next sample (${fmtCount(current.viewerCount)}, +${Math.round(held * 100)}%), threshold +${Math.round(quality.stepFraction * 100)}%${shapeNote}` +
      (later ? `; surge ${context.surgesSoFar + 1} of the session at ${quality.laterSurgeConfidenceFactor}× confidence` : ""),
  };
}

/** A drop, by the Phase 16 rule; the quality rules leave drops alone (off by default). */
export function dropMoment(session: LiveSession, samples: Array<Pick<LiveSample, "sampledAt" | "viewerCount">>, current: { sampledAt: Date; viewerCount: number | null }, config: LiveConfig): LiveMoment | null {
  const moment = audienceMoment(session, samples, current, { ...config, surgeFraction: Number.POSITIVE_INFINITY });
  return moment?.moment === "audience_drop" ? moment : null;
}

/**
 * A clip burst under the quality rules: an hour of session and thirty clips
 * before the window, fifteen in it, against the largest of the session's
 * pace, the person's usual rate (or, until there is one, a floor that scales
 * with the audience) and the absolute floor; once a session.
 */
export function qualityClipMoment(
  session: LiveSession,
  samples: Array<Pick<LiveSample, "clipsWindowFrom" | "clipsWindowTo" | "clipsInWindow">>,
  current: { from: Date; to: Date; count: number },
  now: Date,
  context: { burstsSoFar: number; usualPerHour: number | null },
  config: LiveConfig,
): LiveMoment | null {
  const quality = config.quality;
  if (!quality) return null;
  if (minutesBetween(session.startedAt, now) < quality.burstMinSessionMinutes) return null;
  if (context.burstsSoFar >= quality.maxBurstsPerSession) return null;
  const rate = clipRate(session, samples, current, config, { exactSpan: true });
  if (!rate || rate.priorClips < quality.burstMinPriorClips || rate.trailingClips < quality.burstMinClips) return null;
  const averageViewers = session.sampleCount > 0 ? session.viewerSum / session.sampleCount : 0;
  const audienceFloor = (averageViewers / 1000) * quality.clipsPerHourPerThousandViewers;
  const reference = context.usualPerHour ?? audienceFloor;
  const basePerHour = Math.max(rate.sessionPerHour, reference, config.floorClipsPerHour);
  const multiple = basePerHour > 0 ? rate.trailingPerHour / basePerHour : 0;
  if (multiple < config.burstMultiple) return null;
  const referenceNote = context.usualPerHour !== null ? `the person's usual ${context.usualPerHour.toFixed(1)}/h` : `the audience floor ${audienceFloor.toFixed(1)}/h (${quality.clipsPerHourPerThousandViewers}/h per 1,000 of ${fmtCount(averageViewers)} average viewers)`;
  return {
    moment: "clip_burst",
    direction: 1,
    confidence: confidenceAboveThreshold(multiple, config.burstMultiple, config.fullConfidenceMultiple),
    magnitude: round3(multiple),
    windowMinutes: Math.round(rate.trailingHours * 60),
    from: Math.round(basePerHour * 10) / 10,
    to: Math.round(rate.trailingPerHour * 10) / 10,
    rule: "quality",
    rationale: `${rate.trailingClips} clips in ${Math.round(rate.trailingHours * 60)} min (${rate.trailingPerHour.toFixed(1)}/h) against ${basePerHour.toFixed(1)}/h, the largest of the session's ${rate.sessionPerHour.toFixed(1)}/h, ${referenceNote} and the floor ${config.floorClipsPerHour}/h: ${multiple.toFixed(1)}×, threshold ${config.burstMultiple}×`,
  };
}

// ---------------------------------------------------------------------------
// The signals
// ---------------------------------------------------------------------------

/** Signal kind of a session's closing summary: an ordinary event the sentiment path reads. */
export const STREAM_SUMMARY_KIND = "stream_summary";

/** "2h 05m into the stream". */
export function describeElapsed(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export function liveMomentSignal(person: { display_name: string }, session: LiveSession, moment: LiveMoment, now: Date, sourceName: string): RawSignal {
  const elapsed = describeElapsed(minutesBetween(session.startedAt, now));
  const possessive = person.display_name.endsWith("s") ? `${person.display_name}'` : `${person.display_name}'s`;
  const quality = moment.rule === "quality";
  const headline =
    moment.moment === "audience_surge"
      ? quality
        ? `${possessive} live audience stepped up ${Math.round(moment.magnitude * 100)}%: ${fmt(moment.to)} viewers over ${moment.windowMinutes / 2} minutes against ${fmt(moment.from)} in the ${moment.windowMinutes / 2} before, and holding, ${elapsed} into the stream.`
        : `${possessive} live audience is up ${Math.round(moment.magnitude * 100)}% in the last ${moment.windowMinutes} minutes, ${fmt(moment.from)} to ${fmt(moment.to)} viewers, ${elapsed} into the stream.`
      : moment.moment === "audience_drop"
        ? `${possessive} live audience is down ${Math.round(-moment.magnitude * 100)}% in the last ${moment.windowMinutes} minutes, ${fmt(moment.from)} to ${fmt(moment.to)} viewers, ${elapsed} into the stream.`
        : quality
          ? `Clips of ${possessive} stream are being made at ${moment.magnitude.toFixed(1)}× the expected pace: ${moment.to} an hour over the last ${moment.windowMinutes} minutes against ${moment.from} expected, ${elapsed} in.`
          : `Clips of ${possessive} stream are being made at ${moment.magnitude.toFixed(1)}× the session's pace: ${moment.to} an hour over the last ${moment.windowMinutes} minutes, ${elapsed} in.`;
  return {
    headline,
    occurredAt: now,
    dedupeKey: `${sourceName}:live:${session.streamId}:${moment.moment}:${now.toISOString()}`,
    rawPayload: {
      kind: LIVE_MOMENT_KIND,
      source: sourceName,
      moment: moment.moment,
      direction: moment.direction,
      confidence: moment.confidence,
      magnitude: moment.magnitude,
      window_minutes: moment.windowMinutes,
      from: moment.from,
      to: moment.to,
      stream_id: session.streamId,
      channel: session.channel,
      minutes_into_stream: Math.round(minutesBetween(session.startedAt, now)),
      rationale: moment.rationale,
      ...(quality ? { rule: "quality" } : {}),
    },
  };
}

export interface SessionAggregates {
  hours: number;
  averageViewers: number | null;
  peakViewers: number | null;
  peakToAverage: number | null;
  timeToPeakMinutes: number | null;
  clipsTotal: number;
  clipsPerHour: number | null;
  categorySwitches: number;
}

/** What a closed session amounts to. */
export function sessionAggregates(session: LiveSession, endedAt: Date): SessionAggregates {
  const hours = Math.max(0, (endedAt.getTime() - session.startedAt.getTime()) / 3_600_000);
  const averageViewers = session.sampleCount > 0 ? session.viewerSum / session.sampleCount : null;
  return {
    hours: Math.round(hours * 1000) / 1000,
    averageViewers: averageViewers === null ? null : Math.round(averageViewers),
    peakViewers: session.viewerPeak,
    peakToAverage: averageViewers && session.viewerPeak !== null && averageViewers > 0 ? Math.round((session.viewerPeak / averageViewers) * 100) / 100 : null,
    timeToPeakMinutes: session.peakAt ? Math.round(minutesBetween(session.startedAt, session.peakAt)) : null,
    clipsTotal: session.clipsTotal,
    clipsPerHour: hours > 0 ? Math.round((session.clipsTotal / hours) * 10) / 10 : null,
    categorySwitches: session.categorySwitches,
  };
}

/** The closing summary: one ordinary event per session, in language the sentiment path reads, with the session's facts. */
export function streamSummarySignal(person: { display_name: string }, session: LiveSession, endedAt: Date, sourceName: string, platform: string): RawSignal {
  const a = sessionAggregates(session, endedAt);
  const possessive = person.display_name.endsWith("s") ? `${person.display_name}'` : `${person.display_name}'s`;
  const parts: string[] = [];
  if (a.peakViewers !== null) parts.push(`a peak of ${fmt(a.peakViewers)} viewers${a.averageViewers !== null ? ` (${fmt(a.averageViewers)} on average)` : ""}`);
  if (a.clipsPerHour !== null) parts.push(`${fmt(a.clipsTotal)} clips (${a.clipsPerHour} an hour)`);
  if (a.categorySwitches > 0) parts.push(`${a.categorySwitches + 1} categories`);
  const observed = session.complete ? "" : " (watched from part way through)";
  return {
    headline: `${possessive} ${platform} stream ended after ${describeElapsed(a.hours * 60)}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}${observed}.`,
    occurredAt: endedAt,
    dedupeKey: `${sourceName}:${STREAM_SUMMARY_KIND}:${session.streamId}`,
    rawPayload: {
      kind: STREAM_SUMMARY_KIND,
      source: sourceName,
      stream_id: session.streamId,
      channel: session.channel,
      started_at: session.startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      hours: a.hours,
      complete: session.complete,
      samples: session.sampleCount,
      peak_viewers: a.peakViewers,
      average_viewers: a.averageViewers,
      peak_to_average: a.peakToAverage,
      time_to_peak_minutes: a.timeToPeakMinutes,
      clips_total: a.clipsTotal,
      clips_per_hour: a.clipsPerHour,
      category_switches: a.categorySwitches,
      largest_drop_fraction: session.largestDropFraction,
    },
  };
}

/** The per-session metric readings a COMPLETE session records through the metric pipeline. Keys as the source row must declare them. */
export const SESSION_PEAK_VIEWERS_METRIC = "session_peak_viewers";
export const CLIPS_PER_STREAM_HOUR_METRIC = "clips_per_stream_hour";

export function sessionMetricReadings(session: LiveSession, endedAt: Date, config: LiveConfig): Array<{ metricKey: string; value: number }> {
  const a = sessionAggregates(session, endedAt);
  // Shorter than the warm-up: not a session, a false start; and only a complete one is evidence.
  if (!session.complete || a.hours * 60 < config.warmupMinutes) return [];
  const out: Array<{ metricKey: string; value: number }> = [];
  if (a.peakViewers !== null) out.push({ metricKey: SESSION_PEAK_VIEWERS_METRIC, value: a.peakViewers });
  if (a.clipsPerHour !== null) out.push({ metricKey: CLIPS_PER_STREAM_HOUR_METRIC, value: a.clipsPerHour });
  return out;
}
