import { NextResponse, type NextRequest } from "next/server";

import { logEventInBackground } from "@/lib/behavioral/log";
import type { BehavioralEventInput } from "@/lib/behavioral/events";
import { getCurrentUser } from "@/lib/auth";
import type { OrderSide } from "@/lib/trading/direction";
import { MAX_ORDER_UNITS, type OrderRejectionCode, type OrderResult } from "@/lib/trading/model";
import { placeOrderAsUser } from "@/lib/trading/server";

/**
 * POST /api/trade/order — the one way an order reaches the database.
 *
 * Body: { personId, side: "BUY" | "SELL", units, quotedPriceCents?, surface? }
 *
 * The client sends what it wants and the price it displayed; nothing else.
 * The server reads the quote, checks the tolerance, the gate, the levers and
 * the balance, and fills or refuses inside place_order(). Every refusal is a
 * structured value with a code, a sentence and the current quote, so the
 * sheet can say exactly what happened. Identity comes from the auth cookies,
 * never from the body.
 *
 * Behavioural events (take_position, close_position, reject_trade) are
 * written after the response, fire-and-forget: they never block or fail a
 * financial write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reject(status: number, code: OrderRejectionCode, message: string) {
  const body: OrderResult = { ok: false, code, message, quote: null, extra: {} };
  return NextResponse.json(body, { status, headers: NO_STORE });
}

interface ParsedOrder {
  personId: string;
  side: OrderSide;
  units: number;
  quotedPriceCents: number | null;
  surface: string | null;
}

function parse(body: unknown): ParsedOrder | string {
  if (typeof body !== "object" || body === null) return "The order must be a JSON object.";
  const record = body as Record<string, unknown>;
  const personId = typeof record.personId === "string" ? record.personId.trim().toLowerCase() : "";
  if (!UUID.test(personId)) return "personId must be a person's id.";
  const side = typeof record.side === "string" ? record.side.trim().toUpperCase() : "";
  if (side !== "BUY" && side !== "SELL") return "side must be BUY or SELL.";
  const units = typeof record.units === "number" ? record.units : Number(record.units);
  if (!Number.isSafeInteger(units) || units <= 0 || units > MAX_ORDER_UNITS) return `units must be a whole number from 1 to ${MAX_ORDER_UNITS}.`;
  let quotedPriceCents: number | null = null;
  if (record.quotedPriceCents !== undefined && record.quotedPriceCents !== null) {
    const quoted = typeof record.quotedPriceCents === "number" ? record.quotedPriceCents : Number(record.quotedPriceCents);
    if (!Number.isSafeInteger(quoted) || quoted <= 0) return "quotedPriceCents must be a positive integer number of cents.";
    quotedPriceCents = quoted;
  }
  const surface = typeof record.surface === "string" && record.surface.trim() ? record.surface.trim().slice(0, 40) : null;
  return { personId, side, units, quotedPriceCents, surface };
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return reject(401, "unauthenticated", "Sign in to trade.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reject(400, "invalid", "The order must be JSON.");
  }
  const parsed = parse(body);
  if (typeof parsed === "string") return reject(400, "invalid", parsed);

  let result: OrderResult;
  try {
    result = await placeOrderAsUser(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not authenticated/i.test(message)) return reject(401, "unauthenticated", "Sign in to trade.");
    console.error("[trade] place_order failed:", message);
    return reject(503, "unavailable", "Trading is unavailable right now. Nothing was placed.");
  }

  logEventInBackground(eventsFor(parsed, result));
  return NextResponse.json(result, { headers: NO_STORE });
}

/** The Phase 5 events an order produces. Amounts are the server's, never the client's. */
function eventsFor(order: ParsedOrder, result: OrderResult): BehavioralEventInput[] {
  const surface = order.surface ?? "profile";
  if (!result.ok) {
    return [{ eventType: "reject_trade", personId: order.personId, metadata: { side: order.side, code: result.code, units: order.units, surface } }];
  }
  const events: BehavioralEventInput[] = [];
  const filled = result.order;
  if (filled.openedUnits > 0 && filled.openedDirection) {
    events.push({
      eventType: "take_position",
      personId: order.personId,
      metadata: {
        direction: filled.openedDirection,
        amount_cents: filled.costCents,
        units: filled.openedUnits,
        price_cents: filled.fillPriceCents,
        position_id: filled.positionId ?? undefined,
        order_id: filled.id,
        surface,
      },
    });
  }
  if (filled.closedUnits > 0) {
    events.push({
      eventType: "close_position",
      personId: order.personId,
      metadata: {
        direction: filled.side === "SELL" ? "HIGH" : "LOW",
        amount_cents: filled.proceedsCents,
        units: filled.closedUnits,
        price_cents: filled.fillPriceCents,
        pnl_cents: filled.realizedPnlCents,
        order_id: filled.id,
        surface,
      },
    });
  }
  return events;
}
