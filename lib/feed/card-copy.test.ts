import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";

import { CREATOR_ONLY_NOUNS, METRIC_VOICE } from "@/lib/signals/metric-language";

import {
  CARD_HIDDEN_BELOW,
  KNOWN_OUTLETS,
  SOURCE_NOUNS,
  engineLead,
  evidenceSource,
  isNarrativeEvidence,
  isTwitchGame,
  namesPerson,
  narrativeCard,
  outletName,
  parseTemplateNarrative,
  projectSignalDetail,
  shortName,
  showsAsCard,
  signalCard,
  signedMove,
  sourceNoun,
  storyCard,
  storyDays,
  storyMove,
  streamHeadline,
  type CardCopy,
  type CardEvidenceInput,
  type CardSubject,
  type SignalDetail,
} from "./card-copy";

/**
 * Phase 30: every word on a card, held to the seven rules in card-copy.ts.
 * The fixtures are the production shapes of 2026-09-25: the Musk company-news
 * template, the Zuckerberg Yahoo Finance article, the Page "clips" narrative,
 * MrBeast's comment digests, Mahomes' game result, Drake on YouTube Trending.
 */

const AT = "2026-09-25T16:45:00Z";

const musk: CardSubject = { name: "Elon Musk", category: "executive", company: "Tesla" };
const zuck: CardSubject = { name: "Mark Zuckerberg", category: "executive", company: "Meta" };
const page: CardSubject = { name: "Larry Page", category: "executive", company: "Alphabet" };
const buffett: CardSubject = { name: "Warren Buffett", category: "executive", company: "Berkshire Hathaway" };
const dell: CardSubject = { name: "Michael Dell", category: "executive", company: "Dell Technologies" };
const mrbeast: CardSubject = { name: "MrBeast", category: "creator", company: null };
const cenat: CardSubject = { name: "Kai Cenat", category: "creator", company: null };
const drake: CardSubject = { name: "Drake", category: "musician", company: null };
const mahomes: CardSubject = { name: "Patrick Mahomes", category: "athlete", company: null };
const founder: CardSubject = { name: "Anthony Baptiste", category: "founder", company: null };

const EVERYONE = [musk, zuck, page, buffett, dell, mrbeast, cenat, drake, mahomes, founder];

function metric(key: string, sigma: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "metric", metric: key, label: key.replace(/_/g, " "), sigma, direction: Math.sign(sigma), polarity: 1, samples: 300, min_samples: 24, window_hours: 336, delta_kind: "level", threshold_std_devs: 2, scale: 0.5, source: "rss", ...extra };
}

function article(outlet: string | null, domain: string, link = `https://${domain}/story`): SignalDetail {
  return { kind: "article", outlet, domain, link, digest: null };
}

const NEWS = "RSS (per-person news feed)";

function signal(subject: CardSubject, over: Partial<Parameters<typeof signalCard>[0]> = {}) {
  return signalCard({ subject, headline: "A headline", sourceName: NEWS, impact: 0.3, processed: true, sentiment: "positive", occurredAt: AT, payload: null, detail: null, ...over });
}

function evidence(over: Partial<CardEvidenceInput> = {}): CardEvidenceInput {
  return { id: "s1", headline: "A headline", sourceName: NEWS, impact: 0.3, occurredAt: AT, payload: null, detail: null, relation: "direct", personName: null, ...over };
}

const BANNED = /\bRSS\b|signal read|Finnhub|σ|\bvia\b|Observed via|gravity target|API-Sports|\bsigma\b/i;

/** Kai Cenat's went-live payloads as production stored them: 09-26 in a non-game category, 09-15 in a game. */
const KAI_0926 = { kind: "stream", source: "twitch", stream_id: "320393470558", channel: "kaicenat", title: "🇮🇸EXPLORING ICELAND🇮🇸[Exploring The Unexplored]", game: "IRL", viewer_count: 0, started_at: "2026-09-26T11:16:20.000Z", observed_at: "2026-09-26T11:16:38.000Z" };
const KAI_0915 = { kind: "stream", source: "twitch", stream_id: "320000000001", channel: "kaicenat", title: "🎮WOLVERINE MARATHON🎮CLICK HERE🎮", game: "Marvel's Wolverine", viewer_count: 40327, started_at: "2026-09-15T17:03:56.000Z", observed_at: "2026-09-15T17:04:10.000Z" };

/** Every string a card puts in front of a reader. */
function words(copy: CardCopy): string[] {
  return [copy.label, copy.headline, copy.line, copy.attribution].filter((text): text is string => text !== null);
}

/** Our own words: the headline when it is ours, and always the line. An article's title is the publisher's. */
function ours(copy: CardCopy): string {
  return copy.quoted ? copy.line : `${copy.headline} ${copy.line}`;
}

function countNames(text: string, subject: CardSubject): number {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const full = text.match(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(subject.name)}(?![\\p{L}\\p{N}])`, "giu"))?.length ?? 0;
  const surname = shortName(subject.name);
  const withoutFull = text.replace(new RegExp(escape(subject.name), "gi"), "");
  const last = withoutFull.match(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(surname)}(?![\\p{L}\\p{N}])`, "giu"))?.length ?? 0;
  return full + last;
}

/** A broad fixture set: every card type, for every kind of person. */
function everyCard(): Array<{ copy: CardCopy; subject: CardSubject; why: string }> {
  const out: Array<{ copy: CardCopy; subject: CardSubject; why: string }> = [];
  for (const subject of EVERYONE) {
    out.push({ subject, why: `${subject.name} article`, copy: signal(subject, { headline: "The publisher's own title, naming nobody", detail: article("Yahoo Finance", "finance.yahoo.com") }) });
    out.push({ subject, why: `${subject.name} article without detail`, copy: signal(subject, { headline: "A title", sourceName: "Publisher feeds" }) });
    out.push({ subject, why: `${subject.name} digest`, copy: signal(subject, { sourceName: "YouTube comments", headline: `Comments on ${subject.name}'s "A video" are mixed, 10 sampled.`, detail: { kind: "comment_digest", outlet: null, domain: null, link: null, digest: { lean: "mixed", videoTitle: "A video", sampled: 10 } } }) });
    out.push({ subject, why: `${subject.name} trending`, copy: signal(subject, { sourceName: "YouTube Trending", headline: `${subject.name} is trending at #1 on YouTube: "A video".`, detail: { kind: "trending", outlet: null, domain: null, link: null, digest: null } }) });
    out.push({ subject, why: `${subject.name} game`, copy: signal(subject, { sourceName: "API-Sports", headline: "Week 2: Kansas City Chiefs beat Indianapolis Colts 33-30.", detail: { kind: "game_result", outlet: null, domain: null, link: null, digest: null } }) });
    out.push({ subject, why: `${subject.name} filing`, copy: signal(subject, { sourceName: "Finnhub", headline: `${subject.name} bought shares.`, detail: { kind: "insider_filing", outlet: null, domain: null, link: null, digest: null } }) });
    for (const payload of [KAI_0926, KAI_0915]) {
      out.push({ subject, why: `${subject.name} went live (${payload.game})`, copy: signal(subject, { sourceName: "Twitch", headline: `${subject.name} is live on Twitch playing ${payload.game} to 0 viewers: "${payload.title}".`, payload, detail: projectSignalDetail(payload), impact: 0.2 }) });
    }
    out.push({ subject, why: `${subject.name} unread`, copy: signal(subject, { processed: false, impact: null, detail: article("Forbes", "forbes.com") }) });
    for (const key of Object.keys(METRIC_VOICE)) {
      for (const sigma of [-3, 2.2, 2.8, 4.1]) {
        const source = key.startsWith("company") ? "Finnhub" : key.startsWith("game") ? "API-Sports" : ["stream_hours_7d", "stream_days_7d", "clips_per_stream_hour", "session_peak_viewers", "follower_count"].includes(key) ? "Twitch" : key.includes("news") || key === "viral_moment_rate" ? NEWS : "YouTube";
        out.push({ subject, why: `${subject.name} ${key} ${sigma}`, copy: signal(subject, { sourceName: source, headline: "stored sigma headline -2.0σ", payload: metric(key, sigma, { observed: 12, baseline: 4 }), impact: sigma > 0 ? 0.4 : -0.4 }) });
      }
    }
    out.push({
      subject,
      why: `${subject.name} template narrative (metric)`,
      copy: narrativeCard({ subject, text: `${subject.name}'s momentum climbed on "stored".`, impact: 0.8, evidence: [evidence({ headline: "stored", sourceName: "Finnhub", payload: metric("company_news_volume_24h", 2.2) })] }),
    });
    out.push({
      subject,
      why: `${subject.name} template narrative (article)`,
      copy: narrativeCard({ subject, text: `${subject.name}'s momentum slipped on "A title".`, impact: -0.6, evidence: [evidence({ headline: "A title", detail: article("Forbes", "forbes.com") })] }),
    });
    out.push({
      subject,
      why: `${subject.name} llm narrative`,
      copy: narrativeCard({ subject, text: "Downgrade triggers a selloff, tempering the week's rally.", impact: -1.1, evidence: [evidence({ detail: article("Forbes", "forbes.com") }), evidence({ id: "s2", detail: article("Yahoo Finance", "finance.yahoo.com") })] }),
    });
    out.push({
      subject,
      why: `${subject.name} llm narrative naming them`,
      copy: narrativeCard({ subject, text: `${subject.name} nets modest momentum from the day's coverage.`, impact: 0.6, evidence: [evidence({ detail: article("Bloomberg", "bloomberg.com") })] }),
    });
    out.push({ subject, why: `${subject.name} inverse pair`, copy: narrativeCard({ subject, text: `${subject.name}'s momentum slipped as a rival's surge pulled the pair the other way.`, impact: -0.5, evidence: [evidence({ relation: "inverse_pair", personName: "Kendrick Lamar" })] }) });
    out.push({ subject, why: `${subject.name} no evidence`, copy: narrativeCard({ subject, text: `${subject.name} drifted up with a broadly positive market mood.`, impact: 0.5, evidence: [] }) });
  }
  return out;
}

describe("the approved cards", () => {
  it("names the company, not the person's company, and puts the move in the line (card 1)", () => {
    const copy = signal(musk, { sourceName: "Finnhub", impact: 0.8, headline: "Elon Musk's company is in the news more than usual", payload: metric("company_news_volume_24h", 2.2) });
    expect(copy.headline).toContain("Tesla");
    expect(copy.headline).not.toMatch(/company|Musk/);
    expect(copy.line).toBe("Company news · Musk +0.8.");
    expect(copy.attribution).toBe("Company news");
    expect(copy.label).toBeNull();
    expect(copy.link).toBeNull();
  });

  it("shows an article as its outlet, its title linked, and one line on how it was read (card 2)", () => {
    const copy = signal(zuck, { headline: "What Meta's Muse event reveals about Mark Zuckerberg's mindset right now", impact: 0.27, detail: article("Yahoo Finance", "finance.yahoo.com", "https://finance.yahoo.com/news/meta-muse") });
    expect(copy).toEqual({
      label: "Yahoo Finance",
      headline: "What Meta's Muse event reveals about Mark Zuckerberg's mindset right now",
      link: "https://finance.yahoo.com/news/meta-muse",
      line: "Read as positive for Zuckerberg · +0.3.",
      attribution: "Yahoo Finance",
      quoted: true,
    });
  });

  it("never says clips of an executive, even on a stored row that did (card 3)", () => {
    const stored = "Larry Page's clips are spreading fast";
    const copy = narrativeCard({ subject: page, text: `Larry Page's momentum climbed on "${stored}".`, impact: 0.75, evidence: [evidence({ headline: stored, payload: metric("viral_moment_rate", 26.41, { observed: 68, baseline: 0.13, window_hours: 720 }) })] });
    expect(copy.headline).not.toMatch(CREATOR_ONLY_NOUNS);
    expect(copy.headline).not.toMatch(/momentum climbed/);
    expect(copy.headline).toContain("Larry Page");
    expect(copy.line).toBe("News coverage · +0.8.");
    expect(copy.attribution).toBe("The Engine · News coverage");
    // The same reading on a creator keeps the creator nouns (the variant is a hash of the day; some days say "everywhere").
    const creatorDays = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"].map((day) => signal(mrbeast, { occurredAt: `${day}T12:00:00Z`, payload: metric("viral_moment_rate", 2.8, { observed: 12, baseline: 3, window_hours: 720 }) }).headline);
    expect(creatorDays.some((headline) => CREATOR_ONLY_NOUNS.test(headline))).toBe(true);
  });

  it("un-nests a template that quoted a count (card 4)", () => {
    const stored = "61 company stories about Elon Musk's company — 2x their usual pace";
    const copy = narrativeCard({ subject: musk, text: `Elon Musk's momentum climbed on "${stored}".`, impact: 1.1, evidence: [evidence({ headline: stored, sourceName: "Finnhub", payload: metric("company_news_volume_24h", 2.95, { observed: 61, baseline: 28.81 }) })] });
    expect(copy.headline).toMatch(/61 stories about Tesla today — 2x its usual pace|Coverage of Tesla is running at 2x its usual pace/);
    expect(copy.headline).not.toMatch(/their/);
    expect(copy.line).toBe("Company news · Musk +1.1.");
  });

  it("re-renders an old sigma headline for the company (card 6)", () => {
    const copy = signal(buffett, { sourceName: "Finnhub", impact: -0.77, headline: "Warren Buffett's company news volume is running -2.0σ below their own trailing fortnight", payload: metric("company_news_volume_24h", -2.0) });
    expect(copy.headline).toMatch(/Berkshire Hathaway/);
    expect(copy.headline).not.toMatch(/σ|Buffett/);
    expect(copy.line).toBe("Company news · Buffett −0.8.");
  });

  it("keeps the Engine's own sentence and says where it came from (card 7)", () => {
    const text = "Goldman Sachs downgrade triggers $9B selloff, tempering Meta's post-Connect momentum despite successful AI hardware launches and viral coverage surge.";
    const copy = narrativeCard({ subject: zuck, text, impact: -1.11, evidence: [evidence({ headline: "Mark Zuckerberg Loses $9 Billion In A Day", sourceName: "Publisher feeds", detail: article("Forbes - Business", "forbes.com") })] });
    expect(copy.headline).toBe(text);
    expect(copy.line).toBe("The Engine, from Forbes · Zuckerberg −1.1.");
    expect(copy.attribution).toBe("The Engine · Forbes");
    expect(copy.quoted).toBe(false);
  });

  it("does not repeat a name the Engine's sentence already carries", () => {
    const copy = narrativeCard({ subject: musk, text: "Musk nets modest momentum from political engagement and a state dinner appearance.", impact: 0.58, evidence: [evidence({ detail: article("Bloomberg.com", "bloomberg.com") }), evidence({ id: "s2", detail: article("Fortune", "fortune.com") })] });
    expect(copy.line).toBe("The Engine, from 2 stories in Bloomberg and Fortune · +0.6.");
  });

  it("names the person once under a metric headline that did not (card 13 against card 1)", () => {
    const views = signal(mrbeast, { sourceName: "YouTube", impact: 0.9, payload: metric("view_count", 2.26, { window_hours: 168, delta_kind: "relative_rate" }) });
    expect(views.headline).toContain("MrBeast");
    expect(views.line).toBe("YouTube · +0.9.");
    expect(views.attribution).toBe("YouTube");
  });

  it("re-renders a comment digest from its shape, without the comments, and a game result as stored", () => {
    const digest = signal(mrbeast, { sourceName: "YouTube comments", impact: 0.1, headline: 'Comments on MrBeast\'s "Can We Build an Entire Village?" are mixed, 10 sampled.', detail: { kind: "comment_digest", outlet: null, domain: null, link: null, digest: { lean: "mixed", videoTitle: "Can We Build an Entire Village?", sampled: 10 } } });
    expect(digest.headline).toBe("Comments under “Can We Build an Entire Village?” are mixed.");
    expect(digest.line).toBe("YouTube comments · MrBeast +0.1.");
    const game = signal(mahomes, { sourceName: "API-Sports", impact: 1.0, headline: "Week 2: Kansas City Chiefs beat Indianapolis Colts 33-30.", detail: { kind: "game_result", outlet: null, domain: null, link: null, digest: null } });
    expect(game.headline).toBe("Week 2: Kansas City Chiefs beat Indianapolis Colts 33-30.");
    expect(game.line).toBe("Game data · Mahomes +1.0.");
    const filing = signal(buffett, { sourceName: "Finnhub", impact: 0.4, headline: "Warren Buffett bought shares.", detail: { kind: "insider_filing", outlet: null, domain: null, link: null, digest: null } });
    expect(filing.attribution).toBe("Company filings");
  });

  it("shows an unread signal as waiting, with no move", () => {
    const copy = signal(drake, { processed: false, impact: null, headline: "Label confirms release date slipped", detail: article("Billboard", "billboard.com") });
    expect(copy.line).toBe("Waiting for the Engine's next read.");
    expect(copy.label).toBe("Billboard");
  });
});

describe("rule 2: no template inside a template", () => {
  it("reads a template narrative apart", () => {
    expect(parseTemplateNarrative('Jeff Bezos\' momentum climbed on "10 stories on Jeff Bezos today, 3x their usual pace".')).toEqual({ name: "Jeff Bezos", verb: "climbed", quoted: "10 stories on Jeff Bezos today, 3x their usual pace" });
    expect(parseTemplateNarrative("Drake's momentum slipped as Kendrick Lamar's surge pulled the pair the other way.")).toBeNull();
    expect(parseTemplateNarrative("Downgrade triggers a selloff.")).toBeNull();
  });

  it("never renders the nested shape, and never quotes another card's sentence", () => {
    const cards = everyCard();
    const headlines = new Set(cards.map((card) => card.copy.headline));
    for (const { copy, why } of cards) {
      expect(copy.headline, why).not.toMatch(/momentum (climbed|slipped) on "/);
      for (const quoted of copy.headline.matchAll(/"([^"]+)"/g)) expect(headlines.has(quoted[1]), `${why} quotes another card`).toBe(false);
    }
  });

  it("falls back to the quoted text when a template's evidence is gone", () => {
    const copy = narrativeCard({ subject: musk, text: 'Elon Musk\'s momentum climbed on "fresh news".', impact: 0.5, evidence: [] });
    expect(copy.headline).toBe("fresh news");
    expect(copy.line).toBe("The Engine · Musk +0.5.");
  });
});

describe("rule 4: name the outlet, never the wire", () => {
  it("has a reader's noun for every source the board runs", () => {
    for (const name of ["RSS (per-person news feed)", "Publisher feeds", "Finnhub", "YouTube", "YouTube comments", "YouTube Trending", "Twitch", "API-Sports"]) {
      expect(SOURCE_NOUNS[name], name).toBeTruthy();
      expect(sourceNoun(name), name).not.toMatch(BANNED);
    }
    expect(sourceNoun("Finnhub", "metric")).toBe("Company news");
    expect(sourceNoun("Finnhub", "insider_filing")).toBe("Company filings");
    expect(sourceNoun("Something (new)")).toBe("Something");
    expect(sourceNoun(null)).toBe("Signal");
  });

  it("names publications the way readers do", () => {
    expect(outletName("Forbes - Business", "forbes.com")).toBe("Forbes");
    expect(outletName("Complex | Music, Sneakers, Pop Culture, News & Shows", "complex.com")).toBe("Complex");
    expect(outletName("fortune.com", null)).toBe("Fortune");
    expect(outletName("People.com", "people.com")).toBe("People");
    expect(outletName("thestreet.com", "thestreet.com")).toBe("TheStreet");
    expect(outletName(null, "finance.biggo.com")).toBe("finance.biggo.com");
    expect(outletName("The Stute", "thestute.com")).toBe("The Stute");
    expect(outletName(null, null)).toBeNull();
    for (const name of Object.values(KNOWN_OUTLETS)) expect(name).not.toMatch(BANNED);
  });

  it("puts no banned word in front of a reader, on any card, for anyone", () => {
    const cards = everyCard();
    expect(cards.length).toBeGreaterThan(500);
    for (const { copy, subject, why } of cards) {
      for (const text of words(copy)) expect(text, why).not.toMatch(BANNED);
      // Signal copy speaks of pace, never of an average or a baseline (Phase 21+, carried forward).
      expect(ours(copy), why).not.toMatch(/\baverage\b|\bbaseline\b/i);
      // Rule 3: with a company to name, never "X's company". (Without one there is nothing to name; the db test keeps that off the board.)
      if (subject.company) expect(ours(copy), why).not.toMatch(/'s? company\b/i);
    }
  });
});

describe("rule 5: words fit the person", () => {
  it("says clips, moments and streams of creators and musicians only", () => {
    for (const { copy, subject, why } of everyCard()) {
      if (copy.quoted) continue;
      if (subject.category === "creator" || subject.category === "musician") continue;
      expect(copy.headline, why).not.toMatch(CREATOR_ONLY_NOUNS);
      expect(copy.line, why).not.toMatch(CREATOR_ONLY_NOUNS);
    }
  });
});

describe("rule 6: zero-impact items are not cards", () => {
  it("hides what would print as zero, and what the Engine has not read", () => {
    expect(CARD_HIDDEN_BELOW).toBe(0.05);
    expect(showsAsCard(0, true)).toBe(false);
    expect(showsAsCard(0.04, true)).toBe(false);
    expect(showsAsCard(-0.049, true)).toBe(false);
    expect(showsAsCard(0.05, true)).toBe(true);
    expect(showsAsCard(-0.3, true)).toBe(true);
    expect(showsAsCard(null, true)).toBe(false);
    expect(showsAsCard(0.8, false)).toBe(false);
    expect(showsAsCard(0.8, null)).toBe(true);
  });

  it("prints the move the way the indicator beside it does", () => {
    expect(signedMove(0.8)).toBe("+0.8");
    expect(signedMove(-1.11)).toBe("−1.1");
    expect(signedMove(0.04)).toBe("0.0");
  });
});

describe("rule 7: the person is named once in the body", () => {
  it("across every card type and every person", () => {
    for (const { copy, subject, why } of everyCard()) {
      if (copy.line === "Waiting for the Engine's next read.") continue;
      const named = countNames(ours(copy), subject);
      // A company metric names the company; Dell Technologies carries Dell's surname and counts as the one mention.
      expect(named, `${why}: "${ours(copy)}"`).toBe(1);
    }
  });

  it("knows a surname, and a name inside a possessive", () => {
    expect(shortName("Elon Musk")).toBe("Musk");
    expect(shortName("MrBeast")).toBe("MrBeast");
    expect(shortName("Kendrick Lamar")).toBe("Lamar");
    expect(namesPerson("MrBeast's channel is pulling views", "MrBeast")).toBe(true);
    expect(namesPerson("Coverage of Larry Page is running hot", "Larry Page")).toBe(true);
    expect(namesPerson("Tesla is in the news more than usual", "Elon Musk")).toBe(false);
    expect(namesPerson("Zuckerberg passes Brin", "Sergey Brin")).toBe(true);
    expect(namesPerson("Pageant season", "Larry Page")).toBe(false);
  });
});

describe("the server's projection of a payload", () => {
  it("keeps the outlet, the link and a digest's shape, and drops everything else", () => {
    const detail = projectSignalDetail({
      kind: "comment_digest",
      lean: "mixed",
      sampled: 10,
      videoTitle: "A video",
      comments: [{ id: "c1", text: "a private comment" }],
      outlet: "x",
      link: "javascript:alert(1)",
    });
    expect(detail).toEqual({ kind: "comment_digest", outlet: "x", domain: null, link: null, digest: { lean: "mixed", videoTitle: "A video", sampled: 10 } });
    expect(JSON.stringify(detail)).not.toContain("private comment");
    expect(projectSignalDetail({ kind: "article", outlet: "Forbes", publisher_domain: "forbes.com", link: "https://forbes.com/a" })).toEqual({ kind: "article", outlet: "Forbes", domain: "forbes.com", link: "https://forbes.com/a", digest: null });
    expect(projectSignalDetail(null).kind).toBeNull();
  });

  it("names the media the platform publishes for embedding, by id only, and a game's scoreboard (Phase 34)", () => {
    const trending = projectSignalDetail({ kind: "trending", video_id: "y56D2WIeKxg", videoTitle: "DRAKE - QUEBEC", channel_id: "UCByOQJjav0CUDwxCk-jVNRQ", view_count: 1220369 });
    expect(trending.media).toEqual({ kind: "youtube", videoId: "y56D2WIeKxg", title: "DRAKE - QUEBEC" });
    expect(JSON.stringify(trending)).not.toContain("UCByOQJjav0CUDwxCk-jVNRQ");
    const digest = projectSignalDetail({ kind: "comment_digest", lean: "mixed", sampled: 10, videoId: "CEJXqm2eiJ0", videoTitle: "A video", comments: [{ text: "private" }] });
    expect(digest.media).toEqual({ kind: "youtube", videoId: "CEJXqm2eiJ0", title: "A video" });
    expect(JSON.stringify(digest)).not.toContain("private");
    // An id that is not an id is not embedded.
    expect(projectSignalDetail({ kind: "trending", video_id: "../evil?x=1" }).media).toBeUndefined();

    const moment = projectSignalDetail({ kind: "live_moment", channel: "KaiCenat", moment: "audience_surge", rationale: "internal", stream_id: "320393470558" });
    expect(moment.media).toEqual({ kind: "twitch", channel: "kaicenat", clip: null, title: null });
    expect(JSON.stringify(moment)).not.toContain("internal");
    expect(projectSignalDetail({ kind: "stream", channel: "kaicenat", title: "WOLVERINE MARATHON", clip_slug: "FunnyClip-abc_123" }).media).toEqual({ kind: "twitch", channel: "kaicenat", clip: "FunnyClip-abc_123", title: "WOLVERINE MARATHON" });
    expect(projectSignalDetail({ kind: "stream", channel: "not a login" }).media).toBeUndefined();
    // An article has no media: nothing is scraped from it.
    expect(projectSignalDetail({ kind: "article", link: "https://forbes.com/a", video_id: "y56D2WIeKxg" }).media).toBeUndefined();

    const game = projectSignalDetail({ kind: "game_result", week: "Week 3", home: "Miami Dolphins", away: "Kansas City Chiefs", home_score: 10, away_score: 24, game_id: "21550", subject: "Patrick Mahomes" });
    expect(game.game).toEqual({ week: "Week 3", home: "Miami Dolphins", away: "Kansas City Chiefs", homeScore: 10, awayScore: 24 });
    expect(projectSignalDetail({ kind: "game_result", home: "Only one side" }).game).toBeUndefined();
  });

  it("says where a narrative came from", () => {
    expect(engineLead([])).toBe("The Engine");
    expect(engineLead([evidence({ detail: article("ESPN", "espn.com") }), evidence({ id: "2", detail: article("MARCA", "marca.com") }), evidence({ id: "3", detail: article("Yahoo Sports", "sports.yahoo.com") })])).toBe("The Engine, from 3 stories in ESPN and 2 others");
    expect(engineLead([evidence({ sourceName: "YouTube comments", detail: { kind: "comment_digest", outlet: null, domain: null, link: null, digest: null } }), evidence({ id: "2", sourceName: "YouTube comments", detail: { kind: "comment_digest", outlet: null, domain: null, link: null, digest: null } })])).toBe("The Engine, from 2 comment digests");
    expect(engineLead([evidence({ sourceName: "Finnhub", payload: metric("company_news_volume_24h", 2.2) })])).toBe("The Engine, from company news");
  });
});

// ---------------------------------------------------------------------------
// PHASE 31 (Kai Cenat, 2026-09-26): the went-live line, and one card per fact
// ---------------------------------------------------------------------------

describe("the went-live line", () => {
  const twitch = (payload: Record<string, unknown>, over: Partial<Parameters<typeof signalCard>[0]> = {}) =>
    signal(cenat, { sourceName: "Twitch", headline: `Kai Cenat is live on Twitch playing ${String(payload.game)} to 0 viewers: "${String(payload.title)}".`, payload, detail: projectSignalDetail(payload), impact: 0, ...over });

  it("reads the 09-26 stream as proposed: the title, the category in brackets, no count", () => {
    const copy = twitch(KAI_0926);
    expect(copy.headline).toBe("Kai Cenat went live on Twitch: “🇮🇸EXPLORING ICELAND🇮🇸[Exploring The Unexplored]” (IRL).");
    expect(copy.quoted).toBe(false);
    // The name is in the headline, so the line carries only the source and the move (rule 7).
    expect(copy.line).toBe("Twitch · 0.0.");
    expect(copy.attribution).toBe("Twitch");
  });

  it("says playing only for a game", () => {
    expect(twitch(KAI_0915).headline).toBe("Kai Cenat went live on Twitch playing Marvel's Wolverine: “🎮WOLVERINE MARATHON🎮CLICK HERE🎮”.");
    for (const category of ["IRL", "Just Chatting", "just chatting", "Music", "Travel & Outdoors", "Talk Shows & Podcasts", "Special Events", "Sports"]) {
      expect(isTwitchGame(category), category).toBe(false);
      expect(streamHeadline("Kai Cenat", { title: "t", category }), category).not.toMatch(/playing/);
    }
    for (const category of ["Fortnite", "Grand Theft Auto V", "Minecraft", "NBA 2K26", "Chess"]) {
      expect(isTwitchGame(category), category).toBe(true);
      expect(streamHeadline("Kai Cenat", { title: "t", category }), category).toBe(`Kai Cenat went live on Twitch playing ${category}: “t”.`);
    }
  });

  it("never prints a viewer count, whatever the payload holds", () => {
    for (const viewers of [0, 18, 40327]) {
      for (const base of [KAI_0926, KAI_0915]) {
        const copy = twitch({ ...base, viewer_count: viewers });
        for (const text of words(copy)) expect(text).not.toMatch(/viewers?|\b40,?327\b|\bto 0\b/);
      }
    }
    // The stream's shape, and (Phase 34, from main) the official Twitch player the story card embeds for it: the channel, no clip.
    expect(projectSignalDetail(KAI_0915)).toEqual({
      kind: "stream",
      outlet: null,
      domain: null,
      link: null,
      digest: null,
      stream: { title: KAI_0915.title, category: "Marvel's Wolverine" },
      media: { kind: "twitch", channel: "kaicenat", clip: null, title: KAI_0915.title },
    });
    expect(JSON.stringify(projectSignalDetail(KAI_0915))).not.toContain("40327");
  });

  it("holds when the title or the category is missing", () => {
    expect(streamHeadline("Kai Cenat", { title: null, category: "IRL" })).toBe("Kai Cenat went live on Twitch (IRL).");
    expect(streamHeadline("Kai Cenat", { title: null, category: "Fortnite" })).toBe("Kai Cenat went live on Twitch playing Fortnite.");
    expect(streamHeadline("Kai Cenat", { title: "  A title  ", category: null })).toBe("Kai Cenat went live on Twitch: “A title”.");
    expect(streamHeadline("Kai Cenat", { title: null, category: null })).toBe("Kai Cenat went live on Twitch.");
    // No name to put on it: the stored headline stands in rather than a sentence about nobody.
    expect(streamHeadline(" ", { title: "t", category: "IRL" })).toBeNull();
    const stored = 'Kai Cenat is live on Twitch playing IRL to 0 viewers: "x".';
    expect(signal({ name: "", category: null, company: null }, { sourceName: "Twitch", headline: stored, payload: KAI_0926, detail: projectSignalDetail(KAI_0926) }).headline).toBe(stored);
  });

  it("un-nests a template that quoted the stored went-live line into the new one", () => {
    const stored = 'Kai Cenat is live on Twitch playing IRL to 0 viewers: "🇮🇸EXPLORING ICELAND🇮🇸[Exploring The Unexplored]".';
    const copy = narrativeCard({
      subject: cenat,
      text: `Kai Cenat's momentum climbed on "${stored}".`,
      impact: 0.4,
      evidence: [evidence({ headline: stored, sourceName: "Twitch", payload: KAI_0926, detail: projectSignalDetail(KAI_0926) })],
    });
    expect(copy.headline).toBe("Kai Cenat went live on Twitch: “🇮🇸EXPLORING ICELAND🇮🇸[Exploring The Unexplored]” (IRL).");
    expect(copy.line).toBe("Twitch · +0.4.");
  });

  it("names one piece of evidence by its source, never 'from 1 signals'", () => {
    const live = evidence({ sourceName: "Twitch", payload: KAI_0926, detail: projectSignalDetail(KAI_0926) });
    expect(engineLead([live])).toBe("The Engine, from Twitch");
    expect(engineLead([live, evidence({ id: "2", sourceName: "YouTube", detail: { kind: "trending", outlet: null, domain: null, link: null, digest: null } })])).toBe("The Engine, from 2 signals");
    expect(evidenceSource(live)).toBe("Twitch");
    expect(evidenceSource(evidence({ detail: article("Forbes - Business", "forbes.com") }))).toBe("Forbes");
    expect(evidenceSource(evidence({ sourceName: "Finnhub", payload: metric("company_news_volume_24h", 2.2) }))).toBe("Company news");
  });
});

describe("rule 8: one card per fact", () => {
  it("counts a direct link, and only a direct link", () => {
    expect(isNarrativeEvidence([{ relation: "direct" }])).toBe(true);
    expect(isNarrativeEvidence([{ relation: "inverse_pair" }, { relation: "direct" }])).toBe(true);
    // An inverse pair's narrative is about the other person; the signal is still news about its own.
    expect(isNarrativeEvidence([{ relation: "inverse_pair" }])).toBe(false);
    expect(isNarrativeEvidence([])).toBe(false);
    expect(isNarrativeEvidence(null)).toBe(false);
    expect(isNarrativeEvidence(undefined)).toBe(false);
  });
});

describe("HTML entities in stored headlines (2026-09-29)", () => {
  it("decodes a stored article title, a digest's video title and an Engine sentence at display, double-encoded too", () => {
    const article = signal(cenat, { headline: "Kai Cenat&#8217;s stream breaks a record", detail: { kind: "article", outlet: "Dexerto", domain: "dexerto.com", link: "https://www.dexerto.com/a", digest: null } });
    expect(article.headline).toBe("Kai Cenat’s stream breaks a record");
    const doubled = signal(cenat, { headline: "Kai Cenat&amp;#8217;s stream breaks a record", detail: { kind: "article", outlet: "Dexerto", domain: "dexerto.com", link: "https://www.dexerto.com/a", digest: null } });
    expect(doubled.headline).toBe("Kai Cenat’s stream breaks a record");
    const digest = signal(mrbeast, { sourceName: "YouTube comments", headline: "x", detail: { kind: "comment_digest", outlet: null, domain: null, link: null, digest: { lean: "mixed", videoTitle: "What&#8217;s Inside My Briefcase?", sampled: 10 } } });
    expect(digest.headline).toBe("Comments under “What’s Inside My Briefcase?” are mixed.");
    const narrative = narrativeCard({ subject: cenat, text: "Kai Cenat&#8217;s momentum climbed on \"a record &quot;subathon&quot;\".", impact: 0.8, evidence: [] });
    expect(narrative.headline).toBe("a record \"subathon\"");
    const sentence = narrativeCard({ subject: cenat, text: "Kai Cenat&#8217;s stream drew a record crowd &amp; a week of coverage.", impact: 0.8, evidence: [] });
    expect(sentence.headline).toBe("Kai Cenat’s stream drew a record crowd & a week of coverage.");
  });
});

describe("the story card (Part B)", () => {
  it("says the move today and over the story's life, once when they are the same", () => {
    expect(storyMove(-0.6, -1.4, 3)).toBe("−0.6 today · −1.4 over 3 days");
    expect(storyMove(0.6, 1.4, 1)).toBe("+1.4 today");
    expect(storyMove(1.4, 1.4, 3)).toBe("+1.4 today");
    expect(storyDays("2026-09-26T12:00:00Z", "2026-09-28T15:30:00Z")).toBe(3);
    expect(storyDays("2026-09-26T12:00:00Z", "2026-09-26T13:00:00Z")).toBe(1);
    expect(storyDays("bad", "2026-09-26T13:00:00Z")).toBe(1);
  });

  it("renders the leader's title under its outlet, linked, and names the person once in the line with where the copies came from", () => {
    const copy = storyCard({
      subject: zuck,
      headline: "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears",
      impactToday: -0.2,
      impactTotal: -1.26,
      days: 2,
      evidence: [
        evidence({ id: "lead", headline: "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears", detail: article("Forbes", "forbes.com", "https://www.forbes.com/lead") }),
        evidence({ id: "copy", headline: "Mark Zuckerberg Loses $9 Billion In A Day As Goldman Sachs Pours Cold Water On Meta Stock Rally", detail: article("Yahoo Finance", "finance.yahoo.com") }),
      ],
    });
    expect(copy).toEqual({
      label: "Forbes",
      headline: "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears",
      link: "https://www.forbes.com/lead",
      line: "2 stories in Forbes and Yahoo Finance · −0.2 today · −1.3 over 2 days.",
      attribution: "Forbes, Yahoo Finance",
      quoted: true,
    });
    for (const text of words(copy)) expect(copyViolations(text)).toEqual([]);
    expect(countNames(ours(copy), zuck)).toBe(0);

    // A headline of ours that does not name the person: the line does, once.
    const metricStory = storyCard({ subject: musk, headline: "x", impactToday: 0.3, impactTotal: 0.3, days: 1, evidence: [evidence({ sourceName: "Finnhub", payload: metric("company_news_volume_24h", 2.2) })] });
    expect(metricStory.line).toBe("Company news · Musk +0.3 today.");
    expect(countNames(ours(metricStory), musk)).toBe(1);
  });
});
