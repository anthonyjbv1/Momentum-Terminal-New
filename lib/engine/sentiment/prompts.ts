import type { PersonMemory } from "@/lib/engine/memory/types";
import type { LLMJsonSchema } from "@/lib/llm/types";
import type { Json } from "@/types/database";

import type { SentimentInput } from "./types";

/**
 * Prompts for the LLM sentiment scorer. The system prompt is stable (and
 * therefore cacheable); everything that varies goes in the user prompt.
 */

export const SENTIMENT_SYSTEM_PROMPT = `You are the Engine, the scoring intelligence of Momentum Terminal, a market where users take HIGH or LOW positions on the momentum of individual people.

Your job: read incoming signals about ONE person and judge, for THIS person specifically, how each signal should move their Momentum Score.

For every signal return:
- label: "positive" if it strengthens the person's momentum, "negative" if it weakens it, "neutral" if it does not move it.
- confidence: a number from 0 to 1 combining how sure you are of the direction and how much the signal matters for this person. Routine noise gets low confidence even when the direction is clear.
- direction: 1 for positive, -1 for negative, 0 for neutral.
- anomaly: "routine" (normal for this person), "notable" (worth a real move), or "anomalous" (out of pattern for this person; rare, a genuine surprise). Judge against the person's own baseline: a 2% net worth move is noise for Elon Musk but notable for Warren Buffett; a daily upload is routine for a creator, a record-breaking video is not. The person block gives today's date and dated recent events: an event weeks old is context, not the current picture, and does not make a similar event today routine.
- rationale: one short sentence.

Duplicate or overlapping headlines must not be double counted: give the strongest one its due and mark the rest routine with low confidence. Baseline or status-only signals that report a number without a change are neutral.

Also write "narrative": one sentence (at most 30 words) in the Engine's voice explaining the net effect of these signals on the person's momentum, suitable for a public feed. Plain text, no markdown, no hedging filler. If nothing meaningful happened, say so briefly.

Respond with a single JSON object and nothing else, shaped exactly like:
{"signals":[{"id":"...","label":"positive","confidence":0.8,"direction":1,"anomaly":"notable","rationale":"..."}],"narrative":"..."}`;

export const SENTIMENT_RESPONSE_SCHEMA: LLMJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["signals", "narrative"],
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "confidence", "direction", "anomaly", "rationale"],
        properties: {
          id: { type: "string" },
          label: { type: "string", enum: ["positive", "negative", "neutral"] },
          confidence: { type: "number" },
          direction: { type: "integer" },
          anomaly: { type: "string", enum: ["routine", "notable", "anomalous"] },
          rationale: { type: "string" },
        },
      },
    },
    narrative: { type: "string" },
  },
};

/**
 * VERSION 2 (Phase 31): the same assessment plus SALIENCE per signal and an
 * ANALYST'S NOTE with a declared direction. Used only while the quality
 * rules are on; version 1 above is what production runs and is not touched.
 *
 * Salience asks what the story says about this person's TRAJECTORY, not
 * whether they are its main subject: the party overtaken in a wealth
 * ranking is told something about; a name in an attendee list is not. The
 * Signals force multiplies by it (1.0 / 0.3 / 0).
 *
 * The narrative is written for the reader who follows the person, not
 * about the Engine's weighing: the prompt bans the vocabulary of weighing
 * ("signal", "noise", "digest", "priced in") and internals (multiples,
 * baselines, comment volume), and asks for a direction the Engine can check
 * against the Signals force before publishing the sentence
 * (lib/engine/narratives.ts).
 */
export const SENTIMENT_SYSTEM_PROMPT_V2 = `You are the Engine, the scoring intelligence of Momentum Terminal, a market where users take HIGH or LOW positions on the momentum of individual people.

Your job: read incoming signals about ONE person and judge, for THIS person specifically, how each signal should move their Momentum Score.

For every signal return:
- label: "positive" if it strengthens the person's momentum, "negative" if it weakens it, "neutral" if it does not move it.
- confidence: a number from 0 to 1 combining how sure you are of the direction and how much the signal matters for this person. Routine noise gets low confidence even when the direction is clear.
- direction: 1 for positive, -1 for negative, 0 for neutral.
- anomaly: "routine" (normal for this person), "notable" (worth a real move), or "anomalous" (out of pattern for this person; rare, a genuine surprise). Judge against the person's own baseline: a 2% net worth move is noise for Elon Musk but notable for Warren Buffett; a daily upload is routine for a creator, a record-breaking video is not. The person block gives today's date and dated recent events: an event weeks old is context, not the current picture, and does not make a similar event today routine.
- salience: what the story says about THIS person's trajectory, whether or not they are its main subject. "relevant" when it carries information about their momentum even as a secondary party: being overtaken in a ranking is relevant for the person overtaken, funding a campaign is relevant for the donor, a company's news is relevant for the founder who runs it. "incidental" when the person is named without anything being said about them: a name in an attendee list, a passing comparison, an essay crediting several people generically. "unrelated" when the story is about a different person or thing that shares the name. Keep the label and confidence honest either way; salience is judged separately.
- rationale: one short sentence.

Duplicate or overlapping headlines must not be double counted: give the strongest one its due and mark the rest routine with low confidence. Baseline or status-only signals that report a number without a change are neutral.

Also write "narrative": one sentence, at most 30 words, as an analyst's note for a reader who follows this person. Say what happened and why it matters to them. Name the company, deal, game, video or announcement plainly. Name the person at most once. Do not describe how you weighed anything: never write "signal", "noise", "digest", "routine", "adds no", "offset", "priced in" or "net effect", and do not narrate the score or the momentum itself. Never mention multiples, baselines, averages, comment volume or view counts. If nothing meaningful happened, write one plain sentence about what the day's coverage was about. Plain text, no markdown.

And "narrative_direction": "up" if the day's news on balance strengthens the person's standing, "down" if it weakens it, "flat" if it does neither. It must agree with the net of the labels above.

Respond with a single JSON object and nothing else, shaped exactly like:
{"signals":[{"id":"...","label":"positive","confidence":0.8,"direction":1,"anomaly":"notable","salience":"relevant","rationale":"..."}],"narrative":"...","narrative_direction":"up"}`;

export const SENTIMENT_RESPONSE_SCHEMA_V2: LLMJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["signals", "narrative", "narrative_direction"],
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "confidence", "direction", "anomaly", "salience", "rationale"],
        properties: {
          id: { type: "string" },
          label: { type: "string", enum: ["positive", "negative", "neutral"] },
          confidence: { type: "number" },
          direction: { type: "integer" },
          anomaly: { type: "string", enum: ["routine", "notable", "anomalous"] },
          salience: { type: "string", enum: ["relevant", "incidental", "unrelated"] },
          rationale: { type: "string" },
        },
      },
    },
    narrative: { type: "string" },
    narrative_direction: { type: "string", enum: ["up", "down", "flat"] },
  },
};

export type SentimentPromptVersion = 1 | 2;

/** The system prompt and response schema of a prompt version. Version 1 is production; version 2 is Phase 31, behind the switch. */
export function sentimentPrompt(version: SentimentPromptVersion): { systemPrompt: string; schema: LLMJsonSchema; name: string } {
  return version === 2
    ? { systemPrompt: SENTIMENT_SYSTEM_PROMPT_V2, schema: SENTIMENT_RESPONSE_SCHEMA_V2, name: "sentiment_assessment_v2" }
    : { systemPrompt: SENTIMENT_SYSTEM_PROMPT, schema: SENTIMENT_RESPONSE_SCHEMA, name: "sentiment_assessment" };
}

/**
 * The only payload fields that may reach the model. Normalised values and
 * descriptive metadata only: never a raw level (a follower count, a view
 * total, a balance) and never a raw delta, whatever a connector stored.
 * A test asserts that a payload carrying such fields cannot leak through.
 */
export const PAYLOAD_KEYS = ["kind", "metric", "label", "relativeChange", "sigma", "direction", "window_hours", "channelTitle", "videoTitle", "publishedAt", "outlet"] as const;
const MAX_PAYLOAD_CHARS = 320;

function compactPayload(payload: Json | null): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "";
  const picked: Record<string, Json | undefined> = {};
  for (const key of PAYLOAD_KEYS) if (payload[key] !== undefined) picked[key] = payload[key];
  const text = JSON.stringify(picked);
  return text === "{}" ? "" : text.slice(0, MAX_PAYLOAD_CHARS);
}

function list(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join("; ") : "n/a";
}

export interface PersonPromptContext {
  displayName: string;
  slug: string;
  category: string;
  memory: PersonMemory;
  /** The tick's date. Shown as "Today", and every recent event is shown with its age, so a dated event reads as old. */
  today?: Date;
  /** Events older than this are not shown verbatim: they live in the summary as history. */
  eventMaxAgeDays?: number;
}

/**
 * TODAY'S DATE IN THE PERSON BLOCK (Phase 12+). The recent events always
 * carried dates, but the model was never told what day it was, so an
 * eight-month-old event and yesterday's read the same. Now the block opens
 * with "Today", each event carries its age, and events past the memory
 * expiry horizon are left out (they are already folded into the summary as
 * history). A person with nothing recent gets a block with no events line
 * and the summary — always a valid block, never an empty prompt.
 */
export function buildPersonBlock(person: PersonPromptContext): string {
  const { profile, baselinePatterns, recentContext } = person.memory;
  const today = person.today;
  const ageDays = (at: string): number | null => {
    if (!today) return null;
    const time = Date.parse(at);
    return Number.isFinite(time) ? (today.getTime() - time) / 86_400_000 : null;
  };
  const current = recentContext.notable_events.filter((e) => {
    const age = ageDays(e.at);
    return age === null || person.eventMaxAgeDays === undefined || age <= person.eventMaxAgeDays;
  });
  const events = current.slice(0, 5).map((e) => {
    const age = ageDays(e.at);
    const when = age === null ? e.at.slice(0, 10) : `${e.at.slice(0, 10)} (${age < 1 ? "today" : `${Math.round(age)} days ago`})`;
    return `  - ${when}: ${e.headline} (${e.label}, ${e.impact >= 0 ? "+" : ""}${e.impact.toFixed(2)})`;
  });
  return [
    `PERSON`,
    `Name: ${person.displayName} (slug ${person.slug}, category ${person.category})`,
    ...(today ? [`Today: ${today.toISOString().slice(0, 10)}`] : []),
    `Role: ${profile.role ?? person.category}`,
    `Summary: ${profile.summary ?? "n/a"}`,
    `Momentum drivers: ${list(profile.momentum_drivers)}`,
    `Context: ${profile.context ?? "n/a"}`,
    `Typical signal volume: ${baselinePatterns.typical_signal_volume ?? "unknown"}; typical change magnitude: ${baselinePatterns.typical_change_magnitude ?? "unknown"}`,
    `Routine for this person: ${list(baselinePatterns.routine)}`,
    `Notable for this person: ${list(baselinePatterns.notable)}`,
    `Noise note: ${baselinePatterns.noise_note ?? "n/a"}`,
    `Recent context: ${recentContext.summary}`,
    ...(events.length > 0 ? [`Recent notable events${person.eventMaxAgeDays !== undefined ? ` (last ${person.eventMaxAgeDays} days)` : ""}:`, ...events] : []),
  ].join("\n");
}

export function buildSignalsBlock(signals: SentimentInput[], occurredAt?: Map<string, Date>): string {
  const lines = signals.map((signal, index) => {
    const when = occurredAt?.get(signal.id);
    const payload = compactPayload(signal.rawPayload);
    return [
      `${index + 1}. id=${signal.id} | source=${signal.sourceName} (tier ${signal.sourceTier})${when ? ` | occurred=${when.toISOString()}` : ""}`,
      `   Headline: ${signal.headline}`,
      ...(payload ? [`   Payload: ${payload}`] : []),
    ].join("\n");
  });
  return [`SIGNALS (${signals.length})`, ...lines].join("\n");
}

/**
 * The model is NOT shown a signal's age, on purpose (Phase 12). Staleness is
 * weighted numerically, once, by the Signals force (2^(−age/24h), zero past
 * seven days). Showing the date as well would invite the model to discount
 * the same thing a second time, with an unstated curve, on a field whose
 * quality varies by source (a feed can resurface an old item with its
 * original date). The model's question stays "what does this mean for this
 * person"; "when" is the Engine's. buildSignalsBlock keeps its optional
 * occurred map for tooling, and this function deliberately never passes it.
 */
export function buildSentimentUserPrompt(person: PersonPromptContext, signals: SentimentInput[]): string {
  return `${buildPersonBlock(person)}\n\n${buildSignalsBlock(signals)}\n\nAssess every signal above for ${person.displayName} and respond with the JSON object only.`;
}
