import { baselineDeviation, type BaselineDeviation } from "@/lib/engine/baseline";
import type { EngineConfig } from "@/lib/engine/config";
import { clamp, round } from "@/lib/engine/math";

/**
 * PER-PERSON SIGNAL VOLUME NORMALISATION (Phase 15).
 *
 * The Signals force grows with how much the world writes about a person:
 * one hundred routine items a day sum to a permanent lift that five a day
 * never reach, so the most-covered subject outranks everyone on volume
 * alone, and adding a source to a person raises their ceiling. Phase 7
 * named the honest fix and deferred it for lack of history: normalise each
 * person's volume against THEIR OWN trailing volume, with the shared
 * baseline every metric uses.
 *
 * The series is the person's event signals per day, counted on complete days
 * since the person's newest source mapping was created. A mapping change is a
 * new volume regime, so the clock restarts with it, and the days before it are
 * not evidence of a quiet person but of an untracked one.
 *
 *   reading = baselineDeviation(trailing-24h count against the daily series)
 *   typical = the reading's mean, signals per day
 *   weight  = clamp(referenceSignalsPerDay / typical, minWeight, maxWeight)
 *
 * Every EVENT signal's impact is multiplied by the weight, so a person's
 * typical day moves their score by the same amount whoever they are, and a
 * day of three times their typical volume reads as three times that: a big
 * news day FOR THEM. Until the baseline is sufficient the weight is exactly
 * 1 and the force is what it was. The reading's sigma is carried into the
 * force's details as "how unusual today's volume is for this person".
 *
 * WHAT COUNTS (Phase 18+). One rule decides both sides of the fraction, and
 * it has to, because the denominator must be exactly the set the weight
 * multiplies. A signal counted but not weighted dilutes everything else for
 * free; a signal weighted but not counted is amplified by a denominator it
 * never contributed to. Phase 16 settled the live moment on both sides and
 * left the rule unwritten, so the comment digest stayed on both. The rule:
 *
 *   A SIGNAL COUNTS WHEN ITS RATE IS SET BY THE WORLD, NOT BY OUR POLLING.
 *
 * Halve the poll interval and ask what changes. An article does not: a story
 * is published once and deduplicated across the two news doors. A stream
 * summary does not: one per broadcast. A game result does not: one per game.
 * A Form 4 does not. Those are EVENTS — they count here and they carry the
 * weight, and it does not matter that some are coverage of the person while
 * others are the person's own activity; both have a rate reality sets.
 *
 * A comment digest DOES change: it is emitted once per video per poll
 * whenever the top-comment sample has churned, so its rate is our cadence and
 * YouTube's like ranking and nothing about the person. A live moment does
 * too: it is the live cron's own sampling of a session, bounded by a cooldown
 * that is itself a sampling parameter. Those are ARTIFACTS — counted nowhere,
 * weighted never. It is the Phase 10 rule ("do not register something whose
 * sigma would describe the sampling rather than the subject") applied to the
 * volume series instead of to a metric.
 *
 * Metric signals were already out: they carry their own per-metric baseline,
 * so the volume weight would normalise them twice. Baseline signals are seeds
 * at zero impact and are evidence of nothing.
 *
 * Measured when the rule was applied: 80 of MrBeast's 92 event signals over
 * 2026-09-14..17 were comment digests, all at 0.000 impact, and every one sat
 * in the denominator of his own weight. His seven-day series went
 * {1,6,4,16,38,27,12} to {1,0,0,1,6,3,1}, mean 14.86 to 1.71; no other person
 * held a signal of any excluded kind.
 *
 * AND WHAT THE CORRECTION EXPOSED: at referenceSignalsPerDay = 20 the weight
 * now saturates at maxWeight for fifteen of the sixteen subjects, because the
 * real roster runs at 0.3 to 13.9 events a day and not the 3 to 100 the
 * reference was chosen against. When it engages it will be very nearly a
 * constant 2x on the Signals force rather than a normalisation, and only
 * patrick-mahomes (1.443) will sit below the ceiling. Re-deriving the
 * reference from the roster's own volumes is its own decision and has not
 * been made; signal-volume.test.ts pins the arithmetic so it cannot be
 * forgotten.
 */

/**
 * Signal kinds that are the platform's own sampling rather than events: never
 * counted in the volume series, never multiplied by the weight it produces.
 *
 * This list is the contract with public.person_signal_volume(), whose SQL
 * carries the same five kinds; lib/engine/signal-volume.test.ts fails if the
 * migration and this array disagree.
 */
export const UNCOUNTED_SIGNAL_KINDS = [
  /** A reading with its own per-metric baseline (Phase 7). */
  "metric",
  /** A zero-impact seed (Phase 3). */
  "baseline",
  /** One per video per poll when the sampled top comments churn (Phase 8+). */
  "comment_digest",
  /** One per sampled comment; not emitted since Phase 8+ replaced it with the digest. */
  "comment",
  /** The live cron's own sampling of a session (Phase 16). */
  "live_moment",
] as const;

/** True when a signal's payload carries one of the uncounted kinds. */
export function isUncountedSignal(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const kind = (payload as Record<string, unknown>).kind;
  return typeof kind === "string" && (UNCOUNTED_SIGNAL_KINDS as readonly string[]).includes(kind);
}

export interface PersonSignalVolume {
  /** When the person's newest active source mapping was created: the start of the current volume regime. */
  trackedSince: Date | null;
  /** Event signals in the trailing 24 hours. */
  current24h: number;
  /** Event signals per complete day since trackedSince, oldest first, at most windowDays of them. */
  daily: number[];
}

export interface VolumeWeight {
  /** The multiplier on every event signal's impact this tick. 1 until the baseline is sufficient. */
  weight: number;
  /** The baseline reading behind it; null when the person's volume is unknown to the tick. */
  reading: BaselineDeviation | null;
  /** The person's event signals in the trailing 24 hours, the reading judged; null when unknown. */
  current: number | null;
}

export const UNWEIGHTED: VolumeWeight = { weight: 1, reading: null, current: null };

const WEIGHT_DECIMALS = 4;

export function volumeWeight(volume: PersonSignalVolume | undefined, config: EngineConfig["signals"]["volume"]): VolumeWeight {
  if (!volume) return UNWEIGHTED;
  // The current reading is judged against the complete days plus itself, as
  // the utility expects; only complete days count toward the minimum.
  const reading = baselineDeviation(
    { current: volume.current24h, baseline: [...volume.daily, volume.current24h], samples: volume.daily.length },
    { minSamples: config.minSamples, sdFloor: config.sdFloor, thresholdStdDevs: config.thresholdStdDevs },
  );
  if (!reading.sufficient) return { weight: 1, reading, current: volume.current24h };
  const typical = Math.max(reading.mean, 0);
  const raw = typical > 0 ? config.referenceSignalsPerDay / typical : config.maxWeight;
  return { weight: round(clamp(raw, config.minWeight, config.maxWeight), WEIGHT_DECIMALS), reading, current: volume.current24h };
}

/** One row of person_signal_volume(), as the database returns it. */
export interface PersonSignalVolumeRow {
  person_id: string;
  tracked_since: string | null;
  current_24h: number | string | null;
  daily: Array<number | string> | null;
}

export function readSignalVolumeRow(row: PersonSignalVolumeRow): [string, PersonSignalVolume] {
  const num = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [
    row.person_id,
    {
      trackedSince: row.tracked_since ? new Date(row.tracked_since) : null,
      current24h: num(row.current_24h),
      daily: (row.daily ?? []).map(num),
    },
  ];
}

// ---------------------------------------------------------------------------
// The spread, for the operator (Phase 18++)
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS. referenceSignalsPerDay is a cross-person constant inside a
 * per-person mechanism, so it goes stale whenever the roster or its sources
 * change — and it went stale silently for three phases, until fourteen of
 * sixteen people sat on the ceiling and the weight had quietly become a
 * constant multiplier. A roster-relative reference would self-correct but
 * would couple every person's weight to every other person's, which is the
 * thing the per-person design exists to avoid. So the reference stays fixed
 * and the staleness is made VISIBLE instead: these two symptoms are on
 * /admin, and either one crossing is the signal to re-derive.
 */
export interface VolumeSpreadRow {
  personId: string;
  /** Complete days of history behind the reading. */
  samples: number;
  /** The weight the tick would apply right now. Exactly 1 while the baseline is thin. */
  weight: number;
  /** The person's own typical events per day, or null until the baseline is sufficient. */
  typicalPerDay: number | null;
  /** Whether the baseline is sufficient — whether the weight is doing anything at all. */
  engaged: boolean;
  /** Which bound the weight is sitting on, if either. */
  bound: "ceiling" | "floor" | null;
}

export interface VolumeSpread {
  reference: number;
  minWeight: number;
  maxWeight: number;
  rows: VolumeSpreadRow[];
  /** People whose baseline is sufficient: the weight is live for them. */
  engaged: number;
  people: number;
  atCeiling: number;
  atFloor: number;
  /**
   * The geometric mean of the engaged people's typical rates — what the
   * reference would be if it were re-derived today. null until somebody is
   * engaged with a non-zero rate.
   */
  liveGeometricMean: number | null;
  /** More than a third of the engaged people are sitting on a bound. */
  boundedShareHigh: boolean;
  /** The live geometric mean has left [reference / 2, reference x 2]. */
  referenceDrifted: boolean;
}

/** Either symptom crossing is the signal to re-derive the reference. */
export const BOUNDED_SHARE_REVIEW_THRESHOLD = 1 / 3;
export const REFERENCE_DRIFT_FACTOR = 2;

export function volumeSpread(volumes: Map<string, PersonSignalVolume>, config: EngineConfig["signals"]["volume"]): VolumeSpread {
  const rows: VolumeSpreadRow[] = [...volumes.entries()]
    .map(([personId, volume]) => {
      const computed = volumeWeight(volume, config);
      const engaged = computed.reading?.sufficient === true;
      const typicalPerDay = engaged && computed.reading ? round(Math.max(computed.reading.mean, 0), 2) : null;
      const bound = !engaged ? null : computed.weight >= config.maxWeight ? "ceiling" : computed.weight <= config.minWeight ? "floor" : null;
      return { personId, samples: computed.reading?.samples ?? 0, weight: computed.weight, typicalPerDay, engaged, bound } satisfies VolumeSpreadRow;
    })
    .sort((a, b) => (b.typicalPerDay ?? -1) - (a.typicalPerDay ?? -1) || a.personId.localeCompare(b.personId));

  const engagedRows = rows.filter((row) => row.engaged);
  const positive = engagedRows.map((row) => row.typicalPerDay ?? 0).filter((rate) => rate > 0);
  const liveGeometricMean = positive.length > 0 ? round(Math.exp(positive.reduce((total, rate) => total + Math.log(rate), 0) / positive.length), 3) : null;
  const bounded = engagedRows.filter((row) => row.bound !== null).length;

  return {
    reference: config.referenceSignalsPerDay,
    minWeight: config.minWeight,
    maxWeight: config.maxWeight,
    rows,
    engaged: engagedRows.length,
    people: rows.length,
    atCeiling: engagedRows.filter((row) => row.bound === "ceiling").length,
    atFloor: engagedRows.filter((row) => row.bound === "floor").length,
    liveGeometricMean,
    boundedShareHigh: engagedRows.length > 0 && bounded / engagedRows.length > BOUNDED_SHARE_REVIEW_THRESHOLD,
    referenceDrifted:
      liveGeometricMean !== null &&
      (liveGeometricMean < config.referenceSignalsPerDay / REFERENCE_DRIFT_FACTOR || liveGeometricMean > config.referenceSignalsPerDay * REFERENCE_DRIFT_FACTOR),
  };
}

/** What the force's details carry about the volume, rounded for the audit trail. */
export function describeVolume(volume: VolumeWeight): Record<string, unknown> | null {
  if (!volume.reading) return null;
  const r = volume.reading;
  return {
    weight: volume.weight,
    sufficient: r.sufficient,
    samples: r.samples,
    minSamples: r.minSamples,
    current24h: volume.current,
    meanPerDay: round(r.mean, 2),
    sdPerDay: round(r.sdApplied, 2),
    sigma: round(r.sigma, 2),
  };
}
