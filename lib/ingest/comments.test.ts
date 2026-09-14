import { describe, expect, it } from "vitest";

import { scoreHeadline } from "@/lib/engine/sentiment/rules";

import { COMMENT_LEAN_MARGIN, aggregateComments, commentDigestSignal, excerpt, fingerprint, type SampledComment } from "./comments";

const NOW = new Date("2026-09-07T12:00:00.000Z");
/** The Engine's own lexicon, as the connector injects it. */
const LEXICON = (text: string) => scoreHeadline(text).direction;

const comment = (id: string, text: string, publishedAt: string | null = "2026-09-06T10:00:00Z"): SampledComment => ({ id, text, publishedAt });

describe("excerpt", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(excerpt("  so   good\n\nlove it ")).toBe("so good love it");
    const long = "word ".repeat(60).trim();
    expect(excerpt(long).length).toBe(160);
    expect(excerpt(long).endsWith("…")).toBe(true);
  });
});

describe("aggregateComments", () => {
  it("counts each side with the lexicon it is given and leans only past the margin", () => {
    const positive = [comment("1", "a record breaking win"), comment("2", "he surpasses everyone"), comment("3", "nothing much to say")];
    expect(aggregateComments(positive, LEXICON)).toMatchObject({ sampled: 3, positive: 2, negative: 0, neutral: 1, lean: "positive" });

    const negative = [comment("1", "what a scandal"), comment("2", "total backlash")];
    expect(aggregateComments(negative, LEXICON)).toMatchObject({ sampled: 2, positive: 0, negative: 2, lean: "negative", margin: -1 });

    // Evenly split is mixed, not a weak lean in either direction.
    const split = [comment("1", "a record win"), comment("2", "what a scandal")];
    expect(aggregateComments(split, LEXICON)).toMatchObject({ sampled: 2, positive: 1, negative: 1, lean: "mixed", margin: 0 });
    expect(aggregateComments([], LEXICON)).toMatchObject({ sampled: 0, lean: "mixed", margin: 0 });
  });

  it("needs more than COMMENT_LEAN_MARGIN of the sample to lean", () => {
    expect(COMMENT_LEAN_MARGIN).toBe(0.1);
    const ten = (positives: number) =>
      Array.from({ length: 10 }, (_, index) => comment(String(index), index < positives ? "a record win" : "nothing in particular"));
    expect(aggregateComments(ten(1), LEXICON).lean).toBe("mixed");
    expect(aggregateComments(ten(2), LEXICON).lean).toBe("positive");
  });
});

describe("commentDigestSignal", () => {
  const digest = (comments: SampledComment[]) =>
    commentDigestSignal({ sourceName: "youtube_comments", personName: "MrBeast", videoId: "v1", videoTitle: "Escape 100 Cops, Win $500,000", comments, lexicon: LEXICON, now: NOW });

  it("is one signal for the whole sample, with the distribution and never a comment as its headline", () => {
    const signal = digest([comment("c1", "Bro is making movie productions now"), comment("c2", "this surpasses everything"), comment("c3", "a record breaking win")])!;
    expect(signal.headline).toBe('Comments on MrBeast\'s "Escape 100 Cops, Win $500,000" lean positive, 3 sampled.');
    expect(signal.headline).not.toContain("Bro is making");
    expect(signal.rawPayload).toMatchObject({ kind: "comment_digest", source: "youtube_comments", videoId: "v1", sampled: 3, positive: 2, negative: 0, neutral: 1, lean: "positive" });
    // The comments are kept as evidence, under the payload, in excerpt form.
    expect(signal.rawPayload.comments).toEqual([
      { id: "c1", text: "Bro is making movie productions now", publishedAt: "2026-09-06T10:00:00Z" },
      { id: "c2", text: "this surpasses everything", publishedAt: "2026-09-06T10:00:00Z" },
      { id: "c3", text: "a record breaking win", publishedAt: "2026-09-06T10:00:00Z" },
    ]);
    expect(signal.occurredAt).toEqual(new Date("2026-09-06T10:00:00Z"));
  });

  it("reads negative and mixed samples in the same voice", () => {
    expect(digest([comment("c1", "what a scandal")])!.headline).toBe('Comments on MrBeast\'s "Escape 100 Cops, Win $500,000" lean negative, 1 sampled.');
    expect(digest([comment("c1", "a record win"), comment("c2", "what a scandal")])!.headline).toBe('Comments on MrBeast\'s "Escape 100 Cops, Win $500,000" are mixed, 2 sampled.');
  });

  it("keys on the video and a fingerprint of the sampled ids, so an unchanged sample is not stored twice", () => {
    const first = digest([comment("c1", "great"), comment("c2", "good")])!;
    const reordered = digest([comment("c2", "good"), comment("c1", "great")])!;
    const changed = digest([comment("c1", "great"), comment("c3", "new one")])!;
    expect(first.dedupeKey).toBe(reordered.dedupeKey);
    expect(first.dedupeKey).not.toBe(changed.dedupeKey);
    expect(first.dedupeKey).toMatch(/^youtube_comments:digest:v1:[a-z0-9]+$/);
    expect(fingerprint(["a", "b"])).toBe(fingerprint(["b", "a"]));
    expect(fingerprint(["a"])).not.toBe(fingerprint(["b"]));
  });

  it("has nothing to say about a video with no usable comments, and falls back to the run's clock", () => {
    expect(digest([])).toBeNull();
    expect(digest([comment("c1", "   ")])).toBeNull();
    expect(digest([comment("c1", "great", null)])!.occurredAt).toBe(NOW);
    // A comment dated in the future never dates the digest ahead of the run.
    expect(digest([comment("c1", "great", "2030-01-01T00:00:00Z")])!.occurredAt).toBe(NOW);
  });
});
