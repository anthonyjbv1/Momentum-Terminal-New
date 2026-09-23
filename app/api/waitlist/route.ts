import { NextResponse, type NextRequest } from "next/server";

import { logPublicEventInBackground } from "@/lib/behavioral/public-log";
import { joinWaitlist, parseWaitlistBody, toWaitlistResponse, type JoinResult, type WaitlistSubmission } from "@/lib/landing/waitlist";
import { createSupabaseRateLimiter } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * POST /api/waitlist — the one way onto the waitlist (Phase 28).
 *
 * Body: { email, source?: "landing_hero" | "landing_footer", utm?: {source,
 * medium, campaign, content, term}, referrer?, website? }. `website` is the
 * honeypot: a person never sees the field, so anything in it is a bot and
 * the request is dropped behind a success that gives nothing away.
 *
 * No session. Rate-limited per address in the DATABASE (five in ten minutes,
 * held across instances), then join_waitlist() through the service role —
 * the table itself grants nothing to any client. A known address and a new
 * one get the same answer, so the route cannot be used to test whether
 * somebody is on the list. The address is never logged; the behavioural
 * event records only which form and what became of the submission.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientAddress(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = parseWaitlistBody(body);
  if (typeof parsed === "string") {
    const { body: out, status, headers } = toWaitlistResponse({ ok: false, code: "invalid" });
    return NextResponse.json(out, { status, headers });
  }

  const admin = createSupabaseAdminClient();
  const join = async (submission: WaitlistSubmission): Promise<JoinResult> => {
    const { data, error } = await admin.rpc("join_waitlist", {
      p_email: submission.email,
      p_source: submission.source,
      p_utm: submission.utm,
      p_referrer: submission.referrer ?? undefined,
    });
    if (error) throw new Error(error.message);
    const record = (data ?? {}) as Record<string, unknown>;
    const position = typeof record.position === "number" ? record.position : Number(record.position);
    if (!Number.isFinite(position)) throw new Error("join_waitlist returned no position");
    return { created: record.created === true, position };
  };

  const { outcome, disposition } = await joinWaitlist(parsed, { limiter: createSupabaseRateLimiter(admin), join, ip: clientAddress(request) });
  logPublicEventInBackground({ eventType: "join_waitlist", metadata: { source: parsed.source, disposition } });

  const { body: out, status, headers } = toWaitlistResponse(outcome);
  return NextResponse.json(out, { status, headers });
}
