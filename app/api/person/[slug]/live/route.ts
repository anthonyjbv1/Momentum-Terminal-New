import { NextResponse } from "next/server";

import { getPersonBySlug } from "@/lib/person/profile";
import { isValidSlug } from "@/lib/person/profile-model";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * GET /api/person/[slug]/live?after=<ISO time>
 *
 * The profile page's tick feed. Returns the person's current score and
 * quotes plus every score_history tick newer than `after` (oldest first, at
 * most MAX_TICKS; when more exist the newest MAX_TICKS are returned and the
 * page accepts the gap). Without `after` it returns the last hour.
 *
 * Public read of public data, through the service-role client for the same
 * reason the page is (anon has no policies). Nothing here is cached: the
 * page asks once per 30-second tick, and the answer must be that tick.
 */

export const dynamic = "force-dynamic";

const MAX_TICKS = 240;
const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;
const NO_STORE = { "cache-control": "no-store" } as const;

type Params = Promise<{ slug: string }>;

export async function GET(request: Request, { params }: { params: Params }) {
  const { slug } = await params;
  if (!isValidSlug(slug)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const afterRaw = new URL(request.url).searchParams.get("after");
  const afterMs = afterRaw ? Date.parse(afterRaw) : Number.NaN;
  const since = Number.isFinite(afterMs) ? new Date(afterMs) : null;

  try {
    const person = await getPersonBySlug(slug);
    if (!person) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from("score_history")
      .select("score, recorded_at")
      .eq("person_id", person.id)
      .order("recorded_at", { ascending: false })
      .order("tick_number", { ascending: false })
      .limit(MAX_TICKS);
    query = since ? query.gt("recorded_at", since.toISOString()) : query.gte("recorded_at", new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString());

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const ticks = (data ?? [])
      .map((row) => ({ at: row.recorded_at, score: Number(row.score) }))
      .filter((tick) => Number.isFinite(tick.score))
      .reverse();

    return NextResponse.json(
      {
        score: person.score,
        lastTickAt: person.lastTickAt,
        buyPrice: person.buyPrice,
        sellPrice: person.sellPrice,
        spread: person.spread,
        ticks,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.warn("[person/live] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
