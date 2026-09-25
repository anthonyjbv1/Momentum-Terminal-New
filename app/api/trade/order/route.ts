import { NextResponse, type NextRequest } from "next/server";

import { logEventInBackground } from "@/lib/behavioral/log";
import type { BehavioralEventInput } from "@/lib/behavioral/events";
import { getCurrentUser } from "@/lib/auth";
import { getFingerprintSaltOrNull } from "@/lib/env";
import type { OrderSide } from "@/lib/trading/direction";
import { fingerprintFor } from "@/lib/trading/fingerprint";
import { MAX_ORDER_SHARES, MIN_ORDER_CENTS, UNITS_PER_SHARE, sharesToUnits, type OrderRejectionCode, type OrderResult } from "@/lib/trading/model";
import { placeOrderAsUser } from "@/lib/trading/server";

/**
 * POST /api/trade/order — the one way an order reaches the database.
 *
 * Body: { personId, side: "BUY" | "SELL", quotedPriceCents?, surface? } plus
 * EXACTLY ONE of
 *
 *   shares         a quantity, fractional to three decimals (Shares mode)
 *   maxSpendCents  an amount to spend, in whole cents     (Dollars mode)
 *
 * Shares are converted to whole units here — thousandths of a share — and the
 * request declares that scale to place_order() rather than leaving it to be
 * guessed. In Dollars mode no quantity is sent at all: the server resolves it
 * against the quote it just read, so the amount cannot be computed against a
 * price that has since moved.
 *
 * The client sends what it wants and the price it displayed; nothing else.
 * The server reads the quote, checks the tolerance, the gate, the levers and
 * the balance, and fills or refuses inside place_order(). Every refusal is a
 * structured value with a code, a sentence and the current quote, so the
 * sheet can say exactly what happened. Identity comes from the auth cookies,
 * never from the body.
 *
 * THE FINGERPRINT (Phase 29). The route hashes the connection's address and
 * user agent with FINGERPRINT_SALT and passes the hash — never the inputs —
 * to place_order(), which stores it on the order for the shared-
 * infrastructure detector (several accounts trading one person from one
 * hash inside the surveillance window). The client cannot influence it: it is
 * read from the request's own headers here, not from the body. No salt, no
 * hash, and that detector stays silent.
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
  /** Shares mode: whole units. Null in Dollars mode. */
  units: number | null;
  /** Dollars mode: whole cents. Null in Shares mode. */
  maxSpendCents: number | null;
  quotedPriceCents: number | null;
  surface: string | null;
  /** Computed from the request's headers, never parsed from the body. */
  fingerprintHash: string | null;
}

function parse(body: unknown): ParsedOrder | string {
  if (typeof body !== "object" || body === null) return "The order must be a JSON object.";
  const record = body as Record<string, unknown>;
  const personId = typeof record.personId === "string" ? record.personId.trim().toLowerCase() : "";
  if (!UUID.test(personId)) return "personId must be a person's id.";
  const side = typeof record.side === "string" ? record.side.trim().toUpperCase() : "";
  if (side !== "BUY" && side !== "SELL") return "side must be BUY or SELL.";

  // EXACTLY ONE MODE, checked here as well as in SQL, so a confused client
  // gets a sentence rather than a raised exception.
  const wantsShares = record.shares !== undefined && record.shares !== null;
  const wantsSpend = record.maxSpendCents !== undefined && record.maxSpendCents !== null;
  if (wantsShares === wantsSpend) return "Send either shares or maxSpendCents, not both.";

  let units: number | null = null;
  let maxSpendCents: number | null = null;
  if (wantsShares) {
    const shares = typeof record.shares === "number" ? record.shares : Number(record.shares);
    if (!Number.isFinite(shares) || shares <= 0 || shares > MAX_ORDER_SHARES) {
      return `shares must be a number from ${1 / UNITS_PER_SHARE} to ${MAX_ORDER_SHARES.toLocaleString("en-US")}.`;
    }
    units = sharesToUnits(shares);
    // A quantity finer than a thousandth rounds to nothing and would otherwise
    // reach the database as a zero it has to refuse in a less helpful way.
    if (units <= 0) return `The smallest quantity is ${1 / UNITS_PER_SHARE} of a share.`;
  } else {
    const spend = typeof record.maxSpendCents === "number" ? record.maxSpendCents : Number(record.maxSpendCents);
    if (!Number.isSafeInteger(spend) || spend < MIN_ORDER_CENTS) return "maxSpendCents must be a whole number of cents, at least the minimum order.";
    if (spend > MAX_ORDER_SHARES * 100 * 100) return "maxSpendCents is larger than any order this interface places.";
    maxSpendCents = spend;
  }

  let quotedPriceCents: number | null = null;
  if (record.quotedPriceCents !== undefined && record.quotedPriceCents !== null) {
    const quoted = typeof record.quotedPriceCents === "number" ? record.quotedPriceCents : Number(record.quotedPriceCents);
    if (!Number.isSafeInteger(quoted) || quoted <= 0) return "quotedPriceCents must be a positive integer number of cents.";
    quotedPriceCents = quoted;
  }
  const surface = typeof record.surface === "string" && record.surface.trim() ? record.surface.trim().slice(0, 40) : null;
  return { personId, side, units, maxSpendCents, quotedPriceCents, surface, fingerprintHash: null };
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
  const parsedBody = parse(body);
  if (typeof parsedBody === "string") return reject(400, "invalid", parsedBody);
  const parsed: ParsedOrder = { ...parsedBody, fingerprintHash: fingerprintFor(request.headers, getFingerprintSaltOrNull()) };

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

/**
 * The Phase 5 events an order produces. Amounts are the server's, never the
 * client's, and every units figure says what scale it is counted in.
 */
function eventsFor(order: ParsedOrder, result: OrderResult): BehavioralEventInput[] {
  const surface = order.surface ?? "profile";
  if (!result.ok) {
    return [
      {
        eventType: "reject_trade",
        personId: order.personId,
        metadata: {
          side: order.side,
          code: result.code,
          // A Dollars-mode order has no quantity to report: it never got one.
          units: order.units ?? undefined,
          units_per_share: order.units === null ? undefined : UNITS_PER_SHARE,
          requested_cents: order.maxSpendCents ?? undefined,
          surface,
        },
      },
    ];
  }
  const events: BehavioralEventInput[] = [];
  const filled = result.order;
  // The parsed order speaks units; the result has been through the read path
  // and speaks shares, so it converts back here rather than logging two scales.
  if (filled.openedUnits > 0 && filled.openedDirection) {
    events.push({
      eventType: "take_position",
      personId: order.personId,
      metadata: {
        direction: filled.openedDirection,
        amount_cents: filled.costCents,
        units: sharesToUnits(filled.openedUnits),
        units_per_share: UNITS_PER_SHARE,
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
        units: sharesToUnits(filled.closedUnits),
        units_per_share: UNITS_PER_SHARE,
        price_cents: filled.fillPriceCents,
        pnl_cents: filled.realizedPnlCents,
        order_id: filled.id,
        surface,
      },
    });
  }
  return events;
}
