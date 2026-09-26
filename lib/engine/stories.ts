import type { EngineConfig } from "@/lib/engine/config";
import { STORY_SIMILARITY_THRESHOLD, storySimilarity, storyTokens } from "@/lib/ingest/stories";
import type { RecentStory, ScoredSignal, StoryConfirmation } from "@/lib/engine/types";

/**
 * ONE EVENT, ONE SIGNAL (Phase 31).
 *
 * Ingestion already collapses syndicated copies of a story (lib/ingest/
 * stories.ts: Dice over content words at 0.4, within 48 hours, across both
 * news doors). What survives it and still reaches the Engine twice is the
 * REWRITE: the same event under headlines that share little vocabulary.
 * Measured over the week to 2026-09-25, every one of the four cases the
 * operator named sat below the ingestion threshold:
 *
 *   "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears"
 *   "Mark Zuckerberg Loses $9 Billion In A Day As Goldman Sachs Pours Cold
 *    Water On Meta Stock Rally"                             Dice 0.353
 *   "Martha Stewart Reveals Her Verdict On MrBeast After Spending Three Days
 *    Together" / "Martha Stewart Surprisingly Spent 3 Days with This
 *    Influencer, Later Calling Him 'Entertaining'"          Dice 0.353
 *   "Kendrick Lamar Earns Highest-Grossing Touring Year by a Rapper in
 *    History" / "Kendrick Lamar's 'Grand National Tour' Becomes
 *    Highest-Grossing Rap Tour Ever"                        Dice 0.25
 *
 * and each was scored at full impact twice: −1.11 and −1.11, +0.38 and
 * +0.48, +0.48 and +0.38.
 *
 * WHAT CHANGES. At scoring, a new event signal is compared with the person's
 * event signals already scored inside the story window, and with the other
 * event signals of the same tick. A copy of a story already scored is a
 * CONFIRMATION: it contributes a bounded share of its own impact
 * (storyConfirmationShare, at most storyConfirmationCap points), never the
 * full impact again. The first copy keeps everything it earned: scoring is
 * forward-only and nothing already published is restated.
 *
 * WHAT COUNTS AS THE SAME STORY. The ingestion rule (Dice ≥ 0.4) still does;
 * below it, two headlines are one story from storyAnchorThreshold when they
 * share an ANCHOR: a number ("9", "1299", "266.4", read with the "$" and the
 * thousands separators removed) or a PHRASE, two consecutive content words
 * that are not part of this person's everyday vocabulary ("martha stewart",
 * "highest grossing", "goldman sachs"). The everyday vocabulary is measured
 * on the person's own recent headlines: a word in at least
 * BACKGROUND_SHARE of them (and at least BACKGROUND_MIN_DOCS of them) is
 * background, and a phrase made only of background words ("nvidia ceo",
 * "week 3") anchors nothing.
 *
 * WHAT IT STILL MISSES, measured: five takes on one Jensen Huang interview
 * whose headlines quote five different sentences ("Sacrificing Our
 * Children's Minds", "Sued to Death", "true threat of AI") share no phrase
 * and no number. No lexical rule reaches those; the model sees them together
 * only when they arrive in one chunk, and the version-2 prompt tells it to
 * mark the rest routine. That is the honest limit of this instrument.
 *
 * Only news articles are compared (payload kind "article"): a game result,
 * a filing and a stream summary are each one event by construction.
 */

/**
 * A word is this person's background when it appears in at least this share
 * of their recent headlines... 0.15, tuned on the week to 2026-09-25: at 0.3
 * a quarterback's co-stars ("travis kelce", "tom brady") and an investor's
 * company ("berkshire hathaway") were still anchors, and every pair of
 * stories that mentioned them read as one story.
 */
export const BACKGROUND_SHARE = 0.15;
/** ...and in at least this many of them, so a person with two headlines has no background yet. */
export const BACKGROUND_MIN_DOCS = 3;

export interface StoryOptions {
  /** The Dice coefficient at or above which two headlines are one story without an anchor. Defaults to the ingestion threshold. */
  threshold?: number;
  /** The Dice coefficient from which two headlines sharing an anchor are one story. */
  anchorThreshold: number;
  /** Two items published further apart than this are never one story. */
  windowHours: number;
  /** The share of its own impact a confirming copy contributes. */
  confirmationShare: number;
  /** The most a confirming copy contributes, in points. */
  confirmationCap: number;
  /** The person's names, removed before headlines are compared. */
  personNames: string[];
}

export function storyOptions(quality: EngineConfig["signalQuality"], personNames: string[]): StoryOptions {
  return {
    anchorThreshold: quality.storyAnchorThreshold,
    windowHours: quality.storyWindowHours,
    confirmationShare: quality.storyConfirmationShare,
    confirmationCap: quality.storyConfirmationCap,
    personNames,
  };
}

/**
 * Google News keeps HTML entities in some titles ("Drake&#8217;s &#8220;Quebec&#8221;"),
 * and "8220" read as a number anchored two unrelated Drake stories. Entities
 * are whitespace here; the stored headline is not changed.
 */
export function withoutEntities(headline: string): string {
  return headline.replace(/&#\d+;|&#x[0-9a-f]+;|&[a-z]+;/gi, " ");
}

/** The content words of a headline in order (duplicates kept), for phrases; the set for Dice comes from lib/ingest/stories. */
function orderedTokens(headline: string, personNames: string[]): string[] {
  // storyTokens returns a Set in first-seen order, which is enough for the
  // set arithmetic but loses adjacency. Rebuild adjacency from the folded
  // text by walking its words and keeping those the set kept.
  const kept = storyTokens(headline, { personNames });
  const words = headline
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0);
  const out: string[] = [];
  for (const word of words) {
    const stemmed = stemLike(word);
    if (kept.has(stemmed)) out.push(stemmed);
  }
  return out;
}

/** The same light stem lib/ingest/stories applies, so a phrase's words meet the set's words. */
function stemLike(token: string): string {
  if (token.length > 4 && /(ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

const NUMBER = /\$?(\d[\d,]*(?:\.\d+)?)(?:\s*(%|[a-z]+))?/gi;

/**
 * The numbers in a headline, each with the word it qualifies: "$9 Billion"
 * → "9 billion", "1,299" → "1299 meta", "266.4 billion" → "266.4 billion".
 * A bare small integer anchors nothing on its own: "Week 3" against
 * "Week 3" is a recurring topic, not an event, and it read as one until this
 * rule. A number with a decimal point or four or more digits is specific
 * enough to stand alone.
 */
/** A four-digit number that is a year is a date, not an amount: "2026 Chiefs" and "2026 season" are one season, not one story. */
const YEAR = /^(19|20)\d\d$/;

export function numberAnchors(headline: string): Set<string> {
  const out = new Set<string>();
  for (const match of withoutEntities(headline).matchAll(NUMBER)) {
    const value = match[1].replace(/,/g, "");
    if (!value) continue;
    const word = match[2]?.toLowerCase();
    if (word && !YEAR.test(value)) out.add(`${value} ${stemLike(word)}`);
    if (value.includes(".") || (value.replace(/\D/g, "").length >= 4 && !YEAR.test(value))) out.add(value);
  }
  return out;
}

/** Every consecutive content-word pair of a headline, unfiltered: the raw material of phrase anchors and of the phrase frequencies. */
export function phrases(headline: string, personNames: string[]): Set<string> {
  const tokens = orderedTokens(withoutEntities(headline), personNames);
  const out = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i] !== tokens[i + 1]) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

/**
 * THE PERSON'S EVERYDAY VOCABULARY, measured on their own recent headlines:
 * a word in at least BACKGROUND_SHARE of them (and BACKGROUND_MIN_DOCS of
 * them), and any PHRASE in more than MAX_ANCHOR_PHRASE_DOCS of them. A phrase
 * that recurs across a quarterback's week ("chiefs qb", "travis kelce",
 * "kansas city") is a topic, and every pair of stories sharing it read as
 * one story until phrases were counted too: at the word level "kelce" sits
 * in a tenth of his headlines, below any share that still leaves "martha
 * stewart" an anchor for a creator with thirty. Counting the phrase itself
 * separates the two: an event's phrase appears in its copies and nowhere
 * else, a topic's phrase appears all week.
 */
export interface Vocabulary {
  words: Set<string>;
  commonPhrases: Set<string>;
}

/** A phrase in more than this many of the person's recent headlines is a topic, not an event: it anchors nothing. */
export const MAX_ANCHOR_PHRASE_DOCS = 3;

export function vocabulary(headlines: string[], personNames: string[]): Vocabulary {
  const documents = headlines.length;
  const wordCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  for (const headline of headlines) {
    for (const token of storyTokens(withoutEntities(headline), { personNames })) wordCounts.set(token, (wordCounts.get(token) ?? 0) + 1);
    for (const phrase of phrases(headline, personNames)) phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
  }
  const words = new Set<string>();
  for (const [token, count] of wordCounts) {
    if (count >= BACKGROUND_MIN_DOCS && count / documents >= BACKGROUND_SHARE) words.add(token);
  }
  const commonPhrases = new Set<string>();
  for (const [phrase, count] of phraseCounts) {
    if (count > MAX_ANCHOR_PHRASE_DOCS) commonPhrases.add(phrase);
  }
  return { words, commonPhrases };
}

/** Consecutive content-word pairs, less the person's everyday phrases and pairs made only of everyday words. */
export function phraseAnchors(headline: string, personNames: string[], vocab: Vocabulary): Set<string> {
  const out = new Set<string>();
  for (const phrase of phrases(headline, personNames)) {
    if (vocab.commonPhrases.has(phrase)) continue;
    const [a, b] = phrase.split(" ");
    if (vocab.words.has(a) && vocab.words.has(b)) continue;
    out.add(phrase);
  }
  return out;
}

export interface StoryDescription {
  tokens: Set<string>;
  anchors: Set<string>;
  occurredAt: Date;
}

export function describeStory(headline: string, occurredAt: Date, personNames: string[], vocab: Vocabulary): StoryDescription {
  return {
    tokens: storyTokens(withoutEntities(headline), { personNames }),
    anchors: new Set([...numberAnchors(headline), ...phraseAnchors(headline, personNames, vocab)]),
    occurredAt,
  };
}

export interface StoryMatch {
  same: boolean;
  similarity: number;
  /** The anchor that carried a match below the plain threshold; null when the plain threshold decided or nothing matched. */
  anchor: string | null;
}

/** Whether two described headlines tell one story: the plain threshold, or the anchor threshold with a shared anchor, inside the window. */
export function sameStory(a: StoryDescription, b: StoryDescription, options: StoryOptions): StoryMatch {
  const threshold = options.threshold ?? STORY_SIMILARITY_THRESHOLD;
  if (Math.abs(a.occurredAt.getTime() - b.occurredAt.getTime()) > options.windowHours * 3_600_000) return { same: false, similarity: 0, anchor: null };
  const similarity = storySimilarity(a.tokens, b.tokens);
  if (similarity >= threshold) return { same: true, similarity, anchor: null };
  if (similarity >= options.anchorThreshold) {
    for (const anchor of a.anchors) {
      if (b.anchors.has(anchor)) return { same: true, similarity, anchor };
    }
  }
  return { same: false, similarity, anchor: null };
}

/** The impact a confirming copy contributes: its own sign, a share of its own size, capped. */
export function confirmationImpact(fullImpact: number, options: Pick<StoryOptions, "confirmationShare" | "confirmationCap">): number {
  const magnitude = Math.min(Math.abs(fullImpact) * options.confirmationShare, options.confirmationCap);
  return Math.sign(fullImpact) * magnitude;
}

function isArticle(payload: unknown): boolean {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).kind === "article";
}

export interface StoryCluster {
  leaderId: string;
  leader: "recent" | "tick";
  headline: string;
  members: Array<{ id: string; similarity: number; anchor: string | null; fullImpact: number; impact: number }>;
}

export interface ConfirmedStories {
  scored: ScoredSignal[];
  clusters: StoryCluster[];
}

/**
 * Bounds every scored article that repeats a story already scored.
 *
 * Members are considered strongest first, so within one tick the strongest
 * copy is the one that keeps its impact. A recently scored story is a
 * cluster from the start, with its own impact already published; a new
 * article joins the cluster holding the member it is most similar to (single
 * linkage, as ingestion does), or starts one. Neutral articles (impact 0)
 * are left alone: there is nothing to bound.
 */
export function confirmStories(scored: ScoredSignal[], recent: RecentStory[], options: StoryOptions): ConfirmedStories {
  const candidates = scored.filter((entry) => entry.impact !== 0 && isArticle(entry.signal.rawPayload));
  if (candidates.length === 0) return { scored, clusters: [] };

  const headlines = [...recent.map((story) => story.headline), ...scored.filter((entry) => isArticle(entry.signal.rawPayload)).map((entry) => entry.signal.headline)];
  const vocab = vocabulary(headlines, options.personNames);

  type Member = StoryDescription & { id: string };
  type Cluster = { leaderId: string; leader: "recent" | "tick"; headline: string; members: Member[]; record: StoryCluster };
  const clusters: Cluster[] = recent.map((story) => {
    const description = describeStory(story.headline, story.occurredAt, options.personNames, vocab);
    const record: StoryCluster = { leaderId: story.id, leader: "recent", headline: story.headline, members: [] };
    return { leaderId: story.id, leader: "recent", headline: story.headline, members: [{ ...description, id: story.id }], record };
  });

  const ordered = [...candidates].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact) || a.signal.id.localeCompare(b.signal.id));
  const confirmations = new Map<string, { impact: number; story: StoryConfirmation }>();

  for (const entry of ordered) {
    const description = describeStory(entry.signal.headline, entry.signal.occurredAt, options.personNames, vocab);
    let best: { cluster: Cluster; match: StoryMatch } | null = null;
    for (const cluster of clusters) {
      for (const member of cluster.members) {
        const match = sameStory(description, member, options);
        if (match.same && (best === null || match.similarity > best.match.similarity)) best = { cluster, match };
      }
    }
    if (best) {
      const { cluster, match } = best;
      cluster.members.push({ ...description, id: entry.signal.id });
      const impact = confirmationImpact(entry.impact, options);
      const story: StoryConfirmation = { leaderId: cluster.leaderId, leader: cluster.leader, similarity: Number(match.similarity.toFixed(3)), anchor: match.anchor, fullImpact: entry.impact };
      confirmations.set(entry.signal.id, { impact, story });
      cluster.record.members.push({ id: entry.signal.id, similarity: story.similarity, anchor: match.anchor, fullImpact: entry.impact, impact });
      continue;
    }
    const record: StoryCluster = { leaderId: entry.signal.id, leader: "tick", headline: entry.signal.headline, members: [] };
    clusters.push({ leaderId: entry.signal.id, leader: "tick", headline: entry.signal.headline, members: [{ ...description, id: entry.signal.id }], record });
  }

  return {
    scored: scored.map((entry) => {
      const confirmation = confirmations.get(entry.signal.id);
      return confirmation ? { ...entry, impact: confirmation.impact, story: confirmation.story } : entry;
    }),
    clusters: clusters.filter((cluster) => cluster.record.members.length > 0).map((cluster) => cluster.record),
  };
}
