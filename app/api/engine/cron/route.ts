import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest, runScheduledTicks } from "@/lib/engine/cron";
import { runFullTick } from "@/lib/engine/run-tick";
import { getCronSecretOrNull, getEngineSecretOrNull, isEngineCronEnabled } from "@/lib/env";

/**
 * GET /api/engine/cron — the scheduled Engine heartbeat (see vercel.json:
 * every minute). Order of checks:
 *
 *   1. ENGINE_CRON_ENABLED must be exactly "true", otherwise the handler logs
 *      "skipped (disabled)" and returns immediately: no tick, no LLM call,
 *      no cost. This is the switch, and it defaults to OFF.
 *   2. The caller must be Vercel Cron (Authorization: Bearer CRON_SECRET) or
 *      hold ENGINE_SECRET.
 *   3. Two ticks, 30 seconds apart, through the same runFullTick() path the
 *      manual /api/engine/tick route uses — within a 55-second budget so the
 *      invocation never outruns maxDuration.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const enabled = isEngineCronEnabled();

  if (!enabled) {
    const result = await runScheduledTicks({ enabled: false, runTick: () => runFullTick({ trigger: "cron" }) });
    return NextResponse.json(result);
  }

  const auth = authorizeCronRequest(request.headers, { cronSecret: getCronSecretOrNull(), engineSecret: getEngineSecretOrNull() });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  const result = await runScheduledTicks({ enabled: true, runTick: () => runFullTick({ trigger: "cron" }) });
  return NextResponse.json(result, { status: result.ticks.some((t) => !t.ok) ? 500 : 200 });
}
