import { describe, expect, it } from "vitest";

import { EMPTY_DISAMBIGUATION, applyQueryExclusions, excludeReason, hasRules, isGoogleNewsSearch, readDisambiguation, type Disambiguation } from "./disambiguation";

/** Drake's seeded rules, as the migration writes them. */
const DRAKE: Disambiguation = {
  ...EMPTY_DISAMBIGUATION,
  exclude_terms: [
    "drake university",
    "drake bulldogs",
    "drake relays",
    "drake law",
    "drake maye",
    "drake bell",
    "non-conference",
    "missouri valley",
    "ncaa tournament",
  ],
  require_any: [],
};

const DRAKE_FEED = "https://news.google.com/rss/search?q=%22Drake%22+rapper&hl=en-US&gl=US&ceid=US%3Aen";

describe("readDisambiguation", () => {
  it("reads the block, lowercasing and de-duplicating terms", () => {
    const rules = readDisambiguation({ disambiguation: { exclude_terms: ["Drake University", "DRAKE UNIVERSITY", " drake relays "], require_any: ["Rapper"] } });
    expect(rules.exclude_terms).toEqual(["drake university", "drake relays"]);
    expect(rules.require_any).toEqual(["rapper"]);
  });

  it("treats anything malformed or absent as no rules rather than throwing", () => {
    for (const config of [null, undefined, {}, { disambiguation: null }, { disambiguation: "yes" }, { disambiguation: [] }, { disambiguation: { exclude_terms: "drake" } }]) {
      const rules = readDisambiguation(config as Record<string, never>);
      expect(rules, JSON.stringify(config)).toEqual(EMPTY_DISAMBIGUATION);
      expect(hasRules(rules)).toBe(false);
    }
    // Non-string entries are dropped, not fatal.
    expect(readDisambiguation({ disambiguation: { exclude_terms: ["ok", 7, null] } }).exclude_terms).toEqual(["ok"]);
  });
});

describe("excludeReason", () => {
  it("refuses the item that actually reached production, on its context term", () => {
    // The real one. It names neither "Drake University" nor "Bulldogs" — only
    // the collegiate-athletics vocabulary gives it away, which is why the
    // seeded terms cover the discourse and not just the names.
    const verdict = excludeReason("Michigan State Adds Non-Conference Game Against Drake", DRAKE);
    expect(verdict).toEqual({ reason: "excluded_term", term: "non-conference" });
  });

  it("refuses the other entities by name, whatever the casing", () => {
    expect(excludeReason("Drake University names new athletic director", DRAKE)?.term).toBe("drake university");
    expect(excludeReason("DRAKE BULLDOGS fall in overtime", DRAKE)?.term).toBe("drake bulldogs");
    expect(excludeReason("Drake Maye throws for 300 yards", DRAKE)?.term).toBe("drake maye");
    expect(excludeReason("Drake Bell speaks out", DRAKE)?.term).toBe("drake bell");
  });

  it("admits the real Drake stories the feed actually carried", () => {
    // Every one of these is a genuine signal from the production corpus. If a
    // term ever starts refusing one of them, this test is where it shows up.
    const real = [
      "Drake Reveals “FOMO” As Self-Funded Film About One Wild Summer",
      "Everybody Likes Drake Again. That Means We’re Healing",
      "Drake Says Jim Carrey Roast Is 'All I Want for My Birthday'",
      "Judge Sends Drake's Stake Gambling Lawsuit to Arbitration, Pauses Rapper's Case",
      "Drake Rolls With Powerhouse College Football Teams In New OVO Collab— See Every Look",
      "'Drake Curse' Continues As Canadian Rapper Placed A $1.5 Million Bet On Argentina",
      "Why is Drake barking like a dog? Six things you need to know about the rapper’s midlife pivot",
      "Is Drake making country music? Rapper teases 'Choosin' Texas' remix",
    ];
    for (const headline of real) expect(excludeReason(headline, DRAKE), headline).toBeNull();
  });

  it("keeps a subject-adjacent sports story: a college football collab is still about him", () => {
    // "College Football" alone must NOT be an exclusion term — he collaborates
    // with college programmes. Only the conference vocabulary is specific
    // enough, which is why "college" is deliberately not seeded.
    expect(excludeReason("Drake Rolls With Powerhouse College Football Teams In New OVO Collab", DRAKE)).toBeNull();
  });

  it("matches the outlet as well as the headline, since the caller passes both", () => {
    expect(excludeReason("Bulldogs win again Drake Athletics", { ...EMPTY_DISAMBIGUATION, exclude_terms: ["drake athletics"] })?.term).toBe("drake athletics");
  });

  it("applies require_any only when it is set, and says which rule refused", () => {
    const withContext: Disambiguation = { ...EMPTY_DISAMBIGUATION, require_any: ["rapper", "album", "ovo"] };
    expect(excludeReason("Drake drops a new album", withContext)).toBeNull();
    expect(excludeReason("Drake wins the 400m", withContext)).toEqual({ reason: "missing_context", term: null });
    // Empty require_any admits everything, so an unconfigured subject is untouched.
    expect(excludeReason("Anything at all", EMPTY_DISAMBIGUATION)).toBeNull();
  });

  it("checks exclusions before context, so the reported reason is the specific one", () => {
    const both: Disambiguation = { ...EMPTY_DISAMBIGUATION, exclude_terms: ["drake university"], require_any: ["rapper"] };
    expect(excludeReason("Drake University hires a rapper", both)).toEqual({ reason: "excluded_term", term: "drake university" });
  });
});

describe("applyQueryExclusions", () => {
  it("pushes the terms into a Google News query as negatives, quoting the phrases", () => {
    const url = new URL(applyQueryExclusions(DRAKE_FEED, DRAKE));
    const query = url.searchParams.get("q") ?? "";
    expect(query).toContain('"Drake" rapper');
    expect(query).toContain('-"drake university"');
    expect(query).toContain('-"non-conference"');
    // The rest of the query string survives untouched.
    expect(url.searchParams.get("hl")).toBe("en-US");
    expect(url.searchParams.get("ceid")).toBe("US:en");
  });

  it("quotes only multi-word terms", () => {
    const query = new URL(applyQueryExclusions(DRAKE_FEED, { ...EMPTY_DISAMBIGUATION, exclude_terms: ["bulldogs", "drake university"] })).searchParams.get("q") ?? "";
    expect(query).toContain("-bulldogs");
    expect(query).toContain('-"drake university"');
  });

  it("does not add a term the query already excludes", () => {
    const once = applyQueryExclusions(DRAKE_FEED, DRAKE);
    expect(applyQueryExclusions(once, DRAKE)).toBe(once);
  });

  it("leaves a feed alone when it is not a Google News search, or when there is nothing to exclude", () => {
    const outletFeed = "https://www.billboard.com/feed/";
    expect(applyQueryExclusions(outletFeed, DRAKE)).toBe(outletFeed);
    expect(applyQueryExclusions(DRAKE_FEED, EMPTY_DISAMBIGUATION)).toBe(DRAKE_FEED);
    // A Google News URL with no q is not rewritten into a broken one.
    const noQuery = "https://news.google.com/rss/search?hl=en-US";
    expect(applyQueryExclusions(noQuery, DRAKE)).toBe(noQuery);
  });

  it("recognises only the Google News search shape", () => {
    expect(isGoogleNewsSearch(DRAKE_FEED)).toBe(true);
    expect(isGoogleNewsSearch("https://news.google.com/rss/topics/abc")).toBe(false);
    expect(isGoogleNewsSearch("https://example.com/rss")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 31: the namesake who shares the surname
// ---------------------------------------------------------------------------

import { exclusionSubject, namesSubject, obituaryReason, subjectNames, subjectSurname } from "./disambiguation";

describe("the name-conditional rules (Phase 31)", () => {
  const ellison = readDisambiguation({
    disambiguation: { exclude_unless_named: ["David Ellison", "Skydance", "Paramount"], namesake_guard: true, aliases: ["Oracle founder", "Oracle co-founder", "Larry and David Ellison"], surname_alone: true },
  });
  const larry = subjectNames({ display_name: "Larry Ellison", full_name: "Lawrence Joseph Ellison" }, ellison);
  // The subject is the same whatever the publisher's tier (decided 2026-09-29): both names stand for the two halves of the old test.
  const known = exclusionSubject({ display_name: "Larry Ellison", full_name: "Lawrence Joseph Ellison" }, ellison);
  const unknown = known;

  it("reads the new keys and treats them as no rules when absent or malformed", () => {
    expect(ellison.exclude_unless_named).toEqual(["david ellison", "skydance", "paramount"]);
    expect(ellison.namesake_guard).toBe(true); // read, and ignored: the requirement is no longer a flag
    expect(ellison.aliases).toEqual(["oracle founder", "oracle co-founder", "larry and david ellison"]);
    expect(hasRules(ellison)).toBe(true);
    expect(readDisambiguation({ disambiguation: { namesake_guard: "yes", aliases: "Larry", exclude_unless_named: null } })).toEqual(EMPTY_DISAMBIGUATION);
    expect(hasRules(readDisambiguation({ disambiguation: { namesake_guard: true } }))).toBe(false);
    expect(known).toEqual({ names: larry, surname: "Ellison", surnameAlone: true, surnameContext: [] });
    expect(readDisambiguation({ disambiguation: { surname_alone: "yes", surname_context: "Oracle" } })).toMatchObject({ surname_alone: false, surname_context: [] });
    expect(readDisambiguation({ disambiguation: { surname_context: ["Oracle", " ORCL "] } }).surname_context).toEqual(["oracle", "orcl"]);
    expect(subjectSurname({ display_name: "Drake" })).toBeNull();
    expect(subjectSurname({ display_name: "Kai Carlo Cenat III" })).toBe("III");
    // Aliases come out of the config lower-cased like every other term; naming is judged case-insensitively anyway.
    expect(larry).toEqual(["Larry Ellison", "Lawrence Joseph Ellison", "oracle founder", "oracle co-founder", "larry and david ellison"]);
  });

  it("refuses the ten David Ellison stories scored for Larry in one fortnight, and keeps the one about both", () => {
    // Variety, tier 1: the exclusion term does it; the domain is known, so the namesake guard alone would have let it through.
    expect(excludeReason("Paramount's David Ellison Attends Trump White House State Dinner for Chinese President", ellison, known)).toEqual({ reason: "excluded_unless_named", term: "david ellison" });
    expect(excludeReason("The 'Kid' Takes Over: David Ellison Becomes a Hollywood Colossus", ellison, known)?.reason).toBe("excluded_unless_named");
    expect(excludeReason("The Paramount Settlement Started With Trump", ellison, known)).toEqual({ reason: "excluded_unless_named", term: "paramount" });
    // Named alongside: kept, whichever term is present.
    expect(excludeReason("Larry and David Ellison have all the money, and a boost from Trump. Now they're going to own Warner Bros.", ellison, known)).toBeNull();
    expect(excludeReason("John Oliver Takes Swipe at David Ellison and His 'Business Daddy' Larry Ellison on 'Last Week Tonight'", ellison, known)).toBeNull();
    expect(excludeReason("Paramount's Threat to Leave California Is a Page Out of Larry Ellison's Playbook", ellison, known)).toBeNull();
    // An alias counts as naming: the Oracle founder is him.
    expect(excludeReason("Paramount deal rests on the Oracle founder's fortune", ellison, known)).toBeNull();
  });

  it("the name requirement refuses an item that names the subject nowhere, whatever the publisher's tier (decided 2026-09-29)", () => {
    expect(excludeReason("Oracle leaders receive subpoenas to appear before House VA Committee", ellison, unknown)).toEqual({ reason: "namesake_unnamed", term: null });
    // A listed publisher's item is held to the same requirement: listing changes trust, not naming.
    expect(excludeReason("Oracle leaders receive subpoenas to appear before House VA Committee", ellison, known)).toEqual({ reason: "namesake_unnamed", term: null });
    // The surname names him for the requirement ("Ellison pledges" is Larry), but not for the exclusions ("David Ellison attends" is not).
    expect(excludeReason("Ellison Pledges $9.2 Billion More in Oracle Shares as Collateral", ellison, unknown)).toBeNull();
    expect(excludeReason("Larry Ellison Pledges $9.2 Billion More in Oracle Shares as Collateral", ellison, unknown)).toBeNull();
    expect(excludeReason("The Ellisons Have Made This Movie Before", ellison, known)).toEqual({ reason: "namesake_unnamed", term: null });
    // The retired flag changes nothing either way.
    const withoutGuard = { ...ellison, namesake_guard: false };
    expect(excludeReason("Oracle leaders receive subpoenas", withoutGuard, unknown)).toEqual({ reason: "namesake_unnamed", term: null });
    // Off, with context words (decided 2026-09-29): the bare surname names the subject beside one of them, and the exclusions still win.
    const ellisonOff = readDisambiguation({ disambiguation: { exclude_unless_named: ["David Ellison", "Skydance", "Paramount"], aliases: ["Oracle founder", "Oracle's Ellison", "Oracle chairman"], surname_context: ["Oracle"] } });
    const larryOff = exclusionSubject({ display_name: "Larry Ellison", full_name: "Lawrence Joseph Ellison" }, ellisonOff);
    expect(excludeReason("Ellison Pledges $9.2 Billion More in Oracle Shares as Collateral", ellisonOff, larryOff)).toBeNull();
    expect(excludeReason("Oracle (ORCL) Says Ellison Canceled a Plan to Sell Up to $7.5 Billion in Shares", ellisonOff, larryOff)).toBeNull();
    expect(excludeReason("Opinion | Hollywood Surrenders to the Ellison Empire", ellisonOff, larryOff)).toEqual({ reason: "namesake_unnamed", term: null });
    expect(excludeReason("David Ellison weighs Oracle stake in Warner deal", ellisonOff, larryOff)).toEqual({ reason: "excluded_unless_named", term: "david ellison" });
    expect(excludeReason("Paramount's Ellison eyes Oracle-style empire", ellisonOff, larryOff)).toEqual({ reason: "excluded_unless_named", term: "paramount" });
    // The context word counts in the first paragraph too.
    expect(excludeReason("Ellison pledges more shares as collateral\nThe Oracle chairman added $9.2 billion.", ellisonOff, larryOff)).toBeNull();
    // A surname the row does not call distinctive names nobody: Dell is a company, Page a word, until the full name or an alias appears.
    const dell = exclusionSubject({ display_name: "Michael Dell", full_name: "Michael Saul Dell" }, readDisambiguation({ disambiguation: { aliases: ["Dell founder"] } }));
    expect(excludeReason("Dell's AI backlog surge positions stock for $600", EMPTY_DISAMBIGUATION, dell)).toEqual({ reason: "namesake_unnamed", term: null });
    expect(excludeReason("Tampa company to sell in $7.7B take-private deal backed by Dell founder", EMPTY_DISAMBIGUATION, dell)).toBeNull();
    expect(excludeReason("Michael Dell overtakes Jeff Bezos", EMPTY_DISAMBIGUATION, dell)).toBeNull();
    // A one-word name has no separate surname: the name itself is the requirement.
    const drake = exclusionSubject({ display_name: "Drake", full_name: "Aubrey Drake Graham" }, EMPTY_DISAMBIGUATION);
    expect(excludeReason("Drake drops a surprise album", EMPTY_DISAMBIGUATION, drake)).toBeNull();
    expect(excludeReason("OVO Sound signs a new artist", EMPTY_DISAMBIGUATION, drake)).toEqual({ reason: "namesake_unnamed", term: null });
    // The first paragraph counts: a headline that names nobody, a lead that names him.
    expect(excludeReason("Oracle leaders receive subpoenas\nLarry Ellison and Safra Catz were asked to appear.", ellison, known)).toBeNull();
  });

  it("without a subject the two rules never run: the Phase 10 function is byte-for-byte what it was", () => {
    expect(excludeReason("Paramount's David Ellison Attends Trump White House State Dinner", ellison)).toBeNull();
    expect(excludeReason("Oracle leaders receive subpoenas", ellison)).toBeNull();
    // And the unconditional rules still come first, with their own reasons.
    const both = { ...ellison, exclude_terms: ["skydance"] };
    expect(excludeReason("Skydance closes with Larry Ellison's money", both, known)).toEqual({ reason: "excluded_term", term: "skydance" });
  });

  it("names the subject as whole words, possessives included, never inside a longer word", () => {
    expect(namesSubject("Larry Ellison's yacht", ["Larry Ellison"])).toBe(true);
    expect(namesSubject("The Ellisons Have Made This Movie Before", ["Larry Ellison", "Ellison"])).toBe(false);
    expect(namesSubject("Michael Dell Overtakes Jeff Bezos", ["Michael Dell"])).toBe(true);
    expect(namesSubject("Michael Henry Dell's Obituary", ["Michael Dell"])).toBe(false);
    expect(namesSubject("Élon Musk", ["Elon Musk"])).toBe(true);
    expect(namesSubject("Nvidia’s Huang weighs in", ["Nvidia's Huang"])).toBe(true);
  });

  it("Page Auto Group is not Larry Page, and needs no publisher to be refused", () => {
    const page = readDisambiguation({ disambiguation: { exclude_unless_named: ["Page Auto"], surname_alone: false } });
    // "Larry" alone is not an alias for either Larry: it would name Larry Page in Larry Ellison's feed and the other way round.
    expect(namesSubject("Larry's next move", subjectNames({ display_name: "Larry Page", full_name: "Lawrence Edward Page" }, page))).toBe(false);
    const subject = exclusionSubject({ display_name: "Larry Page", full_name: "Lawrence Edward Page" }, page);
    expect(excludeReason("Page Auto Group owner planning mixed-use project with Sheetz and townhomes in Mechanicsville", page, subject)).toEqual({ reason: "excluded_unless_named", term: "page auto" });
    expect(excludeReason("Google Co-Founder Larry Page Is Reportedly Exiting California In Style", page, subject)).toBeNull();
    // A Google company story that names neither founder is not a Larry Page story, from any outlet.
    expect(excludeReason("Google's Gemini adds a new model", page, subject)).toEqual({ reason: "namesake_unnamed", term: null });
  });
});

describe("the obituary guard (Phase 31)", () => {
  it("refuses the two funeral notices that were scored for public figures who are alive", () => {
    expect(obituaryReason({ headline: "Larry Dean Ellison Obituary Sep 22, 2026", outlet: "Reynolds-Love Funeral Home", domain: "reynoldslovefuneralhome.com" })).toEqual({ reason: "obituary", term: "obituary" });
    expect(obituaryReason({ headline: "Michael Henry Dell's Obituary, Visitation & Funeral Information", outlet: "Aftercare Cremation & Burial Service", domain: "aftercare.org" })).toEqual({ reason: "obituary", term: "obituary" });
    // The same home's tribute page, headline first, then the outlet's name.
    expect(obituaryReason({ headline: "Tribute Wall | Michael Henry Dell", outlet: "Aftercare Cremation & Burial Service", domain: "aftercare.org" })).toEqual({ reason: "obituary", term: "tribute wall" });
    expect(obituaryReason({ headline: "Michael Henry Dell", outlet: "Aftercare Cremation & Burial Service", domain: "aftercare.org" })).toEqual({ reason: "obituary", term: "cremation" });
    expect(obituaryReason({ headline: "In memory of a friend", domain: "legacy.com" })).toEqual({ reason: "obituary", term: "legacy.com" });
  });

  it("does not refuse news of a death, a memorial fund or a mention of the word in passing", () => {
    expect(obituaryReason({ headline: "Madeline Ross Dead - Sister of Adin Ross Dies at 36", outlet: "TMZ", domain: "tmz.com" })).toBeNull();
    expect(obituaryReason({ headline: "Tay Keith, Grammy-nominated record producer, died of drug overdose: Autopsy report", outlet: "ABC News", domain: "abcnews.com" })).toBeNull();
    expect(obituaryReason({ headline: "MrBeast funds a memorial scholarship in Ghana", outlet: "GhanaWeb", domain: "ghanaweb.com" })).toBeNull();
    expect(obituaryReason({ headline: "Warren Buffett hands Berkshire chairman seat to son Howard", outlet: "TheStreet", domain: "thestreet.com" })).toBeNull();
  });
});

describe("the obituary guard (hotfix 2026-09-28)", () => {
  it("refuses the three funeral notices scored for public figures who are alive, as they were stored", () => {
    // Larry Page, 2026-09-26 (signal 1cd53fad…): the Legacy.com notice that primed the false death.
    expect(obituaryReason({ headline: "Larry Page Obituary (2026) - Greeneville, TN", outlet: "Legacy obituary", domain: "legacy.com" })).toEqual({ reason: "obituary", term: "obituary" });
    // Larry Ellison, 2026-09-22 (signal 32f2e4f2…).
    expect(obituaryReason({ headline: "Larry Dean Ellison Obituary Sep 22, 2026", outlet: "Reynolds-Love Funeral Home", domain: "reynoldslovefuneralhome.com" })).toEqual({ reason: "obituary", term: "obituary" });
    // Michael Dell, 2026-09-24 and 2026-09-17 (signals 04d17d77…, 9c3addc6…).
    expect(obituaryReason({ headline: "Michael Henry Dell's Obituary, Visitation & Funeral Information", outlet: "Aftercare Cremation & Burial Service", domain: "aftercare.org" })).toEqual({ reason: "obituary", term: "obituary" });
    expect(obituaryReason({ headline: "Tribute Wall | Michael Henry Dell", outlet: "Aftercare Cremation & Burial Service", domain: "aftercare.org" })).toEqual({ reason: "obituary", term: "tribute wall" });
  });

  it("refuses on the publisher alone when the headline is only a name", () => {
    expect(obituaryReason({ headline: "Michael Henry Dell", outlet: "Aftercare Cremation & Burial Service", domain: "aftercare.org" })).toEqual({ reason: "obituary", term: "cremation" });
    expect(obituaryReason({ headline: "In memory of a friend", domain: "legacy.com" })).toEqual({ reason: "obituary", term: "legacy.com" });
    expect(obituaryReason({ headline: "Larry Page", outlet: "Legacy obituary", domain: null })).toEqual({ reason: "obituary", term: "obituar" });
  });

  it("does NOT refuse the wgrv.com item of 2026-09-28 (signal 2d73f458…): a bare name from a radio station is not a funeral notice", () => {
    // On record: the guard is about obituaries, not namesakes. The narrative guard is what stops that item becoming a death on the Feed.
    expect(obituaryReason({ headline: "Larry Page", outlet: "wgrv.com", domain: "wgrv.com" })).toBeNull();
  });

  it("does not refuse a public figure's death reported as news, a memorial they fund, or a succession story", () => {
    expect(obituaryReason({ headline: "Madeline Ross Dead - Sister of Adin Ross Dies at 36", outlet: "TMZ", domain: "tmz.com" })).toBeNull();
    expect(obituaryReason({ headline: "Tay Keith, Grammy-nominated record producer, died of drug overdose: Autopsy report", outlet: "ABC News", domain: "abcnews.com" })).toBeNull();
    expect(obituaryReason({ headline: "MrBeast funds a scholarship in Ghana", outlet: "GhanaWeb", domain: "ghanaweb.com" })).toBeNull();
    expect(obituaryReason({ headline: "Warren Buffett hands Berkshire chairman seat to son Howard", outlet: "TheStreet", domain: "thestreet.com" })).toBeNull();
  });
});
