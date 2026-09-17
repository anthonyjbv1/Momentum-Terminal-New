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
): { trailingClips: number; trailingHours: number; trailingPerHour: number; sessionPerHour: number; baselinePerHour: number; multiple: number } | null {
  const windowStart = current.to.getTime() - config.clipWindowMinutes * MINUTE;
  const windows = [
    ...samples.filter((sample) => sample.clipsWindowFrom && sample.clipsWindowTo && sample.clipsWindowTo.getTime() > windowStart).map((sample) => ({ from: sample.clipsWindowFrom!, to: sample.clipsWindowTo!, count: sample.clipsInWindow })),
    current,
  ];
  const earliest = Math.max(windowStart, Math.min(...windows.map((window) => window.from.getTime())));
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
  return { trailingClips, trailingHours, trailingPerHour, sessionPerHour, baselinePerHour, multiple: baselinePerHour > 0 ? trailingPerHour / baselinePerHour : 0 };
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
  const headline =
    moment.moment === "audience_surge"
      ? `${possessive} live audience is up ${Math.round(moment.magnitude * 100)}% in the last ${moment.windowMinutes} minutes, ${fmt(moment.from)} to ${fmt(moment.to)} viewers, ${elapsed} into the stream.`
      : moment.moment === "audience_drop"
        ? `${possessive} live audience is down ${Math.round(-moment.magnitude * 100)}% in the last ${moment.windowMinutes} minutes, ${fmt(moment.from)} to ${fmt(moment.to)} viewers, ${elapsed} into the stream.`
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
