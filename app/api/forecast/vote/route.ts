import { NextResponse, type NextRequest } from "next/server";

import { logEventInBackground } from "@/lib/behavioral/log";
import { getCurrentUser } from "@/lib/auth";
import { isForecastDirection, isForecastReason, type CastForecastResult, type ForecastRejectionCode } from "@/lib/forecast/model";
import { castForecastVoteAsUser, type CastForecastInput } from "@/lib/forecast/server";

/**
 * POST /api/forecast/vote — the one way a forecast reaches the database.
 *
 * Body: { personId, direction: "rising" | "falling", reason, surface? }
 *
 * Identity comes from the auth cookies, never from the body. The server
 * validates the vocabulary, and cast_forecast_vote() decides everything
 * else — the person's pause flag, the rate limit, the supersede — inside
 * one transaction, returning refusals as values with a code. The score at
 * vote time is the server's reading, never the client's.
 *
 * The cast_forecast behavioural event is written after the response,
 * fire-and-forget: it never blocks or fails the vote.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reject(status: number, code: ForecastRejectionCode, message: string) {
  const body: CastForecastResult = { ok: false, code, message };
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function parse(body: unknown): (CastForecastInput & { surface: string | null }) | string {
  if (typeof body !== "object" || body === null) return "The forecast must be a JSON object.";
  const record = body as Record<string, unknown>;
  const personId = typeof record.personId === "string" ? record.personId.trim().toLowerCase() : "";
  if (!UUID.test(personId)) return "personId must be a person's id.";
  const direction = typeof record.direction === "string" ? record.direction.trim().toLowerCase() : "";
  if (!isForecastDirection(direction)) return "direction must be rising or falling.";
  const reason = typeof record.reason === "string" ? record.reason.trim().toLowerCase() : "";
  if (!isForecastReason(reason)) return "reason must be one of the seven tags.";
  const surface = typeof record.surface === "string" && record.surface.trim() ? record.surface.trim().slice(0, 40) : null;
  return { personId, direction, reason, surface };
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return reject(401, "unauthenticated", "Sign in to forecast.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reject(400, "invalid", "The forecast must be JSON.");
  }
  const parsed = parse(body);
  if (typeof parsed === "string") return reject(400, "invalid", parsed);

  let result: CastForecastResult;
  try {
    result = await castForecastVoteAsUser(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not authenticated/i.test(message)) return reject(401, "unauthenticated", "Sign in to forecast.");
    console.error("[forecast] cast_forecast_vote failed:", message);
    return reject(503, "unavailable", "Forecasts are unavailable right now. Nothing was recorded.");
  }

  if (result.ok && result.changed) {
    logEventInBackground([
      { eventType: "cast_forecast", personId: parsed.personId, metadata: { direction: parsed.direction, reason: parsed.reason, changed: true, surface: parsed.surface ?? "profile" } },
    ]);
  }
  return NextResponse.json(result, { headers: NO_STORE });
}
