import type { EngineConfig } from "@/lib/engine/config";
import { clamp, mean, standardDeviation } from "@/lib/engine/math";
import type { ForceEntry, TradeEvent } from "@/lib/engine/types";

/**
 * FORCE 5 — Trading Activity (live Buy/Sell velocity).
 *
 *   netFlow          = Buy cents - Sell cents in the rolling window (60s)
 *   convictionScore  = clamp(netFlow / max_allocation_cents, -1, +1)
 *   history          = the same score for every window in the trailing
 *                      historyHours (zero windows included)
 *   fires only when   convictionScore is beyond mean ± thresholdStdDevs * sd
 *   adjustment       = convictionScore * weight
 *                      × unconfirmedDampening when no signal backed the move this tick
 *                      clamped to ±maxAbsImpact
 *   gate             = skipped entirely below minConcentration of open capital
 *
 * With no trades the history is all zeros, sd = 0 and the force is 0.
 */

function signedCents(event: TradeEvent): number {
  return event.side === "BUY" ? event.amountCents : -event.amountCents;
}

/** Net flow per fixed window over the history, oldest first, zeros included. */
export function windowedNetFlows(events: TradeEvent[], now: Date, config: EngineConfig["tradingActivity"]): number[] {
  const windowMs = config.windowSeconds * 1000;
  const windows = Math.max(1, Math.round((config.historyHours * 3600 * 1000) / windowMs));
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

  const windowStart = now.getTime() - config.windowSeconds * 1000;
  const netFlowCents = events
    .filter((e) => e.createdAt.getTime() > windowStart && e.createdAt.getTime() <= now.getTime())
    .reduce((sum, e) => sum + signedCents(e), 0);
  const convictionScore = maxAllocationCents > 0 ? clamp(netFlowCents / maxAllocationCents, -1, 1) : 0;

  const history = windowedNetFlows(events, now, config).map((flow) => (maxAllocationCents > 0 ? clamp(flow / maxAllocationCents, -1, 1) : 0));
  const historyMean = mean(history);
  const historySd = standardDeviation(history);

  const details = { netFlowCents, convictionScore, historyMean, historySd, threshold: config.thresholdStdDevs, confirmedBySignals };

  if (historySd === 0) {
    return { ...base, impact: 0, details: { ...details, reason: "no variance in history" } };
  }

  const upper = historyMean + config.thresholdStdDevs * historySd;
  const lower = historyMean - config.thresholdStdDevs * historySd;
  if (convictionScore <= upper && convictionScore >= lower) {
    return { ...base, impact: 0, details: { ...details, reason: "within threshold" } };
  }

  const dampening = confirmedBySignals ? 1 : config.unconfirmedDampening;
  const impact = clamp(convictionScore * config.weight * dampening, -config.maxAbsImpact, config.maxAbsImpact);
  return { ...base, impact, details: { ...details, dampening, fired: true } };
}
