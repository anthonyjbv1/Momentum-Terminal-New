import { NextResponse } from "next/server";

import { marketAtTicks, type PremiumChange } from "@/lib/person/live-series";
import { getPersonBySlug } from "@/lib/person/profile";
import { isValidSlug } from "@/lib/person/profile-model";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * GET /api/person/[slug]/live?after=<ISO time>
 *
 * The profile page's tick feed. Returns the person's current score, market
 * price and quotes plus every score_history tick newer than `after` (oldest
 * first, at most MAX_TICKS; when more exist the newest MAX_TICKS are returned
 * and the page accepts the gap). Without `after` it returns the last hour.
 *
 * THE MARKET LINE (Phase 29). Each tick also carries the market price as it
 * stood at that tick: the score plus the premium from premium_history by the
 * same rule person_market_series() applies in SQL (the latest change at or
 * before the tick). The premium changes are read once per poll — a decay
 * step a tick while inventory stands, nothing while it is zero — and placed
 * under the ticks here rather than looked up per row.
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
    const from = since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    let query = supabase
      .from("score_history")
      .select("score, recorded_at")
      .eq("person_id", person.id)
      .order("recorded_at", { ascending: false })
      .order("tick_number", { ascending: false })
      .limit(MAX_TICKS);
    query = since ? query.gt("recorded_at", from.toISOString()) : query.gte("recorded_at", from.toISOString());

    const [history, changes, anchor] = await Promise.all([
      query,
      // Every premium change inside the window, and (below) the one before it.
      supabase
        .from("premium_history")
        .select("recorded_at, premium_before_cents, premium_after_cents")
        .eq("person_id", person.id)
        .gt("recorded_at", from.toISOString())
        .order("recorded_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(2 * MAX_TICKS),
      supabase
        .from("premium_history")
        .select("recorded_at, premium_before_cents, premium_after_cents")
        .eq("person_id", person.id)
        .lte("recorded_at", from.toISOString())
        .order("recorded_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
    ]);
    if (history.error) throw new Error(history.error.message);
    // The premium is an enhancement to the tick feed: without its history the
    // line is drawn at the premium as it stands, which is exact for the newest tick.
    if (changes.error) console.warn("[person/live] premium_history read failed:", changes.error.message);
    if (anchor.error) console.warn("[person/live] premium_history anchor read failed:", anchor.error.message);

    const premiumChanges: PremiumChange[] = [...(anchor.data ?? []), ...(changes.data ?? [])].map((row) => ({
      at: row.recorded_at,
      premiumBeforeCents: Number(row.premium_before_cents),
      premiumAfterCents: Number(row.premium_after_cents),
    }));

    const ticks = marketAtTicks(
      (history.data ?? [])
        .map((row) => ({ at: row.recorded_at, score: Number(row.score) }))
        .filter((tick) => Number.isFinite(tick.score))
        .reverse(),
      premiumChanges,
      person.premiumCents,
    );

    return NextResponse.json(
      {
        score: person.score,
        lastTickAt: person.lastTickAt,
        buyPrice: person.buyPrice,
        sellPrice: person.sellPrice,
        spread: person.spread,
        premiumCents: person.premiumCents,
        marketPrice: person.marketPrice,
        inventoryUnits: person.inventoryUnits,
        tradingMode: person.tradingMode,
        haltedUntil: person.haltedUntil,
        haltReason: person.haltReason,
        ticks,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.warn("[person/live] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
