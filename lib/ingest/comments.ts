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
