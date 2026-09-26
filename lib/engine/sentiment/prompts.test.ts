import { describe, expect, it } from "vitest";

import type { PersonMemory } from "@/lib/engine/memory/types";

import { createHash } from "node:crypto";

import { PAYLOAD_KEYS, SENTIMENT_RESPONSE_SCHEMA, SENTIMENT_RESPONSE_SCHEMA_V2, SENTIMENT_SYSTEM_PROMPT, buildPersonBlock, buildSentimentUserPrompt, sentimentPrompt } from "./prompts";
import type { SentimentInput } from "./types";

/**
 * The narrative layer only ever sees normalised values. Whatever a connector
 * stored in a payload, the prompt carries an allow-list of fields and a raw
 * level cannot reach the model through it.
 */

const memory: PersonMemory = {
  personId: "p1",
  profile: { role: "creator", summary: "Runs the largest channel on YouTube." },
  baselinePatterns: { routine: ["weekly uploads"], notable: ["a record video"] },
  recentContext: { summary: "Quiet fortnight.", notable_events: [] },
  updatedAt: null,
};

const person = { displayName: "MrBeast", slug: "mrbeast", category: "creator", memory };

describe("the sentiment prompt", () => {
  it("carries only the allow-listed payload fields, never a level, a previous level or a delta", () => {
    expect([...PAYLOAD_KEYS]).not.toContain("previous");
    expect([...PAYLOAD_KEYS]).not.toContain("current");
    expect([...PAYLOAD_KEYS]).not.toContain("delta");
    expect([...PAYLOAD_KEYS]).not.toContain("value");
    expect([...PAYLOAD_KEYS]).not.toContain("milestone");

    const leaky: SentimentInput = {
      id: "s1",
      personId: "p1",
      headline: "MrBeast uploads a new video",
      sourceName: "youtube",
      sourceTier: 2,
      rawPayload: {
        kind: "change",
        metric: "subscriber_count",
        previous: 516100000,
        current: 516950000,
        delta: 850000,
        value: 516950000,
        followers: 123456789,
        balance: 987654321,
        subscriberCount: 516950000,
        relativeChange: 0.0016,
        statistics: { viewCount: "90000000000" },
      },
    };
    const prompt = buildSentimentUserPrompt(person, [leaky]);
    expect(prompt).toContain('"kind":"change"');
    expect(prompt).toContain('"relativeChange":0.0016');
    for (const raw of ["516100000", "516950000", "850000", "123456789", "987654321", "90000000000", "previous", "current", "followers", "balance", "statistics"]) {
      expect(prompt, raw).not.toContain(raw);
    }
  });

  it("shows a metric signal, should one ever reach it, as sigma and direction only", () => {
    const metric: SentimentInput = {
      id: "m1",
      personId: "p1",
      headline: "MrBeast's YouTube subscriber growth is running +1.4σ above their own trailing week",
      sourceName: "youtube",
      sourceTier: 2,
      rawPayload: { kind: "metric", metric: "subscriber_count", sigma: 1.4, direction: 1, polarity: 1, window_hours: 168, samples: 48 },
    };
    const prompt = buildSentimentUserPrompt(person, [metric]);
    expect(prompt).toContain('"sigma":1.4');
    expect(prompt).toContain('"direction":1');
    expect(prompt).not.toContain("polarity");
    expect(prompt).not.toContain("samples");
  });
});

describe("the person block and today's date (Phase 12+)", () => {
  const today = new Date("2026-09-16T12:00:00.000Z");
  const withEvents: PersonMemory = {
    ...memory,
    recentContext: {
      summary: "Earlier: Dramatic scandal (2026-06-12, -3.50).",
      notable_events: [
        { at: "2026-09-15T08:00:00Z", headline: "Record-breaking video", label: "positive", impact: 2.1, anomaly: "anomalous" },
        { at: "2026-09-01T08:00:00Z", headline: "Weekly upload", label: "positive", impact: 0.6 },
        { at: "2026-06-12T08:00:00Z", headline: "Dramatic scandal", label: "negative", impact: -3.5 },
      ],
    },
  };

  it("opens with today's date and shows each recent event with its age; an event past the horizon is not shown verbatim", () => {
    const block = buildPersonBlock({ ...person, memory: withEvents, today, eventMaxAgeDays: 30 });
    expect(block).toContain("Today: 2026-09-16");
    expect(block).toContain("Recent notable events (last 30 days):");
    expect(block).toContain("  - 2026-09-15 (1 days ago): Record-breaking video (positive, +2.10)");
    expect(block).toContain("  - 2026-09-01 (15 days ago): Weekly upload (positive, +0.60)");
    expect(block).not.toContain("2026-06-12 (");
    // The scandal is still known — as history, in the summary, with its date.
    expect(block).toContain("Recent context: Earlier: Dramatic scandal (2026-06-12, -3.50).");
    // The system prompt tells the model what to do with the dates.
    expect(SENTIMENT_SYSTEM_PROMPT).toContain("today's date");
  });

  it("a person whose every event has expired still gets a valid block: no events line, the summary, today's date", () => {
    const expiredOnly: PersonMemory = { ...withEvents, recentContext: { ...withEvents.recentContext, notable_events: [withEvents.recentContext.notable_events[2]] } };
    const block = buildPersonBlock({ ...person, memory: expiredOnly, today, eventMaxAgeDays: 30 });
    expect(block).toContain("Today: 2026-09-16");
    expect(block).not.toContain("Recent notable events");
    expect(block).toContain("Recent context: Earlier: Dramatic scandal");
    expect(block.split("\n").every((line) => line.trim().length > 0)).toBe(true);
    // Without a date (tooling), the block keeps the old shape and hides nothing.
    const undated = buildPersonBlock({ ...person, memory: withEvents });
    expect(undated).not.toContain("Today:");
    expect(undated).toContain("  - 2026-06-12: Dramatic scandal (negative, -3.50)");
  });
});

describe("the two prompt versions (Phase 31)", () => {
  it("version 1 is the production prompt, unchanged to the byte; version 2 adds salience and the analyst's note and is chosen only by the switch", () => {
    expect(createHash("sha256").update(SENTIMENT_SYSTEM_PROMPT).digest("hex")).toBe("edbe095f4d6759e2d8078eccdbe0449fce3a98d661a4f5f56116a2b284f40c14");
    expect(SENTIMENT_SYSTEM_PROMPT).not.toContain("salience");
    expect(SENTIMENT_SYSTEM_PROMPT).toContain("in the Engine's voice explaining the net effect of these signals");
    expect(sentimentPrompt(1)).toEqual({ systemPrompt: SENTIMENT_SYSTEM_PROMPT, schema: SENTIMENT_RESPONSE_SCHEMA, name: "sentiment_assessment" });
    expect(SENTIMENT_RESPONSE_SCHEMA.required).toEqual(["signals", "narrative"]);

    const v2 = sentimentPrompt(2);
    expect(v2.name).toBe("sentiment_assessment_v2");
    expect(v2.systemPrompt).toContain('- salience: what the story says about THIS person\'s trajectory');
    expect(v2.systemPrompt).toContain("as an analyst's note for a reader who follows this person");
    for (const banned of ['"signal"', '"noise"', '"digest"', '"routine"', '"adds no"', '"offset"', '"priced in"', '"net effect"']) expect(v2.systemPrompt).toContain(banned);
    expect(v2.systemPrompt).toContain("Never mention multiples, baselines, averages, comment volume or view counts.");
    expect(v2.systemPrompt).toContain('"narrative_direction"');
    expect(v2.schema.required).toEqual(["signals", "narrative", "narrative_direction"]);
    expect(SENTIMENT_RESPONSE_SCHEMA_V2.properties).toMatchObject({ signals: { items: { required: ["id", "label", "confidence", "direction", "anomaly", "salience", "rationale"] } } });
    // The user prompt is shared: the same person block and signals block feed both versions.
    expect(buildSentimentUserPrompt(person, [])).toContain("Assess every signal above for MrBeast");
  });
});
