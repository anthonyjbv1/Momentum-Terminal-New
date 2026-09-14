import { describe, expect, it } from "vitest";

import { STORY_DEDUP_LOOKBACK_HOURS, STORY_SIMILARITY_THRESHOLD, collapseStories, storySimilarity, storyTokens, stripOutletSuffix, type StoredStory } from "./stories";

const DRAKE = ["Drake", "Aubrey Drake Graham"];
const MRBEAST = ["MrBeast", "James Stephen Donaldson"];
const at = (iso: string) => new Date(iso);

describe("stripOutletSuffix", () => {
  it("strips the Google News outlet suffix only when it names the outlet", () => {
    expect(stripOutletSuffix("Drake Shares 'Fear of Missing Out' Teaser - Billboard", "Billboard")).toBe("Drake Shares 'Fear of Missing Out' Teaser");
    expect(stripOutletSuffix("Drake Shares 'Fear of Missing Out' Teaser - Billboard", "Rolling Stone")).toBe("Drake Shares 'Fear of Missing Out' Teaser - Billboard");
    expect(stripOutletSuffix("Drake Shares Teaser – Türkiye Today", "Turkiye Today")).toBe("Drake Shares Teaser");
    expect(stripOutletSuffix("Drake - Iceman review - pitchfork.com", "pitchfork.com")).toBe("Drake - Iceman review");
    expect(stripOutletSuffix("Drake - Iceman review", null)).toBe("Drake - Iceman review");
  });
});

describe("storyTokens", () => {
  it("keeps the content words: no outlet, no person name, no stop words, plurals folded", () => {
    expect([...storyTokens("Drake's 'Iceman' Album Release Date - Billboard", { personNames: DRAKE, outlet: "Billboard" })].sort()).toEqual(["album", "date", "iceman", "release"]);
    // "James" is MrBeast's own first name (James Stephen Donaldson), so it goes with the person's name; Patterson stays.
    expect([...storyTokens("MrBeast and James Patterson's new books are flops", { personNames: MRBEAST })].sort()).toEqual(["book", "flop", "patterson"]);
    // The stem is blunt ("james" → "jame") and applied to both sides alike; only equality between sides matters.
    expect([...storyTokens("MrBeast and James Patterson's new books are flops", { personNames: ["MrBeast"] })].sort()).toEqual(["book", "flop", "jame", "patterson"]);
    expect(storyTokens("Drake", { personNames: DRAKE }).size).toBe(0);
    expect([...storyTokens("Beyoncé’s Renaissance")].sort()).toEqual(["beyonce", "renaissance"]);
  });

  it("stems the unambiguous -es plurals without mangling a word that ends in e", () => {
    // "lunches" must meet "lunch"; "surprises" must still meet "surprise" rather than becoming "surpris".
    expect([...storyTokens("free lunches at the school")]).toContain("lunch");
    expect([...storyTokens("a lunch debt push")]).toContain("lunch");
    expect([...storyTokens("he surprises them")]).toEqual(["surprise"]);
    expect([...storyTokens("a surprise for them")]).toEqual(["surprise"]);
    expect([...storyTokens("boxes and classes")].sort()).toEqual(["box", "class"]);
  });
});

describe("storySimilarity", () => {
  it("is Dice over the token sets", () => {
    const a = new Set(["a", "b", "c", "d"]);
    expect(storySimilarity(a, new Set(["a", "b", "c", "d"]))).toBe(1);
    expect(storySimilarity(a, new Set(["x", "y"]))).toBe(0);
    expect(storySimilarity(a, new Set())).toBe(0);
    expect(storySimilarity(a, new Set(["a", "b", "e", "f"]))).toBe(0.5);
  });

  it("puts syndicated copies above the threshold and different stories below it", () => {
    expect(STORY_SIMILARITY_THRESHOLD).toBe(0.4);
    const tokens = (text: string, outlet: string) => storyTokens(text, { personNames: DRAKE, outlet });
    const announce = tokens("Drake Announces 'Iceman' Album Release Date - Complex", "Complex");
    const reveals = tokens("Drake reveals release date for new album Iceman - NME", "NME");
    const finally_ = tokens("Drake's 'Iceman' Finally Has a Release Date - Billboard", "Billboard");
    const sued = tokens("Drake sued over Toronto concert cancellation - Toronto Star", "Toronto Star");
    expect(storySimilarity(announce, reveals)).toBeGreaterThanOrEqual(STORY_SIMILARITY_THRESHOLD);
    expect(storySimilarity(announce, finally_)).toBeGreaterThanOrEqual(STORY_SIMILARITY_THRESHOLD);
    expect(storySimilarity(announce, sued)).toBe(0);
    expect(storySimilarity(reveals, sued)).toBe(0);
  });
});

interface Item {
  id: string;
  headline: string;
  outlet: string;
  tier: number;
  at: string;
}

const describeItem = (names: string[]) => (item: Item) => ({ tokens: storyTokens(item.headline, { personNames: names, outlet: item.outlet }), tier: item.tier, occurredAt: at(item.at) });

describe("collapseStories", () => {
  // The Fear of Missing Out story as the first production run stored it: eight outlets, one story.
  const fomo: Item[] = [
    { id: "inmusic", headline: "Drake Announces ‘Fear of Missing Out’ as a “Not So Short Film” - inmusicblog.com", outlet: "inmusicblog.com", tier: 5, at: "2026-09-12T11:19:00Z" },
    { id: "hnm", headline: "Drake Announces 'FOMO' Film For Upcoming Album 'Fear Of Missing Out': Watch Trailer - HipHop-N-More", outlet: "HipHop-N-More", tier: 5, at: "2026-09-12T13:29:00Z" },
    { id: "complex", headline: "Drake Finally Reveals What 'Fear of Missing Out' Is — and It's Coming Soon - Complex", outlet: "Complex", tier: 2, at: "2026-09-12T14:32:00Z" },
    { id: "now", headline: "Drake previews FOMO film ahead of Sept. 15 premiere - NOW Toronto", outlet: "NOW Toronto", tier: 5, at: "2026-09-12T17:31:00Z" },
    { id: "billboard", headline: "Drake Shares ‘Fear of Missing Out’ Teaser: ‘A Not So Short Film’ - Billboard", outlet: "Billboard", tier: 1, at: "2026-09-12T18:50:00Z" },
    { id: "rollingstone", headline: "Drake Reveals ‘Fear of Missing Out’ Is a ‘Not So Short Film’ - Rolling Stone", outlet: "Rolling Stone", tier: 1, at: "2026-09-12T19:01:00Z" },
    { id: "justjared", headline: "Is Drake’s ‘Fear of Missing Out’ a New Album? He Reveals What FOMO Actually Is - Just Jared", outlet: "Just Jared", tier: 3, at: "2026-09-12T19:35:00Z" },
    { id: "needledrop", headline: "Drake's 'Fear of Missing Out' is a \"not so short\" film - The Needle Drop", outlet: "The Needle Drop", tier: 2, at: "2026-09-13T16:02:00Z" },
  ];
  const distinct: Item[] = [
    { id: "wack", headline: "Wack 100 Salutes Drake for Reportedly Stepping Up on Rappers’ Legal Bills - The Source Magazine", outlet: "The Source Magazine", tier: 3, at: "2026-09-12T22:43:00Z" },
    { id: "casino", headline: "Drake Denies Backing AI Casino Despite Managers’ Investments - CCN.com", outlet: "CCN.com", tier: 5, at: "2026-09-12T12:43:00Z" },
    { id: "bebe", headline: "Bebe Rexha Slid Into Drake’s DMs Saying “I’m Your Dream Girl” and Got Left on Read - Yahoo", outlet: "Yahoo", tier: 5, at: "2026-09-12T21:43:00Z" },
  ];

  it("collapses syndicated copies into the highest-tier publisher's item, earliest among equals, following the chain of wordings", () => {
    const result = collapseStories(fomo, describeItem(DRAKE), []);
    // Seven wordings of one announcement collapse into Billboard's (tier 1, the earlier of the two tier-1 items). NOW Toronto's
    // "previews FOMO film ahead of Sept. 15 premiere" shares almost no words with any of them and stays: a different framing is
    // not a near-duplicate, and the rule errs towards keeping.
    expect(result.kept.map((item) => item.id)).toEqual(["now", "billboard"]);
    expect(result.collapsed.map((c) => c.item.id).sort()).toEqual(["complex", "hnm", "inmusic", "justjared", "needledrop", "rollingstone"]);
    for (const collapse of result.collapsed) {
      expect(collapse.into.kind).toBe("run");
      if (collapse.into.kind === "run") expect(collapse.into.item.id).toBe("billboard");
      expect(collapse.similarity).toBeGreaterThanOrEqual(STORY_SIMILARITY_THRESHOLD);
      expect(collapse.upgrade).toBe(false);
    }
    // Complex's wording only meets Rolling Stone's, not Billboard's: it joins the cluster through a member, not the survivor.
    const noBridge = collapseStories([fomo[4], fomo[2]], describeItem(DRAKE), []);
    expect(noBridge.kept.map((item) => item.id)).toEqual(["billboard", "complex"]);
  });

  it("keeps genuinely different stories about the same person on the same day, in feed order", () => {
    const mixed = [distinct[0], fomo[4], distinct[1], fomo[5], distinct[2]];
    const result = collapseStories(mixed, describeItem(DRAKE), []);
    expect(result.kept.map((item) => item.id)).toEqual(["wack", "billboard", "casino", "bebe"]);
    expect(result.collapsed.map((c) => c.item.id)).toEqual(["rollingstone"]);
  });

  it("does not collapse related but different stories: a flop report and a sales-pitch piece about the same book", () => {
    const book: Item[] = [
      { id: "brew", headline: "Reports: MrBeast and James Patterson’s new book is a flop - Morning Brew", outlet: "Morning Brew", tier: 5, at: "2026-09-01T07:00:00Z" },
      { id: "pajiba", headline: "MrBeast and James Patterson's Book Might Be a Flop - Pajiba", outlet: "Pajiba", tier: 5, at: "2026-09-02T07:00:00Z" },
      { id: "insider", headline: "MrBeast's new challenge: convincing fans to buy his first book - Business Insider", outlet: "Business Insider", tier: 2, at: "2026-09-01T07:00:00Z" },
      { id: "gemini", headline: "Google is sending MrBeast into the wilderness, armed with AI - The Verge", outlet: "The Verge", tier: 2, at: "2026-09-02T07:00:00Z" },
    ];
    const result = collapseStories(book, describeItem(MRBEAST), []);
    expect(result.kept.map((item) => item.id)).toEqual(["brew", "insider", "gemini"]);
    expect(result.collapsed.map((c) => [c.item.id, c.into.kind === "run" ? c.into.item.id : c.into.id])).toEqual([["pajiba", "brew"]]);
  });

  it("collapses a copy of a story already stored inside the lookback, and upgrades an unprocessed stored signal to a better publisher", () => {
    const stored: StoredStory[] = [
      { id: "sig-farm", tokens: storyTokens(fomo[0].headline, { personNames: DRAKE, outlet: fomo[0].outlet }), tier: 5, processed: false, occurredAt: at(fomo[0].at) },
    ];
    const result = collapseStories([fomo[4], distinct[0]], describeItem(DRAKE), stored);
    expect(result.kept.map((item) => item.id)).toEqual(["wack"]);
    expect(result.collapsed).toEqual([expect.objectContaining({ item: fomo[4], into: { kind: "stored", id: "sig-farm", tier: 5, processed: false }, upgrade: true })]);

    // A processed signal is never rewritten; a stored signal of an equal or better tier is not upgraded either.
    const processed = collapseStories([fomo[4]], describeItem(DRAKE), [{ ...stored[0], processed: true }]);
    expect(processed.collapsed[0].upgrade).toBe(false);
    const betterStored = collapseStories([fomo[5]], describeItem(DRAKE), [{ ...stored[0], tier: 1 }]);
    expect(betterStored.kept).toEqual([]);
    expect(betterStored.collapsed[0].upgrade).toBe(false);
    // Two better copies in one poll upgrade the stored signal once, to the best of them.
    const twice = collapseStories([fomo[7], fomo[4]], describeItem(DRAKE), stored);
    expect(twice.collapsed.map((c) => [c.item.id, c.upgrade])).toEqual([["billboard", true], ["needledrop", false]]);
  });

  it("treats the same headline outside the lookback as a new story", () => {
    expect(STORY_DEDUP_LOOKBACK_HOURS).toBe(48);
    const stored: StoredStory[] = [{ id: "old", tokens: storyTokens(fomo[4].headline, { personNames: DRAKE, outlet: "Billboard" }), tier: 1, processed: true, occurredAt: at("2026-09-09T18:50:00Z") }];
    expect(collapseStories([fomo[4]], describeItem(DRAKE), stored).kept).toEqual([fomo[4]]);
    const farApart = [fomo[4], { ...fomo[5], at: "2026-09-15T19:01:00Z" }];
    expect(collapseStories(farApart, describeItem(DRAKE), []).kept.map((item) => item.id)).toEqual(["billboard", "rollingstone"]);
  });

  it("does NOT collapse local-TV rewrites of one event, and records what they actually score", () => {
    // Both pairs are the same real event, observed in production, and both survive at 0.4. They are pinned
    // here with their measured scores because word overlap cannot reach them: the wordings share almost
    // nothing, and the gap between them and a genuinely different story (0.167 at the widest) is too small
    // to close with a threshold. A mechanism that reads abbreviations and synonyms would; a looser number
    // would only start deleting real stories.
    const lunch: Item[] = [
      { id: "fox4kc", headline: "MrBeast surprises Tonganoxie students with year of free lunches, back-to-school clothes", outlet: "FOX4KC.com", tier: 5, at: "2026-08-31T07:00:00Z" },
      { id: "kctv5", headline: "MrBeast surprises Kansas school after teacher’s yearlong lunch debt push", outlet: "KCTV", tier: 5, at: "2026-09-02T07:00:00Z" },
    ];
    const police: Item[] = [
      { id: "police1", headline: "Ind. troopers hunt down MrBeast in ‘Escape 100 Cops’ challenge", outlet: "Police1", tier: 5, at: "2026-08-24T07:00:00Z" },
      { id: "whas11", headline: "MrBeast hides from 100 Indiana State Police troopers in latest video", outlet: "WHAS11", tier: 5, at: "2026-08-22T07:00:00Z" },
    ];
    const score = (pair: Item[]) =>
      storySimilarity(storyTokens(pair[0].headline, { personNames: MRBEAST, outlet: pair[0].outlet }), storyTokens(pair[1].headline, { personNames: MRBEAST, outlet: pair[1].outlet }));

    expect(score(lunch)).toBeCloseTo(0.353, 3);
    expect(score(police)).toBeCloseTo(0.286, 3);
    expect(collapseStories(lunch, describeItem(MRBEAST), []).kept).toHaveLength(2);
    expect(collapseStories(police, describeItem(MRBEAST), []).kept).toHaveLength(2);
  });

  it("collapses the local-TV rewrites that DO share wording, as production showed", () => {
    // From the second run: two of the four police stories did collapse into WHAS11's at 0.5 and 0.526.
    const police: Item[] = [
      { id: "whas11", headline: "MrBeast hides from 100 Indiana State Police troopers in latest video", outlet: "WHAS11", tier: 5, at: "2026-08-22T07:00:00Z" },
      { id: "wthitv", headline: "MrBeast vs. Indiana State Police: 100 troopers hunt down YouTube star in $500K chase at southern Indiana base", outlet: "WTHI-TV", tier: 5, at: "2026-08-22T07:00:00Z" },
      { id: "wlky", headline: "Indiana State Police scores $500K after appearing in MrBeast’s latest YouTube video", outlet: "wlky.com", tier: 5, at: "2026-08-24T07:00:00Z" },
    ];
    const result = collapseStories(police, describeItem(MRBEAST), []);
    expect(result.kept.map((item) => item.id)).toEqual(["whas11"]);
    expect(result.collapsed.map((c) => c.item.id).sort()).toEqual(["wlky", "wthitv"]);
  });

  it("applies the threshold at the boundary, inclusive", () => {
    const describe = (item: { id: string; tokens: string[] }) => ({ tokens: new Set(item.tokens), tier: 5, occurredAt: at("2026-09-12T12:00:00Z") });
    // Two shared of 4 and 6 is exactly 0.4: collapses. Two shared of 4 and 7 is 0.364: does not.
    const exactly = collapseStories([{ id: "a", tokens: ["a", "b", "c", "d"] }, { id: "b", tokens: ["a", "b", "e", "f", "g", "h"] }], describe, []);
    expect(exactly.kept.map((item) => item.id)).toEqual(["a"]);
    const under = collapseStories([{ id: "a", tokens: ["a", "b", "c", "d"] }, { id: "b", tokens: ["a", "b", "e", "f", "g", "h", "i"] }], describe, []);
    expect(under.kept.map((item) => item.id)).toEqual(["a", "b"]);
    // Nothing to compare: an empty headline never collapses into anything.
    const empty = collapseStories([{ id: "a", tokens: [] }, { id: "b", tokens: [] }], describe, []);
    expect(empty.kept).toHaveLength(2);
  });
});
