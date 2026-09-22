import { LIVE_TICK_MS } from "@/lib/person/live-series";

import type { OrderSide, PositionDirection } from "./direction";

/**
 * The trading flow's shape, on both sides of the server boundary.
 *
 * MONEY AND POINTS NEVER MIX. `Cents` and `Points` are branded numbers:
 * a value has to be declared as one or the other at the edge (a database
 * row, a quote) and the compiler refuses to add a score to a balance. Every
 * monetary value is an integer number of cents; every quantity is an
 * integer number of units. The interface says "shares"; the schema, the
 * RPCs and this file say `units` — the seam is deliberate.
 *
 * THE DATABASE IS THE AUTHORITY. Everything here mirrors the constants and
 * arithmetic of migration 20260911200110_trading_flow so the interface can
 * explain an order before it is sent and show the result after; the
 * server never trusts a number from here.
 */

export type Cents = number & { readonly __unit: "cents" };
export type Points = number & { readonly __unit: "points" };

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new RangeError(`not an integer number of cents: ${value}`);
  return value as Cents;
}

export function points(value: number): Points {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number of points: ${value}`);
  return value as Points;
}

/** One score point is one dollar: POINT_CENTS cents per point. */
export const POINT_CENTS = 100;

/**
 * The one conversion from points to money, mirroring points_to_cents():
 * round to the nearest cent, half away from zero. Scores and spreads are
 * persisted at four decimals since Phase 14, so a quote is rounded to the
 * cent here and in the database by the same rule, and the two never differ;
 * the rounding also means a stray float can never carry fractions of a cent.
 */
export function pointsToCents(value: Points | number): Cents {
  const scaled = Number((value * POINT_CENTS).toFixed(6));
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return cents(rounded);
}

export function centsToPoints(value: Cents | number): Points {
  return points(value / POINT_CENTS);
}

// ---------------------------------------------------------------------------
// Constants (mirrors of the migration's defaults; the database is the authority)
// ---------------------------------------------------------------------------

/**
 * THE PAPER BALANCE every new user starts with: starting_balance_cents().
 * $10,000. At POINT_CENTS = 100 one share at score 50 costs $50, so this is
 * room for real positions in a dozen people rather than three or four (the
 * 6e figure of $1,000 bought roughly nineteen shares in total, too coarse
 * for a beta whose purpose is finding out whether a portfolio feels like
 * anything). Raised in 6f; existing beta accounts were topped up through
 * the ledger with credit_paper_balance(), not rewritten.
 */
export const STARTING_BALANCE_CENTS = cents(1_000_000);

/**
 * THE CLOSE COOLDOWN FLOOR, in seconds: one full Engine tick. The platform's
 * regulatory positioning describes the close cooldown as preventing
 * round-trip score influence (buy, let your own flow feed Trading Activity,
 * sell into the move you helped create), so whatever value policy settles
 * on, it must span at least one tick. Tests pin the shipped default above
 * this.
 */
export const CLOSE_COOLDOWN_MIN_SECONDS = LIVE_TICK_MS / 1000;

/**
 * The tolerance band, in cents per unit: a displayed price further than
 * this from the server's quote is rejected with the new quote. Mirrors the
 * platform_settings.price_tolerance_cents default.
 */
export const PRICE_TOLERANCE_CENTS_DEFAULT = cents(10);

/**
 * THE RISK LEVERS, as shipped. Installed, enforced in place_order(), and set
 * permissively so none binds during beta; calibration waits for real flow.
 * Live values come from platform_settings; these are the defaults.
 */
export const RISK_LEVER_DEFAULTS = {
  /** Most open units one user may hold on one person. */
  maxUnitsPerPerson: 100_000,
  /** Largest share (0–1) of all open units on one person a single user may hold. 1 = never binds. */
  maxOpenInterestShare: 1.0,
  /** Most close value one user may realise in a trailing 24 hours. */
  maxDailyCloseCents: cents(100_000_000),
  /**
   * A lot may not be closed until this long after it opened. TUNABLE, with
   * a floor: 60 s spans two ticks, so a buy cannot feed Trading Activity and
   * be sold into the tick it helped move (5 s only blocked the within-tick
   * round trip, which already loses the spread). The final value is a
   * POLICY DECISION PENDING; it must never go below CLOSE_COOLDOWN_MIN_SECONDS
   * (one full tick), which is what the platform's regulatory positioning
   * relies on.
   */
  closeCooldownSeconds: 60,
} as const;

/**
 * Most SHARES one order may ask for from the interface (the server's own
 * bound is the balance and the levers).
 */
export const MAX_ORDER_SHARES = 100_000;

/** Deprecated spelling kept while callers move over; both are share counts. */
export const MAX_ORDER_UNITS = MAX_ORDER_SHARES;

/**
 * THE SCALE, mirroring units_per_share(). A unit is a thousandth of a share,
 * so 0.001 is the smallest quantity that exists and every quantity sent to
 * the server is a whole number of units.
 */
export const UNITS_PER_SHARE = 1000;

/** The smallest order the platform accepts, either mode: platform_settings.min_order_cents. */
export const MIN_ORDER_CENTS = cents(100);

/**
 * THE ROUNDING RULE, mirroring units_cost_cents() and units_proceeds_cents().
 * A buy's cost rounds UP to the cent and a sell's proceeds round DOWN, so a
 * fraction of a cent is never resolved in the user's favour. Both live here,
 * in one place each, exactly as they do in SQL — and the preview the sheet
 * shows is the charge the server will make, not an approximation of it.
 */
export function unitsCostCents(units: number, priceCents: Cents | number): Cents {
  return cents(Math.ceil((units * priceCents) / UNITS_PER_SHARE));
}

export function unitsProceedsCents(units: number, priceCents: Cents | number): Cents {
  return cents(Math.floor((units * priceCents) / UNITS_PER_SHARE));
}

/**
 * Shares as the user typed them → whole units for the wire. Rounded to the
 * nearest unit because a third decimal is as fine as the scale goes: 0.0005
 * is not a quantity, it is a typo, and the server would refuse it anyway.
 */
export function sharesToUnits(shares: number): number {
  return Number.isFinite(shares) ? Math.round(shares * UNITS_PER_SHARE) : 0;
}

export function unitsToShares(units: number): number {
  return units / UNITS_PER_SHARE;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface TradeQuote {
  personId: string;
  score: Points;
  spread: Points;
  /** Buy fills at this: score + spread, in cents per unit. */
  buyCents: Cents;
  /** Sell fills at this: score − spread, in cents per unit. */
  sellCents: Cents;
  toleranceCents: Cents;
  asOf: string | null;
}

export function quotePriceFor(quote: Pick<TradeQuote, "buyCents" | "sellCents">, side: OrderSide): Cents {
  return side === "BUY" ? quote.buyCents : quote.sellCents;
}

/** The Buy and Sell quotes from a score and spread, as the page derives them between ticks. */
export function quoteFromScore(score: number, spread: number): { buyCents: Cents; sellCents: Cents } {
  return { buyCents: pointsToCents(score + spread), sellCents: pointsToCents(score - spread) };
}

// ---------------------------------------------------------------------------
// The scale a payload is counted in
// ---------------------------------------------------------------------------

/**
 * Quantities cross the server boundary as whole integers, but what one of
 * those integers MEANS is the server's to declare and not this side's to
 * assume. Until Phase 27 one unit was one share; from Phase 27 one unit is a
 * thousandth of a share. So every payload that carries a quantity also carries
 * `units_per_share`, and everything below divides by what it was told rather
 * than by a constant compiled in here.
 *
 * A PAYLOAD WITH NO SUCH FIELD CAME FROM A SERVER THAT ONLY EVER MEANT WHOLE
 * SHARES, so an absent scale is 1. That one rule is what lets this build ship
 * BEFORE the data moves and stay correct after: the same code reads both
 * shapes, and there is no instant at which a holding of three shares can be
 * printed as three thousand.
 *
 * Everything past the parse boundary is therefore in SHARES, and a share may
 * be fractional.
 */
export function payloadUnitsPerShare(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 1;
  const declared = (payload as Record<string, unknown>).units_per_share;
  const parsed = typeof declared === "number" ? declared : typeof declared === "string" ? Number(declared) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/** A server quantity, counted in the scale its payload declared, as shares. */
export function toShares(value: unknown, unitsPerShare: number): number {
  return toInt(value) / unitsPerShare;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface PositionSummary {
  personId: string;
  direction: PositionDirection | null;
  /** Shares held, from the payload's own scale. May be fractional. */
  openUnits: number;
  costCents: Cents;
  /** Weighted-average entry price, cents per unit. Display only; realized P&L is FIFO by lot. */
  avgEntryCents: Cents | null;
  lots: number;
  oldestOpenedAt: string | null;
  newestOpenedAt: string | null;
  /** The quote the position would close at right now. */
  markPriceCents: Cents | null;
  valueCents: Cents;
  unrealizedPnlCents: Cents;
  realizedPnlCents: Cents;
}

export const EMPTY_POSITION: Omit<PositionSummary, "personId"> = {
  direction: null,
  openUnits: 0,
  costCents: cents(0),
  avgEntryCents: null,
  lots: 0,
  oldestOpenedAt: null,
  newestOpenedAt: null,
  markPriceCents: null,
  valueCents: cents(0),
  unrealizedPnlCents: cents(0),
  realizedPnlCents: cents(0),
};

function toInt(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** position_summary_for() / my_position() as JSON → PositionSummary. */
export function toPositionSummary(value: unknown, personId: string): PositionSummary {
  if (typeof value !== "object" || value === null) return { personId, ...EMPTY_POSITION };
  const record = value as Record<string, unknown>;
  const direction = record.direction === "HIGH" || record.direction === "LOW" ? record.direction : null;
  const avg = toNullableInt(record.avg_entry_cents);
  const mark = toNullableInt(record.mark_price_cents);
  const unitsPerShare = payloadUnitsPerShare(record);
  return {
    personId,
    direction,
    openUnits: toShares(record.open_units, unitsPerShare),
    costCents: cents(toInt(record.cost_cents)),
    avgEntryCents: avg === null ? null : cents(avg),
    lots: toInt(record.lots),
    oldestOpenedAt: typeof record.oldest_opened_at === "string" ? record.oldest_opened_at : null,
    newestOpenedAt: typeof record.newest_opened_at === "string" ? record.newest_opened_at : null,
    markPriceCents: mark === null ? null : cents(mark),
    valueCents: cents(toInt(record.value_cents)),
    unrealizedPnlCents: cents(toInt(record.unrealized_pnl_cents)),
    realizedPnlCents: cents(toInt(record.realized_pnl_cents)),
  };
}

/** trade_quote() / the quote inside an order result as JSON → TradeQuote. */
export function toTradeQuote(value: unknown, personId: string): TradeQuote | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const buy = toNullableInt(record.buy_cents);
  const sell = toNullableInt(record.sell_cents);
  if (buy === null || sell === null) return null;
  return {
    personId: typeof record.person_id === "string" ? record.person_id : personId,
    score: points(toNumber(record.score)),
    spread: points(toNumber(record.spread)),
    buyCents: cents(buy),
    sellCents: cents(sell),
    toleranceCents: cents(toInt(record.tolerance_cents, PRICE_TOLERANCE_CENTS_DEFAULT)),
    asOf: typeof record.as_of === "string" ? record.as_of : null,
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** Why place_order() refused. Each maps to a specific sentence; there is no generic failure. */
export const ORDER_REJECTION_CODES = [
  "price_moved",
  "insufficient_balance",
  "exceeds_position",
  "daily_limit",
  "cooldown",
  "max_units",
  "open_interest",
  "unknown_person",
  "no_quote",
  // The order is smaller than platform_settings.min_order_cents, in whichever
  // mode it was entered: the amount in Dollars, the notional in Shares.
  "below_minimum",
  // Raised by the route rather than the database.
  "unauthenticated",
  "invalid",
  "unavailable",
] as const;
export type OrderRejectionCode = (typeof ORDER_REJECTION_CODES)[number];

export interface OrderFill {
  positionId: string;
  units: number;
  entryPriceCents: Cents;
  pnlCents: Cents;
  proceedsCents: Cents;
}

export interface FilledOrder {
  id: string;
  personId: string;
  side: OrderSide;
  units: number;
  fillPriceCents: Cents;
  grossCents: Cents;
  openedUnits: number;
  openedDirection: PositionDirection | null;
  positionId: string | null;
  costCents: Cents;
  closedUnits: number;
  proceedsCents: Cents;
  realizedPnlCents: Cents;
  fills: OrderFill[];
  createdAt: string | null;
}

export type OrderResult =
  | { ok: true; order: FilledOrder; balanceCents: Cents; position: PositionSummary; quote: TradeQuote | null }
  | { ok: false; code: OrderRejectionCode; message: string; quote: TradeQuote | null; extra: Record<string, unknown> };

export function isOrderRejectionCode(value: unknown): value is OrderRejectionCode {
  return typeof value === "string" && (ORDER_REJECTION_CODES as readonly string[]).includes(value);
}

/** place_order()'s JSON → OrderResult. Anything unrecognisable is a rejection, never a fill. */
export function toOrderResult(value: unknown, personId: string): OrderResult {
  const unknownRejection: OrderResult = { ok: false, code: "no_quote", message: "The order could not be placed.", quote: null, extra: {} };
  if (typeof value !== "object" || value === null) return unknownRejection;
  const record = value as Record<string, unknown>;

  if (record.ok !== true) {
    const { ok: _ok, code, message, quote, ...extra } = record;
    void _ok;
    return {
      ok: false,
      code: isOrderRejectionCode(code) ? code : "no_quote",
      message: typeof message === "string" && message ? message : unknownRejection.message,
      quote: toTradeQuote(quote, personId),
      extra,
    };
  }

  const order = (typeof record.order === "object" && record.order !== null ? record.order : {}) as Record<string, unknown>;
  // The order's own declared scale covers every quantity inside it, the fills
  // included — whatever scale the request itself was expressed in.
  const unitsPerShare = payloadUnitsPerShare(order);
  const fills = Array.isArray(order.fills)
    ? order.fills
        .filter((fill): fill is Record<string, unknown> => typeof fill === "object" && fill !== null)
        .map((fill) => ({
          positionId: typeof fill.position_id === "string" ? fill.position_id : "",
          units: toShares(fill.units, unitsPerShare),
          entryPriceCents: cents(toInt(fill.entry_price_cents)),
          pnlCents: cents(toInt(fill.pnl_cents)),
          proceedsCents: cents(toInt(fill.proceeds_cents)),
        }))
    : [];

  return {
    ok: true,
    order: {
      id: typeof order.id === "string" ? order.id : "",
      personId,
      side: order.side === "SELL" ? "SELL" : "BUY",
      units: toShares(order.units, unitsPerShare),
      fillPriceCents: cents(toInt(order.fill_price_cents)),
      grossCents: cents(toInt(order.gross_cents)),
      openedUnits: toShares(order.opened_units, unitsPerShare),
      openedDirection: order.opened_direction === "HIGH" || order.opened_direction === "LOW" ? order.opened_direction : null,
      positionId: typeof order.position_id === "string" ? order.position_id : null,
      costCents: cents(toInt(order.cost_cents)),
      closedUnits: toShares(order.closed_units, unitsPerShare),
      proceedsCents: cents(toInt(order.proceeds_cents)),
      realizedPnlCents: cents(toInt(order.realized_pnl_cents)),
      fills,
      createdAt: typeof order.created_at === "string" ? order.created_at : null,
    },
    balanceCents: cents(toInt(record.balance_cents)),
    position: toPositionSummary(record.position, personId),
    quote: toTradeQuote(record.quote, personId),
  };
}

/** What the profile page knows about the viewer's trading state on a person. */
export interface ViewerTradingState {
  signedIn: boolean;
  balanceCents: Cents | null;
  position: PositionSummary | null;
}

/** The order route's JSON, which is already an OrderResult. Anything else is an "unavailable" rejection. */
export function parseOrderResponse(value: unknown, personId: string): OrderResult {
  if (typeof value === "object" && value !== null && "ok" in value) {
    const record = value as Record<string, unknown>;
    if (record.ok === true && typeof record.order === "object" && record.order !== null) return value as OrderResult;
    if (record.ok === false && isOrderRejectionCode(record.code)) {
      return {
        ok: false,
        code: record.code,
        message: typeof record.message === "string" && record.message ? record.message : "The order could not be placed.",
        quote: typeof record.quote === "object" && record.quote !== null ? (record.quote as TradeQuote) : null,
        extra: typeof record.extra === "object" && record.extra !== null ? (record.extra as Record<string, unknown>) : {},
      };
    }
  }
  void personId;
  return { ok: false, code: "unavailable", message: "Trading is unavailable right now. Nothing was placed.", quote: null, extra: {} };
}

// ---------------------------------------------------------------------------
// Previews (what the sheet shows before the server decides)
// ---------------------------------------------------------------------------

export interface OrderPreview {
  side: OrderSide;
  /** Shares, as the sheet will send them. May be fractional. */
  shares: number;
  /** The same quantity in whole units: what actually goes on the wire. */
  units: number;
  priceCents: Cents;
  /** What the server will charge for a Buy, or return for a Sell — through the rounding rule, to the cent. */
  grossCents: Cents;
  /** The balance after, before any realized P&L on a Sell is known. */
  balanceAfterCents: Cents;
  /** Shares the balance can cover at this price (Buy). */
  affordableShares: number;
  /** True when the order is worth less than the platform minimum and the server would refuse it. */
  belowMinimum: boolean;
}

/**
 * What a Shares-mode order will do, priced the way the server prices it.
 * previewOrder does not round a quantity: the sheet decides what the user
 * asked for and this says what it costs.
 */
export function previewOrder(side: OrderSide, shares: number, priceCents: Cents, balanceCents: Cents): OrderPreview {
  const units = shares > 0 ? sharesToUnits(shares) : 0;
  const gross = side === "BUY" ? unitsCostCents(units, priceCents) : unitsProceedsCents(units, priceCents);
  const balanceAfter = cents(side === "BUY" ? balanceCents - gross : balanceCents + gross);
  return {
    side,
    shares: units / UNITS_PER_SHARE,
    units,
    priceCents,
    grossCents: gross,
    balanceAfterCents: balanceAfter,
    affordableShares: priceCents > 0 ? affordableUnits(balanceCents, priceCents) / UNITS_PER_SHARE : 0,
    belowMinimum: units > 0 && gross < MIN_ORDER_CENTS,
  };
}

/**
 * DOLLARS MODE, mirroring place_order()'s inversion. The largest quantity
 * whose rounded-UP cost still fits inside the amount asked for. Because
 * ceil(x) <= S is exactly x <= S for an integer S, that quantity is
 * floor(S × 1000 / price) — no search, no float, and the charge that comes
 * back is at most the amount entered, never more.
 */
export function affordableUnits(spendCents: Cents | number, priceCents: Cents | number): number {
  if (priceCents <= 0) return 0;
  return Math.floor((spendCents * UNITS_PER_SHARE) / priceCents);
}

/** What a Dollars-mode order will actually buy and actually cost. */
export function previewSpend(side: OrderSide, spendCents: Cents, priceCents: Cents, balanceCents: Cents): OrderPreview {
  const units = affordableUnits(spendCents, priceCents);
  const gross = side === "BUY" ? unitsCostCents(units, priceCents) : unitsProceedsCents(units, priceCents);
  const balanceAfter = cents(side === "BUY" ? balanceCents - gross : balanceCents + gross);
  return {
    side,
    shares: units / UNITS_PER_SHARE,
    units,
    priceCents,
    grossCents: gross,
    balanceAfterCents: balanceAfter,
    affordableShares: affordableUnits(balanceCents, priceCents) / UNITS_PER_SHARE,
    // In Dollars mode the minimum is checked against what the user entered,
    // so that typing exactly $1.00 is never perversely refused for landing a
    // cent under it once the quantity is resolved.
    belowMinimum: spendCents < MIN_ORDER_CENTS || units <= 0,
  };
}

/**
 * A quantity of shares as a number: up to three decimals, trailing zeros
 * trimmed, so 3 is "3", 0.5 is "0.5" and 1.125 is "1.125". Mirrors
 * shares_text() so a rejection sentence written in SQL and a line written
 * here never describe the same order two ways.
 */
export function sharesText(shares: number): string {
  const units = sharesToUnits(shares);
  if (units % UNITS_PER_SHARE === 0) return (units / UNITS_PER_SHARE).toLocaleString("en-US");
  return (units / UNITS_PER_SHARE).toFixed(3).replace(/0+$/, "");
}

/** "shares" is the word people see. Singular only at exactly one. */
export function sharesLabel(shares: number): string {
  return `${sharesText(shares)} ${sharesToUnits(shares) === UNITS_PER_SHARE ? "share" : "shares"}`;
}

