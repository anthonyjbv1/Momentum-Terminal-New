import type { EngineConfig } from "@/lib/engine/config";
import { clamp, mean, standardDeviation } from "@/lib/engine/math";
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
 *   fires only when   |deviation| > thresholdStdDevs * baselineSd
 *   adjustment       = deviation * weight
 *                      × unconfirmedDampening when no signal backed the move this tick
 *                      clamped to ±maxAbsImpact
 *   gate             = skipped entirely below minConcentration of open capital
 *
 * Measuring against the rolling baseline rather than against zero is what
 * keeps the force honest under long-only trading, where flow can only be
 * positive or zero: a steady inflow is the baseline and reads as nothing, a
 * burst above it lifts the score, a lull below it lowers the score. The same
 * arithmetic holds when shorting is enabled and flow can go negative, so
 * nothing here changes with the gate.
 *
 * With no trades the baseline is all zeros, sd = 0 and the force is 0.
 */

function signedCents(event: TradeEvent): number {
  return event.side === "BUY" ? event.amountCents : -event.amountCents;
}

/** Net flow per fixed window over the baseline, oldest first, zeros included. The last window is the current one. */
export function windowedNetFlows(events: TradeEvent[], now: Date, config: EngineConfig["tradingActivity"]): number[] {
  const windowMs = config.windowSeconds * 1000;
  const windows = Math.max(1, Math.round((config.baselineHours * 3600 * 1000) / windowMs));
  const flows = new Array<number>(windows).fill(0);
  const end = now.getTime();
  const start = end - windows * windowMs;
  for (const event of events) {
    const t = event.createdAt.getTime();
    if (t < start || t > end) continue;
    const index = Math.min(windows - 1, Math.floor((t - start) / windowMs));
    flows[index] += signedCents(event);
  }
  return flows;
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

  const baseline = windowedNetFlows(events, now, config).map(toScore);
  const baselineMean = mean(baseline);
  const baselineSd = standardDeviation(baseline);
  const deviation = flowScore - baselineMean;

  const details = {
    netFlowCents,
    flowScore,
    baselineHours: config.baselineHours,
    baselineMean,
    baselineSd,
    deviation,
    threshold: config.thresholdStdDevs,
    weight: config.weight,
    confirmedBySignals,
  };

  if (baselineSd === 0) {
    return { ...base, impact: 0, details: { ...details, reason: "no variance in baseline" } };
  }

  if (Math.abs(deviation) <= config.thresholdStdDevs * baselineSd) {
    return { ...base, impact: 0, details: { ...details, reason: "within threshold" } };
  }

  const dampening = confirmedBySignals ? 1 : config.unconfirmedDampening;
  const impact = clamp(deviation * config.weight * dampening, -config.maxAbsImpact, config.maxAbsImpact);
  return { ...base, impact, details: { ...details, dampening, fired: true } };
}
