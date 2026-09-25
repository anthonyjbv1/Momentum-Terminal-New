/**
 * THE MARKET PRICE'S ARITHMETIC (Phase 29), mirrored from migration
 * phase29_market_price so the interface can show, before an order is sent,
 * exactly what the server will charge — and so a test can hold the two
 * implementations against each other over thousands of inputs.
 *
 * THE DATABASE IS THE AUTHORITY. Nothing here is trusted by the server; it is
 * a preview and a replay tool. Every function is integer arithmetic over
 * BigInt: the curve's terms are rational numbers with no finite decimal
 * expansion for a general depth, so they are evaluated as one integer
 * fraction and rounded once, exactly as the SQL does. No float touches money
 * or the premium.
 *
 *   marginal price at inventory x     S + 100·x/D            cents per share
 *   walk of u units, up (a buy)       u·S/1000 + u·(2I + u)/(20·D)   → ceil
 *   walk of u units, down (a sell)    u·S/1000 + u·(2I − u)/(20·D)   → floor
 *   premium                           trunc(I × 100 / D)     cents per share
 *   decay, per tick                   I − sign(I)·ceil(|I| / K),  K = round(halfLife / ln 2)
 *
 * S is the side's BASE price (score ± half-spread, whole cents, premium
 * excluded), I the dealer's inventory in units (thousandths of a share), D
 * the tier's depth in units per point. A null depth is the flat market:
 * Phase 27 pricing exactly, premium 0, no impact.
 */

export type WalkDirection = "up" | "down";
export type Rounding = "ceil" | "floor";

export interface MarketState {
  /** The side's base price in whole cents per share, premium excluded. */
  baseCents: number;
  /** The dealer's inventory in units. */
  inventoryUnits: number;
  /** Units per point of premium; null is the flat market. */
  depthUnits: number | null;
}

// BigInt constants by call rather than literal, so the file compiles under
// any TypeScript target.
const N0 = BigInt(0);
const N1 = BigInt(1);
const N2 = BigInt(2);
const N20 = BigInt(20);
const N100 = BigInt(100);
const N1000 = BigInt(1000);
const N20000 = BigInt(20000);

function big(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) throw new RangeError(`not an integer: ${value}`);
  return BigInt(value);
}

/** floor(num / den) for integers, den > 0. */
function floorDiv(num: bigint, den: bigint): bigint {
  const q = num / den; // truncates toward zero
  return num % den !== N0 && num < N0 ? q - N1 : q;
}

/** ceil(num / den) for integers, den > 0. */
function ceilDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  return num % den !== N0 && num > N0 ? q + N1 : q;
}

/** round(num / den) half away from zero, for integers, den > 0. */
function roundDiv(num: bigint, den: bigint): bigint {
  const twice = N2 * num;
  return num >= N0 ? floorDiv(twice + den, N2 * den) : -floorDiv(-twice + den, N2 * den);
}

function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`out of range: ${value}`);
  return Number(value);
}

/** trunc(I × 100 / D): the premium in cents per share. 0 in a flat market. */
export function premiumCents(inventoryUnits: number, depthUnits: number | null): number {
  if (depthUnits === null) return 0;
  return toNumber((big(inventoryUnits) * N100) / big(depthUnits));
}

/**
 * The exact value of u units along the curve, rounded once.
 * Mirrors market_walk_cents().
 */
export function walkCents(units: number, state: MarketState, direction: WalkDirection, rounding: Rounding): number {
  const u = big(units);
  if (u <= N0) return 0;
  let num: bigint;
  let den: bigint;
  if (state.depthUnits === null) {
    num = u * big(state.baseCents);
    den = N1000;
  } else {
    const d = big(state.depthUnits);
    const signed = direction === "up" ? u : -u;
    num = N20 * d * u * big(state.baseCents) + N1000 * u * (N2 * big(state.inventoryUnits) + signed);
    den = N20000 * d;
  }
  return toNumber(rounding === "ceil" ? ceilDiv(num, den) : floorDiv(num, den));
}

/** What a buy of u units costs: the up-walk, rounded up. */
export function buyCostCents(units: number, state: MarketState): number {
  return walkCents(units, state, "up", "ceil");
}

/** What a sell of u units returns: the down-walk, rounded down. */
export function sellProceedsCents(units: number, state: MarketState): number {
  return walkCents(units, state, "down", "floor");
}

/** The marginal price at an inventory, rounded as asked. Mirrors market_marginal_cents(). */
export function marginalCents(state: MarketState, rounding: Rounding): number {
  if (state.depthUnits === null) return state.baseCents;
  const d = big(state.depthUnits);
  const num = big(state.baseCents) * d + N100 * big(state.inventoryUnits);
  return toNumber(rounding === "ceil" ? ceilDiv(num, d) : floorDiv(num, d));
}

/**
 * The exact average price per share of a walk, rounded to the nearest cent.
 * Mirrors market_average_cents(): S + 100·(2I ± u) / (2·D).
 */
export function averageCents(units: number, state: MarketState, direction: WalkDirection): number {
  if (state.depthUnits === null || units <= 0) return state.baseCents;
  const d = big(state.depthUnits);
  const u = big(units);
  const signed = direction === "up" ? u : -u;
  const num = N2 * d * big(state.baseCents) + N100 * (N2 * big(state.inventoryUnits) + signed);
  return toNumber(roundDiv(num, N2 * d));
}

/** The order's own impact term u² / (20·D), to nine decimals, for display. Mirrors market_impact_cents(). */
export function impactCents(units: number, depthUnits: number | null): number {
  if (depthUnits === null || units <= 0) return 0;
  return Math.round(((units * units) / (20 * depthUnits)) * 1e9) / 1e9;
}

/** The largest inventory the cap allows: ceil((cap + 1)·D / 100) − 1. Mirrors market_cap_inventory_units(). */
export function capInventoryUnits(capCents: number, depthUnits: number): number {
  return toNumber(ceilDiv((big(capCents) + N1) * big(depthUnits), N100) - N1);
}

/** K = round(halfLife / ln 2). Mirrors market_decay_divisor(). */
export function decayDivisor(halfLifeTicks: number): number {
  return Math.max(1, Math.round(halfLifeTicks / Math.LN2));
}

/** One decay step: I − sign(I)·ceil(|I| / K). Mirrors market_decay_step(). */
export function decayStep(inventoryUnits: number, divisor: number): number {
  const i = big(inventoryUnits);
  const k = big(divisor);
  if (i === N0) return 0;
  if (i > N0) return toNumber(i - (i + k - N1) / k);
  return toNumber(i + (-i + k - N1) / k);
}

/** The most units the Dollars search ever considers: MAX_ORDER_SHARES × UNITS_PER_SHARE (lib/trading/model.ts). */
const SEARCH_CEILING_UNITS = 100_000_000;

/**
 * The largest sell whose last unit still prices at or above zero: past it a
 * sell's proceeds FALL as the quantity grows. u ≤ I + S·D / 100.
 */
function sellPeakUnits(state: MarketState): number {
  if (state.depthUnits === null) return SEARCH_CEILING_UNITS;
  const peak = (big(state.baseCents) * big(state.depthUnits) + N100 * big(state.inventoryUnits)) / N100;
  return peak > big(SEARCH_CEILING_UNITS) ? SEARCH_CEILING_UNITS : toNumber(peak);
}

/**
 * DOLLARS MODE: the largest quantity whose walk stays within the amount. The
 * walk is monotone in the quantity, so this is a binary search over integers;
 * the charge is at most the amount, never more. Mirrors the search in
 * place_order(). Returns 0 when nothing fits.
 *
 * THE SEARCH IS BOUNDED (Phase 29b). A sell's walk is monotone only while
 * the price it walks down to stays above zero; beyond that its proceeds fall
 * again, so an amount larger than any sell could ever return kept the
 * widening loop doubling toward 10^12 units until an intermediate figure left
 * the safe-integer range and the sheet threw while rendering. The search now
 * never looks past that peak, nor past the largest order the sheet accepts;
 * inside those bounds the answer is exactly place_order()'s, and anything
 * beyond them the server refuses as too large anyway.
 */
export function largestUnitsWithin(spendCents: number, state: MarketState, direction: WalkDirection, rounding: Rounding): number {
  if (spendCents <= 0) return 0;
  const startMarginal = marginalCents(state, "floor");
  if (startMarginal <= 0) return 0;
  const ceiling = direction === "down" ? Math.min(SEARCH_CEILING_UNITS, sellPeakUnits(state)) : SEARCH_CEILING_UNITS;
  if (ceiling <= 0) return 0;
  const fits = (units: number) => walkCents(units, state, direction, rounding) <= spendCents;
  let lo = 0;
  let hi = Math.min(ceiling + 1, Math.max(1, Math.floor((spendCents * 1000) / startMarginal) + 1));
  while (hi <= ceiling && fits(hi)) hi = Math.min(ceiling + 1, hi * 2);
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The state after an order of u units: the inventory walks by u, in the order's direction. */
export function stateAfter(units: number, state: MarketState, direction: WalkDirection): MarketState {
  if (state.depthUnits === null) return state;
  return { ...state, inventoryUnits: state.inventoryUnits + (direction === "up" ? units : -units) };
}

/**
 * Replays a sequence of inventory changes — trades and decay steps — from a
 * starting inventory, exactly as the database would have written them, so a
 * recorded premium_history can be checked row by row.
 */
export interface ReplayStep {
  kind: "trade" | "decay";
  /** For a trade: signed units, positive for a buy. */
  units?: number;
}

export function replayInventory(start: number, steps: ReplayStep[], halfLifeTicks: number): number[] {
  const divisor = decayDivisor(halfLifeTicks);
  const out: number[] = [];
  let inventory = start;
  for (const step of steps) {
    inventory = step.kind === "trade" ? inventory + (step.units ?? 0) : decayStep(inventory, divisor);
    out.push(inventory);
  }
  return out;
}
