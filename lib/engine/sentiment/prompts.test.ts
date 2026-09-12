import { describe, expect, it } from "vitest";

import type { PersonMemory } from "@/lib/engine/memory/types";

import { PAYLOAD_KEYS, buildSentimentUserPrompt } from "./prompts";
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
