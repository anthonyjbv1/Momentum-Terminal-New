import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { MAX_ANCHOR_PHRASE_DOCS, confirmStories, confirmationImpact, describeStory, numberAnchors, phraseAnchors, sameStory, storyOptions, vocabulary, withoutEntities } from "./stories";
import type { RecentStory, ScoredSignal } from "./types";

/**
 * STORY CONFIRMATION (Phase 31), pinned on the production pairs that
 * motivated it. Every headline here was stored and scored in the week to
 * 2026-09-25; the impacts are the ones the Engine published.
 */

const AT = new Date("2026-09-25T19:11:00.000Z");
const hours = (n: number) => new Date(AT.getTime() + n * 3_600_000);
const quality = { ...DEFAULT_ENGINE_CONFIG.signalQuality, enabled: true };

function scored(id: string, headline: string, impact: number, occurredAt = AT, kind = "article"): ScoredSignal {
  return {
    signal: { id, personId: "p", headline, rawPayload: { kind }, sourceName: "rss", sourceTier: 5, occurredAt, createdAt: occurredAt },
    sentiment: { label: impact > 0 ? "positive" : impact < 0 ? "negative" : "neutral", confidence: 0.5, direction: impact > 0 ? 1 : impact < 0 ? -1 : 0 },
    impact,
    ageHours: 0,
    freshness: 1,
    volumeWeight: 1,
  };
}

function recent(id: string, headline: string, impact: number, occurredAt = AT): RecentStory {
  return { id, personId: "p", headline, occurredAt, impact };
}

describe("anchors", () => {
  it("reads a number with the word it qualifies, and a bare small integer anchors nothing", () => {
    expect(numberAnchors("Mark Zuckerberg Loses $9 Billion In A Day")).toEqual(new Set(["9 billion"]));
    expect(numberAnchors("Week 3 Scheme Advantages")).toEqual(new Set(["3 scheme"]));
    expect(numberAnchors("announces Meta VR Glasses for $1,299")).toEqual(new Set(["1299"]));
    expect(numberAnchors("net worth hits $266.4 billion")).toEqual(new Set(["266.4 billion", "266.4"]));
  });

  it("a year is a date, not an amount, and an HTML entity is not a number", () => {
    expect(numberAnchors("Why 2026 Chiefs Are Different")).toEqual(new Set());
    expect(numberAnchors("Drake&#8217;s &#8220;Quebec&#8221; Removed From YouTube")).toEqual(new Set());
    expect(withoutEntities("Drake&#8217;s &#8220;Quebec&#8221; &#038; more &amp; again")).toBe("Drake s  Quebec    more   again");
  });

  it("a phrase the person's headlines repeat all week anchors nothing", () => {
    const names = ["Patrick Mahomes"];
    const week = [
      "Chiefs QB Patrick Mahomes Sends Team Strong Warning After Critics Change Tune",
      "How Chiefs QB Patrick Mahomes found his groove again",
      "We got our first look at the gnarly scars on Chiefs QB Patrick Mahomes' knee",
      "Dallas Stars player wasn't thrilled with Chiefs QB Patrick Mahomes' quick recovery",
      "Patrick Mahomes' Play in Return From Injury Evaluated by NFL Exec, Chiefs QB 'Ripping the Ball'",
    ];
    const vocab = vocabulary(week, names);
    expect(vocab.commonPhrases.has("chief qb")).toBe(true);
    expect(week.length).toBeGreaterThan(MAX_ANCHOR_PHRASE_DOCS);
    expect(phraseAnchors(week[0], names, vocab).has("chief qb")).toBe(false);
    // A phrase that appears once is exactly what an event looks like.
    expect(phraseAnchors(week[0], names, vocab).has("strong warning")).toBe(true);
  });
});

describe("sameStory: the production pairs", () => {
  const options = (names: string[]) => storyOptions(quality, names);
  const pair = (a: string, b: string, names: string[], gapHours = 1) => {
    const vocab = vocabulary([a, b], names);
    return sameStory(describeStory(a, AT, names, vocab), describeStory(b, hours(gapHours), names, vocab), options(names));
  };

  it("Zuckerberg's $9 billion day, twice from Forbes, below the ingestion threshold but sharing the number", () => {
    const match = pair("Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears", "Mark Zuckerberg Loses $9 Billion In A Day As Goldman Sachs Pours Cold Water On Meta Stock Rally", ["Mark Zuckerberg"]);
    expect(match.same).toBe(true);
    expect(match.similarity).toBeLessThan(0.4);
    expect(match.anchor).toBe("9 billion");
  });

  it("Martha Stewart's three days with MrBeast, two outlets a day apart", () => {
    const match = pair("Martha Stewart Reveals Her Verdict On MrBeast After Spending Three Days Together", "Martha Stewart Surprisingly Spent 3 Days with This Influencer, Later Calling Him 'Entertaining'", ["MrBeast", "James Stephen Donaldson"], 27);
    expect(match).toMatchObject({ same: true, anchor: "martha stewart" });
  });

  it("Kendrick Lamar's tour record, the widest rewrite of the four", () => {
    const match = pair("Kendrick Lamar's 'Grand National Tour' Becomes Highest-Grossing Rap Tour Ever", "Kendrick Lamar Earns Highest-Grossing Touring Year by a Rapper in History – Report", ["Kendrick Lamar"], 17);
    expect(match).toMatchObject({ same: true, anchor: "highest grossing" });
    expect(match.similarity).toBeGreaterThanOrEqual(quality.storyAnchorThreshold);
  });

  it("Dell overtaken by Zuckerberg, told two ways without naming Dell", () => {
    const match = pair("Meta's Mark Zuckerberg overtakes founder of world's largest server maker to become fourth richest billionaire", "Muse downloads surpass ChatGPT as Zuckerberg's net worth hits $266.4 billion, vaulting him to world's fourth-richest", ["Michael Dell"]);
    expect(match).toMatchObject({ same: true, anchor: "fourth richest" });
  });

  it("the Huang interview quoted five ways is the acknowledged miss: no phrase, no number, no match", () => {
    const names = ["Jensen Huang"];
    const takes = [
      "Nvidia CEO Jensen Huang Says That Sacrificing Our Children's Minds to AI Is a Price He's Willing to Pay",
      "8 wild quotes from Nvidia CEO Jensen Huang's latest interview on AI and why they should concern you",
      "Nvidia CEO Doesn't Care That Kids Are Forgetting Basic Math Because Of AI: 'I Actually Don't Know My Address'",
      "Nvidia CEO Says AI Companies Will Be Sued to Death If Their Frontier Models Keep Doing Horrible Things",
    ];
    const vocab = vocabulary(takes, names);
    const described = takes.map((take, index) => describeStory(take, hours(index), names, vocab));
    for (let i = 0; i < described.length; i += 1) {
      for (let j = i + 1; j < described.length; j += 1) expect(sameStory(described[i], described[j], options(names)).same, `${i} vs ${j}`).toBe(false);
    }
  });

  it("two different stories that share only the person's everyday words stay two stories", () => {
    expect(pair("Nvidia Stock Set For 40% Surge: 3 Catalysts That Could Drive the Next Big Move", "Jensen Huang Rejects Legal Waivers for AI Labs", ["Jensen Huang"]).same).toBe(false);
    expect(pair("Elon Musk Pushes Tesla Semi Into Its Biggest Phase Yet", "Elon Musk Sighs At EU-Wide FSD Approval Delay", ["Elon Musk"]).same).toBe(false);
  });

  it("outside the window nothing is one story, however alike", () => {
    const a = "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears";
    const b = "Mark Zuckerberg Loses $9 Billion In A Day As Goldman Sachs Pours Cold Water On Meta Stock Rally";
    expect(pair(a, b, ["Mark Zuckerberg"], quality.storyWindowHours + 1).same).toBe(false);
  });
});

describe("confirmationImpact", () => {
  it("is a share of the copy's own impact with its own sign, never above the cap", () => {
    const options = { confirmationShare: 0.2, confirmationCap: 0.15 };
    expect(confirmationImpact(0.5, options)).toBeCloseTo(0.1, 9);
    expect(confirmationImpact(-0.5, options)).toBeCloseTo(-0.1, 9);
    expect(confirmationImpact(-1.11, options)).toBeCloseTo(-0.15, 9);
    expect(confirmationImpact(4, options)).toBe(0.15);
    expect(confirmationImpact(0, options)).toBe(0);
  });
});

describe("confirmStories", () => {
  const names = ["Mark Zuckerberg"];
  const options = storyOptions(quality, names);
  const first = "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears";
  const second = "Mark Zuckerberg Loses $9 Billion In A Day As Goldman Sachs Pours Cold Water On Meta Stock Rally";

  it("a copy of a story scored earlier in the window is bounded; the leader keeps what it earned", () => {
    const result = confirmStories([scored("b", second, -1.11)], [recent("a", first, -1.11, hours(-2))], options);
    expect(result.scored[0].impact).toBeCloseTo(-0.15, 9);
    expect(result.scored[0].story).toMatchObject({ leaderId: "a", leader: "recent", anchor: "9 billion", fullImpact: -1.11 });
    expect(result.clusters).toEqual([{ leaderId: "a", leader: "recent", headline: first, members: [{ id: "b", similarity: result.scored[0].story?.similarity, anchor: "9 billion", fullImpact: -1.11, impact: -0.15 }] }]);
  });

  it("two copies in one tick: the strongest leads at full impact, the other confirms", () => {
    const result = confirmStories([scored("weak", first, -0.4), scored("strong", second, -1.11)], [], options);
    const byId = new Map(result.scored.map((entry) => [entry.signal.id, entry]));
    expect(byId.get("strong")?.impact).toBe(-1.11);
    expect(byId.get("strong")?.story).toBeUndefined();
    expect(byId.get("weak")?.impact).toBeCloseTo(-0.08, 9);
    expect(byId.get("weak")?.story).toMatchObject({ leaderId: "strong", leader: "tick" });
    // Order is preserved: the caller's list comes back in the caller's order.
    expect(result.scored.map((entry) => entry.signal.id)).toEqual(["weak", "strong"]);
  });

  it("leaves a neutral article, a metric, a filing and an unrelated story exactly as they were", () => {
    const untouched = [
      scored("neutral", second, 0),
      scored("metric", "Coverage of Meta is running 2.1x its usual pace", 0.3, AT, "metric"),
      scored("filing", "Mark Zuckerberg sold 50,000 Meta shares", 0.2, AT, "insider_filing"),
      scored("other", "Mark Zuckerberg Tried to Channel Steve Jobs When He Announced a New Muse Device", -0.27),
    ];
    const result = confirmStories(untouched, [recent("a", first, -1.11, hours(-2))], options);
    expect(result.scored).toEqual(untouched);
    expect(result.clusters).toEqual([]);
  });

  it("with nothing to compare against, every article is its own story and nothing changes", () => {
    const only = [scored("a", first, -1.11)];
    expect(confirmStories(only, [], options)).toEqual({ scored: only, clusters: [] });
  });
});
