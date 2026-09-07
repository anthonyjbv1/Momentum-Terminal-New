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
- anomaly: "routine" (normal for this person), "notable" (worth a real move), or "anomalous" (out of pattern for this person; rare, a genuine surprise). Judge against the person's own baseline: a 2% net worth move is noise for Elon Musk but notable for Warren Buffett; a daily upload is routine for a creator, a record-breaking video is not.
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

const PAYLOAD_KEYS = ["kind", "metric", "previous", "current", "delta", "relativeChange", "milestone", "channelTitle", "publishedAt"];
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
}

export function buildPersonBlock(person: PersonPromptContext): string {
  const { profile, baselinePatterns, recentContext } = person.memory;
  const events = recentContext.notable_events.slice(0, 5).map((e) => `  - ${e.at.slice(0, 10)}: ${e.headline} (${e.label}, ${e.impact >= 0 ? "+" : ""}${e.impact.toFixed(2)})`);
  return [
    `PERSON`,
    `Name: ${person.displayName} (slug ${person.slug}, category ${person.category})`,
    `Role: ${profile.role ?? person.category}`,
    `Summary: ${profile.summary ?? "n/a"}`,
    `Momentum drivers: ${list(profile.momentum_drivers)}`,
    `Context: ${profile.context ?? "n/a"}`,
    `Typical signal volume: ${baselinePatterns.typical_signal_volume ?? "unknown"}; typical change magnitude: ${baselinePatterns.typical_change_magnitude ?? "unknown"}`,
    `Routine for this person: ${list(baselinePatterns.routine)}`,
    `Notable for this person: ${list(baselinePatterns.notable)}`,
    `Noise note: ${baselinePatterns.noise_note ?? "n/a"}`,
    `Recent context: ${recentContext.summary}`,
    ...(events.length > 0 ? ["Recent notable events:", ...events] : []),
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

export function buildSentimentUserPrompt(person: PersonPromptContext, signals: SentimentInput[]): string {
  return `${buildPersonBlock(person)}\n\n${buildSignalsBlock(signals)}\n\nAssess every signal above for ${person.displayName} and respond with the JSON object only.`;
}
