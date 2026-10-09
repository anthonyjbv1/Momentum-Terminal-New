import { NextResponse, type NextRequest } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import { authorizeSharedSecret } from "@/lib/api-auth";
import { allegationTerm, isAllegationCategory, type AllegationCategory } from "@/lib/engine/sentiment/allegations";
import { getEngineSecretOrNull, getIngestSecretOrNull } from "@/lib/env";
import { routedComplete } from "@/lib/llm/routing";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import type { Json } from "@/types/database";

/**
 * GET /api/admin/allegation-scan — the two detection methods over the
 * stored backlog (2026-10-09, read-only).
 *
 * For the newest article signals of the window (every person, or one), the
 * 59-term backstop and the scoring call's allegation label are both run and
 * compared: how many each flags, and where they disagree, with the
 * publisher's tier so the operator can see what the rule would hold. The
 * model is asked for the label alone (no score, no narrative), twenty
 * headlines a call. Nothing is written.
 *
 *   ?days=30        the window (default 30, at most 60)
 *   ?person=slug    one person (default everyone)
 *   ?limit=400      the newest N stories (default 400, at most 2000)
 *
 * Protected by INGEST_SECRET or ENGINE_SECRET, like the health check, or
 * by the operator's own admin session, so the console's user can open it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH = 20;

const SYSTEM = `You classify news headlines for a scoring engine. For each headline, say whether it carries an UNVERIFIED allegation of a serious crime about the named person or a member of their family, whatever the story's stance: "sexual_abuse" (sexual abuse, assault, harassment or misconduct), "violence" (physical violence against a person), "minors" (any crime against a minor: grooming, exploitation, abuse of a child), or "none". A denial, a lawsuit over the claim or a reaction to it still carries the claim. A conviction or a charge is still labelled. "none" for everything else, including obituaries, illnesses, an arrest for a minor offence, and claims about an unrelated third party. Respond with JSON only: {"items":[{"id":"...","allegation":"none"}]}`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "allegation"], properties: { id: { type: "string" }, allegation: { type: "string", enum: ["none", "sexual_abuse", "violence", "minors"] } } },
    },
  },
};

function authorize(headers: Headers) {
  const ingest = authorizeSharedSecret(headers, getIngestSecretOrNull(), { headerName: "x-ingest-secret", envName: "INGEST_SECRET" });
  if (ingest.ok) return ingest;
  const engine = authorizeSharedSecret(headers, getEngineSecretOrNull(), { headerName: "x-engine-secret", envName: "ENGINE_SECRET" });
  if (engine.ok) return engine;
  return ingest.status === 401 ? ingest : engine;
}

interface Row {
  id: string;
  headline: string;
  occurred_at: string;
  tier: number | null;
  raw_payload: Json | null;
  people: { slug: string; display_name: string } | null;
}

function field(payload: Json | null, key: string): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

export async function GET(request: NextRequest) {
  const auth = authorize(request.headers);
  if (!auth.ok) {
    const admin = await getAdminUser().catch(() => null);
    if (!admin) return NextResponse.json({ error: auth.message }, { status: auth.status });
  }
  const days = Math.min(60, Math.max(1, Number(request.nextUrl.searchParams.get("days") ?? 30) || 30));
  const limit = Math.min(2000, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 400) || 400));
  const person = request.nextUrl.searchParams.get("person")?.trim() || null;

  try {
    const admin = createSupabaseAdminClient();
    let query = admin
      .from("signals")
      .select("id, headline, occurred_at, tier, raw_payload, people!inner(slug, display_name)")
      .eq("raw_payload->>kind", "article")
      .gte("occurred_at", new Date(Date.now() - days * 86_400_000).toISOString())
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (person) query = query.eq("people.slug", person);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Row[];

    const byModel = new Map<string, AllegationCategory | "none">();
    let calls = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const userPrompt = batch.map((row) => `id=${row.id} | person=${row.people?.display_name ?? "?"} | ${row.headline}`).join("\n");
      const response = await routedComplete({ taskType: "sentiment", systemPrompt: SYSTEM, userPrompt, responseFormat: { type: "json", schema: SCHEMA, name: "allegation_scan" }, maxTokens: 1200 });
      calls += 1;
      const items = (response.structuredData as { items?: Array<{ id?: string; allegation?: string }> } | undefined)?.items ?? [];
      for (const item of items) {
        if (typeof item.id !== "string") continue;
        byModel.set(item.id, isAllegationCategory(item.allegation) ? item.allegation : "none");
      }
    }

    const items = rows.map((row) => {
      const terms = allegationTerm(row.headline);
      const model = byModel.get(row.id) ?? null;
      const publisherTier = Number(field(row.raw_payload, "publisher_tier") ?? row.tier ?? 5);
      const domain = field(row.raw_payload, "publisher_domain");
      return {
        id: row.id,
        person: row.people?.slug ?? null,
        occurredAt: row.occurred_at,
        headline: row.headline,
        publisherDomain: domain,
        publisherTier,
        terms: terms?.category ?? "none",
        term: terms?.term ?? null,
        model: model ?? "unscored",
        wouldHold: (terms !== null || (model !== null && model !== "none")) && !(domain !== null && publisherTier <= 2),
      };
    });
    const flaggedByTerms = items.filter((i) => i.terms !== "none");
    const flaggedByModel = items.filter((i) => i.model !== "none" && i.model !== "unscored");
    const disagreements = items.filter((i) => (i.terms !== "none") !== (i.model !== "none" && i.model !== "unscored") || (i.terms !== "none" && i.model !== "none" && i.model !== "unscored" && i.terms !== i.model));
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      window: { days, person, stories: rows.length, limit },
      llmCalls: calls,
      counts: { terms: flaggedByTerms.length, model: flaggedByModel.length, both: items.filter((i) => i.terms !== "none" && i.model !== "none" && i.model !== "unscored").length, disagreements: disagreements.length, wouldHold: items.filter((i) => i.wouldHold).length },
      flagged: items.filter((i) => i.terms !== "none" || (i.model !== "none" && i.model !== "unscored")),
      disagreements,
    });
  } catch (error) {
    console.error("[admin/allegation-scan] failed:", error);
    return NextResponse.json({ error: "Scan failed", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
