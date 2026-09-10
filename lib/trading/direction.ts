/**
 * Position direction rules: the TypeScript mirror of resolve_position_order()
 * in the database (migration 20260910172052_position_direction_gating).
 *
 * THE DATABASE IS THE AUTHORITY. The trading flow's order RPC calls
 * assert_position_direction() inside its transaction, and the
 * positions_enforce_direction trigger rejects any row change that leaves a
 * user net short while platform_settings.shorting_enabled is false. This copy
 * exists so the interface can explain an order before it is sent, and so the
 * rule is unit-tested here alongside the SQL. Keep the two in step.
 *
 * Netting: a Buy first closes any LOW exposure, then opens HIGH with the
 * rest; a Sell first closes any HIGH exposure, then opens LOW with the rest,
 * and that last step is what the gate controls. Both sides exist in full; the
 * flag only decides whether the net position may be negative.
 */

export type OrderSide = "BUY" | "SELL";
export type PositionDirection = "HIGH" | "LOW";

/** The launch setting: long-only until shorting is switched on deliberately. */
export const SHORTING_ENABLED_DEFAULT = false;

export interface OrderResolution {
  /** Cents closed on the opposite side. */
  reduceCents: number;
  /** Cents opened on the order's own side. */
  openCents: number;
  /** The direction of the position opened, or null when the order only closes. */
  openDirection: PositionDirection | null;
  /** Net position after the order: positive is net HIGH, negative is net LOW. */
  netAfterCents: number;
}

export type OrderOutcome =
  | { ok: true; resolution: OrderResolution }
  | {
      ok: false;
      reason: "shorting_disabled";
      message: string;
      /** The most the user may sell right now: their open HIGH exposure. */
      maxSellCents: number;
    };

export interface OrderInput {
  /** The user's net position on the person before the order, in integer cents. */
  netBeforeCents: number;
  side: OrderSide;
  amountCents: number;
  shortingEnabled: boolean;
}

function assertAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RangeError("amountCents must be a positive integer number of cents");
  }
}

/** Resolves an order against the net position and the gate. Mirrors resolve_position_order(). */
export function resolveOrder({ netBeforeCents, side, amountCents, shortingEnabled }: OrderInput): OrderOutcome {
  assertAmount(amountCents);
  const net = Number.isFinite(netBeforeCents) ? Math.trunc(netBeforeCents) : 0;

  if (side === "BUY") {
    const reduceCents = Math.min(amountCents, Math.max(-net, 0));
    const openCents = amountCents - reduceCents;
    return { ok: true, resolution: { reduceCents, openCents, openDirection: openCents > 0 ? "HIGH" : null, netAfterCents: net + amountCents } };
  }

  const reduceCents = Math.min(amountCents, Math.max(net, 0));
  const openCents = amountCents - reduceCents;
  if (openCents > 0 && !shortingEnabled) {
    const maxSellCents = Math.max(net, 0);
    return {
      ok: false,
      reason: "shorting_disabled",
      message: `Sell of ${amountCents} cents exceeds the open position of ${maxSellCents} cents and shorting is disabled`,
      maxSellCents,
    };
  }
  return { ok: true, resolution: { reduceCents, openCents, openDirection: openCents > 0 ? "LOW" : null, netAfterCents: net - amountCents } };
}

/** Under the gate a Sell can only close: this is how much. With shorting on there is no ceiling here. */
export function maxSellCents(netBeforeCents: number, shortingEnabled: boolean): number | null {
  return shortingEnabled ? null : Math.max(Math.trunc(netBeforeCents), 0);
}
