/**
 * What a metric signal SAYS, in the consumer app.
 *
 * Until Phase 21+ every metric spoke one sentence — "X's <label> is running
 * +2.8σ above their own trailing fortnight" — which had three faults. σ is a
 * derived statistic a casual reader cannot check. "Their own trailing
 * fortnight" is not a phrase anyone says. And one template across sixteen
 * metrics is most of why the Feed read mechanical.
 *
 * This module is the replacement, and it is DISPLAY ONLY. Nothing here decides
 * what a metric measures, what emits, where a threshold sits or what a score
 * does; it is handed a reading that has already been judged and chooses words
 * for it. `lib/signals/metric-language.scoring.test.ts` asserts that.
 *
 * FOUR RULES, all deterministic.
 *
 * 1. NO σ. The raw counts underneath are more transparent, not less: "twelve
 *    stories today against a usual pace of four" is checkable by anyone with
 *    the Feed in front of them, where +2.8σ is checkable by nobody. σ stays in
 *    the operator console and the methodology.
 *
 * 2. REGISTER FOLLOWS MAGNITUDE, as a function and never a random draw, so the
 *    same reading always produces the same words and a reader learns what
 *    "spiking" means against "running hot" without being taught. Where a band
 *    holds several variants the choice is a hash of the person and the day
 *    (`variantIndex`), so a refresh cannot change the sentence under someone.
 *
 * 3. MULTIPLES AT 2x AND ABOVE, PERCENTAGES BELOW, and never a decimal
 *    multiple for a reading below its own pace: "0.3x his baseline" is
 *    unreadable where "down 70% from his usual pace" is not. Which side of a
 *    boundary a reading falls is decided on the figure as DISPLAYED, never on
 *    the raw value behind it (Phase 24): a rule that branches on the raw
 *    number and then rounds for the reader will, sooner or later, print the
 *    same fact two ways.
 *
 * 4. EVERY METRIC SAYS WHAT IT OBSERVED. `METRIC_VOICE` gives each registered
 *    metric its own nouns and verbs; a metric with no entry falls back to its
 *    declared label rather than to silence.
 *
 * ON PRONOUNS. The comparison is to the person themselves — Drake against
 * Drake, never Drake against MrBeast — and that has to survive the rewrite.
 * It is carried by naming the person and by "their own", NOT by he/she: the
 * people on this board are real, `people` stores no pronouns, and a name does
 * not tell you anybody's. Guessing would misgender someone in production in a
 * way "their" never does. If pronouns are added to the roster as data, the
 * possessive here is the one place that needs to change.
 */

import { registerFor, type MetricRegister } from "./register";

/** The digits a count may carry in a headline before the privacy trigger refuses it (no run of four). */
const MAX_PLAIN_COUNT = 999;

/** A reading, as the language layer needs it: judged already, and carrying no identity of its own. */
export interface MetricReadingText {
  /** The metric key, which picks the voice. */
  metric: string;
  /** The declared label, the fallback when a metric has no voice of its own. */
  label: string;
  /** Standard deviations from the person's own baseline. Read for magnitude and sign ONLY; never shown. */
  sigma: number;
  /** The baseline window, in hours. */
  windowHours: number;
  /** The observed quantity, when the metric declares it publishable (`publish_observed`). */
  observed?: number | null;
  /** The mean of the person's own baseline, when the metric declares it publishable. */
  baseline?: number | null;
}

export interface MetricSentenceInput extends MetricReadingText {
  /** The person's display name. */
  name: string;
  /**
   * The day the variant is chosen for, as YYYY-MM-DD. The sentence is stable
   * within a day and for a given reading; passing the reading's own date keeps
   * a stored headline and a re-render of it identical forever.
   */
  day: string;
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * The bands live in ./register, not here. They were a display concern until
 * Phase 24 made a band change the thing a metric emits on, which gave them a
 * second caller in the ingestion path; this module keeps choosing words and
 * nothing else. Re-exported so the many callers that ask this module for a
 * register need not know where it moved to.
 */
export { REGISTER_BANDS, registerFor, type MetricRegister } from "./register";

/**
 * Which variant a band uses, from the person and the day. A stable hash
 * (FNV-1a), never Math.random: a reader who refreshes must see the same
 * sentence, and a stored headline must match a later re-render of it exactly.
 */
export function variantIndex(name: string, day: string, metric: string, count: number): number {
  if (count <= 1) return 0;
  let hash = 0x811c9dc5;
  for (const char of `${name}|${day}|${metric}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

// ---------------------------------------------------------------------------
// Comparison: multiples above 2x, percentages below
// ---------------------------------------------------------------------------

/**
 * How the reading compares with the person's own pace, in two grammatical
 * shapes — or null when the metric publishes no counts, or when the baseline
 * is too near zero for a ratio to mean anything (a pace of nothing has no
 * multiple).
 *
 * `standalone` follows a dash or stands alone: "3x their usual pace",
 * "up 30% on their usual pace". `running` completes "... is running ___":
 * "3x their usual pace", "30% above their usual pace". One phrase cannot do
 * both jobs — "is running up 30%" is not a sentence.
 *
 * ABOVE: a reading that would PRINT as 2x or more becomes a multiple, rounded
 * to the nearest half so "3x" stays punchy and "2.5x" stays honest; anything
 * below that becomes a percentage, because "1.3x their baseline" reads worse
 * than "up 30%". The test is the displayed percentage and not the raw ratio —
 * see the note in the body, which is a real defect this fixed.
 *
 * BELOW: never a decimal multiple. A simple fraction when the pace divides
 * close to one ("a third of their usual pace"), a percentage otherwise. The
 * fraction windows are narrow enough that each one swallows the percentage
 * that would name it — nothing below pace ever prints "down 50%", because
 * "half" owns that reading — which is the same rule as above, enforced by
 * arithmetic rather than by a branch.
 */
export interface Comparison {
  standalone: string;
  running: string;
  /** Observed over baseline, for anything that needs the number rather than the words. */
  ratio: number;
}

export function comparisonPhrase(observed: number | null | undefined, baseline: number | null | undefined): Comparison | null {
  if (typeof observed !== "number" || typeof baseline !== "number") return null;
  if (!Number.isFinite(observed) || !Number.isFinite(baseline)) return null;
  // A ratio against a pace of nothing is either infinite or meaningless.
  if (baseline <= 0 || observed < 0) return null;

  const ratio = observed / baseline;
  if (!Number.isFinite(ratio)) return null;

  // EVERY BOUNDARY IS DECIDED ON THE DISPLAYED FIGURE, NEVER THE RAW ONE
  // (Phase 24). The first live game put these two lines fifteen minutes
  // apart, about the same metric, on the same afternoon:
  //
  //   "People are sharing Patrick Mahomes' moments 100% above their usual pace"
  //   "People are sharing Patrick Mahomes' moments at 2x their usual pace"
  //
  // Both were right. A ratio of 1.9975 took the percentage branch (raw ratio
  // below 2) and then ROUNDED to 100%, which is 2x said differently, while
  // 2.0007 took the multiple branch. The raw ratio decided the branch and the
  // rounded figure decided the words, so the two disagreed in the gap between
  // them.
  //
  // The fix is to let the DISPLAYED percentage choose: the multiple form owns
  // everything that would print as 2x or more, so the percentage form can
  // never print 100% and the two can never describe the same magnitude. The
  // crossover is exactly where "up 99%" ends.
  const percent = Math.round((ratio - 1) * 100);

  if (percent >= 100) {
    // A multiple is itself a number, and past a point it becomes a raw level
    // wearing an x: 45,000 stories against a usual 4 is "11250x", which is
    // four digits and would trip the privacy trigger as surely as the count
    // would. Anything this far out is "over 100x" — the exact figure tells a
    // reader nothing the words do not. Tested on the ROUNDED multiple for the
    // same reason as above: 99.8x rounds to "100x", so it belongs with the
    // hundreds and not with the exact figures.
    const rounded = Math.round(ratio * 2) / 2;
    if (rounded >= 100) return { standalone: "over 100x their usual pace", running: "at over 100x their usual pace", ratio };
    const multiple = `${formatMultiple(rounded)}x their usual pace`;
    // "at" so the phrase survives any progressive verb — "is running at 3x
    // their usual pace", "has been live at 2x their usual pace".
    return { standalone: multiple, running: `at ${multiple}`, ratio };
  }
  if (ratio > 1) {
    if (percent < 1) return { standalone: "barely above their usual pace", running: "barely above their usual pace", ratio };
    return { standalone: `up ${percent}% on their usual pace`, running: `${percent}% above their usual pace`, ratio };
  }
  if (ratio === 1) return { standalone: "level with their usual pace", running: "level with their usual pace", ratio };

  // Nothing at all is not "down 100%". A percentage describes a shortfall from
  // something; zero is the absence of the thing, and the first live signal
  // after Phase 21+ shipped was exactly this — Larry Ellison, no stories
  // against a usual pace of 5.3. About 1.5% of emitted readings are zero.
  if (ratio === 0) return { standalone: "nothing at all against their usual pace", running: "nowhere near their usual pace", ratio };

  // Below pace, and the same rule again: the fraction owns exactly the
  // shortfalls that would PRINT as its own percentage, so the two forms can
  // never name the same reading. Keying the window off the displayed figure
  // rather than off the denominator is what closed the last hole in this —
  // a ratio of 0.195 printed "down 80%" while 0.1953 printed "a fifth".
  const down = Math.round((1 - ratio) * 100);
  if (down < 1) return { standalone: "just below their usual pace", running: "just below their usual pace", ratio };
  // A shortfall that rounds to the whole thing is not the whole thing: a
  // reading of 0.004 against a pace of 1 is not "down 100%", which claims the
  // absence that the ratio === 0 branch above is for.
  if (down >= 100) return { standalone: "next to nothing against their usual pace", running: "nowhere near their usual pace", ratio };
  const fraction = FRACTION_WORDS[down];
  if (fraction) return { standalone: `${fraction} of their usual pace`, running: `at ${fraction} of their usual pace`, ratio };
  return { standalone: `down ${down}% on their usual pace`, running: `${down}% below their usual pace`, ratio };
}

/**
 * The shortfalls a plain fraction says better than a percentage, keyed by the
 * percentage each one IS as displayed: "half" is exactly the reading that
 * would print "down 50%", "a third" the one that would print "down 67%".
 */
const FRACTION_WORDS: Record<number, string> = { 50: "half", 67: "a third", 75: "a quarter", 80: "a fifth" };

/** 3 → "3", 2.5 → "2.5". A multiple never shows a trailing zero. */
function formatMultiple(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
// ---------------------------------------------------------------------------
// Per-metric voice
// ---------------------------------------------------------------------------

/**
 * WHAT EACH METRIC SAYS, per register, as COMPLETE SENTENCES rather than
 * fragments to be glued together.
 *
 * The first attempt at this composed a sentence from a noun phrase and a verb
 * phrase per metric, and produced "Drake's clips and moments spreading just
 * accelerated" and "Views on their newest uploads is elevated for MrBeast".
 * English does not survive that kind of assembly. Every template here is
 * written out and readable on its own line, which is more text and the only
 * way the result reads like a person wrote it.
 *
 * PLACEHOLDERS. `{name}` and `{their}` (the possessive, by one rule for the
 * whole app) always resolve. `{span}` is the baseline window in
 * words ("fortnight"). `{count}` is the observed quantity with its unit ("12
 * stories") and resolves only for a metric that declares `publish_observed`.
 * `{comparison}` stands alone after a dash ("3x their usual pace", "up 30% on
 * their usual pace"); `{running}` follows a progressive verb —
 * "is running at 3x their usual pace", "are spreading 30% above their usual
 * pace" — which is why a multiple carries "at" there and not in `{comparison}`. A template whose placeholders cannot
 * all be filled is dropped before the variant is chosen, so a metric that
 * publishes no counts simply uses its other lines.
 *
 * COMPARISON TO SELF is carried in every line, by naming the person and
 * saying "their usual", never by an appended "for him". See the note on
 * pronouns at the top of this file.
 */
/**
 * What a count counts, in both numbers. BOTH forms are declared rather than
 * derived, because the head noun is not always the first word ("company
 * stories" → "company story") nor the last ("clips an hour" → "clip an hour"),
 * and a rule that has to find it would be wrong on one of the seventeen.
 */
export interface MetricUnit {
  /** The form used when the displayed figure is exactly 1: "story", "clip an hour". */
  one: string;
  /** The form used for every other figure, zero and fractions included: "stories", "clips an hour". */
  many: string;
}

export interface MetricVoice {
  /** What the count counts, for `{count}` and for the expand. Absent when the metric publishes no counts. */
  unit?: MetricUnit;
  /** 3.5σ and above: momentum-native, because something is genuinely happening. */
  spiking: string[];
  /** 2.5–3.5σ: concrete, because the number carries itself. */
  concrete: string[];
  /** 2.0–2.5σ: terminal-flavoured and understated, for a modest reading. */
  elevated: string[];
  /** Below their own pace, at any magnitude: terminal throughout, and never a concrete count. */
  quiet: string[];
}

export const METRIC_VOICE: Record<string, MetricVoice> = {
  // --- the two news doors --------------------------------------------------
  news_volume_24h: {
    unit: { one: "story", many: "stories" },
    spiking: ["Attention on {name} is spiking", "{their} news flow just accelerated", "{name} is all over the news right now"],
    concrete: ["{count} on {name} today — {comparison}", "Coverage of {name} is running {running}", "{count} on {name} today, {comparison}"],
    elevated: ["Coverage of {name} is running hot", "Unusually busy stretch for {name}", "{name} is getting more coverage than usual"],
    quiet: ["Quiet stretch for {name}", "Coverage of {name} has cooled off", "The news has gone quiet on {name}"],
  },
  company_news_volume_24h: {
    // Deliberately about the company and never the person: this counts
    // articles about the business, and conflating the two would credit
    // someone with their employer's news.
    unit: { one: "company story", many: "company stories" },
    spiking: ["{their} company is all over the news", "News about {their} company just accelerated"],
    concrete: ["{count} about {their} company — {comparison}", "Coverage of {their} company is running {running}"],
    elevated: ["{their} company is in the news more than usual", "Busy stretch for {their} company"],
    quiet: ["Quiet stretch for {their} company", "Coverage of {their} company has cooled off"],
  },
  viral_moment_rate: {
    unit: { one: "viral moment", many: "viral moments" },
    spiking: ["{name} is everywhere right now", "{their} clips are spreading fast", "People cannot stop sharing {their} moments"],
    concrete: ["{count} from {name} spreading — {comparison}", "People are sharing {their} moments {running}", "{their} moments are spreading {running}"],
    elevated: ["People are sharing {their} moments more than usual", "{their} clips are travelling further than usual"],
    quiet: ["{their} moments are spreading less than usual", "Fewer {name} clips are travelling than usual"],
  },

  // --- YouTube -------------------------------------------------------------
  subscriber_count: {
    spiking: ["{name} is gaining subscribers fast", "Subscribers are piling onto {their} channel"],
    concrete: ["{name} is gaining subscribers {running}", "Subscriber growth on {their} channel is running {running}"],
    elevated: ["{name} is picking up subscribers faster than usual", "Subscriber growth is running ahead of usual for {name}"],
    quiet: ["Subscriber growth has slowed for {name}", "{name} is gaining subscribers more slowly than usual"],
  },
  view_count: {
    spiking: ["Views on {their} channel are surging", "{their} channel is pulling views fast"],
    concrete: ["{their} channel is pulling views {running}", "Views on {their} channel are running {running}"],
    elevated: ["{their} channel is pulling views faster than usual", "View growth is running ahead of usual for {name}"],
    quiet: ["Views on {their} channel have slowed", "{their} channel is pulling views more slowly than usual"],
  },
  recent_video_views: {
    spiking: ["{their} newest uploads are taking off", "{their} latest videos are moving fast"],
    concrete: ["{their} newest uploads are moving {running}", "Views on {their} latest videos are running {running}"],
    elevated: ["{their} newest uploads are moving faster than usual", "{their} latest videos are outpacing their usual"],
    quiet: ["{their} newest uploads are moving more slowly than usual", "{their} latest videos are under their usual pace"],
  },
  commentary_volume_24h: {
    unit: { one: "video", many: "videos" },
    spiking: ["YouTube cannot stop talking about {name}", "{name} is the subject of the day on YouTube"],
    concrete: ["{count} about {name} on YouTube — {comparison}", "YouTube is talking about {name} {running}"],
    elevated: ["YouTube is talking about {name} more than usual", "More creators are covering {name} than usual"],
    quiet: ["YouTube has gone quieter on {name}", "Fewer creators are covering {name} than usual"],
  },
  upload_rate: {
    unit: { one: "upload a day", many: "uploads a day" },
    spiking: ["{name} is uploading at a tear", "{their} upload schedule has gone into overdrive"],
    concrete: ["{name} is uploading {running}", "{their} upload cadence is running {running}"],
    elevated: ["{name} is uploading more often than usual", "{their} upload schedule has picked up"],
    quiet: ["{name} is uploading less often than usual", "{their} upload schedule has slowed"],
  },
  comment_volume: {
    // Observe-only since Phase 21 (a sum over a changing basket of uploads),
    // so it emits nothing today. Written for the day the connector gives it a
    // basket-stable definition.
    unit: { one: "comment", many: "comments" },
    spiking: ["{their} comment sections have erupted", "Viewers are flooding {their} comments"],
    concrete: ["{their} comment sections are running {running}", "Comments on {their} videos are running {running}"],
    elevated: ["{their} comment sections are busier than usual", "Viewers are commenting more than usual on {name}"],
    quiet: ["{their} comment sections have gone quiet", "Viewers are commenting less than usual on {name}"],
  },

  // --- Twitch --------------------------------------------------------------
  follower_count: {
    spiking: ["{name} is gaining followers fast", "Followers are piling onto {their} channel"],
    concrete: ["{name} is gaining followers {running}", "Follower growth for {name} is running {running}"],
    elevated: ["{name} is picking up followers faster than usual", "Follower growth is running ahead of usual for {name}"],
    quiet: ["Follower growth has slowed for {name}", "{name} is gaining followers more slowly than usual"],
  },
  stream_hours_7d: {
    unit: { one: "hour", many: "hours" },
    spiking: ["{name} has barely been offline", "{name} is living on stream this week"],
    concrete: ["{name} streamed {count} this week — {comparison}", "{name} has been live {running}"],
    elevated: ["{name} has been live more than usual", "Longer week on stream than usual for {name}"],
    quiet: ["{name} has been live less than usual", "Shorter week on stream than usual for {name}"],
  },
  stream_days_7d: {
    unit: { one: "day", many: "days" },
    spiking: ["{name} has streamed almost every day", "{name} is on a streaming run"],
    concrete: ["{name} was live on {count} this week — {comparison}", "{name} is streaming {running}"],
    elevated: ["{name} is streaming on more days than usual", "{name} has been on more often than usual"],
    quiet: ["{name} is streaming on fewer days than usual", "{name} has been on less often than usual"],
  },
  clips_per_stream_hour: {
    unit: { one: "clip an hour", many: "clips an hour" },
    spiking: ["{their} stream is getting clipped constantly", "Clips are pouring off {their} stream"],
    concrete: ["{count} off {their} stream — {comparison}", "{their} stream is getting clipped {running}"],
    elevated: ["{their} stream is getting clipped more than usual", "More clip-worthy stream than usual for {name}"],
    quiet: ["{their} stream is getting clipped less than usual", "Fewer clips off {their} stream than usual"],
  },
  session_peak_viewers: {
    // No unit: peak concurrent audience is an audience size, and the Phase 7
    // boundary keeps those out of a payload. The register still carries the
    // reading; the number does not appear.
    spiking: ["{their} stream drew a huge crowd", "{name} packed the stream out"],
    concrete: ["{their} stream peaked well above their usual", "{name} drew a bigger crowd than usual"],
    elevated: ["{their} stream peaked above their usual", "Bigger crowd than usual on {their} stream"],
    quiet: ["{their} stream peaked below their usual", "Smaller crowd than usual on {their} stream"],
  },

  // --- American football ---------------------------------------------------
  game_passing_yards: {
    unit: { one: "yard", many: "yards" },
    spiking: ["{name} put up a huge passing game", "{name} threw the ball all over the field"],
    concrete: ["{count} through the air for {name} — {comparison}", "{name} is throwing the ball {running}"],
    elevated: ["{name} is throwing for more than usual", "Bigger passing game than usual for {name}"],
    quiet: ["{name} is throwing for less than usual", "Quieter passing game than usual for {name}"],
  },
  game_passer_rating: {
    spiking: ["{name} was near-perfect through the air", "{name} put up an elite passing line"],
    concrete: ["{name} is rating well above their usual", "{name} is playing above their usual standard"],
    elevated: ["{name} is rating above their usual", "Sharper game than usual for {name}"],
    quiet: ["{name} is rating below their usual", "Off day by {their} standards"],
  },
  game_interceptions: {
    unit: { one: "interception", many: "interceptions" },
    spiking: ["{name} is giving the ball away", "Turnovers are piling up on {name}"],
    concrete: ["{count} thrown by {name} — {comparison}", "{name} is throwing interceptions {running}"],
    elevated: ["{name} is throwing more interceptions than usual", "Looser with the ball than usual for {name}"],
    quiet: ["{name} is protecting the ball better than usual", "Fewer giveaways than usual from {name}"],
  },
};

/**
 * A metric with no voice of its own still says what it observed, built from
 * its declared label. Deliberately plain: a metric that reaches a reader
 * without anyone writing its words should read as unremarkable, not as broken.
 */
export function fallbackVoice(label: string): MetricVoice {
  const subject = label.trim() || "activity";
  return {
    spiking: [`{their} ${subject} has jumped sharply`],
    concrete: [`{their} ${subject} is running {running}`, `{their} ${subject} is well above their usual`],
    elevated: [`{their} ${subject} is running above their usual`],
    quiet: [`{their} ${subject} is running below their usual`],
  };
}

export function voiceFor(metric: string, label: string): MetricVoice {
  return METRIC_VOICE[metric] ?? fallbackVoice(label);
}

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

/** "fortnight", "week" — the span the person is compared against, in the words a reader uses. */
export function spanWords(hours: number): string {
  if (hours <= 36) return "day";
  if (hours <= 192) return "week";
  if (hours <= 360) return "fortnight";
  if (hours <= 800) return "month";
  // Past a month, weeks stay more legible than a fractional month until the
  // span is long enough that months read cleanly: 1680 hours is "10 weeks",
  // not "2 months".
  const weeks = Math.round(hours / 168);
  return weeks <= 14 ? `${weeks} weeks` : `${Math.round(hours / 720)} months`;
}

/**
 * The unit that agrees with a figure, AS IT IS DISPLAYED. English takes the
 * singular for exactly one and the plural for everything else, zero and
 * fractions included — "0 stories", "1 story", "1.4 stories" — so the test is
 * the rounded figure the reader will see, never the raw value behind it.
 */
export function unitFor(value: number, unit: MetricUnit): string {
  return value === 1 ? unit.one : unit.many;
}

/** A count small enough to print in a headline without tripping the privacy trigger's digit rules. */
export function countWords(value: number, unit: MetricUnit): string {
  const rounded = Math.round(value);
  // Over a thousand is said in words rather than digits: the privacy trigger
  // refuses a run of four digits in a metric headline, and it is right to —
  // "1,247 clips" is a raw level wearing a comma. "Over a thousand" is not.
  if (rounded > MAX_PLAIN_COUNT) return `over a thousand ${unit.many}`;
  return `${rounded} ${unitFor(rounded, unit)}`;
}

/**
 * The sentence a reader sees. Deterministic in every input: the same reading,
 * person and day always produce the same words, so a refresh cannot change the
 * sentence under someone and a stored headline always matches a later
 * re-render of itself.
 */
export function metricSentence(input: MetricSentenceInput): string {
  const { name, sigma, metric, label, windowHours, observed, baseline, day } = input;
  const voice = voiceFor(metric, label);
  const register = registerFor(sigma);
  const comparison = comparisonPhrase(observed, baseline);

  const values: Record<string, string | null> = {
    name,
    their: possessive(name),
    span: spanWords(windowHours),
    count: voice.unit && typeof observed === "number" && Number.isFinite(observed) ? countWords(observed, voice.unit) : null,
    // A count below the person's own pace is never printed: stated plainly it
    // reads as an accusation, which is why the quiet band has no {count} line.
    comparison: register === "quiet" ? null : (comparison?.standalone ?? null),
    running: register === "quiet" ? null : (comparison?.running ?? null),
  };

  const fits = (band: MetricRegister) => voice[band].filter((template) => placeholders(template).every((key) => values[key] != null));

  // The CONCRETE band is built around a number, so a metric that publishes no
  // count has nothing to say in it. Rather than give seventeen metrics a bland
  // spare line, such a reading borrows the ELEVATED band's words: "above their
  // usual, and I cannot tell you by how much" is exactly what that band says.
  // The other three bands are written to need nothing but the person's name,
  // and metric-language.test.ts fails if that stops being true.
  const own = fits(register);
  const usable = own.length > 0 ? own : register === "concrete" ? fits("elevated") : [];
  const templates = usable.length > 0 ? usable : [`{their} ${label} is running ${sigma < 0 ? "below" : "above"} their usual`];
  return fill(templates[variantIndex(name, day, metric, templates.length)], values);
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
}

function fill(template: string, values: Record<string, string | null>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// The expand: what was observed, and what it was measured against
// ---------------------------------------------------------------------------

export interface MetricDetailLine {
  label: string;
  value: string;
}

/**
 * What the expand shows, so a reader can reconstruct why the signal fired
 * without meeting σ: the observed count, the person's own pace, the
 * comparison between them, and the window and sample size the pace was built
 * from. A metric that publishes no counts still explains itself — the window
 * and the sample are the part that makes the comparison fair.
 */
export function metricDetail(input: MetricReadingText & { name: string; samples?: number | null }): MetricDetailLine[] {
  const voice = voiceFor(input.metric, input.label);
  const lines: MetricDetailLine[] = [];
  const unit = voice.unit;

  if (unit && typeof input.observed === "number" && Number.isFinite(input.observed)) {
    lines.push({ label: "Observed", value: countLine(input.observed, unit) });
  }
  if (unit && typeof input.baseline === "number" && Number.isFinite(input.baseline)) {
    lines.push({ label: "Their usual pace", value: countLine(input.baseline, unit) });
  }

  const comparison = comparisonPhrase(input.observed, input.baseline);
  if (comparison) lines.push({ label: "Against their own pace", value: capitalise(comparison.standalone) });

  // The comparison is to the person themselves, and this line is where that
  // is stated outright rather than implied.
  lines.push({ label: "Measured against", value: `${possessive(input.name)} own ${spanWords(input.windowHours)}` });
  if (typeof input.samples === "number" && Number.isFinite(input.samples)) {
    lines.push({ label: "Readings in that window", value: String(Math.round(input.samples)) });
  }
  return lines;
}

/** "Drake" → "Drake's", "Travis Scott" → "Travis Scott's", "Lucas" → "Lucas'". */
export function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/**
 * A count and its unit for the expand, where the privacy trigger's headline
 * rules do not apply but readability still does. The unit agrees with the
 * figure AFTER rounding, so a baseline of 1.02 reads "1 story" and one of 1.4
 * reads "1.4 stories".
 */
function countLine(value: number, unit: MetricUnit): string {
  const rounded = Math.round(value * 10) / 10;
  return `${formatCount(value)} ${unitFor(rounded, unit)}`;
}

/** A count for the expand, to one decimal, thousands separated. */
function formatCount(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toLocaleString("en-US") : rounded.toFixed(1);
}

// ---------------------------------------------------------------------------
// Reading a stored payload back
// ---------------------------------------------------------------------------

/** A metric signal's payload, as the display layer meets it. */
export interface MetricPayloadReading extends MetricReadingText {
  samples: number | null;
}

/**
 * A metric signal's payload, parsed for display — or null when the payload is
 * not a metric's, or carries too little to say anything.
 *
 * This is what lets a signal stored BEFORE Phase 21+ still read as plain
 * language: the sentence needs the metric, its label, the sigma and the
 * window, and every payload has carried those since Phase 7. Only the counts
 * are new, so a historical signal renders the sentence and omits the
 * arithmetic rather than falling back to the stored sigma headline.
 */
export function readMetricPayload(payload: unknown): MetricPayloadReading | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.kind !== "metric") return null;

  const metric = typeof record.metric === "string" ? record.metric : null;
  const sigma = numberOrNull(record.sigma);
  const windowHours = numberOrNull(record.window_hours);
  if (metric === null || sigma === null || windowHours === null) return null;

  return {
    metric,
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : metric.replace(/_/g, " "),
    sigma,
    windowHours,
    observed: numberOrNull(record.observed),
    baseline: numberOrNull(record.baseline),
    samples: numberOrNull(record.samples),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The day a signal's sentence is chosen for: its own, so a re-render matches what was stored. */
export function dayOf(occurredAt: string): string {
  const date = new Date(occurredAt);
  return Number.isNaN(date.getTime()) ? "1970-01-01" : date.toISOString().slice(0, 10);
}

/**
 * The sentence for a stored metric signal, or null when the payload is not a
 * metric's. `name` is the person the signal is ABOUT, which for an
 * inverse-pair evidence row is the paired person rather than the entry's.
 */
export function sentenceForPayload(payload: unknown, name: string, occurredAt: string): string | null {
  const reading = readMetricPayload(payload);
  if (!reading) return null;
  return metricSentence({ ...reading, name, day: dayOf(occurredAt) });
}

/** The expand's lines for a stored metric signal, or an empty list when it is not one. */
export function detailForPayload(payload: unknown, name: string): MetricDetailLine[] {
  const reading = readMetricPayload(payload);
  return reading ? metricDetail({ ...reading, name }) : [];
}
