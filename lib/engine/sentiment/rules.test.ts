import { describe, expect, it } from "vitest";

import { getSentimentScorer, listSentimentScorers, resetSentimentScorers } from "./index";
import { RulesBasedScorer, applyPayloadHints, scoreHeadline } from "./rules";
import type { SentimentInput, SentimentScorer } from "./types";

const scorer = new RulesBasedScorer();

function input(headline: string, rawPayload: SentimentInput["rawPayload"] = null): SentimentInput {
  return { id: "sig", personId: "p-1", headline, rawPayload, sourceName: "youtube", sourceTier: 2 };
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
  it("returns the LLM scorer by default, the rules scorer on request, and rejects unknown names", () => {
    delete process.env.SCORER;
    delete process.env.SENTIMENT_SCORER;
    resetSentimentScorers();
    expect(getSentimentScorer().name).toBe("llm");
    expect(getSentimentScorer("rules")).toBeInstanceOf(RulesBasedScorer);
    expect(listSentimentScorers()).toEqual(["rules", "llm"]);
    expect(() => getSentimentScorer("oracle")).toThrow(/Unknown sentiment scorer/);

    // SCORER=rules is the instant fallback switch.
    process.env.SCORER = "rules";
    resetSentimentScorers();
    expect(getSentimentScorer().name).toBe("rules");
    delete process.env.SCORER;
    resetSentimentScorers();
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

/**
 * PHASE 18. The lexicon reads the news register and not the creator-comment
 * one, and that is a decision, not an oversight: scoreHeadline is one shared
 * function, so casual vocabulary added for comment digests lands on every news
 * headline too. These are the real production headlines a candidate casual
 * extension was replayed against — 30 of the 33 it touched changed direction.
 * They are pinned here so an extension has to face them first.
 *
 * The full replay and the recommendation are in lib/ingest/comments.ts.
 */
describe("the register boundary: casual vocabulary would misread these real headlines", () => {
  it("keeps the negative reading of headlines where a casual positive term appears", () => {
    // "fire" is praise in a comment and the opposite in both of these.
    for (const headline of [
      "Officials Under Fire for Missing Travis Kelce Penalty on Patrick Mahomes TD Run",
      "Adin Ross Wants 'Investigation' Into Ray J vs. Supa Hot Fire Fight",
    ]) {
      expect(scoreHeadline(headline).direction, headline).toBe(-1);
    }
  });

  it("stays neutral on headlines a casual lexicon would read as praise", () => {
    for (const headline of [
      "Sergey Brin fights fire with fire — and two ballot initiatives",
      "MrBeast's 'God King' problem",
      "Who Made the Guest List for King Charles III’s AI Summit",
      "King Green Reveals $1.2M UFC Earnings, Mocks Adin Ross and BrandRisk Pay",
      "Video: Kai Cenat on Quitting Streaming at His Peak to Start a Fashion Brand",
      "Kendrick Lamar According to C. S. Lewis: Epic Poetry “Reincarnated” as Hip-Hop",
      "Warren Buffett Has More Than 50% of His Portfolio in These 3 Stocks. Which One Is the Best Buy Today?",
    ]) {
      expect(scoreHeadline(headline).direction, headline).toBe(0);
    }
  });

  it("stays neutral on headlines a casual lexicon would read as an insult", () => {
    for (const headline of [
      "‘The village idiot could have made it’: Warren Buffett’s dead-simple playbook to supercharge your retirement now",
      "MrBeast Raps About His Millions on Lil Baby's \"Dead Fresh\" Remix",
      "Heed Warren Buffett's Advice: The Time to Be Fearful When Others Are Greedy Has Arrived on Wall Street",
      "Bears news: GM Ryan Poles' 'boring' takeaway from Patrick Mahomes' Caleb Williams advice",
    ]) {
      expect(scoreHeadline(headline).direction, headline).toBe(0);
    }
  });

  it("reads real viewer comments as neutral, which is why every digest in production is mixed", () => {
    // Six of the 96 distinct comments behind the 87 stored digests.
    for (const comment of [
      "Can we appreciate the camera crew? They are surviving the same extreme place without getting any credit. Legends behind the camera❤❤❤",
      "This was insane! The jungle part was crazy 🔥",
      "salute for cameraman they are the true legends and the best survivors",
      "El Goat de Youtube!!! Que alegría que gente cómo tu invierta tanto en hacer tan buen contenido",
      "Bro is making movie productions now💀",
      "Congrats on the 1000 video🎉🎉",
    ]) {
      expect(scoreHeadline(comment).direction, comment).toBe(0);
    }
  });
});
