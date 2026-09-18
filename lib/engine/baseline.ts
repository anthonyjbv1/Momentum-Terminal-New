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
 *
 * ---------------------------------------------------------------------------
 * ROBUST SPREAD: REPLAYED 2026-09-18, DEFERRED AGAIN. (Phase 18)
 *
 * Phase 12 flagged that the population sd above is not robust: one extreme
 * reading inflates sd and shifts the mean for the whole trailing window, so
 * every ordinary move after it reads as fewer sigmas. The fixes proposed then
 * were to winsorize the window at ±3 sd, or to swap mean/sd for median/MAD.
 * Both were replayed against every observation the Engine has accumulated —
 * 3,130 readings across 14 metrics, 2026-09-14 to 2026-09-18 — by
 * reconstructing each reading's own window from the stored observation ledger
 * (the privacy rule keeps that table's name out of application source; the
 * query is in the Phase 18 section of the README). The reconstruction
 * reproduced the stored classification on 3,130 of 3,130.
 *
 *   rule                        readings that emit
 *   current (mean / sd)         662
 *   winsorized at ±3 sd         663   (+1: a boundary tie, |sigma| 0.9989 -> 1.0004)
 *   median / 1.4826 × MAD       604   (176 reclassified: 117 lost, 59 gained)
 *
 * Winsorizing changes nothing at this data volume. Its single difference is
 * patrick-mahomes / news_volume_24h at 2026-09-18 06:45 (observed 28, mean
 * 37.5566 -> 37.5496, sd 9.5671 -> 9.5458), a reading sitting exactly on the
 * deadband edge. Shipping it would be a change that only matters in theory.
 *
 * MAD is worse than nothing here, and not marginally: 773 of the windows have
 * a MAD of exactly 0, because these are small-integer count metrics whose
 * median absolute deviation collapses as soon as half the window shares a
 * value. A zero MAD falls straight through to sdFloor, a constant, so the
 * metric stops being normalised against itself at all. That is the failure the
 * sd floor exists to bound, not one to walk into deliberately.
 *
 * The outlier-inflation concern is real but structurally shrinking: one
 * outlier contributes d²/n to the variance, so it matters most when n is
 * small, and these windows fill (news volume is already past n = 100). What
 * will not fill is the per-game athlete metrics — min_samples 8 over a
 * 1,680 h window — where n stays small by construction. REVISIT THERE, around
 * eight played games (November 2026), not before.
 *
 * AND WHOEVER REVISITS: this function is shared, and a change here reaches
 * every caller —
 *   lib/ingest/metrics.ts                  the metric pipeline (the intended target)
 *   lib/ingest/metrics.ts                  the derived spike_count cutoff
 *   lib/engine/signal-volume.ts            the per-person volume weight, which
 *                                          DIVIDES BY `mean`: either robust
 *                                          rule moves it
 *   lib/engine/forces/trading-activity.ts  net order flow per window
 * The volume weight has no complete days to replay against until 2026-09-25,
 * so a robust rule must arrive as a per-call-site option with the current
 * behaviour as its default — never as a new definition of baselineDeviation.
 * ---------------------------------------------------------------------------
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
