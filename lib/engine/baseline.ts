import { mean, standardDeviation } from "@/lib/engine/math";

/**
 * THE BASELINE. One implementation of "how unusual is this reading for this
 * person right now", shared by every consumer that normalises a series
 * against its own trailing history: the Trading Activity force (net order
 * flow per window) and every metric connector (subscriber growth, news
 * volume, popularity, ...).
 *
 *   mean, sd      of the trailing baseline (population sd, zeros included)
 *   sdApplied     = max(sd, sdFloor): a quiet but non-zero history cannot
 *                   turn a small move into a many-sigma event
 *   deviation     = current - mean
 *   sigma         = deviation / sdApplied, the normalised magnitude
 *   band          inside when |deviation| <= thresholdStdDevs × sdApplied
 *   sufficient    only when the sample count reaches minSamples; below it
 *                 the reading is reported but nothing may act on it, because
 *                 the variance of a thin history is meaningless
 *
 * The three guards (minimum sample, sd floor, deadband) were introduced for
 * Trading Activity in 6c+ / 6e; they live here now so a metric cannot get a
 * looser version of them by accident.
 */

export interface BaselineConfig {
  /** Samples required before a deviation counts. Below it, `sufficient` is false and sigma is 0. */
  minSamples: number;
  /** Floor for the baseline standard deviation, in the series' own units. */
  sdFloor: number;
  /** Deadband threshold in standard deviations: inside it, the reading is normal. */
  thresholdStdDevs: number;
}

export interface BaselineReading {
  /** The reading being judged, in the series' units. */
  current: number;
  /** The trailing series the reading is judged against, the current reading included, oldest first. */
  baseline: number[];
  /**
   * How many samples count toward the minimum. Defaults to baseline.length;
   * Trading Activity passes the number of windows that saw a trade, because
   * its baseline is padded with zeros for empty windows.
   */
  samples?: number;
}

export interface BaselineDeviation {
  samples: number;
  minSamples: number;
  sufficient: boolean;
  mean: number;
  sd: number;
  sdFloor: number;
  sdApplied: number;
  deviation: number;
  /** deviation / sdApplied; 0 when insufficient. */
  sigma: number;
  threshold: number;
  /** null when insufficient. */
  band: "inside" | "outside" | null;
  /** True when the deviation is too small to carry a direction. */
  atBaseline: boolean;
}

/** Deviations this close to zero are "at baseline": no direction to report. */
export const AT_BASELINE_EPSILON = 1e-9;

export function baselineDeviation(reading: BaselineReading, config: BaselineConfig): BaselineDeviation {
  const samples = reading.samples ?? reading.baseline.length;
  const sufficient = samples >= config.minSamples;
  const baselineMean = mean(reading.baseline);
  const sd = standardDeviation(reading.baseline);
  const sdApplied = Math.max(sd, config.sdFloor);
  const deviation = reading.current - baselineMean;
  const atBaseline = Math.abs(deviation) < AT_BASELINE_EPSILON;
  const sigma = sufficient && sdApplied > 0 ? deviation / sdApplied : 0;
  const inside = Math.abs(deviation) <= config.thresholdStdDevs * sdApplied;

  return {
    samples,
    minSamples: config.minSamples,
    sufficient,
    mean: baselineMean,
    sd,
    sdFloor: config.sdFloor,
    sdApplied,
    deviation,
    sigma,
    threshold: config.thresholdStdDevs,
    band: sufficient ? (inside ? "inside" : "outside") : null,
    atBaseline,
  };
}
