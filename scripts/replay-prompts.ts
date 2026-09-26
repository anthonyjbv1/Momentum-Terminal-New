/**
 * REPLAY: the version-2 sentiment prompt (salience + analyst's note) against
 * recent ticks, compared with what version 1 stored.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... \
 *     npx tsx scripts/replay-prompts.ts [--sample 40] [--since 7d] [--v1]
 *
 * For each of the newest `sample` LLM narratives it rebuilds the chunk the
 * tick scored (the narrative's linked signals, the person's memory as it is
 * now), asks the model with the version-2 prompt, and prints:
 *
 *   - per-signal label agreement with the stored sentiment_label, and the
 *     label distribution before and after (the shift the prompt causes)
 *   - the salience distribution, with every incidental and unrelated headline
 *   - the old narrative, the new one, and whether the declared direction
 *     agrees with the stored move (checkNarrative)
 *
 * With --v1 it asks version 1 again instead, so the model's own run-to-run
 * variance can be told apart from the prompt's effect. Reads the database
 * through the service role, calls the model, WRITES NOTHING. Cost: one call
 * per sampled narrative at the sentiment route's price.
 *
 * The memory is today's memory, not the memory at the time of the tick, so a
 * disagreement on a signal from days ago can be the memory's doing rather
 * than the prompt's; the comparison is strongest on the newest narratives.
 */
import { createClient } from "@supabase/supabase-js";

import { DEFAULT_ENGINE_CONFIG } from "../lib/engine/config";
import { createSupabaseMemoryStore } from "../lib/engine/memory/store";
import { checkNarrative } from "../lib/engine/narratives";
import { buildSentimentUserPrompt, sentimentPrompt, type SentimentPromptVersion } from "../lib/engine/sentiment/prompts";
import { routedComplete } from "../lib/llm/routing";
import type { Database } from "../types/database";

function argNumber(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function argDuration(name: string, fallbackDays: number): Date {
  const index = process.argv.indexOf(`--${name}`);
  const raw = index === -1 ? `${fallbackDays}d` : process.argv[index + 1];
  const match = /^(\d+)([dh])$/.exec(raw ?? "");
  const hours = match ? Number(match[1]) * (match[2] === "d" ? 24 : 1) : fallbackDays * 24;
  return new Date(Date.now() - hours * 3_600_000);
}

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required; the model key is read by the provider (ANTHROPIC_API_KEY by default).");
  process.exit(2);
}
const version: SentimentPromptVersion = process.argv.includes("--v1") ? 1 : 2;
const sample = argNumber("sample", 40);
const since = argDuration("since", 7);

const client = createClient<Database>(url, key, { auth: { persistSession: false } });
const memoryStore = createSupabaseMemoryStore(client);

type Label = "positive" | "negative" | "neutral";
const counts = (labels: Label[]) => ({ positive: labels.filter((l) => l === "positive").length, negative: labels.filter((l) => l === "negative").length, neutral: labels.filter((l) => l === "neutral").length });

async function main() {
  const { data: narratives, error } = await client
    .from("narratives")
    .select("id, person_id, text, created_at, score_before, score_after, narrative_signals(signal_id, relation)")
    .eq("source", "llm")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(sample);
  if (error) throw new Error(error.message);
  if (!narratives || narratives.length === 0) {
    console.log("no LLM narratives in the window");
    return;
  }

  const personIds = [...new Set(narratives.map((n) => n.person_id))];
  const { data: people } = await client.from("people").select("id, slug, display_name, category").in("id", personIds);
  const peopleById = new Map((people ?? []).map((p) => [p.id, p]));
  const memories = await memoryStore.loadMany(personIds);
  const prompt = sentimentPrompt(version);

  const storedLabels: Label[] = [];
  const newLabels: Label[] = [];
  let agreements = 0;
  let compared = 0;
  const saliences = { relevant: 0, incidental: 0, unrelated: 0 };
  const notRelevant: string[] = [];
  let directionChecks = 0;
  let directionAgreed = 0;
  const sentences: string[] = [];

  for (const narrative of narratives) {
    const person = peopleById.get(narrative.person_id);
    if (!person) continue;
    const ids = (narrative.narrative_signals ?? []).filter((l) => l.relation === "direct").map((l) => l.signal_id);
    if (ids.length === 0) continue;
    const { data: signals } = await client.from("signals").select("id, headline, raw_payload, impact_score, sentiment_label, data_sources(name, tier), tier").in("id", ids);
    if (!signals || signals.length === 0) continue;

    const inputs = signals.map((s) => ({
      id: s.id,
      personId: person.id,
      headline: s.headline,
      rawPayload: s.raw_payload,
      sourceName: (s.data_sources as { name: string } | null)?.name ?? "unknown",
      sourceTier: s.tier ?? (s.data_sources as { tier: number } | null)?.tier ?? 5,
    }));
    const memory = memories.get(person.id) ?? { personId: person.id, profile: {}, baselinePatterns: {}, recentContext: { summary: "No notable events recorded yet.", notable_events: [] }, updatedAt: null };
    const response = await routedComplete({
      taskType: "sentiment",
      systemPrompt: prompt.systemPrompt,
      userPrompt: buildSentimentUserPrompt(
        { displayName: person.display_name, slug: person.slug, category: person.category, memory, today: new Date(narrative.created_at), eventMaxAgeDays: DEFAULT_ENGINE_CONFIG.memory.maxEventAgeDays },
        inputs,
      ),
      responseFormat: { type: "json", schema: prompt.schema, name: prompt.name },
      timeoutMs: 30_000,
    });
    const data = response.structuredData as { signals?: Array<{ id: string; label: Label; salience?: keyof typeof saliences }>; narrative?: string; narrative_direction?: "up" | "down" | "flat" } | null;
    if (!data?.signals) continue;

    for (const s of signals) {
      const fresh = data.signals.find((x) => x.id === s.id);
      if (!fresh) continue;
      const stored = (s.sentiment_label ?? "neutral") as Label;
      storedLabels.push(stored);
      newLabels.push(fresh.label);
      compared += 1;
      if (fresh.label === stored) agreements += 1;
      if (fresh.salience && fresh.salience in saliences) {
        saliences[fresh.salience] += 1;
        if (fresh.salience !== "relevant") notRelevant.push(`${person.display_name}: [${fresh.salience}] ${s.headline}`);
      }
    }

    const signalsImpact = signals.reduce((sum, s) => sum + Number(s.impact_score ?? 0), 0);
    if (data.narrative) {
      const check = checkNarrative(data.narrative, data.narrative_direction, signalsImpact, DEFAULT_ENGINE_CONFIG.narratives.minAbsChange);
      directionChecks += 1;
      if (check.ok) directionAgreed += 1;
      sentences.push(
        [`${person.display_name}  ${narrative.created_at.slice(0, 16)}  move ${Number(narrative.score_after) - Number(narrative.score_before) >= 0 ? "+" : ""}${(Number(narrative.score_after) - Number(narrative.score_before)).toFixed(2)}  signals ${signalsImpact >= 0 ? "+" : ""}${signalsImpact.toFixed(2)}`, `  was: ${narrative.text}`, `  now: ${data.narrative}  [${data.narrative_direction ?? "n/a"}${check.ok ? "" : `, REPLACED: ${check.reason}`}]`].join("\n"),
      );
    }
  }

  console.log(`prompt version ${version}, ${narratives.length} narratives, ${compared} signals compared\n`);
  console.log(`label agreement with stored: ${compared > 0 ? ((100 * agreements) / compared).toFixed(1) : "n/a"}%`);
  console.log(`stored labels: ${JSON.stringify(counts(storedLabels))}`);
  console.log(`new labels:    ${JSON.stringify(counts(newLabels))}`);
  if (version === 2) {
    console.log(`salience: ${JSON.stringify(saliences)}`);
    if (notRelevant.length > 0) console.log(`\nnot relevant:\n  ${notRelevant.join("\n  ")}`);
    console.log(`\nnarrative direction agrees with the Signals force and passes the voice check: ${directionAgreed} of ${directionChecks}`);
  }
  console.log(`\n${sentences.join("\n\n")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
