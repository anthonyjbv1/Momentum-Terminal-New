import { detailForPayload, readMetricPayload, sentenceForPayload, type MetricDetailLine } from "@/lib/signals/metric-language";

/**
 * ONE VOICE FOR EVERY CARD (Phase 30).
 *
 * Every surface that shows a signal or an Engine narrative — the Feed, the
 * profile's Signals list, the landing page's "Why it moved" and Home's
 * desktop rail — renders its words here, from the same inputs, so the four
 * read as one publication. Display only: nothing here decides what a signal
 * is, what it scored or what is stored; stored text is never rewritten.
 *
 * THE ANATOMY. A card is a LABEL (the outlet, above an article's title), a
 * HEADLINE (our sentence, or the article's own title, linked), one plain LINE
 * that says what moved and by how much, and an ATTRIBUTION (where it came
 * from). The rules the copy is held to, by `card-copy.test.ts`:
 *
 *   1. One voice. The same card types render the same way everywhere.
 *   2. No template inside a template. A stored Engine narrative of the shape
 *      'X's momentum climbed on "…"' is UN-NESTED at display: the quoted
 *      signal becomes the headline and the move goes in the line. Our
 *      headlines never quote another generated sentence.
 *   3. Name the company. A company-news metric says Tesla, never "X's
 *      company" (`lib/signals/metric-language.ts`, `lib/people/company.ts`).
 *   4. Name the outlet, never the wire. An article card shows the
 *      publication and links to the piece. "RSS", "signal read" and
 *      "Finnhub" never reach a reader; SOURCE_NOUNS says what does.
 *   5. Words fit the person. Nouns follow the category as well as the
 *      metric (`categoryGroup` in metric-language).
 *   6. Zero-impact items are not cards (`showsAsCard`); they stay in detail
 *      panels.
 *   7. The person is named ONCE in the body: our headline or the line, never
 *      both. An article's title is the publisher's text and does not count.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The person a card is about, as the copy needs them. */
export interface CardSubject {
  name: string;
  category: string | null;
  /** The company behind a company-news metric; null for anyone without a Finnhub mapping. */
  company: string | null;
}

/**
 * What the server adds to a signal beyond what feed_entries() carries: the
 * article's outlet and link, the payload kind, and a comment digest's public
 * shape. Never the payload itself, and never the comment texts.
 */
export interface SignalDetail {
  kind: string | null;
  outlet: string | null;
  domain: string | null;
  link: string | null;
  digest: { lean: "positive" | "negative" | "mixed" | null; videoTitle: string | null; sampled: number | null } | null;
}

export const NO_DETAIL: SignalDetail = { kind: null, outlet: null, domain: null, link: null, digest: null };

function detailText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * The public projection of a signal's payload: the fields above and nothing
 * else. A comment digest's payload holds the sampled comment texts; they are
 * not read here, so nothing that renders a card can carry them.
 */
export function projectSignalDetail(payload: unknown): SignalDetail {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return NO_DETAIL;
  const record = payload as Record<string, unknown>;
  const kind = detailText(record.kind, 40);
  const link = detailText(record.link, 2048);
  const lean = record.lean === "positive" || record.lean === "negative" || record.lean === "mixed" ? record.lean : null;
  const sampled = typeof record.sampled === "number" && Number.isFinite(record.sampled) ? record.sampled : null;
  return {
    kind,
    outlet: detailText(record.outlet, 120),
    domain: detailText(record.publisher_domain, 253),
    link: link && /^https?:\/\//i.test(link) ? link : null,
    digest: kind === "comment_digest" ? { lean, videoTitle: detailText(record.videoTitle, 200), sampled } : null,
  };
}

export interface SignalCardInput {
  subject: CardSubject;
  /** The stored headline. */
  headline: string;
  /** The data source's display name, as the database returns it. */
  sourceName: string | null;
  impact: number | null;
  processed: boolean | null;
  sentiment: string | null;
  occurredAt: string;
  /** The metric payload, when the signal is a metric; null otherwise. */
  payload: unknown;
  detail: SignalDetail | null;
}

export interface CardEvidenceInput {
  id: string;
  headline: string;
  sourceName: string | null;
  impact: number | null;
  occurredAt: string;
  payload: unknown;
  detail: SignalDetail | null;
  relation: "direct" | "inverse_pair";
  /** The paired person, for inverse-pair evidence. */
  personName: string | null;
}

export interface NarrativeCardInput {
  subject: CardSubject;
  /** The Engine's sentence, as stored. */
  text: string;
  impact: number | null;
  evidence: CardEvidenceInput[];
}

export interface CardCopy {
  /** The outlet, shown small above an article's title. Null when the headline is our own sentence. */
  label: string | null;
  headline: string;
  /** Where the headline goes: the article. Null when the headline is our own sentence. */
  link: string | null;
  /** The one plain line under the headline: what it was, and the move. */
  line: string;
  /** The footer: where it came from. */
  attribution: string;
  /** True when the headline is the publisher's title rather than the Engine's words. */
  quoted: boolean;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Decimals a card prints a move to: "+0.8". The same as the Feed's direction indicator. */
export const CARD_MOVE_DECIMALS = 1;

/**
 * A card is not shown when its move would print as zero at CARD_MOVE_DECIMALS
 * — below this in either direction. Rule 6 says 0.00; the threshold is the one
 * decimal the card prints, so no card ever reads "+0.0". A move of 0.03 is
 * hidden with the rest; it stays in the detail panel of any narrative that
 * used it.
 */
export const CARD_HIDDEN_BELOW = 0.05;

// ---------------------------------------------------------------------------
// Names and nouns
// ---------------------------------------------------------------------------

/** "Elon Musk" → "Musk", "MrBeast" → "MrBeast", "Kendrick Lamar" → "Lamar". The last word of the display name. */
export function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  return parts[parts.length - 1] || displayName;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a sentence names the person, by full display name or by surname. */
export function namesPerson(text: string, displayName: string): boolean {
  const name = displayName.trim();
  if (!name) return false;
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu").test(text)) return true;
  const short = shortName(name);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(short)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * What a source is called on a card, by the data source's display name. The
 * names the wire uses for itself — RSS, Finnhub, API-Sports — are not names a
 * reader uses; these are. An article card names the OUTLET instead and never
 * reaches this table.
 */
export const SOURCE_NOUNS: Readonly<Record<string, string>> = {
  "RSS (per-person news feed)": "News coverage",
  "Publisher feeds": "News coverage",
  Finnhub: "Company news",
  YouTube: "YouTube",
  "YouTube comments": "YouTube comments",
  "YouTube Trending": "YouTube Trending",
  Twitch: "Twitch",
  "API-Sports": "Game data",
  Spotify: "Spotify",
  Billboard: "Billboard",
  Forbes: "Forbes",
  "NewsData.io": "News coverage",
};

/** The noun for a source and, where the payload kind changes it, the kind: a Finnhub event is a filing, not news volume. */
export function sourceNoun(sourceName: string | null | undefined, kind?: string | null): string {
  if (!sourceName) return "Signal";
  if (sourceName === "Finnhub" && kind && kind !== "metric") return "Company filings";
  const known = SOURCE_NOUNS[sourceName];
  if (known) return known;
  const stripped = sourceName.replace(/\s*\(.*\)\s*$/, "").trim();
  return stripped || "Signal";
}

/**
 * Outlets whose feed name or domain does not read as the publication's name.
 * Keyed by domain; the domain is the stable identity, the feed's own name
 * ("Forbes - Business", "Complex | Music, Sneakers, Pop Culture, News &
 * Shows") is not.
 */
export const KNOWN_OUTLETS: Readonly<Record<string, string>> = {
  "forbes.com": "Forbes",
  "nytimes.com": "The New York Times",
  "finance.yahoo.com": "Yahoo Finance",
  "sports.yahoo.com": "Yahoo Sports",
  "tech.yahoo.com": "Yahoo Tech",
  "news.yahoo.com": "Yahoo News",
  "yahoo.com": "Yahoo",
  "people.com": "People",
  "bloomberg.com": "Bloomberg",
  "benzinga.com": "Benzinga",
  "fortune.com": "Fortune",
  "cnn.com": "CNN",
  "espn.com": "ESPN",
  "si.com": "Sports Illustrated",
  "marca.com": "MARCA",
  "xxlmag.com": "XXL",
  "complex.com": "Complex",
  "billboard.com": "Billboard",
  "hotnewhiphop.com": "HotNewHipHop",
  "thesource.com": "The Source",
  "businessinsider.com": "Business Insider",
  "techradar.com": "TechRadar",
  "futurism.com": "Futurism",
  "law360.com": "Law360",
  "barrons.com": "Barron's",
  "theatlantic.com": "The Atlantic",
  "nypost.com": "New York Post",
  "variety.com": "Variety",
  "deadline.com": "Deadline",
  "thestreet.com": "TheStreet",
  "moneycontrol.com": "Moneycontrol",
  "timesofindia.indiatimes.com": "The Times of India",
  "inc.com": "Inc.",
  "fool.com": "The Motley Fool",
  "seekingalpha.com": "Seeking Alpha",
  "washingtonpost.com": "The Washington Post",
  "wsj.com": "The Wall Street Journal",
  "reuters.com": "Reuters",
  "apnews.com": "AP News",
  "youtu.be": "YouTube",
  "youtube.com": "YouTube",
  "facebook.com": "Facebook",
  "instagram.com": "Instagram",
  "about.instagram.com": "Instagram",
};

/**
 * The publication's name for an article: the known name for its domain, else
 * the feed's own name cleaned of section and tagline ("Forbes - Business" →
 * "Forbes"), else the domain, which is at least true.
 */
export function outletName(outlet: string | null | undefined, domain: string | null | undefined): string | null {
  const host = domain?.trim().toLowerCase().replace(/^www\./, "") ?? null;
  if (host && KNOWN_OUTLETS[host]) return KNOWN_OUTLETS[host];

  const raw = outlet?.trim() ?? "";
  if (raw) {
    const cut = raw.split(/\s+[|–—-]\s+/)[0]?.trim() ?? raw;
    const bare = cut.toLowerCase().replace(/^www\./, "");
    // A feed that names itself by its domain ("fortune.com", "thestreet.com").
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(bare)) return KNOWN_OUTLETS[bare] ?? bare;
    if (cut) return cut;
  }
  return host;
}

// ---------------------------------------------------------------------------
// The move
// ---------------------------------------------------------------------------

/** "+0.8", "−1.1", "0.0". The same shape as the direction indicator beside it, with the true minus sign. */
export function signedMove(value: number, decimals: number = CARD_MOVE_DECIMALS): string {
  const fixed = Math.abs(value).toFixed(decimals);
  if (value > 0 && Number(fixed) !== 0) return `+${fixed}`;
  if (value < 0 && Number(fixed) !== 0) return `−${fixed}`;
  return fixed;
}

/**
 * Whether an item is a card at all. Nothing the Engine has not read yet, and
 * nothing whose move prints as zero (rule 6): a Feed of "+0.0" cards is not
 * a feed. Both still appear in detail panels and on the profile's list.
 */
export function showsAsCard(impact: number | null, processed: boolean | null): boolean {
  if (processed === false) return false;
  if (impact === null || !Number.isFinite(impact)) return false;
  return Math.abs(impact) >= CARD_HIDDEN_BELOW;
}

/**
 * The line: a lead, then the move, with the surname between them when our
 * headline did not name the person (rule 7). "Company news · Musk +0.8."
 * where the headline said Tesla; "YouTube · +0.9." where it said MrBeast.
 */
function line(lead: string, subject: CardSubject, impact: number | null, headlineNamesPerson: boolean): string {
  if (impact === null) return `${lead}.`;
  const who = headlineNamesPerson || !subject.name.trim() ? "" : `${shortName(subject.name)} `;
  return `${lead} · ${who}${signedMove(impact)}.`;
}

const LEAN_PHRASE = { positive: "lean positive", negative: "lean negative", mixed: "are mixed" } as const;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function isArticle(input: { sourceName: string | null; payload: unknown; detail: SignalDetail | null }): boolean {
  if (input.detail?.kind) return input.detail.kind === "article";
  // Without the server's detail: a non-metric item from a news door is an article.
  return readMetricPayload(input.payload) === null && (input.sourceName === "RSS (per-person news feed)" || input.sourceName === "Publisher feeds");
}

/** The stored digest headline, re-rendered from its public shape when the server passed it: the video, and how the comments leaned. */
function digestHeadline(input: { headline: string; detail: SignalDetail | null }): string {
  const digest = input.detail?.digest;
  if (digest?.videoTitle && digest.lean) return `Comments under “${digest.videoTitle}” ${LEAN_PHRASE[digest.lean]}.`;
  return input.headline;
}

/** What a signal's headline is, in our voice or the publisher's, and whether it is ours. */
export function signalHeadline(input: Pick<SignalCardInput, "subject" | "headline" | "payload" | "detail" | "occurredAt" | "sourceName">): { headline: string; quoted: boolean } {
  const metric = sentenceForPayload(input.payload, input.subject.name, input.occurredAt, { category: input.subject.category, company: input.subject.company });
  if (metric) return { headline: metric, quoted: false };
  if (input.detail?.kind === "comment_digest") return { headline: digestHeadline(input), quoted: false };
  return { headline: input.headline, quoted: isArticle(input) };
}

/** How the Engine read an article, from the sentiment it stored: "Read as positive for Zuckerberg". */
function readingLead(sentiment: string | null, subject: CardSubject): string {
  const who = shortName(subject.name);
  if (sentiment === "positive" || sentiment === "negative" || sentiment === "neutral") return `Read as ${sentiment} for ${who}`;
  return `Read for ${who}`;
}

export function signalCard(input: SignalCardInput): CardCopy {
  const { subject, detail } = input;
  const { headline, quoted } = signalHeadline(input);
  const noun = sourceNoun(input.sourceName, detail?.kind);
  const outlet = quoted ? outletName(detail?.outlet, detail?.domain) : null;
  const attribution = outlet ?? noun;

  if (input.processed === false) {
    return { label: outlet, headline, link: quoted ? (detail?.link ?? null) : null, line: "Waiting for the Engine's next read.", attribution, quoted };
  }

  if (quoted) {
    // The title is the publisher's, so the person has not been named by us
    // yet: the lead does it, once, and the line adds only the move.
    return { label: outlet, headline, link: detail?.link ?? null, line: line(readingLead(input.sentiment, subject), subject, input.impact, true), attribution, quoted };
  }

  return { label: null, headline, link: null, line: line(noun, subject, input.impact, namesPerson(headline, subject.name)), attribution, quoted };
}

// ---------------------------------------------------------------------------
// Narratives
// ---------------------------------------------------------------------------

/** The stored shape of an Engine template narrative that quotes a signal: 'X's momentum climbed on "…".' */
const TEMPLATE_QUOTED = /^(.+?)'s? momentum (climbed|slipped) on "([\s\S]+)"\.?$/;

export interface TemplateNarrative {
  name: string;
  verb: "climbed" | "slipped";
  quoted: string;
}

/** Reads a template narrative apart, or null when the sentence is not one. */
export function parseTemplateNarrative(text: string): TemplateNarrative | null {
  const match = TEMPLATE_QUOTED.exec(text.trim());
  if (!match) return null;
  return { name: match[1], verb: match[2] as "climbed" | "slipped", quoted: match[3] };
}

/** The rendered sentence for one piece of evidence: a metric from its payload, a digest from its shape, an article as titled. */
export function evidenceSentence(item: CardEvidenceInput, subject: CardSubject): { headline: string; quoted: boolean } {
  const name = item.personName ?? subject.name;
  // An inverse-pair signal belongs to the paired person, whose category and company we do not carry: the general voice, which is the safe one.
  const about: CardSubject = item.personName ? { name, category: null, company: null } : subject;
  return signalHeadline({ subject: about, headline: item.headline, payload: item.payload, detail: item.detail, occurredAt: item.occurredAt, sourceName: item.sourceName });
}

/** "Forbes and Yahoo Finance", "ESPN and 2 others". */
function outletList(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 2) return unique.join(" and ");
  const rest = unique.length - 1;
  return `${unique[0]} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/**
 * Where a narrative came from, for its line: "The Engine, from Forbes", "The
 * Engine, from 3 stories in ESPN and 2 others", "The Engine, from 2 comment
 * digests", "The Engine, from company news", or just "The Engine" when other
 * forces carried the move.
 */
export function engineLead(evidence: CardEvidenceInput[]): string {
  const direct = evidence.filter((item) => item.relation === "direct");
  if (direct.length === 0) return "The Engine";

  const kinds = direct.map((item) => {
    if (readMetricPayload(item.payload)) return "metric";
    if (item.detail?.kind) return item.detail.kind;
    return isArticle(item) ? "article" : "signal";
  });
  const all = (kind: string) => kinds.every((k) => k === kind);

  if (all("article")) {
    const outlets = direct.map((item) => outletName(item.detail?.outlet, item.detail?.domain) ?? sourceNoun(item.sourceName));
    if (direct.length === 1) return `The Engine, from ${outlets[0]}`;
    return `The Engine, from ${direct.length} stories in ${outletList(outlets)}`;
  }
  if (all("metric")) {
    const nouns = [...new Set(direct.map((item) => sourceNoun(item.sourceName, "metric").toLowerCase()))];
    return `The Engine, from ${nouns.join(" and ")}`;
  }
  if (all("comment_digest")) return `The Engine, from ${direct.length} comment digest${direct.length === 1 ? "" : "s"}`;
  return `The Engine, from ${direct.length} signals`;
}

/** The footer for a narrative: the Engine, then where its evidence came from. */
export function engineAttribution(evidence: CardEvidenceInput[]): string {
  const direct = evidence.filter((item) => item.relation === "direct");
  const names = [...new Set(direct.map((item) => (isArticle(item) && !readMetricPayload(item.payload) ? outletName(item.detail?.outlet, item.detail?.domain) : null) ?? sourceNoun(item.sourceName, readMetricPayload(item.payload) ? "metric" : item.detail?.kind)))];
  return names.length > 0 ? `The Engine · ${names.join(", ")}` : "The Engine";
}

export function narrativeCard(input: NarrativeCardInput): CardCopy {
  const { subject, evidence } = input;
  const template = parseTemplateNarrative(input.text);

  if (template) {
    // Rule 2: the quoted signal, un-nested. It is the linked evidence whose
    // stored headline the template quoted; failing that, the strongest one.
    const quotedItem = evidence.find((item) => item.relation === "direct" && item.headline === template.quoted) ?? evidence.find((item) => item.relation === "direct");
    if (quotedItem) {
      const rendered = evidenceSentence(quotedItem, subject);
      const noun = sourceNoun(quotedItem.sourceName, readMetricPayload(quotedItem.payload) ? "metric" : quotedItem.detail?.kind);
      if (rendered.quoted) {
        const outlet = outletName(quotedItem.detail?.outlet, quotedItem.detail?.domain) ?? noun;
        return {
          label: outlet,
          headline: rendered.headline,
          link: quotedItem.detail?.link ?? null,
          line: line(`The Engine, from ${outlet}`, subject, input.impact, false),
          attribution: `The Engine · ${outlet}`,
          quoted: true,
        };
      }
      return {
        label: null,
        headline: rendered.headline,
        link: null,
        line: line(noun, subject, input.impact, namesPerson(rendered.headline, subject.name)),
        attribution: `The Engine · ${noun}`,
        quoted: false,
      };
    }
    // Quoted text with no evidence to un-nest into: say it plainly, without the nesting.
    const headline = template.quoted;
    return { label: null, headline, link: null, line: line("The Engine", subject, input.impact, namesPerson(headline, subject.name)), attribution: "The Engine", quoted: false };
  }

  // The Engine's own sentence, as written.
  const headline = input.text.trim();
  return {
    label: null,
    headline,
    link: null,
    line: line(engineLead(evidence), subject, input.impact, namesPerson(headline, subject.name)),
    attribution: engineAttribution(evidence),
    quoted: false,
  };
}

// ---------------------------------------------------------------------------
// Detail panels
// ---------------------------------------------------------------------------

/** The lines a detail panel shows for a signal beyond the metric arithmetic: where it came from, and how many comments a digest sampled. */
export function detailSourceLines(input: { sourceName: string | null; payload: unknown; detail: SignalDetail | null }): MetricDetailLine[] {
  const lines: MetricDetailLine[] = [];
  const article = isArticle(input) && !readMetricPayload(input.payload);
  if (article) {
    const outlet = outletName(input.detail?.outlet, input.detail?.domain);
    const domain = input.detail?.domain?.replace(/^www\./, "") ?? null;
    if (outlet) lines.push({ label: "Source", value: domain && domain.toLowerCase() !== outlet.toLowerCase() ? `${outlet} · ${domain}` : outlet });
  } else {
    lines.push({ label: "Source", value: sourceNoun(input.sourceName, readMetricPayload(input.payload) ? "metric" : input.detail?.kind) });
  }
  const sampled = input.detail?.digest?.sampled;
  if (typeof sampled === "number") lines.push({ label: "Comments sampled", value: String(sampled) });
  return lines;
}

/** Everything a detail panel lists for a signal: the source, then the metric arithmetic when there is any. */
export function signalDetailLines(input: SignalCardInput): MetricDetailLine[] {
  return [...detailSourceLines(input), ...detailForPayload(input.payload, input.subject.name, { category: input.subject.category, company: input.subject.company })];
}
