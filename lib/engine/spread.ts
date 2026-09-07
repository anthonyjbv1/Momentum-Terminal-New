import type { EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";

/**
 * LMSR dynamic spread.
 *
 * The previous platform priced every index with an LMSR marginal price
 *   p_i = exp(q_i / b) / Σ_j exp(q_j / b)        (b = 5000, q in dollars)
 *   spread_i = max(0.5, (1 - p_i) * 3)
 * but its allocation map was always empty client-side, so the formula never
 * fired. Here q_i is the platform-wide open capital on each person, available
 * server-side, and the marginal price is measured against the uniform share
 * 1/N so that an empty market sits exactly at the base spread:
 *
 *   thinness_i  = clamp((1/N - p_i) / (1/N), 0, 1)   0 at or above an equal share
 *   widening    = (max - base) * thinness_i          thin markets are expensive
 *   tightening  = clamp(w_c * concentration + w_d * min(depth / saturation, 1) + w_f * confidence, 0, 1)
 *   spread_i    = clamp(base + widening * (1 - tightening), base, max)
 *
 * More capital concentration, more signal depth and higher confidence all
 * tighten; with no positions and no volume everything collapses to base
 * (0.50). Buy = score + spread, Sell = score - spread.
 */

export interface SpreadInput {
  personId: string;
  openCapitalCents: number;
  maxAllocationCents: number;
  /** Processed signals for this person inside the depth window. */
  signalDepth: number;
  /** Mean sentiment confidence of those signals, 0–1. */
  averageConfidence: number;
}

export interface SpreadResult {
  personId: string;
  spread: number;
  marginalPrice: number;
  thinness: number;
  widening: number;
  tightening: number;
}

export function lmsrMarginalPrices(openCapitalCentsByPerson: Map<string, number>, liquidityDollars: number): Map<string, number> {
  const terms = new Map<string, number>();
  let sum = 0;
  for (const [personId, cents] of openCapitalCentsByPerson) {
    const term = Math.exp(cents / 100 / liquidityDollars);
    terms.set(personId, term);
    sum += term;
  }
  const prices = new Map<string, number>();
  for (const [personId, term] of terms) prices.set(personId, sum > 0 ? term / sum : 0);
  return prices;
}

export function computeSpreads(inputs: SpreadInput[], config: EngineConfig["spread"]): Map<string, SpreadResult> {
  const results = new Map<string, SpreadResult>();
  if (inputs.length === 0) return results;

  const capital = new Map(inputs.map((i) => [i.personId, i.openCapitalCents]));
  const prices = lmsrMarginalPrices(capital, config.lmsrLiquidity);
  const uniform = 1 / inputs.length;
  const { concentration: wConcentration, depth: wDepth, confidence: wConfidence } = config.weights;

  for (const input of inputs) {
    const marginalPrice = prices.get(input.personId) ?? uniform;
    const thinness = clamp((uniform - marginalPrice) / uniform, 0, 1);
    const widening = (config.max - config.base) * thinness;

    const concentration = input.maxAllocationCents > 0 ? clamp(input.openCapitalCents / input.maxAllocationCents, 0, 1) : 0;
    const depth = clamp(input.signalDepth / config.depthSaturationSignals, 0, 1);
    const confidence = clamp(input.averageConfidence, 0, 1);
    const tightening = clamp(wConcentration * concentration + wDepth * depth + wConfidence * confidence, 0, 1);

    const spread = clamp(config.base + widening * (1 - tightening), config.base, config.max);
    results.set(input.personId, { personId: input.personId, spread, marginalPrice, thinness, widening, tightening });
  }
  return results;
}

/** Buy (formerly Allocate) and Sell (formerly Redeem) prices around a score. */
export function buySellPrices(score: number, spread: number): { buyPrice: number; sellPrice: number } {
  return { buyPrice: score + spread, sellPrice: score - spread };
}
