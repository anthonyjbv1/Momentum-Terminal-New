/**
 * REPLAY: the version-2 sentiment prompt (salience + analyst's note) against
 * recent ticks, compared with what version 1 stored.
 *
 *   npx tsx scripts/replay-prompts.ts [--sample 40] [--since 7d] [--v1]
 *
 * For each of the newest `sample` LLM narratives it rebuilds the chunk the
 * tick scored (the narrative's linked signals, the person's memory as it is
 * now), asks the model, and prints:
 *
 *   - per-signal label agreement with the stored sentiment_label, and the
 *     label distribution before and after (the shift the prompt causes)
 *   - the salience distribution, with every headline not labelled relevant
 *   - the old narrative, the new one, and whether the declared direction
 *     agrees with the stored move (checkNarrative)
 *
 * Run it TWICE: once with version 2 (the default) and once with --v1, which
 * asks the production prompt again. The --v1 run's disagreement with the
 * stored labels is the model's own run-to-run variance; the difference
 * between the two runs is the prompt's effect. It WRITES NOTHING.
 *
 * ACCESS. The model key is read by the provider (ANTHROPIC_API_KEY for the
 * default provider); set LLM_MODEL, and LLM_MODEL_SENTIMENT if production
 * sets it, to the same values as production, or the comparison measures two
 * models. The database is read through the first of these that is set:
 *
 *   REPLAY_DATABASE_URL          a direct Postgres connection as a READ-ONLY
 *                                role (see the README for the role); pg, TLS
 *                                per the URL's sslmode
 *   REPLAY_USER_EMAIL +          an ordinary account signed in through the
 *   REPLAY_USER_PASSWORD +       publishable key: the six tables it reads all
 *   NEXT_PUBLIC_SUPABASE_URL +   carry SELECT policies for `authenticated`,
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   so no privileged key is needed
 *   SUPABASE_SERVICE_ROLE_KEY +  the service role (the last resort; it can
 *   SUPABASE_URL                 write, this script never does)
 *
 * The memory is today's memory, not the memory at the time of the tick, so a
 * disagreement on a signal from days ago can be the memory's doing rather
 * than the prompt's; the comparison is strongest on the newest narratives.
 */
import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";

import { DEFAULT_ENGINE_CONFIG } from "../lib/engine/config";
import type { PersonMemory } from "../lib/engine/memory/types";
import { checkNarrative } from "../lib/engine/narratives";
import { buildSentimentUserPrompt, sentimentPrompt, type SentimentPromptVersion } from "../lib/engine/sentiment/prompts";
import type { SentimentInput } from "../lib/engine/sentiment/types";
import { routedComplete } from "../lib/llm/routing";
import type { Database, Json } from "../types/database";

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

type Label = "positive" | "negative" | "neutral";
type Salience = "relevant" | "wealth_ranking" | "incidental" | "unrelated";

interface NarrativeRow {
  id: string;
  person_id: string;
  text: string;
  created_at: string;
  score_before: number;
  score_after: number;
  signal_ids: string[];
}
interface PersonRow {
  id: string;
  slug: string;
  display_name: string;
  category: string;
}
interface SignalRow {
  id: string;
  headline: string;
  raw_payload: Json | null;
  impact_score: number;
  sentiment_label: Label | null;
  tier: number | null;
  source_name: string;
  source_tier: number;
}

/** The four reads, behind whichever access the environment offers. */
interface Reader {
  readonly kind: string;
  narratives(since: Date, limit: number): Promise<NarrativeRow[]>;
  people(ids: string[]): Promise<PersonRow[]>;
  signals(ids: string[]): Promise<SignalRow[]>;
  memories(ids: string[]): Promise<Map<string, PersonMemory>>;
  close(): Promise<void>;
}

function memoryFrom(row: { person_id: string; profile: Json; baseline_patterns: Json; recent_context: Json; updated_at: string | null }): PersonMemory {
  const object = (value: Json): Record<string, Json | undefined> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : {});
  const recent = object(row.recent_context);
  return {
    personId: row.person_id,
    profile: object(row.profile) as PersonMemory["profile"],
    baselinePatterns: object(row.baseline_patterns) as PersonMemory["baselinePatterns"],
    recentContext: {
      summary: typeof recent.summary === "string" ? recent.summary : "No notable events recorded yet.",
      notable_events: Array.isArray(recent.notable_events) ? (recent.notable_events as unknown as PersonMemory["recentContext"]["notable_events"]) : [],
    },
    updatedAt: row.updated_at,
  };
}

async function pgReader(url: string): Promise<Reader> {
  const client = new PgClient({ connectionString: url });
  await client.connect();
  // Belt and braces: a read-only role cannot write anyway; a session that is read-only refuses to even try.
  await client.query("set session characteristics as transaction read only");
  return {
    kind: "direct connection",
    async narratives(since, limit) {
      const { rows } = await client.query<NarrativeRow>(
        `select n.id, n.person_id, n.text, n.created_at::text as created_at, n.score_before::float8 as score_before, n.score_after::float8 as score_after,
                coalesce(array_agg(ns.signal_id) filter (where ns.signal_id is not null and ns.relation = 'direct'), '{}') as signal_ids
           from public.narratives n left join public.narrative_signals ns on ns.narrative_id = n.id
          where n.source = 'llm' and n.created_at >= $1
          group by n.id order by n.created_at desc limit $2`,
        [since.toISOString(), limit],
      );
      return rows;
    },
    async people(ids) {
      const { rows } = await client.query<PersonRow>(`select id, slug, display_name, category from public.people where id = any($1::uuid[])`, [ids]);
      return rows;
    },
    async signals(ids) {
      const { rows } = await client.query<SignalRow>(
        `select s.id, s.headline, s.raw_payload, s.impact_score::float8 as impact_score, s.sentiment_label, s.tier, d.name as source_name, d.tier as source_tier
           from public.signals s join public.data_sources d on d.id = s.data_source_id where s.id = any($1::uuid[])`,
        [ids],
      );
      return rows;
    },
    async memories(ids) {
      const { rows } = await client.query<{ person_id: string; profile: Json; baseline_patterns: Json; recent_context: Json; updated_at: string | null }>(
        `select person_id, profile, baseline_patterns, recent_context, updated_at::text as updated_at from public.person_memory where person_id = any($1::uuid[])`,
        [ids],
      );
      return new Map(rows.map((row) => [row.person_id, memoryFrom(row)]));
    },
    async close() {
      await client.end();
    },
  };
}

async function restReader(url: string, key: string, login?: { email: string; password: string }): Promise<Reader> {
  const client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  if (login) {
    const { error } = await client.auth.signInWithPassword(login);
    if (error) throw new Error(`sign-in failed: ${error.message}`);
  }
  return {
    kind: login ? "REST as an ordinary account" : "REST with the service role",
    async narratives(since, limit) {
      const { data, error } = await client
        .from("narratives")
        .select("id, person_id, text, created_at, score_before, score_after, narrative_signals(signal_id, relation)")
        .eq("source", "llm")
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => ({
        id: row.id,
        person_id: row.person_id,
        text: row.text,
        created_at: row.created_at,
        score_before: Number(row.score_before),
        score_after: Number(row.score_after),
        signal_ids: (row.narrative_signals ?? []).filter((l) => l.relation === "direct").map((l) => l.signal_id),
      }));
    },
    async people(ids) {
      const { data, error } = await client.from("people").select("id, slug, display_name, category").in("id", ids);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async signals(ids) {
      const { data, error } = await client.from("signals").select("id, headline, raw_payload, impact_score, sentiment_label, tier, data_sources(name, tier)").in("id", ids);
      if (error) throw new Error(error.message);
      return (data ?? []).map((s) => ({
        id: s.id,
        headline: s.headline,
        raw_payload: s.raw_payload,
        impact_score: Number(s.impact_score ?? 0),
        sentiment_label: (s.sentiment_label ?? null) as Label | null,
        tier: s.tier,
        source_name: (s.data_sources as { name: string } | null)?.name ?? "unknown",
        source_tier: (s.data_sources as { tier: number } | null)?.tier ?? 5,
      }));
    },
    async memories(ids) {
      const { data, error } = await client.from("person_memory").select("person_id, profile, baseline_patterns, recent_context, updated_at").in("person_id", ids);
      if (error) throw new Error(error.message);
      return new Map((data ?? []).map((row) => [row.person_id, memoryFrom(row)]));
    },
    async close() {
      if (login) await client.auth.signOut();
    },
  };
}

async function openReader(): Promise<Reader> {
  const env = process.env;
  if (env.REPLAY_DATABASE_URL) return pgReader(env.REPLAY_DATABASE_URL);
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  if (url && env.REPLAY_USER_EMAIL && env.REPLAY_USER_PASSWORD && env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return restReader(url, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { email: env.REPLAY_USER_EMAIL, password: env.REPLAY_USER_PASSWORD });
  }
  if (url && env.SUPABASE_SERVICE_ROLE_KEY) return restReader(url, env.SUPABASE_SERVICE_ROLE_KEY);
  throw new Error(
    "no database access: set REPLAY_DATABASE_URL (a read-only role), or REPLAY_USER_EMAIL + REPLAY_USER_PASSWORD with NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
  );
}

const counts = (labels: Label[]) => ({ positive: labels.filter((l) => l === "positive").length, negative: labels.filter((l) => l === "negative").length, neutral: labels.filter((l) => l === "neutral").length });

async function main() {
  const version: SentimentPromptVersion = process.argv.includes("--v1") ? 1 : 2;
  const sample = argNumber("sample", 40);
  const since = argDuration("since", 7);
  const reader = await openReader();
  console.log(`database: ${reader.kind}; prompt version ${version}; the newest ${sample} LLM narratives since ${since.toISOString()}\n`);

  const narratives = await reader.narratives(since, sample);
  if (narratives.length === 0) {
    console.log("no LLM narratives in the window");
    await reader.close();
    return;
  }
  const personIds = [...new Set(narratives.map((n) => n.person_id))];
  const peopleById = new Map((await reader.people(personIds)).map((p) => [p.id, p]));
  const memories = await reader.memories(personIds);
  const prompt = sentimentPrompt(version);

  const storedLabels: Label[] = [];
  const newLabels: Label[] = [];
  let agreements = 0;
  let compared = 0;
  const saliences: Record<Salience, number> = { relevant: 0, wealth_ranking: 0, incidental: 0, unrelated: 0 };
  const notRelevant: string[] = [];
  let directionChecks = 0;
  let directionAgreed = 0;
  const replaced: string[] = [];
  const sentences: string[] = [];

  for (const narrative of narratives) {
    const person = peopleById.get(narrative.person_id);
    if (!person || narrative.signal_ids.length === 0) continue;
    const signals = await reader.signals(narrative.signal_ids);
    if (signals.length === 0) continue;

    const inputs: SentimentInput[] = signals.map((s) => ({ id: s.id, personId: person.id, headline: s.headline, rawPayload: s.raw_payload, sourceName: s.source_name, sourceTier: s.tier ?? s.source_tier }));
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
    const data = response.structuredData as { signals?: Array<{ id: string; label: Label; salience?: Salience }>; narrative?: string; narrative_direction?: "up" | "down" | "flat" } | null;
    if (!data?.signals) continue;

    for (const s of signals) {
      const fresh = data.signals.find((x) => x.id === s.id);
      if (!fresh) continue;
      const stored = s.sentiment_label ?? "neutral";
      storedLabels.push(stored);
      newLabels.push(fresh.label);
      compared += 1;
      if (fresh.label === stored) agreements += 1;
      if (fresh.salience && fresh.salience in saliences) {
        saliences[fresh.salience] += 1;
        if (fresh.salience !== "relevant") notRelevant.push(`${person.display_name}: [${fresh.salience}] ${s.headline}`);
      }
    }

    const signalsImpact = signals.reduce((sum, s) => sum + s.impact_score, 0);
    if (data.narrative) {
      const check = checkNarrative(data.narrative, data.narrative_direction, signalsImpact, DEFAULT_ENGINE_CONFIG.narratives.minAbsChange);
      directionChecks += 1;
      if (check.ok) directionAgreed += 1;
      else replaced.push(`${person.display_name} (${check.reason}): ${data.narrative}`);
      const move = narrative.score_after - narrative.score_before;
      sentences.push(
        [
          `${person.display_name}  ${narrative.created_at.slice(0, 16)}  move ${move >= 0 ? "+" : ""}${move.toFixed(2)}  signals ${signalsImpact >= 0 ? "+" : ""}${signalsImpact.toFixed(2)}`,
          `  was: ${narrative.text}`,
          `  now: ${data.narrative}  [${data.narrative_direction ?? "n/a"}${check.ok ? "" : `, REPLACED: ${check.reason}`}]`,
        ].join("\n"),
      );
    }
  }
  await reader.close();

  console.log(`${narratives.length} narratives, ${compared} signals compared`);
  console.log(`label agreement with stored: ${compared > 0 ? ((100 * agreements) / compared).toFixed(1) : "n/a"}%`);
  console.log(`stored labels: ${JSON.stringify(counts(storedLabels))}`);
  console.log(`new labels:    ${JSON.stringify(counts(newLabels))}`);
  if (version === 2) {
    console.log(`salience: ${JSON.stringify(saliences)}`);
    if (notRelevant.length > 0) console.log(`\nnot relevant:\n  ${notRelevant.join("\n  ")}`);
    console.log(`\nnarrative passes the direction and voice check: ${directionAgreed} of ${directionChecks}`);
    if (replaced.length > 0) console.log(`replaced by the template:\n  ${replaced.join("\n  ")}`);
  }
  console.log(`\n${sentences.join("\n\n")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
