import { baselineDeviation } from "@/lib/engine/baseline";
import type { EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";
import type { ForceEntry, TradeEvent } from "@/lib/engine/types";

/**
 * FORCE 5 — Trading Activity (live Buy/Sell velocity, baseline-relative).
 *
 *   netFlow          = Buy cents - Sell cents in the current window (windowSeconds)
 *   flowScore        = clamp(netFlow / max_allocation_cents, -1, +1)
 *   baseline         = the same score for every window in the trailing
 *                      baselineHours (zero windows included, current window
 *                      included): its mean is what "normal flow" means for
 *                      this person right now, its sd is how noisy that is
 *   deviation        = flowScore - baselineMean
 *   band             = |deviation| <= thresholdStdDevs × sd  → inside, else outside
 *   adjustment       outside: deviation × weight
 *                    inside:  deviation × weight × inBandScale, but never
 *                             smaller in magnitude than inBandMinImpact, so
 *                             the force reads alive during normal trading
 *                      × unconfirmedDampening when no signal backed the move this tick
 *                      clamped to ±maxAbsImpact
 *   gate             = skipped entirely below minConcentration of open capital
 *
 * The baseline arithmetic (mean, sd, sd floor, minimum sample, deadband) is
 * lib/engine/baseline.ts, shared with the metric connectors since Phase 7.
 * The three guards it carries were introduced here (Phase 6e, from 6c+):
 *   MINIMUM SAMPLE   fewer than minPopulatedWindows windows with any trade in
 *                    the baseline → the force returns 0 and reports
 *                    "insufficient baseline". On day one, and for a newly
 *                    added person, variance is near zero and every trade
 *                    would otherwise land far outside the band.
 *   SD FLOOR         the standard deviation is floored at sdFloor, so a quiet
 *                    but non-zero baseline cannot turn a small deviation into
 *                    a many-sigma event.
 *   DEADBAND         at 1.0σ most trading is "inside"; the in-band value is
 *                    small and signed by the deviation, so the profile row
 *                    reads alive rather than idle. Over a baseline window the
 *                    deviations sum to zero, so the in-band value carries no
 *                    drift.
 *
 * Measuring against the rolling baseline rather than against zero is what
 * keeps the force honest under long-only trading, where flow can only be
 * positive or zero: a steady inflow is the baseline and reads as nothing, a
 * burst above it lifts the score, a lull below it lowers the score. The same
 * arithmetic holds when shorting is enabled and flow can go negative, so
 * nothing here changes with the gate.
 */

function signedCents(event: TradeEvent): number {
  return event.side === "BUY" ? event.amountCents : -event.amountCents;
}

/** Net flow per fixed window over the baseline, oldest first, zeros included. The last window is the current one. */
export function windowedNetFlows(events: TradeEvent[], now: Date, config: EngineConfig["tradingActivity"]): number[] {
  return windowed(events, now, config).flows;
}

/** Both the net flow and the trade count per window. */
export function windowed(events: TradeEvent[], now: Date, config: EngineConfig["tradingActivity"]): { flows: number[]; counts: number[] } {
  const windowMs = config.windowSeconds * 1000;
  const windows = Math.max(1, Math.round((config.baselineHours * 3600 * 1000) / windowMs));
  const flows = new Array<number>(windows).fill(0);
  const counts = new Array<number>(windows).fill(0);
  const end = now.getTime();
  const start = end - windows * windowMs;
  for (const event of events) {
    const t = event.createdAt.getTime();
    if (t < start || t > end) continue;
    const index = Math.min(windows - 1, Math.floor((t - start) / windowMs));
    flows[index] += signedCents(event);
    counts[index] += 1;
  }
  return { flows, counts };
}

export function tradingActivityForce(input: {
  events: TradeEvent[];
  now: Date;
  maxAllocationCents: number;
  concentration: number;
  /** True when at least one signal was processed for this person this tick. */
  confirmedBySignals: boolean;
  config: EngineConfig["tradingActivity"];
}): ForceEntry {
  const { events, now, maxAllocationCents, concentration, confirmedBySignals, config } = input;
  const base = { force: "trading_activity" as const };

  if (concentration < config.minConcentration) {
    return { ...base, impact: 0, details: { gated: true, concentration, minConcentration: config.minConcentration } };
  }

  const toScore = (cents: number) => (maxAllocationCents > 0 ? clamp(cents / maxAllocationCents, -1, 1) : 0);

  const windowStart = now.getTime() - config.windowSeconds * 1000;
  const netFlowCents = events
    .filter((e) => e.createdAt.getTime() > windowStart && e.createdAt.getTime() <= now.getTime())
    .reduce((sum, e) => sum + signedCents(e), 0);
  const flowScore = toScore(netFlowCents);

  const { flows, counts } = windowed(events, now, config);
  const reading = baselineDeviation(
    { current: flowScore, baseline: flows.map(toScore), samples: counts.filter((count) => count > 0).length },
    { minSamples: config.minPopulatedWindows, sdFloor: config.sdFloor, thresholdStdDevs: config.thresholdStdDevs },
  );

  const details = {
    netFlowCents,
    flowScore,
    baselineHours: config.baselineHours,
    populatedWindows: reading.samples,
    minPopulatedWindows: reading.minSamples,
    baselineMean: reading.mean,
    baselineSd: reading.sd,
    sdFloor: reading.sdFloor,
    sdApplied: reading.sdApplied,
    deviation: reading.deviation,
    sigma: reading.sigma,
    threshold: reading.threshold,
    weight: config.weight,
    inBandScale: config.inBandScale,
    inBandMinImpact: config.inBandMinImpact,
    confirmedBySignals,
  };

  // MINIMUM SAMPLE: without enough trading history there is no baseline to deviate from.
  if (!reading.sufficient) {
    return { ...base, impact: 0, details: { ...details, reason: "insufficient baseline" } };
  }

  if (reading.atBaseline) {
    return { ...base, impact: 0, details: { ...details, band: "inside", reason: "flow at baseline" } };
  }

  const dampening = confirmedBySignals ? 1 : config.unconfirmedDampening;
  const inside = reading.band === "inside";
  const sign = reading.deviation > 0 ? 1 : -1;
  const magnitude = Math.abs(reading.deviation) * config.weight * dampening * (inside ? config.inBandScale : 1);
  const impact = sign * clamp(Math.max(magnitude, config.inBandMinImpact), 0, config.maxAbsImpact);

  return { ...base, impact, details: { ...details, dampening, band: inside ? "inside" : "outside", fired: !inside } };
}
