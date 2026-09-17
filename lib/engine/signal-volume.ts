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
 * The series is the person's event signals per day (every kind the force
 * scores: articles, digests, streams, results; never metric signals, which
 * carry their own baseline), counted on complete days since the person's
 * newest source mapping was created. A mapping change is a new volume
 * regime, so the clock restarts with it, and the days before it are not
 * evidence of a quiet person but of an untracked one.
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
 */

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
