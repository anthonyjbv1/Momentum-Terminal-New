import { describe, expect, it } from "vitest";

import { getSentimentScorer, listSentimentScorers } from "./index";
import { RulesBasedScorer, applyPayloadHints, scoreHeadline } from "./rules";
import type { SentimentInput, SentimentScorer } from "./types";

const scorer = new RulesBasedScorer();

function input(headline: string, rawPayload: SentimentInput["rawPayload"] = null): SentimentInput {
  return { id: "sig", headline, rawPayload, sourceName: "youtube", sourceTier: 2 };
}

describe("RulesBasedScorer", () => {
  it("scores clearly positive headlines as positive", async () => {
    for (const headline of [
      "MrBeast crosses 516M subscribers on YouTube",
      "Patrick Mahomes wins fourth Super Bowl",
      "Kendrick Lamar breaks streaming record",
      "NVIDIA shares climb 4% after earnings",
    ]) {
      const result = await scorer.scoreSignal(input(headline));
      expect(result.label, headline).toBe("positive");
      expect(result.direction, headline).toBe(1);
      expect(result.confidence, headline).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("scores clearly negative headlines as negative", async () => {
    for (const headline of [
      "Drake drops below 100M monthly listeners",
      "Adin Ross suspended after controversy",
      "Tesla shares plunge 8% as deliveries miss",
      "Larry Ellison sued by former executive",
    ]) {
      const result = await scorer.scoreSignal(input(headline));
      expect(result.label, headline).toBe("negative");
      expect(result.direction, headline).toBe(-1);
      expect(result.confidence, headline).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("is neutral with zero confidence when nothing matches", async () => {
    const result = await scorer.scoreSignal(input("Jensen Huang speaks at a developer conference"));
    expect(result).toMatchObject({ label: "neutral", direction: 0, confidence: 0 });
  });

  it("treats baseline signals as zero impact regardless of wording", async () => {
    const result = await scorer.scoreSignal(
      input("MrBeast crosses 516M subscribers on YouTube", { kind: "baseline", channelId: "UC1" }),
    );
    expect(result).toMatchObject({ label: "neutral", direction: 0, confidence: 0 });
  });

  it("scales confidence with the clarity of the match", () => {
    const strong = scoreHeadline("Elon Musk charged with fraud in federal indictment");
    const weak = scoreHeadline("Sergey Brin is down for a chat");
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    expect(strong.confidence).toBeLessThanOrEqual(0.95);
    expect(weak.label).toBe("negative");
  });

  it("goes neutral on mixed signals and dampens a narrow winner", () => {
    expect(scoreHeadline("Tesla stock falls despite record deliveries")).toMatchObject({ label: "neutral", direction: 0 });
    expect(scoreHeadline("Drake wins award but faces backlash and boycott from fans")).toMatchObject({ label: "neutral", direction: 0 });
    const dampened = scoreHeadline("Drake breaks record and wins award despite a down week");
    expect(dampened.label).toBe("positive");
    expect(dampened.confidence).toBeLessThan(0.7);
  });

  it("uses connector hints from the payload", () => {
    const base = scoreHeadline("MrBeast gains 850K YouTube subscribers (+0.16%) since last check");
    const scaled = applyPayloadHints(base, { kind: "change", relativeChange: 0.0016 });
    expect(scaled.confidence).toBeCloseTo(base.confidence * 0.2, 5);

    const milestone = applyPayloadHints(scoreHeadline("MrBeast now at 517M"), { kind: "milestone" });
    expect(milestone).toMatchObject({ label: "positive", direction: 1, confidence: 0.75 });

    const lost = applyPayloadHints(scoreHeadline("Channel count now 515.9M"), { kind: "milestone_lost" });
    expect(lost).toMatchObject({ label: "negative", direction: -1, confidence: 0.75 });
  });
});

describe("sentiment registry", () => {
  it("returns the rules scorer by default and rejects unknown names", () => {
    expect(getSentimentScorer().name).toBe("rules");
    expect(getSentimentScorer("rules")).toBeInstanceOf(RulesBasedScorer);
    expect(listSentimentScorers()).toEqual(["rules"]);
    expect(() => getSentimentScorer("oracle")).toThrow(/Unknown sentiment scorer/);
  });

  it("is swappable: any object with scoreSignal satisfies the interface", async () => {
    const fake: SentimentScorer = {
      name: "fake-llm",
      async scoreSignal() {
        return { label: "negative", confidence: 0.9, direction: -1, rationale: "stub" };
      },
    };
    await expect(fake.scoreSignal(input("anything"))).resolves.toMatchObject({ direction: -1 });
  });
});
