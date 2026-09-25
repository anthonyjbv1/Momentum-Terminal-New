import { describe, expect, it } from "vitest";

import { CREATOR_ONLY_NOUNS, METRIC_VOICE } from "@/lib/signals/metric-language";

import {
  CARD_HIDDEN_BELOW,
  KNOWN_OUTLETS,
  SOURCE_NOUNS,
  engineLead,
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

  it("says where a narrative came from", () => {
    expect(engineLead([])).toBe("The Engine");
    expect(engineLead([evidence({ detail: article("ESPN", "espn.com") }), evidence({ id: "2", detail: article("MARCA", "marca.com") }), evidence({ id: "3", detail: article("Yahoo Sports", "sports.yahoo.com") })])).toBe("The Engine, from 3 stories in ESPN and 2 others");
    expect(engineLead([evidence({ sourceName: "YouTube comments", detail: { kind: "comment_digest", outlet: null, domain: null, link: null, digest: null } }), evidence({ id: "2", sourceName: "YouTube comments", detail: { kind: "comment_digest", outlet: null, domain: null, link: null, digest: null } })])).toBe("The Engine, from 2 comment digests");
    expect(engineLead([evidence({ sourceName: "Finnhub", payload: metric("company_news_volume_24h", 2.2) })])).toBe("The Engine, from company news");
  });
});
