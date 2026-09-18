import type { RawSignal } from "@/lib/connectors/types";

/**
 * COMMENT DIGESTS (Phase 8+): one signal per video per poll, not one per comment.
 *
 * A single viewer comment is one person's reaction to one video. "Cameramen
 * deserve a huge bonus" is praise for the editing, not information about the
 * person's momentum, and a force built from thousands of them measures video
 * production quality. One comment was also one Feed entry, so a creator's
 * viewer chatter buried everyone else's news.
 *
 * So the sampled comments of a video are aggregated here, at ingestion, into
 * ONE event signal carrying the distribution and the sample size — never an
 * individual comment as its headline. The comments themselves are retained in
 * the payload as evidence; nothing user-facing uses them as hero text.
 *
 * The lean is counted with the Engine's own keyword lexicon
 * (`scoreHeadline` in lib/engine/sentiment/rules.ts), never a variant of it,
 * exactly as the metric pipeline normalises with lib/engine/baseline.ts. It
 * is INJECTED rather than imported, so this module keeps no dependency on the
 * Engine and the Engine's rules scorer can read the digest contract below
 * without the two importing each other.
 *
 * Counting is not judging: the digest reports a distribution, and the Engine
 * still scores the signal for itself — `applyPayloadHints` turns the counts
 * into a direction and a confidence the same way sigma does for a metric.
 *
 * ---------------------------------------------------------------------------
 * CASUAL REGISTER: MEASURED 2026-09-18, NOT FIXED ON PURPOSE. (Phase 18)
 *
 * Phase 8+ predicted the lexicon would read the news register and not this
 * one, and it does. Every digest in production — 87 of 87, over 870 sampled
 * comment slots from 96 distinct comments on 3 videos, one person — reads
 * "are mixed" at 0.000 impact. 851 of the 870 slots scored neutral; 18 scored
 * positive and 1 negative. Comment sentiment contributes exactly nothing, and
 * comment VOLUME (the comment_volume metric) is carrying the signal alone.
 *
 * Two fixes were offered and both were replayed against that corpus.
 *
 * (a) EXTEND THE LEXICON with casual speech. A candidate extension — goat,
 *     legend, insane/crazy/wild, fire, respect, congrats, best/king/hero,
 *     love/appreciate, the praise emoji, and the negatives mid/trash/flop/
 *     fell-off/scam/💀 — lifts the corpus from 5 positive comments to 53 and
 *     would turn 74 of the 87 digests positive at an average margin of 0.385.
 *     It fails on both registers at once:
 *       - NEWS. scoreHeadline is one function, shared. Of the 623 stored
 *         articles, 33 contain a candidate term and 30 of those change
 *         direction, including two that LOSE a correct negative ("Officials
 *         Under Fire for Missing Travis Kelce Penalty", "Adin Ross Wants
 *         'Investigation' Into Ray J vs. Supa Hot Fire Fight") and several
 *         that inherit a wrong one ("Sergey Brin fights fire with fire",
 *         "MrBeast's 'God King' problem", "Warren Buffett's dead-simple
 *         playbook", "The Time to Be Fearful When Others Are Greedy").
 *         lib/engine/sentiment/rules.test.ts pins those readings.
 *       - COMMENTS. The largest single class it newly catches is praise for
 *         the CAMERA CREW — the exact example at the top of this file. It
 *         would score the production, not the person, and it would score it
 *         one way: 74 positive, 0 negative.
 *
 * (b) LLM GRADES THE DIGEST. ~14.5 digests a day at current volume; one call
 *     per digest of ~650 input and ~120 output tokens is $0.00125 on Haiku 4.5
 *     and $0.0063 on Opus 5 — $0.55 and $2.75 a month for this one person,
 *     about $9 and $44 a month if all sixteen subjects were mapped for
 *     comments. Affordable, and it would label the register correctly. It does
 *     not fix what is actually wrong: YouTube's top comments are selected by
 *     likes, so the sample is positively selected BY CONSTRUCTION, and a
 *     perfectly graded digest is a better-measured one-sided reading. That is
 *     the Phase 10 rule — do not register something whose sigma describes the
 *     sampling rather than the subject — arriving by a different door.
 *
 * NEITHER SHIPS. Comment sentiment is not worth fixing while the sample is
 * like-ranked and the subject attribution is unsolved; comment volume is the
 * stronger signal and it already works. The digest stays as it is: a counted
 * distribution that reads mixed and contributes nothing until a comment
 * corpus arrives that is neither like-ranked nor mostly about the crew.
 *
 * ONE CONSEQUENCE WORTH KNOWING, not changed here because it belongs to the
 * volume baseline rather than to this file: person_signal_volume() counts
 * every event signal, digests included, so these zero-impact rows sit in the
 * denominator of the person's volume weight. Over 2026-09-14..17 they were 80
 * of MrBeast's 92 event signals. The weight is referenceSignalsPerDay divided
 * by that mean, so his real coverage is scaled down by his own viewer chatter.
 * Excluding comment_digest from the volume count is a one-line change to the
 * RPC and should be decided on its own, before the baseline engages.
 * ---------------------------------------------------------------------------
 */

export const COMMENT_DIGEST_KIND = "comment_digest";

/** The share of the sample that must lean one way for the digest to lean at all. */
export const COMMENT_LEAN_MARGIN = 0.1;

/** How many comment excerpts a digest keeps as evidence. */
export const COMMENT_EVIDENCE_MAX = 10;

/** Longest comment excerpt kept, in characters. */
export const COMMENT_EXCERPT_CHARS = 160;

export type CommentLean = "positive" | "negative" | "mixed";

export interface SampledComment {
  id: string;
  text: string;
  publishedAt: string | null;
}

export interface CommentDigest {
  sampled: number;
  positive: number;
  negative: number;
  neutral: number;
  lean: CommentLean;
  /** (positive − negative) / sampled, in −1..1. The digest's magnitude. */
  margin: number;
}

/** Collapses whitespace and trims a comment to one line. */
export function excerpt(text: string, max = COMMENT_EXCERPT_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Reads one comment and returns its direction: 1 positive, -1 negative, 0
 * neither. The Engine's `scoreHeadline` is what callers pass in.
 */
export type CommentLexicon = (text: string) => number;

/** The distribution of a video's sampled comments, by the lexicon it is given. */
export function aggregateComments(comments: SampledComment[], lexicon: CommentLexicon): CommentDigest {
  let positive = 0;
  let negative = 0;
  for (const comment of comments) {
    const direction = lexicon(comment.text);
    if (direction > 0) positive += 1;
    else if (direction < 0) negative += 1;
  }
  const sampled = comments.length;
  const margin = sampled > 0 ? (positive - negative) / sampled : 0;
  const lean: CommentLean = margin > COMMENT_LEAN_MARGIN ? "positive" : margin < -COMMENT_LEAN_MARGIN ? "negative" : "mixed";
  return { sampled, positive, negative, neutral: sampled - positive - negative, lean, margin };
}

const LEAN_PHRASE: Record<CommentLean, string> = { positive: "lean positive", negative: "lean negative", mixed: "are mixed" };

/**
 * One digest signal for one video's sampled comments.
 *
 * The dedupe key is the video plus a fingerprint of the comment ids it
 * summarises, so a poll that finds the same top comments as the last one does
 * not store the same digest twice. At most one signal per video per poll, and
 * none at all when nothing about the sample changed.
 */
export function commentDigestSignal(input: {
  sourceName: string;
  personName: string;
  videoId: string;
  videoTitle: string;
  comments: SampledComment[];
  lexicon: CommentLexicon;
  now: Date;
}): RawSignal | null {
  const comments = input.comments.filter((comment) => excerpt(comment.text).length > 0);
  if (comments.length === 0) return null;

  const digest = aggregateComments(
    comments.map((comment) => ({ ...comment, text: excerpt(comment.text) })),
    input.lexicon,
  );
  const title = excerpt(input.videoTitle, 80);
  const newest = comments
    .map((comment) => (comment.publishedAt ? new Date(comment.publishedAt) : null))
    .filter((date): date is Date => date !== null && !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    headline: `Comments on ${input.personName}'s "${title}" ${LEAN_PHRASE[digest.lean]}, ${digest.sampled} sampled.`,
    occurredAt: newest && newest.getTime() <= input.now.getTime() ? newest : input.now,
    dedupeKey: `${input.sourceName}:digest:${input.videoId}:${fingerprint(comments.map((comment) => comment.id))}`,
    rawPayload: {
      kind: COMMENT_DIGEST_KIND,
      source: input.sourceName,
      videoId: input.videoId,
      videoTitle: input.videoTitle,
      sampled: digest.sampled,
      positive: digest.positive,
      negative: digest.negative,
      neutral: digest.neutral,
      lean: digest.lean,
      // Evidence, never hero text: the excerpts behind the distribution above.
      comments: comments.slice(0, COMMENT_EVIDENCE_MAX).map((comment) => ({ id: comment.id, text: excerpt(comment.text), publishedAt: comment.publishedAt })),
    },
  };
}

/** A short, stable fingerprint of the sampled comment ids, order-independent. */
export function fingerprint(ids: string[]): string {
  let hash = 2166136261;
  for (const id of [...ids].sort()) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}
